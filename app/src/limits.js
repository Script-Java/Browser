// Per-client limits: how many proxy connections one client may hold open,
// and how much traffic it may move per day, so one user can't saturate the
// server or run up its bandwidth bill.

const DAY_MS = 86_400_000;
const CHECK_MS = 10_000;

function prefix64(ip) {
	const [head, tail] = ip.split("%")[0].split("::");
	const h = head ? head.split(":") : [];
	const t = tail ? tail.split(":") : [];
	const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
	return groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":") + "::/64";
}

/**
 * Who a request comes from. Railway's edge replaces X-Forwarded-For, so its
 * first entry is the real client. IPv6 clients are keyed by their /64,
 * because one device usually holds a whole /64 and could rotate through it.
 * ponytail: behind a host that passes a client-sent X-Forwarded-For through,
 * this is spoofable; take the entry that host appends instead.
 */
export function clientKey(req) {
	const ip =
		String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
		req.socket?.remoteAddress ||
		"unknown";
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (mapped) return mapped[1];
	return ip.includes(":") ? prefix64(ip) : ip;
}

/** @param {{ maxSockets: number, dailyBytes: number }} options  dailyBytes 0 = unlimited */
export function createLimits({ maxSockets, dailyBytes }) {
	const clients = new Map(); // key -> { bytes, since, sockets: Map<socket, bytes counted> }

	function get(key) {
		const now = Date.now();
		let c = clients.get(key);
		if (!c) clients.set(key, (c = { bytes: 0, since: now, sockets: new Map() }));
		else if (now - c.since > DAY_MS) {
			c.bytes = 0;
			c.since = now;
		}
		return c;
	}

	const overQuota = (key) => dailyBytes > 0 && get(key).bytes >= dailyBytes;

	function addBytes(key, n) {
		get(key).bytes += n;
	}

	function count(c, socket) {
		const total = socket.bytesRead + socket.bytesWritten;
		c.bytes += total - c.sockets.get(socket);
		c.sockets.set(socket, total);
	}

	/** Starts counting a WebSocket's traffic. False when the client is at its limit. */
	function trackSocket(key, socket) {
		const c = get(key);
		if (c.sockets.size >= maxSockets || overQuota(key)) return false;
		c.sockets.set(socket, socket.bytesRead + socket.bytesWritten);
		socket.once("close", () => {
			count(c, socket);
			c.sockets.delete(socket);
		});
		return true;
	}

	setInterval(() => {
		const now = Date.now();
		for (const [key, c] of clients) {
			for (const socket of c.sockets.keys()) count(c, socket);
			if (dailyBytes > 0 && c.bytes >= dailyBytes)
				for (const socket of c.sockets.keys()) socket.destroy();
			if (!c.sockets.size && now - c.since > DAY_MS) clients.delete(key);
		}
	}, CHECK_MS).unref();

	return { overQuota, addBytes, trackSocket };
}

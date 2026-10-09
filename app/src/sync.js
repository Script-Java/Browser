// Sync between two devices, without the server keeping anything: a relay in
// memory. One device shows a one-time code; the other types it in. Each puts
// its bookmarks, history, passwords and passkeys here, encrypted with a key
// made from the code (public/index.js), under a channel name made from it
// too, and takes the other's. The server sees two random names and two
// sealed boxes, each gone once read or after ten minutes.

const TTL_MS = 10 * 60_000;
const MAX_BOX_BYTES = 4 * 1024 * 1024;
const MAX_CHANNELS = 500;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const boxes = new Map(); // channel -> { box, at, owner }
let total = 0;

const CHANNEL = /^[a-f0-9]{32}$/;

function sweep(now = Date.now()) {
	for (const [channel, entry] of boxes)
		if (now - entry.at > TTL_MS) {
			total -= entry.box.length;
			boxes.delete(channel);
		}
}
setInterval(sweep, 60_000).unref();

/** Puts a sealed box on `channel`. Returns an error message, or null. */
export function put(channel, box, owner) {
	if (!CHANNEL.test(channel)) return "bad channel";
	if (typeof box !== "string" || !box || box.length > MAX_BOX_BYTES) return "bad box";
	sweep();
	// one device may hold a few channels at a time, not the whole relay
	let held = 0;
	for (const entry of boxes.values()) if (entry.owner === owner) held++;
	if (held >= 4) return "too many";
	if (boxes.size >= MAX_CHANNELS || total + box.length > MAX_TOTAL_BYTES) return "full";
	const old = boxes.get(channel);
	if (old) total -= old.box.length;
	boxes.set(channel, { box, at: Date.now(), owner });
	total += box.length;
	return null;
}

/** Takes the box on `channel` (once), or null. */
export function take(channel) {
	if (!CHANNEL.test(channel)) return null;
	sweep();
	const entry = boxes.get(channel);
	if (!entry) return null;
	boxes.delete(channel);
	total -= entry.box.length;
	return entry.box;
}

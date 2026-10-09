// Tor tabs, the server's side: a Tor client the server runs next to itself,
// and the proxy connections of Tor tabs sent out through it.
//
// A Tor tab's sites run on origins of their own (t<key>.ISOLATION_DOMAIN),
// whose service workers connect to /torwisp/ instead of /wisp/. Every TCP
// connection they ask for goes to Tor's SOCKS port, with the site's key as
// the SOCKS username: Tor keeps connections with different usernames on
// different circuits, so each site leaves through an exit of its own, as in
// Tor Browser. Sites see a Tor exit, not the server; .onion sites open.
// The server still sees which sites a Tor tab opens: it hands the
// connections to Tor.
//
// Tor itself: the "tor" program (TOR_BIN, or tor on the PATH; the Docker
// image installs it). TOR=off switches Tor tabs off.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { SocksClient } from "socks";
import { SocksProxyAgent } from "socks-proxy-agent";

const state = { enabled: false, ready: false, progress: 0, port: 0, error: null };

/** { available, ready, progress } for the app. */
export const torStatus = () => ({ available: state.enabled, ready: state.ready, progress: state.progress });

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/** Starts Tor, unless switched off or not installed. */
export async function startTor() {
	if (String(process.env.TOR || "").toLowerCase() === "off") return;
	const bin = process.env.TOR_BIN || "tor";
	state.port = await freePort();
	const dataDir = process.env.TOR_DATA_DIR || join(tmpdir(), "badger-tor");
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	// a config of its own, empty: the host's torrc (RunAsDaemon, a User, ports) has no say
	const torrc = join(dataDir, "torrc");
	writeFileSync(torrc, "");
	let child;
	try {
		child = spawn(
			bin,
			[
				"-f", torrc,
				"--defaults-torrc", torrc,
				"--SocksPort", `127.0.0.1:${state.port} IsolateSOCKSAuth`,
				"--DataDirectory", dataDir,
				"--ClientOnly", "1",
				"--AvoidDiskWrites", "1",
				// no control port, no relay, no other way in
				"--ControlPort", "0",
				"--ORPort", "0",
				"--Log", "notice stdout",
			],
			{ stdio: ["ignore", "pipe", "pipe"] }
		);
	} catch {
		return;
	}
	child.once("error", (err) => {
		if (err.code !== "ENOENT") console.warn("tor:", err.message);
		state.enabled = state.ready = false;
	});
	child.once("spawn", () => {
		state.enabled = true;
		console.log("tor: starting");
	});
	child.once("exit", (code) => {
		if (!state.enabled) return;
		console.warn(`tor: stopped (${code}); Tor tabs are off until the server restarts`);
		state.enabled = state.ready = false;
	});
	child.stdout.on("data", (chunk) => {
		for (const line of String(chunk).split("\n")) {
			const progress = /Bootstrapped (\d+)%/.exec(line);
			if (progress) state.progress = Number(progress[1]);
			if (state.progress === 100 && !state.ready) {
				state.ready = true;
				console.log("tor: ready");
			}
		}
	});
	child.stderr.resume();
	// the server's own exit takes Tor with it
	process.once("exit", () => child.kill());
}

/**
 * A TCP socket for wisp-js that goes out through Tor, for one site's
 * connections (its key isolates its circuits from every other site's; the
 * random part, from every other connection of the same site, so a "new
 * circuit" is a reconnect).
 * @param {string} key the Tor origin's label
 */
export function torSocket(key) {
	const isolation = { userId: key, password: randomBytes(8).toString("hex") };
	return class TorSocket {
		constructor(hostname, port) {
			this.hostname = hostname;
			this.port = port;
			this.socket = null;
			this.queue = [];
			this.waiting = [];
			this.ended = false;
		}

		async connect() {
			if (!state.ready) throw new Error("Tor isn't ready");
			const { socket } = await SocksClient.createConnection({
				proxy: { host: "127.0.0.1", port: state.port, type: 5, ...isolation },
				command: "connect",
				// the name, not an address: Tor resolves it at the exit (and .onion names at all)
				destination: { host: this.hostname, port: this.port },
				timeout: 90_000,
			});
			this.socket = socket;
			socket.setNoDelay(true);
			socket.on("data", (chunk) => {
				this.push(chunk);
				if (this.queue.length > 128) socket.pause();
			});
			socket.on("close", () => this.push(null));
			socket.on("error", () => {});
		}

		push(item) {
			if (this.ended) return;
			if (item === null) this.ended = true;
			const waiter = this.waiting.shift();
			if (waiter) waiter(item);
			else this.queue.push(item);
		}

		recv() {
			if (this.queue.length) {
				const item = this.queue.shift();
				if (this.queue.length < 64) this.socket?.resume();
				return Promise.resolve(item);
			}
			if (this.ended) return Promise.resolve(null);
			return new Promise((resolve) => this.waiting.push(resolve));
		}

		send(data) {
			return new Promise((resolve) => (this.socket && !this.socket.destroyed ? this.socket.write(data, resolve) : resolve()));
		}

		close() {
			this.socket?.end();
		}

		// (the queue above does the pausing)
		pause() {}
		resume() {}
	};
}

/** An http(s) agent through Tor, for the media fallback of a Tor tab's site. */
export function torAgent(key) {
	if (!state.ready) return null;
	return new SocksProxyAgent(`socks5h://${encodeURIComponent(key)}:media@127.0.0.1:${state.port}`);
}

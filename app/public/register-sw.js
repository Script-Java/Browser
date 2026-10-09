"use strict";
// The proxy's service worker. Its scope is the proxied pages only, so the
// shell itself isn't controlled by it.
const proxySW = "/scramjet-sw.js";
const proxyScope = "/scramjet/";

/**
 * List of hostnames that are allowed to run serviceworkers on http://
 */
const swAllowedHostnames = ["localhost", "127.0.0.1"];

/**
 * Global util
 * Used in index.html, the recovery page and the service worker's boot page.
 */
async function registerSW() {
	if (!navigator.serviceWorker) {
		if (
			location.protocol !== "https:" &&
			!swAllowedHostnames.includes(location.hostname)
		)
			throw new Error(
				"This page must be opened over HTTPS for the proxy to work."
			);

		throw new Error("Your browser doesn't support service workers.");
	}

	// Ultraviolet's worker, from before the move to Scramjet.
	for (const old of await navigator.serviceWorker.getRegistrations())
		if (new URL(old.scope).pathname === "/uv/") old.unregister();

	const registration = await navigator.serviceWorker.register(proxySW, {
		scope: proxyScope,
	});

	// Take a newer worker now rather than a page load later: fixes to its
	// checks ship in it. Offline, the one already there carries on.
	await registration.update().catch(() => {});

	// serviceWorker.ready only settles for pages inside the SW scope,
	// so wait for this registration to activate directly.
	const worker =
		registration.installing || registration.waiting || registration.active;
	if (worker && worker.state !== "activated") {
		await new Promise((resolve) => {
			worker.addEventListener("statechange", () => {
				if (worker.state === "activated" || worker.state === "redundant")
					resolve();
			});
		});
	}
}

/**
 * Global util
 * Points this origin's bare-mux worker at the epoxy transport over wisp.
 * Needs /baremux/index.js loaded first.
 */
async function setupTransport(fresh = false) {
	// One page of this origin at a time: two pages starting together would
	// each set a transport, and the second would strand the first one's
	// requests (frames of one site inside a page start together).
	if (navigator.locks && !setupTransport.locked)
		return navigator.locks.request("bios-transport", async () => {
			setupTransport.locked = true;
			try {
				return await setupTransport(fresh);
			} finally {
				setupTransport.locked = false;
			}
		});
	const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
	// a Tor tab's site connects through Tor (src/tor.js); the server holds it to that
	const viaTor = /^[tg][a-z2-7]{25}\./.test(location.hostname);
	const wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		(viaTor ? "/torwisp/" : "/wisp/");
	// ponytail: replacing a live transport leaks its connection, so only
	// `fresh` (the old one is known dead) replaces one that's set
	if (fresh || (await connection.getTransport()) !== "/epoxy/index.mjs")
		await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
}

// The proxy's connection to the server can drop (a deploy, the network
// changing) and doesn't come back by itself. The service worker notices and
// asks one open page of this origin to connect again (see shield.js).
if (navigator.serviceWorker && typeof BareMux !== "undefined") {
	navigator.serviceWorker.addEventListener("message", (event) => {
		if (event.origin !== location.origin || event.data?.bios !== "reconnect")
			return;
		setupTransport(true)
			.catch((err) => console.warn("reconnect:", err))
			.finally(() => event.ports[0]?.postMessage("done"));
	});
	navigator.serviceWorker.startMessages();
}

/**
 * Global util
 * Deletes the proxy's cookies (Scramjet keeps every site's cookies in its own
 * database and in the service worker's memory). Its database also holds its
 * config, so callers must not delete "$scramjet" itself.
 */
async function clearProxyCookies() {
	await new Promise((resolve) => {
		const req = indexedDB.open("$scramjet");
		// no database yet: don't create an empty one
		req.onupgradeneeded = () => req.transaction.abort();
		req.onerror = req.onblocked = resolve;
		req.onsuccess = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains("cookies")) {
				db.close();
				return resolve();
			}
			const tx = db.transaction("cookies", "readwrite");
			tx.objectStore("cookies").clear();
			tx.oncomplete = tx.onerror = tx.onabort = () => {
				db.close();
				resolve();
			};
		};
	});
	const registration =
		navigator.serviceWorker &&
		(await navigator.serviceWorker.getRegistration(proxyScope));
	registration?.active?.postMessage({ bios: "wipe" });
}

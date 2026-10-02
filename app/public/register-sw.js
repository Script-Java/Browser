"use strict";
/**
 * Distributed with Ultraviolet and compatible with most configurations.
 */
const stockSW = "/uv/sw.js";

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

	const registration = await navigator.serviceWorker.register(stockSW);

	// serviceWorker.ready only settles for pages inside the SW scope (/uv/),
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
async function setupTransport() {
	const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
	const wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/";
	if ((await connection.getTransport()) !== "/epoxy/index.mjs")
		await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
}

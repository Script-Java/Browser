/*global UVServiceWorker,__uv$config,BiosShield*/
// Replaces Ultraviolet's stock sw.js: same proxy, with the ad/tracker,
// malware and site-isolation checks from shield.js in front of it.
importScripts("uv.bundle.js");
importScripts("uv.config.js");
importScripts(__uv$config.sw || "uv.sw.js");
importScripts("shield.js");

const uv = new UVServiceWorker();
const shield = BiosShield.createShield(uv, __uv$config);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
	event.waitUntil(self.clients.claim())
);

self.addEventListener("fetch", (event) => {
	event.respondWith(shield.handle(event));
});

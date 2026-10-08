/*global $scramjetLoadWorker,BiosShield*/
// The proxy's service worker (scope /scramjet/): Scramjet, with the
// ad/tracker, malware and site-isolation checks from shield.js in front of it.
importScripts("/scram/scramjet.all.js");
importScripts("/bios/shield.js");

// Before Scramjet's and shield.js's listeners: drop messages from anywhere
// but this origin's pages, and config posts. Scramjet takes its config from
// pages that post it; ours never changes and shield.js stores it itself.
// A cookie a page's script set goes to shield.js, which keeps the saved
// ones (Scramjet would save its jar over them; see pageCookie).
self.addEventListener("message", (event) => {
	if (event.origin !== location.origin || event.data?.scramjet$type === "loadConfig")
		event.stopImmediatePropagation();
	else if (event.data?.scramjet$type === "cookie" && !("scramjet$token" in event.data)) {
		event.stopImmediatePropagation();
		shield.pageCookie(event);
	}
});

// before Scramjet opens its database (see storeConfig)
const configStored = BiosShield.storeConfig();
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const shield = BiosShield.createShield(scramjet, configStored);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
	event.respondWith(shield.handle(event));
});

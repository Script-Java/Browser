// Relay-routed sites only: what WebKit sends around the data store's proxy,
// which would show the site this phone's own address (mysk, 2026). WebRTC
// (UDP; the old app's noWebRTC list), WebTransport (QUIC), and DNS prefetching.
for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "RTCSessionDescription", "WebTransport"])
	try {
		Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false });
	} catch {
		// already locked
	}

// first thing in the document, before any link or hint the page has
const meta = document.createElement("meta");
meta.httpEquiv = "x-dns-prefetch-control";
meta.content = "off";
if (document.documentElement) document.documentElement.prepend(meta);
else
	new MutationObserver((_, watch) => {
		if (!document.documentElement) return;
		watch.disconnect();
		document.documentElement.prepend(meta);
	}).observe(document, { childList: true });

// Relay-routed sites only: what WebKit sends around the data store's proxy,
// which would show the site this phone's own address (mysk, 2026): WebRTC
// (UDP; the old app's noWebRTC list) and WebTransport (QUIC). Lockdown, on for
// Relay sites unless the person turns it off, takes both from every frame and
// worker; this is for when it's off.
//
// Runs first, so it keeps the engine's own built-ins: everything below uses
// those copies, never what the page can replace later.
const { apply, getOwnPropertyDescriptor: own } = Reflect;
const define = Object.defineProperty;
const weakGet = WeakMap.prototype.get;

const names = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "RTCSessionDescription", "WebTransport"];
// Workers get no user scripts, and have WebTransport wherever windows do (iOS
// 26.4+ without Lockdown), so no workers then. Wrapping them instead (a blob
// that removes it, then loads the real script) breaks their relative
// addresses, SharedWorker's sharing and pages' CSP; libraries that check for
// Worker fall back to the page. Service workers need app-bound domains, which
// the app doesn't have.
if (typeof WebTransport !== "undefined") names.push("Worker", "SharedWorker");

function lock(win) {
	if (win)
		for (let i = 0; i < names.length; i++)
			try {
				define(win, names[i], { value: undefined, writable: false, configurable: false });
			} catch {
				// already locked
			}
}
lock(self);

// A frame's window has all of them until its own copy of this script runs: an
// about:blank frame, or one whose page is still loading. Locked before the
// page gets it. Only same-origin windows: the page can't touch the others.
// shortcut: frames[i], window[i] and window.open() still hand over child windows unlocked, which Lockdown covers; patch them if people turn Lockdown off on Relay sites.
const disguised = new WeakMap();
const defaultView = own(Document.prototype, "defaultView").get;
for (const Element of [HTMLIFrameElement, HTMLFrameElement, HTMLObjectElement]) {
	const proto = Element.prototype;
	const doc = own(proto, "contentDocument")?.get;
	if (!doc) continue;
	for (const name of ["contentWindow", "contentDocument"]) {
		const real = own(proto, name);
		if (!real?.get) continue;
		const get = real.get;
		const ours = own(
			{
				get [name]() {
					const value = apply(get, this, []);
					const child = apply(doc, this, []);
					if (child) lock(apply(defaultView, child, []));
					return value;
				},
			},
			name
		).get;
		disguised.set(ours, get);
		define(proto, name, { ...real, get: ours });
	}
}

// toString shows those getters as the engine's own.
// shortcut: another frame's Function.prototype.toString still shows their source; mask it in lock() if pages probe that way.
const toString = Function.prototype.toString;
const masked = {
	toString() {
		return apply(toString, apply(weakGet, disguised, [this]) || this, []);
	},
}.toString;
disguised.set(masked, toString);
define(Function.prototype, "toString", { ...own(Function.prototype, "toString"), value: masked });

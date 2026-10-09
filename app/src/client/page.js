// Runs in every proxied page (bundled to /bios/page.js). The service worker
// puts it in each HTML page right after Scramjet's own scripts, so Scramjet
// has already hooked the page. The server puts `self.__biosConfig = {...}`
// in front of it; the service worker sets `self.__biosPage` (this page's
// ad-blocking flags) just before it.
//
// This code is not rewritten by Scramjet: `location` here is the proxy's
// real address, and the site's address comes from the Scramjet client.

import { protect } from "./fingerprint.js";
import { fillLogin, passkeys, watchLogins } from "./logins.js";

const SCRAMJET = Symbol.for("scramjet client global");
// The shell's window, for each tab window that ownParent has changed.
const shells = new WeakMap();
function parentOf(win) {
	return shells.get(win) || win.parent;
}
// Server settings: { isolation: "<domain>" | null, auth: boolean }.
const bios = self.__biosConfig || {};
// The browser's own print(), per window: pages get a silent one, the app's
// menu the real one.
const realPrint = new WeakMap();

/**
 * Asks the app (its own prompt, outside the page) about `kind`, for this
 * page's tab. Resolves with the app's answer, or null.
 * @param {Window} win
 * @param {string} kind "location", "camera", "microphone", "camera+microphone"
 * @param {object} [details]
 */
function askApp(win, kind, details = {}) {
	return new Promise((resolve) => {
		const id = crypto.randomUUID();
		const top = win.top;
		const onAnswer = (event) => {
			const data = event.data;
			if (event.source !== top || data?.bios !== "answer" || data.id !== id) return;
			win.removeEventListener("message", onAnswer, true);
			resolve(data);
		};
		win.addEventListener("message", onAnswer, true);
		try {
			top.postMessage({ bios: "ask", kind, id, ...details }, "*");
		} catch {
			resolve(null);
		}
	});
}
// The service worker's own endpoints (shield.js).
const API = self.location.origin + "/scramjet/__bios/";

// This page is a frame's own origin (f… or g…, see shield.js inFrame): the
// page around it is on another origin, walled off by the browser.
const FRAME_ORIGIN = !!bios.isolation && /^[fg][a-z2-7]{25}\./.test(self.location.hostname);
// What a message carries for whom it's meant (see standInWindow).
const MEANT_FOR = "$bios$target";

const crossOrigin = (win) => {
	try {
		void win.location.href;
		return false;
	} catch {
		return true;
	}
};

const standIns = new WeakMap(); // a window on another origin -> its stand-in
const aroundFrame = new WeakSet(); // frames whose parent (the page around them) is on another origin

/**
 * A stand-in for a window on another origin (a frame of another site, or the
 * page a frame is in), as page scripts would use one: messages, and little
 * else, as a browser allows across origins. A site's message goes in
 * Scramjet's envelope, so the receiving page learns the sender's real
 * origin, with the origin it's meant for, which the receiver holds it to
 * (the browser only knows the proxy's origins). The tab's page is the top:
 * the app above it doesn't exist for a site.
 * @param {Window} real
 * @param {Window} from the window whose site sends what's posted through it
 */
function standInWindow(real, from) {
	if (!real) return real;
	let stand = standIns.get(real);
	if (stand) return stand;
	const isTabPage = () => {
		try {
			return real.parent !== real && real.parent === real.top;
		} catch {
			return false;
		}
	};
	const refused = () => {
		throw new from.DOMException("Blocked a frame from accessing a cross-origin frame.", "SecurityError");
	};
	const navigate = (url) => {
		// only the tab's page may be sent elsewhere by a frame, and only by the app, after a tap
		if (!isTabPage()) return;
		try {
			const target = new URL(String(url), from[SCRAMJET]?.url || undefined);
			if (/^https?:$/.test(target.protocol)) from.top.postMessage({ bios: "navigate", url: target.href }, "*");
		} catch {
			// not an address
		}
	};
	const location = Object.freeze({
		assign: navigate,
		replace: navigate,
		reload() {},
		toString: refused,
		get href() {
			return refused();
		},
		set href(url) {
			navigate(url);
		},
	});
	const target = {
		postMessage(data, targetOrigin, transfer) {
			if (targetOrigin && typeof targetOrigin === "object") {
				transfer = targetOrigin.transfer;
				targetOrigin = targetOrigin.targetOrigin;
			}
			const own = from[SCRAMJET]?.url?.origin || "null";
			let meant = targetOrigin === undefined ? "/" : String(targetOrigin);
			if (meant === "/") meant = own;
			else if (meant !== "*")
				try {
					meant = new URL(meant).origin;
				} catch {
					throw new from.DOMException(`Invalid target origin '${meant}' in a call to 'postMessage'.`, "SyntaxError");
				}
			real.postMessage(
				{ $scramjet$messagetype: "window", $scramjet$origin: own, $scramjet$data: data, [MEANT_FOR]: meant },
				"*",
				transfer || []
			);
		},
		focus() {
			try {
				real.focus();
			} catch {
				// not allowed
			}
		},
		blur() {},
		close() {},
		get closed() {
			return real.closed;
		},
		get length() {
			return real.length;
		},
		get parent() {
			return isTabPage() || real.parent === real ? stand : standInWindow(real.parent, from);
		},
		get top() {
			let w = real;
			try {
				while (w.parent !== w && w.parent !== w.top) w = w.parent;
			} catch {
				// as far as it goes
			}
			return standInWindow(w, from);
		},
		get self() {
			return stand;
		},
		get window() {
			return stand;
		},
		get frames() {
			return stand;
		},
		get opener() {
			return null;
		},
		get location() {
			return location;
		},
		set location(url) {
			navigate(url);
		},
		get document() {
			return refused();
		},
		// Scramjet's own walk up the frames asks whether a window has a client
		[SCRAMJET]: undefined,
		[Symbol.toStringTag]: "Window",
	};
	stand = new Proxy(target, {
		get(object, prop) {
			// a frame inside it, by its index or (below) its name: itself when
			// it's on this page's own origin, its stand-in when not
			const own = (child) => (crossOrigin(child) ? standInWindow(child, from) : child);
			if (typeof prop === "string" && /^\d+$/.test(prop)) return real[Number(prop)] && own(real[Number(prop)]);
			if (prop in object) return Reflect.get(object, prop, stand);
			// what a browser answers with nothing rather than refuse (so that
			// awaiting a window, or asking what it is, doesn't throw)
			if (prop === "then" || prop === Symbol.hasInstance || prop === Symbol.isConcatSpreadable) return undefined;
			// a frame inside it, by its name (widgets find their siblings so):
			// the browser allows that across origins too
			if (typeof prop === "string")
				try {
					const child = real[prop];
					if (child && child === child.window) return own(child);
				} catch {
					// not a frame's name
				}
			return refused();
		},
		has: (object, prop) => prop in object || (typeof prop === "string" && /^\d+$/.test(prop) && Number(prop) < real.length),
		set: (object, prop, value) => {
			if (prop === "location") navigate(value);
			return true;
		},
	});
	standIns.set(real, stand);
	return stand;
}

/** @param {Window} win */
function hook(win) {
	// before the Scramjet check: a frame Scramjet hasn't hooked yet has
	// WebRTC too, and can make frames of its own
	noWebRTC(win);
	privacySignal(win);
	hookFrames(win);
	// before the Scramjet check, like the rest up here: a frame Scramjet
	// hasn't hooked yet answers scripts too
	const flags = pageFlags(win);
	if (flags.safer) protect(win, "safer");
	else if (flags.farble) protect(win, "standard");
	const client = win[SCRAMJET];
	if (!client) return lockBare(win);
	if (refusesFrame(client, win)) return;
	frameNames(client, win);
	acrossOrigins(client, win);
	ownParent(win);
	blobSources(client, win);
	noPopups(client, win);
	pageShield(client, win);
}

/**
 * A frame Scramjet hasn't hooked has the browser's own window.open, dialogs,
 * links and forms, and noPopups can't cover it (it needs Scramjet's client).
 * Until Scramjet hooks it, it gets the blunt version: no windows, no dialogs,
 * and links and forms only to the proxy's own address, inside their frame.
 * @param {Window} win
 */
function lockBare(win) {
	if (win.__biosBare) return;
	Object.defineProperty(win, "__biosBare", { value: true });
	const bare = () => !win[SCRAMJET];
	const here = self.location.origin;
	const leaves = (url) => {
		try {
			return new URL(url, here).origin !== here;
		} catch {
			return true;
		}
	};

	for (const [name, answer] of [["open", null], ["alert", undefined], ["print", undefined], ["confirm", false], ["prompt", null]]) {
		const real = win[name];
		Object.defineProperty(win, name, {
			value: function () {
				return bare() ? answer : real.apply(this, arguments);
			},
			writable: true,
			configurable: true,
		});
	}

	win.addEventListener(
		"click",
		(event) => {
			if (!bare()) return;
			const link = event.composedPath().find((el) => el && (el.localName === "a" || el.localName === "area") && el.href);
			if (!link) return;
			if (leaves(link.href)) event.preventDefault();
			else link.removeAttribute("target");
		},
		true
	);
	const stays = (form) => {
		if (!bare()) return true;
		form.removeAttribute("target");
		return !leaves(form.action);
	};
	win.addEventListener(
		"submit",
		(event) => {
			if (event.target?.localName === "form" && !stays(event.target)) event.preventDefault();
		},
		true
	);
	const realSubmit = win.HTMLFormElement.prototype.submit;
	win.HTMLFormElement.prototype.submit = function () {
		if (stays(this)) return realSubmit.call(this);
	};
}

/**
 * Hooks every frame directly inside `win` that isn't hooked yet.
 * @param {Window} win
 */
function sweep(win) {
	try {
		for (let i = 0; i < win.length; i++) {
			try {
				if (!win[i].__biosFrames) hook(win[i]);
			} catch {
				// cross-origin frame
			}
		}
	} catch {
		// window gone
	}
}

/**
 * Same-origin frames a page writes itself (about:blank, srcdoc) get
 * Scramjet's hooks from their parent but never load this script. Scramjet
 * hooks such a frame when the page first reaches into it, through
 * contentWindow or contentDocument; ours go on at the same moment, before
 * the page can write anything into the frame.
 * A frame is also reachable through window[i] the moment it's in the
 * document, with no getter to hook. So every call that can put one there is
 * followed by a sweep, and frames the parser adds are swept as they appear.
 * ponytail: a page with the patience to find an insertion path not listed
 * here still gets an unhooked frame; the service worker's network lock
 * (shield.js) is what holds then, for everything but WebRTC.
 * @param {Window} win
 */
function hookFrames(win) {
	if (win.__biosFrames) return;
	Object.defineProperty(win, "__biosFrames", { value: true });
	for (const name of ["HTMLIFrameElement", "HTMLFrameElement"]) {
		const proto = win[name]?.prototype;
		if (!proto) continue;
		for (const prop of ["contentWindow", "contentDocument"]) {
			const desc = Object.getOwnPropertyDescriptor(proto, prop);
			if (!desc?.get || !desc.configurable) continue;
			Object.defineProperty(proto, prop, {
				...desc,
				get() {
					let value;
					try {
						value = desc.get.call(this);
					} catch (err) {
						// Scramjet's own hook reaches into the frame, which throws
						// for one on another origin: the browser's answer instead
						// (no document, as a browser gives across origins)
						let real = null;
						try {
							real = win[SCRAMJET]?.descriptors.get(`${name}.prototype.contentWindow`, this);
						} catch {
							// no such frame
						}
						if (!real || !crossOrigin(real)) throw err;
						return prop === "contentWindow" ? standInWindow(real, win) : null;
					}
					// a frame of another site, on its own origin: its stand-in
					if (prop === "contentWindow" && value && crossOrigin(value)) return standInWindow(value, win);
					try {
						const child = prop === "contentWindow" ? value : value?.defaultView;
						if (child && !child.__noPopups) hook(child);
					} catch {
						// cross-origin frame
					}
					return value;
				},
			});
		}
	}
	const sweepAfter = (proto, name) => {
		const desc = proto && Object.getOwnPropertyDescriptor(proto, name);
		const real = desc && (desc.set || desc.value);
		if (typeof real !== "function" || !desc.configurable) return;
		const wrapped = function () {
			try {
				return real.apply(this, arguments);
			} finally {
				sweep(win);
				// called on another window's node (a frame's method, borrowed)
				const home = (this?.ownerDocument || this)?.defaultView;
				if (home && home !== win) sweep(home);
			}
		};
		Object.defineProperty(proto, name, desc.set ? { ...desc, set: wrapped } : { ...desc, value: wrapped });
	};
	const inserters = {
		Node: ["appendChild", "insertBefore", "replaceChild"],
		Element: [
			"append", "prepend", "before", "after", "replaceWith", "replaceChildren",
			"insertAdjacentElement", "insertAdjacentHTML", "setHTMLUnsafe", "innerHTML", "outerHTML",
		],
		CharacterData: ["before", "after", "replaceWith"],
		DocumentType: ["before", "after", "replaceWith"],
		Document: ["append", "prepend", "replaceChildren", "write", "writeln"],
		DocumentFragment: ["append", "prepend", "replaceChildren"],
		ShadowRoot: ["innerHTML", "setHTMLUnsafe"],
		Range: ["insertNode", "surroundContents"],
	};
	for (const [type, names] of Object.entries(inserters))
		for (const name of names) sweepAfter(win[type]?.prototype, name);

	// Frames the parser adds, before the next script in the page runs. Load
	// events from elements never reach the window, hence the document.
	try {
		new win.MutationObserver(() => sweep(win)).observe(win.document, { childList: true, subtree: true });
		win.document.addEventListener("load", () => sweep(win), true);
	} catch {
		// no document yet
	}
	sweep(win);
}

hook(self);

/**
 * WebRTC talks to STUN servers over UDP straight from the device, around the
 * proxy, and hands the page the device's real public IP address, with no
 * prompt. So pages get no WebRTC at all; calls couldn't work through the
 * proxy anyway (it carries TCP only).
 * ponytail: this is page script against page script (see hookFrames for the
 * frames it covers), not a browser rule; no browser has one for WebRTC. The
 * desktop app also cuts WebRTC's UDP off inside Chromium.
 * @param {Window} win
 */
function noWebRTC(win) {
	for (const name of [
		"RTCPeerConnection",
		"webkitRTCPeerConnection",
		"RTCDataChannel",
		"RTCIceCandidate",
		"RTCSessionDescription",
	]) {
		try {
			Object.defineProperty(win, name, { value: undefined, writable: false, configurable: false });
		} catch {
			// already locked
		}
	}
}

/**
 * Global Privacy Control ("don't sell or share my data"), for scripts that
 * ask the page instead of reading the request; shield.js sends the header.
 * ponytail: not in workers, which this script doesn't reach.
 * @param {Window} win
 */
function privacySignal(win) {
	try {
		Object.defineProperty(win.Navigator.prototype, "globalPrivacyControl", {
			get: () => true,
			enumerable: true,
			configurable: true,
		});
	} catch {
		// no Navigator in this window
	}
}

/**
 * The page's settings from the service worker (shield.js, injectHtml). A frame
 * the page wrote itself (about:blank, srcdoc) has none of its own: the page's
 * apply to it.
 * @param {Window} win
 */
function pageFlags(win) {
	try {
		for (let w = win, depth = 0; depth < 8; depth++) {
			if (w.__biosPage) return w.__biosPage;
			if (w.parent === w) break;
			w = w.parent;
		}
	} catch {
		// the shell, on another origin
	}
	return {};
}

/**
 * Origin of the app shell. In isolation mode proxied pages live on
 * <site>.<domain> and the shell on <domain>; otherwise they share an origin.
 * @param {Window} win
 */
function shellOrigin(win) {
	const domain = bios.isolation;
	const loc = win.location;
	if (domain && loc.hostname.endsWith("." + domain))
		return `${loc.protocol}//${domain}${loc.port ? ":" + loc.port : ""}`;
	return loc.origin;
}

/**
 * Scramjet finds the name of a tab's frame by reading the window above it,
 * which throws when that window is the shell on another origin (site
 * isolation). history.pushState asks for the name on every call, so in Safari
 * single-page apps crashed on their first navigation.
 * @param {object} client The Scramjet client for this window.
 * @param {Window} win
 */
function frameNames(client, win) {
	for (const name of ["topFrameName", "parentFrameName"]) {
		const real = Object.getOwnPropertyDescriptor(client.meta, name)?.get;
		if (!real || real.__bios) continue;
		const get = function () {
			try {
				return real.call(this);
			} catch {
				// the highest proxied window we can reach is the tab: its name is its frame's
				let w = win;
				try {
					while (w.parent !== w && w.parent[SCRAMJET]) w = w.parent;
				} catch {
					// cross-origin parent: the shell
				}
				return w.name || null;
			}
		};
		get.__bios = true;
		Object.defineProperty(client.meta, name, { get, configurable: true });
	}
}

/**
 * Scramjet's stand-ins for window.parent and window.top ask each window on
 * the way up whether Scramjet runs there, which throws for the shell on
 * another origin (site isolation): a page that read window.top, as embedded
 * video players do, crashed. The tab's window says it is its own parent, as
 * a top-level page's is, so the walk up ends at the tab.
 * @param {Window} win
 */
function ownParent(win) {
	const shell = win.parent;
	if (shell === win || shells.has(win) || standIns.has(shell)) return;
	try {
		void shell[SCRAMJET];
		return;
	} catch {
		// cross-origin parent: the shell, or the page around a frame
	}
	// A frame on its own origin (FRAME_ORIGIN), inside a page: its parent is
	// that page, which it may only message (standInWindow).
	if (FRAME_ORIGIN && shell !== win.top) {
		const page = standInWindow(shell, win);
		aroundFrame.add(win);
		Object.defineProperty(win, "parent", { get: () => page, set() {}, configurable: true });
		return;
	}
	shells.set(win, shell);
	Object.defineProperty(win, "parent", { get: () => win, set() {}, configurable: true });
}

/**
 * Messages between pages on different origins (a page and a frame of
 * another site, each on its own: see standInWindow). A message meant for
 * another origin than this page's real one never reaches its listeners, as
 * a browser holds it; and the window a message came from, when it's on
 * another origin, is that window's stand-in, so an answer reaches it.
 * @param {object} client
 * @param {Window} win
 */
function acrossOrigins(client, win) {
	if (win.__biosAcross) return;
	Object.defineProperty(win, "__biosAcross", { value: true });
	const listen = client.natives?.store?.["EventTarget.prototype.addEventListener"] || win.EventTarget.prototype.addEventListener;
	listen.call(
		win,
		"message",
		(event) => {
			const data = event.data;
			if (!data || typeof data !== "object" || !(MEANT_FOR in data)) return;
			const meant = data[MEANT_FOR];
			let own = "null";
			try {
				own = client.url.origin;
			} catch {
				// between pages
			}
			if (meant !== "*" && meant !== own) event.stopImmediatePropagation();
		},
		true
	);
	const proto = win.MessageEvent?.prototype;
	const source = proto && Object.getOwnPropertyDescriptor(proto, "source");
	if (source?.get && source.configurable)
		Object.defineProperty(proto, "source", {
			...source,
			get() {
				const real = source.get.call(this);
				// (the app, above everything, answers our own questions as itself)
				return real && real !== win && real !== win.top && crossOrigin(real) ? standInWindow(real, win) : real;
			},
		});
}

/**
 * Scramjet turns a blob: address given to a <video> back into the browser's
 * own, but sends one given to a <source> through the proxy, where a media
 * stream can't be fetched. iPhones play streams through a <source>
 * (ManagedMediaSource), so players there loaded and never started.
 * @param {object} client The Scramjet client for this window.
 * @param {Window} win
 */
function blobSources(client, win) {
	const proto = win.HTMLSourceElement?.prototype;
	if (!proto || proto.__biosBlob) return;
	Object.defineProperty(proto, "__biosBlob", { value: true });
	// true when it set the address itself
	const setBlob = (el, value) => {
		if (!(el instanceof win.HTMLSourceElement) || !String(value).startsWith("blob:")) return false;
		try {
			const real = "blob:" + win.location.origin + new URL(String(value).slice(5)).pathname;
			client.natives.call("Element.prototype.setAttribute", el, "src", real);
			return true;
		} catch {
			return false;
		}
	};
	const src = Object.getOwnPropertyDescriptor(proto, "src");
	if (src?.set && src.configurable)
		Object.defineProperty(proto, "src", {
			...src,
			set(value) {
				if (!setBlob(this, value)) src.set.call(this, value);
			},
		});
	const setAttribute = win.Element.prototype.setAttribute;
	win.Element.prototype.setAttribute = function (name, value) {
		if (String(name).toLowerCase() === "src" && setBlob(this, value)) return;
		return setAttribute.apply(this, arguments);
	};
}

/**
 * A site's rule about which pages may show it in a frame (X-Frame-Options, or
 * frame-ancestors in a Content-Security-Policy) keeps other sites from
 * wrapping it to trick taps. Scramjet drops those headers, so the service
 * worker hands the rule over (shield.js, framingRule): one list of allowed
 * sources per policy. Every page above this one, up to the tab's, must match
 * a source in each list. When one doesn't, nothing of the page shows or
 * runs, as in a browser. A tab's own page isn't framed by another page.
 * ponytail: page script, so a framing page that switches scripts off in its
 * frame (sandbox) still gets the page shown. It gets no signed-in page that
 * way: an embedded site keeps separate cookies under every site embedding it.
 * @param {object} client The Scramjet client for this window.
 * @param {Window} win
 * @returns {boolean} true when the page was stopped
 */
function refusesFrame(client, win) {
	const policies = win.__biosPage?.ancestors;
	if (!policies || parentOf(win) === win || isTab(win)) return false;
	const own = client.url;
	const allowed = (source, url) => {
		source = source.toLowerCase();
		if (source === "'self'") return url.origin === own.origin;
		if (source === "*") return /^https?:$/.test(url.protocol);
		// "https:"
		if (/^[a-z][a-z0-9+.-]*:$/.test(source)) return url.protocol === source;
		// [scheme://]host[:port], the host maybe "*.example.com"; a path doesn't count here
		const parts = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([a-z0-9.-]+|\*)(?::(\d+|\*))?(?:\/.*)?$/.exec(source);
		if (!parts) return false;
		const [, scheme, anySub, host, port] = parts;
		const wanted = scheme ? scheme + ":" : own.protocol;
		// a rule for http also lets the same host's https page frame it
		if (url.protocol !== wanted && !(wanted === "http:" && url.protocol === "https:")) return false;
		if (host !== "*" && (anySub ? !url.hostname.endsWith("." + host) : url.hostname !== host)) return false;
		// URL.port is "" for the scheme's own port
		return port === "*" || url.port === (port === (url.protocol === "https:" ? "443" : "80") ? "" : port || "");
	};
	let refused = false;
	for (let w = win; !refused && parentOf(w) !== w && !isTab(w); ) {
		w = parentOf(w);
		let url = null;
		try {
			url = w[SCRAMJET]?.url;
		} catch {
			// not a page of ours
		}
		// a frame the page wrote itself (about:blank) answers for the page above it
		if (url) refused = !policies.every((sources) => sources.some((source) => allowed(source, url)));
	}
	if (!refused) return false;
	// What's parsed from here on lands outside the document, where nothing
	// shows and no script runs; then the frame goes blank. (Not
	// window.stop(): in Safari the page around the frame never finished
	// loading.)
	win.document.documentElement.replaceChildren();
	win.location.replace("about:blank");
	return true;
}

/**
 * True for the proxied page sitting directly in the shell's frame.
 * @param {Window} win
 */
function isTab(win) {
	const parent = parentOf(win);
	if (parent === win) return false;
	try {
		return !!parent.__biosShell;
	} catch {
		// cross-origin parent: only the shell (isolation mode)
		return true;
	}
}

/**
 * No-popup layer for running inside an iOS standalone PWA.
 *
 * In standalone mode, anything that opens a new window (target=_blank,
 * window.open), leaves the app's origin at the top level, or hands off to
 * another app (mailto:, tel:, ...) pops open a Safari sheet or a system
 * dialog. This keeps every navigation inside the proxy tab and silences the
 * APIs that show system prompts.
 *
 * @param {object} client The Scramjet client for this window.
 * @param {Window} win The window being hooked.
 */
function noPopups(client, win) {
	if (win.__noPopups) return;
	win.__noPopups = true;

	const doc = win.document;
	const SAFE_SCHEMES = ["http:", "https:", "javascript:", "about:", "blob:"];

	// Scramjet leaves mailto: URLs unproxied, so `location.href = "mailto:..."`
	// would hand off to the Mail app. Drop navigations to other apps' schemes
	// (tel:, sms:, etc. are proxied into a harmless error page already).
	const toOtherApp = (url) => /^\s*mailto:/i.test(String(url));
	const urlAccessor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(client), "url");
	Object.defineProperty(client, "url", {
		get: urlAccessor.get,
		set(url) {
			if (!toOtherApp(url)) urlAccessor.set.call(this, url);
		},
		configurable: true,
	});
	const fakeLocation = client.locationProxy;
	for (const name of ["assign", "replace"]) {
		const real = fakeLocation?.[name];
		if (typeof real === "function")
			fakeLocation[name] = function (url) {
				if (!toOtherApp(url)) return real.apply(this, arguments);
			};
	}

	function hasShell() {
		try {
			return !!win.top.__biosShell;
		} catch {
			// a cross-origin top is the shell (isolation mode)
			return win.top !== win;
		}
	}

	// The proxied page acting as "the tab": the shell's iframe, or the top
	// window when there is no shell.
	function tabWindow() {
		let w = win;
		try {
			while (w.parent !== w && !w.parent.__biosShell) w = w.parent;
		} catch {
			// cross-origin ancestor; stay where we are
		}
		return w;
	}

	// Each shell tab's frame has its own name (uvframe-<n>), so a link aimed
	// at it lands in this tab, never another one.
	function tabTargetName() {
		return hasShell() ? tabWindow().name || "_self" : "_top";
	}

	// Real address for a link: Scramjet may hand back its own proxied form.
	function realUrl(href) {
		const proxied = win.location.origin + "/scramjet/";
		href = String(href);
		if (href.startsWith(proxied)) {
			const [path, hash] = href.slice(proxied.length).split("#");
			try {
				return decodeURIComponent(path) + (hash ? "#" + decodeURIComponent(hash) : "");
			} catch {
				return href;
			}
		}
		try {
			return new URL(href, client.url).href;
		} catch {
			return "";
		}
	}

	// In the shell, a new window becomes a new tab. The shell checks the
	// click or tap itself too, so a page can't open tabs on its own.
	function openTab(url, background = false) {
		if (!hasShell()) return false;
		let target;
		try {
			target = new URL(realUrl(url));
		} catch {
			return false;
		}
		if (target.protocol !== "http:" && target.protocol !== "https:") return false;
		const send = () => {
			try {
				win.top.postMessage({ bios: "open", url: target.href, background }, shellOrigin(win));
			} catch {
				// shell gone
			}
		};
		// An ad's pop-up gets no tab: the ad blocker (in the service worker)
		// is asked first. The page hears "opened" either way, so its ad script
		// doesn't fall back to sending the page itself to the ad.
		const ask = client.natives?.store?.fetch;
		if (!ask) send();
		else
			ask
				.call(win, API + "ad?u=" + encodeURIComponent(target.href))
				.then((res) => res.json())
				.then((answer) => answer.blocked || send(), send);
		return true;
	}

	// Targets that would open a new window: _blank, _new, or a name no frame has.
	function opensNewWindow(target) {
		const name = String(target ?? "").trim();
		const lower = name.toLowerCase();
		if (lower === "_blank" || lower === "_new") return true;
		if (!name || lower.startsWith("_")) return false;
		return !findFrame(name);
	}

	function findFrame(name, root = tabWindow()) {
		try {
			if (root.name === name) return root;
			for (let i = 0; i < root.frames.length; i++) {
				const found = findFrame(name, root.frames[i]);
				if (found) return found;
			}
		} catch {
			// cross-origin frame
		}
		return null;
	}

	// Re-wrap pages that escaped the shell (e.g. a target=_top that slipped
	// through) so the toolbar is never lost.
	if (win === win.top && !win.__biosShell) {
		try {
			const source = client.url.href;
			win.location.replace(
				shellOrigin(win) + "/#" + encodeURIComponent(source)
			);
			return;
		} catch {
			// fall through and keep patching
		}
	}

	// Decide whether a link/form target would leave the current tab.
	// Returns the replacement target, or null when it is already safe.
	function fixTarget(target) {
		target = (target || "").trim();
		const lower = target.toLowerCase();
		if (lower === "" || lower === "_self") return null;
		if (lower === "_parent") {
			try {
				if (win.parent !== win && !win.parent.__biosShell) return null;
			} catch {
				// fall through
			}
			return tabTargetName();
		}
		if (lower === "_top" || lower === "_blank" || lower === "_new")
			return tabTargetName();
		if (hasShell() && target === tabWindow().name) return null;
		return findFrame(target) ? null : tabTargetName();
	}

	function baseTarget() {
		const base = doc.querySelector("base[target]");
		return base ? base.getAttribute("target") : "";
	}

	function isSafeScheme(href) {
		try {
			return SAFE_SCHEMES.includes(new URL(href, win.location.href).protocol);
		} catch {
			return true;
		}
	}

	// Links: keep target=_blank/_top/etc. inside the tab, and block links that
	// hand off to other apps (mailto:, tel:, sms:, maps:, itms-apps:, ...).
	win.addEventListener(
		"click",
		(event) => {
			const path = event.composedPath ? event.composedPath() : [event.target];
			const link = path.find(
				(el) =>
					el &&
					(el.localName === "a" || el.localName === "area") &&
					typeof el.href === "string"
			);
			if (!link) return;

			// <a download>: the file goes to the app's download list (a page
			// that saves what it made, like an export, often as a data: or
			// blob: address). Only right after a tap, so a page can't drop
			// files on anyone by itself.
			if (link.hasAttribute("download") && !event.defaultPrevented && /^(https?|blob|data):/i.test(link.href)) {
				event.preventDefault();
				if (userGesture()) saveLink(link);
				return;
			}

			if (!isSafeScheme(link.href)) {
				event.preventDefault();
				return;
			}
			link.removeAttribute("download");

			const target = link.hasAttribute("target")
				? link.getAttribute("target")
				: baseTarget();
			const modified = event.ctrlKey || event.metaKey || event.shiftKey;
			if (modified || opensNewWindow(target)) {
				// a script clicking its own link isn't the person asking for a tab
				if (hasShell() && !userGesture()) {
					event.preventDefault();
					return;
				}
				if (openTab(link.href, modified)) {
					event.preventDefault();
					return;
				}
			}
			// A frame on its own origin can't reach the tab's page: a link
			// meant for it goes through the app, after a tap.
			const lower = String(target || "").trim().toLowerCase();
			// (_parent leaves it only when the parent is the page around the frame)
			const leaves = lower === "_top" || (lower === "_parent" && aroundFrame.has(win));
			if (FRAME_ORIGIN && !isTab(win) && leaves) {
				event.preventDefault();
				if (userGesture()) {
					const to = realUrl(link.href);
					if (/^https?:/.test(to)) win.top.postMessage({ bios: "navigate", url: to }, "*");
				}
				return;
			}
			const fixed = fixTarget(target);
			if (fixed) link.setAttribute("target", fixed);
		},
		true
	);

	// The file behind an <a download>, fetched here (through the proxy, so a
	// blob: the page made is this origin's too) and handed to the app.
	function saveLink(link) {
		const fetchHere = client.natives?.store?.fetch;
		// the address as the browser has it: Scramjet's proxied form
		const proxied = client.natives.call("Element.prototype.getAttribute", link, "href");
		if (!fetchHere || !proxied) return;
		let name = String(link.getAttribute("download") || "").trim();
		fetchHere
			.call(win, new URL(proxied, win.location.href).href)
			.then(async (res) => {
				if (!res.ok) return;
				const blob = await res.blob();
				if (!name) {
					const real = realUrl(link.href);
					name = /^https?:/.test(real) ? decodeURIComponent(new URL(real).pathname.split("/").pop() || "") : "";
				}
				win.top.postMessage({ bios: "download", name: name || "download", type: blob.type, blob }, "*");
			})
			.catch(() => {});
	}

	// Middle click: open the link in a background tab.
	win.addEventListener(
		"auxclick",
		(event) => {
			if (event.button !== 1 || !event.isTrusted) return;
			const path = event.composedPath ? event.composedPath() : [event.target];
			const link = path.find(
				(el) => el && (el.localName === "a" || el.localName === "area") && typeof el.href === "string"
			);
			if (link && isSafeScheme(link.href) && openTab(link.href, true)) event.preventDefault();
		},
		true
	);

	function fixForm(form, submitter) {
		if (submitter && submitter.hasAttribute("formtarget")) {
			const fixed = fixTarget(submitter.getAttribute("formtarget"));
			if (fixed) submitter.setAttribute("formtarget", fixed);
		}
		const target = form.hasAttribute("target")
			? form.getAttribute("target")
			: baseTarget();
		const fixed = fixTarget(target);
		if (fixed) form.setAttribute("target", fixed);
	}

	win.addEventListener(
		"submit",
		(event) => {
			const form = event.target;
			if (!form || form.localName !== "form") return;
			if (!isSafeScheme(form.action)) {
				event.preventDefault();
				return;
			}
			fixForm(form, event.submitter);
		},
		true
	);

	// form.submit() does not fire a submit event.
	const formProto = win.HTMLFormElement.prototype;
	const realSubmit = formProto.submit;
	formProto.submit = function () {
		if (!isSafeScheme(this.action)) return;
		fixForm(this);
		return realSubmit.call(this);
	};

	// window.open: never create a window. Navigate the tab (or the named
	// frame) instead. Calls without a user gesture (pop-unders) are dropped.
	function navigateTo(targetWin, url) {
		let target;
		try {
			// relative to this page's real address, like window.open
			target = new URL(String(url), client.url);
		} catch {
			return false;
		}
		if (target.protocol !== "http:" && target.protocol !== "https:") return false;
		const targetClient = targetWin[SCRAMJET];
		if (!targetClient) return false;
		targetClient.url = target.href;
		return true;
	}

	function resolveTargetWindow(target) {
		const fixed = fixTarget(target == null ? "_blank" : String(target));
		if (!fixed) {
			const lower = String(target || "").toLowerCase();
			if (lower === "_parent") return win.parent;
			if (lower === "" || lower === "_self") return win;
			return findFrame(String(target)) || win;
		}
		return tabWindow();
	}

	function fakeWindow(targetWin, navigate = (url) => navigateTo(targetWin, url)) {
		const location = {
			assign: navigate,
			replace: navigate,
			reload: () => {},
			toString: () => "about:blank",
		};
		Object.defineProperty(location, "href", {
			get: () => "about:blank",
			set: navigate,
		});
		const fake = {
			closed: false,
			opener: null,
			close() {
				fake.closed = true;
			},
			focus() {},
			blur() {},
			postMessage() {},
			addEventListener() {},
			removeEventListener() {},
			document: {
				open() {},
				write() {},
				writeln() {},
				close() {},
				body: null,
			},
		};
		Object.defineProperty(fake, "location", {
			get: () => location,
			set: navigate,
		});
		fake.window = fake.self = fake;
		return fake;
	}

	// The tap in the app that opened this page (Enter in the address bar, a
	// bookmark) can carry over as "the user just tapped", so a page counts as
	// tapped only once a real input event happened in it, like in any browser.
	let touched = false;
	for (const type of ["pointerdown", "mousedown", "touchstart", "keydown"])
		win.addEventListener(
			type,
			(event) => {
				if (event.isTrusted) touched = true;
			},
			true
		);

	function userGesture() {
		const activation = win.navigator.userActivation;
		return touched && (activation ? activation.isActive : true);
	}

	const open = function (url, target) {
		if (!userGesture()) return null;
		// a new window: a new tab in the shell (or later, when the page sets
		// the blank window's location)
		if (hasShell() && opensNewWindow(target == null ? "_blank" : target)) {
			const blank = url == null || String(url).trim() === "" || url === "about:blank";
			if (!blank && (!isSafeScheme(String(url)) || !openTab(url))) return null;
			return fakeWindow(null, (next) => openTab(next));
		}
		const targetWin = resolveTargetWindow(target);
		if (url == null || String(url).trim() === "" || url === "about:blank")
			return fakeWindow(targetWin);
		if (!isSafeScheme(String(url))) return null;
		navigateTo(targetWin, url);
		return targetWin === win ? win : fakeWindow(targetWin);
	};
	Object.defineProperty(win, "open", {
		value: open,
		writable: true,
		configurable: true,
	});

	// JS dialogs.
	const quiet = (name, value) =>
		Object.defineProperty(win, name, {
			value,
			writable: true,
			configurable: true,
		});
	// confirm/prompt show the real in-app dialog right after the person
	// clicked or tapped in the page (a "Delete this?" they asked for).
	// Otherwise they answer "no", so a page can't loop dialogs or get
	// anything agreed to unseen.
	const nativeConfirm = win.confirm;
	const nativePrompt = win.prompt;
	realPrint.set(win, win.print);
	quiet("alert", function () {});
	quiet("confirm", function (message) {
		return userGesture() ? nativeConfirm.call(win, message) : false;
	});
	quiet("prompt", function (message, value) {
		return userGesture() ? nativePrompt.call(win, message, value) : null;
	});
	quiet("print", function () {});

	// Permission prompts and system sheets.
	const denied = (message = "Blocked") =>
		Promise.reject(new win.DOMException(message, "NotAllowedError"));
	const patch = (obj, name, value) => {
		if (!obj) return;
		try {
			Object.defineProperty(obj, name, {
				value,
				writable: true,
				configurable: true,
			});
		} catch {
			// non-configurable; ignore
		}
	};

	const nav = win.navigator;
	// Location, camera and microphone: the app asks the person first (its own
	// prompt, which a page can't draw or answer), then the browser's own
	// prompt follows the first time on a phone.
	if (win.Geolocation) {
		const proto = win.Geolocation.prototype;
		const realGet = proto.getCurrentPosition;
		const realWatch = proto.watchPosition;
		const realClear = proto.clearWatch;
		const geoError = (cb) =>
			typeof cb === "function" &&
			setTimeout(() =>
				cb({
					code: 1,
					message: "User denied Geolocation",
					PERMISSION_DENIED: 1,
					POSITION_UNAVAILABLE: 2,
					TIMEOUT: 3,
				})
			);
		// "Approximate": about a kilometre, as a phone's own approximate location
		const blur = (position, approximate) => {
			if (!approximate) return position;
			const c = position.coords;
			const round = (n) => Math.round(n * 100) / 100;
			const coords = {
				latitude: round(c.latitude),
				longitude: round(c.longitude),
				accuracy: Math.max(c.accuracy || 0, 1500),
				altitude: null,
				altitudeAccuracy: null,
				heading: null,
				speed: null,
			};
			return { coords: { ...coords, toJSON: () => coords }, timestamp: position.timestamp, toJSON: () => ({ coords, timestamp: position.timestamp }) };
		};
		const watches = new Map(); // our id -> the browser's, once allowed
		let nextWatch = 1;
		patch(proto, "getCurrentPosition", function (ok, err, options) {
			const geo = this;
			askApp(win, "location").then((answer) => {
				if (!answer?.allow) return geoError(err);
				realGet.call(geo, (position) => typeof ok === "function" && ok(blur(position, answer.approximate)), err, options);
			});
		});
		patch(proto, "watchPosition", function (ok, err, options) {
			const geo = this;
			const id = nextWatch++;
			watches.set(id, null);
			askApp(win, "location").then((answer) => {
				if (!watches.has(id)) return;
				if (!answer?.allow) return geoError(err);
				watches.set(id, realWatch.call(geo, (position) => typeof ok === "function" && ok(blur(position, answer.approximate)), err, options));
			});
			return id;
		});
		patch(proto, "clearWatch", function (id) {
			const real = watches.get(id);
			watches.delete(id);
			if (real != null) realClear.call(this, real);
		});
	}
	if (win.Notification) {
		patch(win.Notification, "requestPermission", (cb) => {
			if (typeof cb === "function") cb("denied");
			return Promise.resolve("denied");
		});
		try {
			Object.defineProperty(win.Notification, "permission", {
				get: () => "denied",
				configurable: true,
			});
		} catch {
			// ignore
		}
	}
	if (win.MediaDevices) {
		const realMedia = win.MediaDevices.prototype.getUserMedia;
		patch(win.MediaDevices.prototype, "getUserMedia", function (constraints) {
			const kinds = [constraints?.video && "camera", constraints?.audio && "microphone"].filter(Boolean);
			if (!kinds.length || !realMedia) return realMedia ? realMedia.call(this, constraints) : denied();
			const devices = this;
			return askApp(win, kinds.join("+")).then((answer) =>
				answer?.allow ? realMedia.call(devices, constraints) : denied("Permission denied")
			);
		});
	}
	patch(nav, "getUserMedia", (c, ok, err) => err && err(new Error("Blocked")));
	patch(nav, "webkitGetUserMedia", (c, ok, err) => err && err(new Error("Blocked")));
	patch(nav, "share", () => denied());
	patch(nav, "canShare", () => false);
	// Passkeys go to the app, which keeps them (logins.js); password and
	// other stored credentials are refused.
	passkeys(win, (kind, details) => askApp(win, kind, details), isTab(win));
	if (win.Clipboard) {
		// reading the clipboard shows iOS's "Paste" callout
		patch(win.Clipboard.prototype, "read", () => denied());
		patch(win.Clipboard.prototype, "readText", () => denied());
	}
	if (win.PaymentRequest)
		patch(win.PaymentRequest.prototype, "show", () => denied());
	if (win.Document)
		patch(win.Document.prototype, "requestStorageAccess", () => denied());
	for (const ctor of ["DeviceMotionEvent", "DeviceOrientationEvent"]) {
		if (win[ctor] && win[ctor].requestPermission)
			patch(win[ctor], "requestPermission", () => Promise.resolve("denied"));
	}

	// Long-press link/image previews.
	try {
		const style = doc.createElement("style");
		style.textContent = "*{-webkit-touch-callout:none!important}";
		(doc.head || doc.documentElement).appendChild(style);
	} catch {
		// document not ready (about:blank before write); ignore
	}
}

/**
 * Page side of the ad blocker, plus the link to the shell's address bar.
 *
 * The service worker already dropped ad/tracker requests and put this
 * page's element-hiding CSS and scriptlets into the HTML. This adds what
 * needs the live page: generic element hiding (looked up by the class names
 * and ids that actually appear), skipping ads inside video players, and
 * telling the shell which address the tab is showing.
 *
 * @param {object} client Scramjet client
 * @param {Window} win
 */
function pageShield(client, win) {
	if (win.__biosShield) return;
	Object.defineProperty(win, "__biosShield", { value: true });

	// Scramjet's worker waits for the page to confirm every cookie a response
	// sets. Browsers hold a worker's messages until the page has finished
	// parsing, and the parser may be waiting for that very response (a
	// stylesheet that sets a cookie, as Wikipedia's do): the page never
	// finishes loading. This lets the messages through at once.
	try {
		// Scramjet hides navigator.serviceWorker from pages and keeps the real one
		client.serviceWorker.startMessages();
	} catch {
		// no service worker here
	}

	const flags = pageFlags(win);
	// keep the page's own scripts from rewriting our timers
	const setTimer = win.setTimeout.bind(win);
	const setRepeat = win.setInterval.bind(win);

	// The tab's window (what a site takes for the top), for scripts of ours
	// that Scramjet doesn't rewrite (consent.js).
	let tabWin = win;
	try {
		while (parentOf(tabWin) !== tabWin && !isTab(tabWin)) tabWin = parentOf(tabWin);
	} catch {
		// cross-origin ancestor: this is as high as a page of ours goes
	}
	Object.defineProperty(win, "__biosTabWindow", { value: tabWin, configurable: true });

	function whenReady(fn) {
		if (win.document.readyState === "loading")
			win.document.addEventListener("DOMContentLoaded", fn, { once: true });
		else fn();
	}

	// The service worker borrows a connection to this origin's proxy (bare-mux's
	// shared worker) from an open page: any page of ours lends one, not only
	// an anchor frame, so the worker never waits on a page that has gone.
	// The browser's own SharedWorker and postMessage: Scramjet wraps both.
	try {
		const listen = client.natives?.store?.["EventTarget.prototype.addEventListener"];
		if (client.serviceWorker && listen)
			listen.call(client.serviceWorker, "message", (event) => {
				if (event.data?.type !== "getPort" || !event.data.port) return;
				try {
					const shared = client.natives.construct("SharedWorker", win.location.origin + "/baremux/worker.js", "bare-mux-worker");
					client.natives.call("MessagePort.prototype.postMessage", event.data.port, shared.port, [shared.port]);
				} catch {
					// another page answers
				}
			});
	} catch {
		// no service worker here
	}

	// A frame's own origin tells the app it exists, so clearing site data
	// reaches it too (the app can't work out which ones there are).
	if (FRAME_ORIGIN && !isTab(win))
		try {
			win.top.postMessage({ bios: "frame-origin" }, "*");
		} catch {
			// no app above
		}

	// Scramjet keeps the fetch it replaced; ours must reach the service
	// worker, not be sent on to the site.
	const nativeFetch = client.natives.store.fetch;
	if (flags.cosmetic && nativeFetch) hideGenericAds(client, win, nativeFetch, setTimer);
	if (flags.videoAds) skipVideoAds(win, setRepeat, whenReady);
	if (isTab(win)) reportToShell(client, win, setRepeat, whenReady);
	// A frame inside a page (with an address of its own, not about:blank,
	// which would speak for its parent): the service worker leaves it in
	// place when its own scripts send it to an ad, and counts what it blocks
	// in the frame for the tab's page.
	else if (win.parent !== win && nativeFetch && /^https?:/.test(win.location.protocol)) {
		let tabPage = "";
		try {
			let top = win;
			while (parentOf(top) !== top && !isTab(top)) top = parentOf(top);
			tabPage = top[SCRAMJET].url.href;
		} catch {
			// no page of ours up there
		}
		nativeFetch.call(win, API + "framed?top=" + encodeURIComponent(tabPage)).catch(() => {});
	}
}

/**
 * Generic element hiding: send the class names and ids on the page to the
 * service worker, which answers with the CSS for the matching filters.
 */
function hideGenericAds(client, win, nativeFetch, setTimer) {
	const doc = win.document;
	const endpoint = API + "cosmetic";
	const seenClasses = new Set();
	const seenIds = new Set();
	const seenHrefs = new Set();
	let classes = [];
	let ids = [];
	let hrefs = [];
	let timer = 0;
	let style = null;

	function note(el) {
		// a link's real address (Scramjet's getter undoes its rewriting), for
		// rules that hide links to ad networks
		if (el.localName === "a" && hrefs.length < 2000) {
			const href = el.href;
			if (href && !seenHrefs.has(href)) {
				seenHrefs.add(href);
				hrefs.push(href);
			}
		}
		const id = el.id;
		if (id && typeof id === "string" && !seenIds.has(id)) {
			seenIds.add(id);
			ids.push(id);
		}
		const list = el.classList;
		if (list)
			for (let i = 0; i < list.length; i++) {
				const name = list[i];
				if (!seenClasses.has(name)) {
					seenClasses.add(name);
					classes.push(name);
				}
			}
	}

	function scan(root) {
		if (!root || root.nodeType !== 1) return;
		note(root);
		const found = root.querySelectorAll("[id],[class],a[href]");
		for (let i = 0; i < found.length; i++) note(found[i]);
	}

	function flush() {
		timer = 0;
		if (!classes.length && !ids.length && !hrefs.length) return;
		const body = JSON.stringify({
			url: client.url.href,
			classes,
			ids,
			hrefs,
		});
		classes = [];
		ids = [];
		hrefs = [];
		nativeFetch
			.call(win, endpoint, { method: "POST", body })
			.then((res) => res.json())
			.then(({ styles }) => {
				if (!styles) return;
				if (!style || !style.isConnected) {
					style = doc.createElement("style");
					(doc.head || doc.documentElement).appendChild(style);
				}
				style.textContent += styles + "\n";
			})
			.catch(() => {});
	}

	function schedule(delay) {
		if (!timer && seenClasses.size + seenIds.size < 20000)
			timer = setTimer(flush, delay);
	}

	const start = () => {
		scan(doc.documentElement);
		flush();
		new win.MutationObserver((records) => {
			for (const record of records)
				for (const node of record.addedNodes) scan(node);
			schedule(150);
		}).observe(doc.documentElement, { childList: true, subtree: true });
	};
	if (doc.readyState === "loading")
		doc.addEventListener("DOMContentLoaded", start, { once: true });
	else start();
}

/**
 * Skips ads that play inside a site's own video player (YouTube, JW Player,
 * video.js/IMA): clicks "Skip ad" as soon as it exists, mutes ads, and jumps
 * to the end of short ad clips that can't be skipped.
 *
 * Players often reuse one <video> for the ad and the real video, so anything
 * changed during the ad is put back as soon as the ad ends. It never changes
 * the playback speed (the real video would stall at high speed), and never
 * seeks long or live videos, which may be the real video with the ad stitched in.
 */
function skipVideoAds(win, setRepeat, whenReady) {
	const SKIP_BUTTONS = [
		".ytp-ad-skip-button",
		".ytp-ad-skip-button-modern",
		".ytp-skip-ad-button",
		".ytp-ad-skip-button-slot button",
		".videoAdUiSkipButton",
		".jw-skip.jw-skippable",
		".vjs-ima-skip-button",
	].join(",");
	// Videos that are playing an ad right now.
	const AD_VIDEOS = [
		".html5-video-player.ad-showing video",
		".jw-flag-ads video",
		".vjs-ad-playing video",
	].join(",");
	const CLOSE_OVERLAYS = ".ytp-ad-overlay-close-button";
	const MAX_AD_SECONDS = 120;

	const doc = win.document;
	// video -> { muted, seeked } as it was before the ad
	const during = new Map();

	function check() {
		if (!doc.querySelector("video") && !during.size) return;
		for (const button of doc.querySelectorAll(SKIP_BUTTONS)) {
			try {
				button.click();
			} catch {
				// ignore
			}
		}
		for (const button of doc.querySelectorAll(CLOSE_OVERLAYS)) button.click();

		const ads = new Set(doc.querySelectorAll(AD_VIDEOS));
		for (const video of ads) {
			let state = during.get(video);
			if (!state) {
				state = { muted: video.muted, seeked: "" };
				during.set(video, state);
			}
			video.muted = true;
			const duration = video.duration;
			const clip = (video.currentSrc || "") + "|" + duration;
			if (
				Number.isFinite(duration) &&
				duration > 0 &&
				duration <= MAX_AD_SECONDS &&
				state.seeked !== clip &&
				video.currentTime < duration - 0.5
			) {
				// once per ad clip, so a player that resets the time isn't fought
				state.seeked = clip;
				try {
					video.currentTime = duration - 0.1;
				} catch {
					// not seekable yet
				}
			}
		}
		// The ad is over: give the video back its sound.
		for (const [video, state] of during) {
			if (ads.has(video)) continue;
			video.muted = state.muted;
			during.delete(video);
		}
	}
	whenReady(() => setRepeat(check, 250));
}

/**
 * Find in page, for the app's find bar: the browser's own text search
 * (window.find), which selects the next match and scrolls to it. The match
 * also gets a CSS highlight: the selection of a frame that doesn't have the
 * focus (the find bar has it) is drawn faint, and on phones not at all.
 * Every other match gets a fainter one, and the bar says "3 of 12".
 * ponytail: frames inside the page aren't searched; window.find can't.
 * @param {Window} win
 * @param {string} text Empty to clear the last match.
 * @param {boolean} back The match before instead of the next one.
 * @param {boolean} again Past the current match, rather than from where it began.
 * @returns {{ found: boolean, index: number, total: number }} index counts from 1
 */
function findInPage(win, text, back, again) {
	const selection = win.getSelection();
	const marks = win.CSS?.highlights;
	marks?.delete("bios-find");
	marks?.delete("bios-find-all");
	if (!text) {
		selection?.removeAllRanges();
		return { found: false, index: 0, total: 0 };
	}
	// a word still being typed matches where the shorter one did, if it can
	if (!again && selection?.rangeCount) selection.collapseToStart();
	const found = win.find(text, false, back, true);
	if (!found || !selection?.rangeCount) return { found, index: 0, total: 0 };
	const current = selection.getRangeAt(0).cloneRange();
	const { ranges, index } = allMatches(win, text, current);
	if (marks) {
		const doc = win.document;
		if (!doc.getElementById("bios-find")) {
			const style = doc.createElement("style");
			style.id = "bios-find";
			style.textContent =
				"::highlight(bios-find-all){background:#ffe9a6;color:inherit}::highlight(bios-find){background:#ffb000;color:#000}";
			(doc.head || doc.documentElement).appendChild(style);
		}
		if (ranges.length) marks.set("bios-find-all", new win.Highlight(...ranges));
		marks.set("bios-find", new win.Highlight(current));
	}
	return { found, index, total: Math.max(ranges.length, 1) };
}

/**
 * Every visible match of `text` in the page (up to 1000, ignoring case, also
 * across element boundaries as window.find matches), and which of them is
 * `current`, counting from 1.
 * @param {Window} win
 * @param {string} text
 * @param {Range} current
 */
function allMatches(win, text, current) {
	const doc = win.document;
	const root = doc.body || doc.documentElement;
	const hidden = new Map();
	const shown = (el) => {
		if (!hidden.has(el))
			hidden.set(el, el.checkVisibility ? !el.checkVisibility({ visibilityProperty: true }) : !el.getClientRects().length);
		return !hidden.get(el);
	};
	const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const el = node.parentElement;
			if (!el || /^(script|style|noscript|template|textarea|select)$/i.test(el.localName) || !shown(el))
				return win.NodeFilter.FILTER_REJECT;
			return win.NodeFilter.FILTER_ACCEPT;
		},
	});
	const nodes = [];
	let full = "";
	while (walker.nextNode() && full.length < 5_000_000) {
		nodes.push({ node: walker.currentNode, at: full.length });
		full += walker.currentNode.data;
	}
	// a position in the joined text -> [text node, offset]
	const locate = (pos) => {
		let lo = 0;
		let hi = nodes.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (nodes[mid].at <= pos) lo = mid;
			else hi = mid - 1;
		}
		return [nodes[lo].node, pos - nodes[lo].at];
	};
	const haystack = full.toLowerCase();
	const needle = text.toLowerCase();
	const ranges = [];
	let index = 0;
	for (let pos = haystack.indexOf(needle); pos !== -1 && ranges.length < 1000; pos = haystack.indexOf(needle, pos + needle.length)) {
		const range = doc.createRange();
		try {
			range.setStart(...locate(pos));
			range.setEnd(...locate(pos + needle.length - 1));
			range.setEnd(range.endContainer, range.endOffset + 1);
		} catch {
			continue;
		}
		ranges.push(range);
		if (!index && range.compareBoundaryPoints(win.Range.START_TO_START, current) >= 0) index = ranges.length;
	}
	return { ranges, index: index || ranges.length };
}

// The page's markup as the page itself sees it (Scramjet's getter undoes its
// rewriting), for the app's reader view. Capped, so a huge page can't stall it.
function readerSource(client, win) {
	const doc = win.document;
	let html = "";
	try {
		html = doc.documentElement.outerHTML;
	} catch {
		// the document is gone
	}
	return { html: html.length > 5_000_000 ? "" : html, url: client.url.href, title: String(doc.title || "") };
}

/**
 * Images for the reader view, fetched here, through the proxy and its ad
 * blocking, and handed over as data: addresses (the app loads nothing itself).
 * @param {Function} nativeFetch Scramjet's copy of the browser's fetch
 * @param {Window} win
 * @param {string[]} urls real addresses
 */
async function readerImages(nativeFetch, win, urls) {
	const MAX_BYTES = 3 * 1024 * 1024;
	const out = [];
	await Promise.all(
		urls.slice(0, 40).map(async (url) => {
			try {
				const target = new URL(url);
				if (target.protocol !== "http:" && target.protocol !== "https:") return;
				const res = await nativeFetch.call(win, win.location.origin + "/scramjet/" + encodeURIComponent(target.href));
				const type = res.headers.get("content-type") || "";
				if (!res.ok || !/^image\//i.test(type)) return;
				const blob = await res.blob();
				if (blob.size > MAX_BYTES) return;
				const data = await new Promise((resolve, reject) => {
					const reader = new win.FileReader();
					reader.onload = () => resolve(reader.result);
					reader.onerror = reject;
					reader.readAsDataURL(blob);
				});
				if (/^data:image\//i.test(data)) out.push([url, data]);
			} catch {
				// left out
			}
		})
	);
	return out;
}

/**
 * Tells the shell the tab's real address. In isolation mode the shell checks
 * that the address belongs to the site this frame's origin was created for,
 * so a page can't make the address bar show another site.
 */
function reportToShell(client, win, setRepeat, whenReady) {
	const target = shellOrigin(win);
	let last = "";
	function send() {
		let url;
		try {
			url = client.url.href;
		} catch {
			return;
		}
		const title = String(win.document.title || "");
		if (url + "\n" + title === last) return;
		last = url + "\n" + title;
		try {
			parentOf(win).postMessage({ bios: "nav", url, title }, target);
		} catch {
			// shell gone
		}
	}
	send();
	whenReady(send);
	win.addEventListener("load", send);
	setRepeat(send, 500);

	// for consent.js: what it answered on this page
	const tell = (message) => {
		try {
			parentOf(win).postMessage(message, target);
		} catch {
			// shell gone
		}
	};
	Object.defineProperty(win, "__biosReport", { value: tell, configurable: true });
	// sign-in forms, for the app's password filling (logins.js)
	watchLogins(win, tell);

	const nativeFetch = client.natives?.store?.fetch;
	win.addEventListener("message", (event) => {
		// Scramjet reports this page's own site as every message's origin, so
		// check the sender instead: only the shell is the tab's parent, and
		// the browser sets event.source.
		if (event.source !== parentOf(win)) return;
		const data = event.data;
		if (!data || data.bios !== "cmd") return;
		if (data.cmd === "back") win.history.back();
		else if (data.cmd === "forward") win.history.forward();
		else if (data.cmd === "find") {
			const text = String(data.text ?? "").slice(0, 200);
			tell({ bios: "found", text, ...findInPage(win, text, !!data.back, !!data.again) });
		} else if (data.cmd === "zoom") {
			// the page's own size, as a browser's zoom: text, boxes and images alike
			const level = Math.min(Math.max(Number(data.level) || 100, 30), 300);
			win.document.documentElement.style.zoom = level === 100 ? "" : level + "%";
		} else if (data.cmd === "print") {
			realPrint.get(win)?.call(win);
		} else if (data.cmd === "reader") {
			tell({ bios: "reader-source", ...readerSource(client, win) });
		} else if (data.cmd === "fill" && typeof data.password === "string") {
			// the login the person picked in the app, for this page's site
			fillLogin(win, String(data.username || ""), data.password);
		} else if (data.cmd === "images" && Array.isArray(data.urls) && nativeFetch) {
			readerImages(nativeFetch, win, data.urls.map(String)).then((images) => tell({ bios: "images", images }));
		}
	});
}

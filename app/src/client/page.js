// Runs in every proxied page (bundled to /bios/page.js). The service worker
// puts it in each HTML page right after Scramjet's own scripts, so Scramjet
// has already hooked the page. The server puts `self.__biosConfig = {...}`
// in front of it; the service worker sets `self.__biosPage` (this page's
// ad-blocking flags) just before it.
//
// This code is not rewritten by Scramjet: `location` here is the proxy's
// real address, and the site's address comes from the Scramjet client.

import { label } from "./label.js";
import { ONE_FONT, everyday, safer, screenAndFonts } from "./unique.js";

const SCRAMJET = Symbol.for("scramjet client global");
// The window above, as the browser has it. Not win.parent: crossParent puts
// something else there for the page's scripts, on windows of other pages'
// copies of this script too.
const parentGetter = (
	Object.getOwnPropertyDescriptor(self, "parent") ||
	Object.getOwnPropertyDescriptor(self.Window.prototype, "parent") ||
	{}
).get;
function parentOf(win) {
	return parentGetter ? parentGetter.call(win) : win.parent;
}
// The app's window, when the page is in the app.
const TOP = self.top;
// Server settings: { isolation: "<domain>" | null, auth: boolean }.
const bios = self.__biosConfig || {};
// The service worker's own endpoints (shield.js).
const API = self.location.origin + "/scramjet/__bios/";

// A form's address. Not form.action: a field named "action" takes its place.
function actionOf(form) {
	// (a document with no window of its own, as DOMParser makes, has this one's)
	const proto = (form.ownerDocument?.defaultView || self).HTMLFormElement.prototype;
	return Object.getOwnPropertyDescriptor(proto, "action").get.call(form);
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
	if (flags.safer) {
		safer(win);
		screenAndFonts(win);
		oneFont(win);
	} else if (flags.fingerprint) everyday(win);
	const client = win[SCRAMJET];
	if (!client) return lockBare(win);
	if (refusesFrame(client, win)) return;
	frameNames(client, win);
	crossParent(win);
	hearWindows(win);
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
		return !leaves(actionOf(form));
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
					// A frame showing another origin's page (site isolation):
					// the browser keeps its window shut, and Scramjet's own
					// getter throws asking it. Scripts get a stand-in, as for
					// any window of another origin, and no document.
					const client = win[SCRAMJET];
					const key = `${name}.prototype.contentWindow`;
					const inner =
						client && Object.prototype.hasOwnProperty.call(client.descriptors.store, key)
							? client.descriptors.get(key, this)
							: null;
					if (inner && !reachable(inner)) return prop === "contentWindow" ? standIn(inner) : null;
					const value = desc.get.call(this);
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
	// frames[0] or frames["name"]: a stand-in for a frame of another origin,
	// as from contentWindow (Scramjet's rewritten frames[0].postMessage reads
	// the window, which the browser refuses).
	// ponytail: window[0] itself can't be hooked, and stays the browser's own
	const framesDesc = bios.isolation && Object.getOwnPropertyDescriptor(win, "frames");
	if (framesDesc?.get && framesDesc.configurable) {
		const list = new Proxy(win, {
			get(target, key) {
				const value = target[key];
				if (typeof value === "function") return value.bind(target);
				if (typeof key !== "string" || !value || value === target || typeof value !== "object") return value;
				try {
					// a window: across origins, its window is itself
					return value.window === value ? seen(value) : value;
				} catch {
					return value;
				}
			},
		});
		Object.defineProperty(win, "frames", { ...framesDesc, get: () => list });
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
 * "Safer": all the page's text in the system's font, so measuring text set in
 * one family or another doesn't tell which fonts the device has (unique.js).
 * @param {Window} win
 */
function oneFont(win) {
	try {
		if (win.document.getElementById("bios-one-font")) return;
		const style = win.document.createElement("style");
		style.id = "bios-one-font";
		style.textContent = ONE_FONT;
		(win.document.head || win.document.documentElement).appendChild(style);
	} catch {
		// no document yet
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
			if (parentOf(w) === w) break;
			w = parentOf(w);
		}
	} catch {
		// another origin's window: the shell, or the page around a frame
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
				// the highest proxied window we can reach (the tab's, unless
				// this is a frame on an origin of its own): its name is its frame's
				let w = win;
				try {
					while (parentOf(w) !== w && parentOf(w)[SCRAMJET]) w = parentOf(w);
				} catch {
					// another origin's window above
				}
				return w.name || null;
			}
		};
		get.__bios = true;
		Object.defineProperty(client.meta, name, { get, configurable: true });
	}
}

const crossed = new WeakSet(); // windows crossParent has done

/**
 * Scramjet's stand-ins for window.parent and window.top ask each window on
 * the way up whether Scramjet runs there, which throws for a window on
 * another origin (site isolation): the shell above a tab's page, or the page
 * around a frame of another site. A page that read window.top, as embedded
 * video players do, crashed. So a window under another origin's gets a
 * `parent` its scripts can use. The tab's window says it is its own parent,
 * as a top-level page's is, and the walk up ends there. A frame gets a
 * stand-in for the page around it (see standIn).
 * @param {Window} win
 */
function crossParent(win) {
	const above = parentOf(win);
	if (above === win || crossed.has(win)) return;
	try {
		void above[SCRAMJET];
		return;
	} catch {
		// another origin's window
	}
	crossed.add(win);
	const shown = above === win.top ? win : standIn(above);
	Object.defineProperty(win, "parent", { get: () => shown, set() {}, configurable: true });
}

// --------------------------------------------------- other origins' windows
// With site isolation a page and a frame of another site inside it are on
// different origins, and the browser lets neither see into the other. That
// is the protection. What follows only keeps the ways pages talk across it
// working, because Scramjet expects every window to be one it can reach: a
// script gets a stand-in for the other window, with what a browser allows
// there (posting it a message, sending it to a new address, focus) and a
// SecurityError for the rest.

const standIns = new WeakMap(); // another origin's window -> its stand-in
// stand-in -> where the last message from its window came from: `origin`
// (the browser's word for it) and `claimed` (the site's own origin, which
// comes with each message, once it has been checked: see hearWindows)
const heard = new WeakMap();
// what Scramjet finds when it asks a stand-in for its client: nothing to see
const NO_CLIENT = Object.freeze({ descriptors: Object.freeze({ get: () => null }) });
// Scramjet's names for parent, top and location in the code it rewrites
const WRAPPED = "$scramjet__";
const refuse = () => {
	throw new DOMException("Blocked a frame from accessing a cross-origin frame.", "SecurityError");
};

/** True for a window scripts here may see into: one of this origin. */
function reachable(other) {
	try {
		void other.location.href;
		return true;
	} catch {
		return false;
	}
}

/** What scripts get for a window: the window, or its stand-in when it is another origin's. */
function seen(other) {
	return !other || other === TOP || reachable(other) ? other : standIn(other);
}

// A real tap or key press happened in this page (see noPopups).
let tapped = false;
// window -> the browser's own print(), for the app's "Print" (noPopups silences the page's)
const printers = new WeakMap();

// Questions for the app (a permission, see noPopups), by number, each with
// what to do with its answer, which comes with the app's own messages to the
// tab (reportToShell). A watch of the position keeps its number until the
// page forgets it.
const questions = new Map(); // number -> { win, answer, watch }
let asked = 0;
function askApp(win, question, answer) {
	const id = ++asked;
	questions.set(id, { win, answer, watch: !!question.watch });
	try {
		TOP.postMessage({ bios: "ask", id, ...question }, shellOrigin(win));
	} catch {
		questions.delete(id);
		setTimeout(() => answer({ code: 2, message: "Position unavailable" }));
	}
	return id;
}
function forget(win, id) {
	if (questions.get(id)?.win !== win) return;
	questions.delete(id);
	try {
		TOP.postMessage({ bios: "ask-done", id }, shellOrigin(win));
	} catch {
		// the app is gone
	}
}
function answered(win, data) {
	const question = questions.get(data.id);
	if (question?.win !== win) return;
	if (!question.watch || !data.position) questions.delete(data.id);
	question.answer(data);
}
// A position from the app as a page's script reads one.
function positionOf(given) {
	const number = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);
	const coords = {};
	for (const name of ["latitude", "longitude", "accuracy", "altitude", "altitudeAccuracy", "heading", "speed"])
		coords[name] = number(given?.[name]);
	const plain = { ...coords };
	coords.toJSON = () => plain;
	const timestamp = number(given?.timestamp) ?? Date.now();
	return { coords, timestamp, toJSON: () => ({ coords: plain, timestamp }) };
}

/**
 * Asks the app to send the tab somewhere: only it can, from a frame on an
 * origin of its own. Like a new tab, only once the person has tapped in this
 * page: a tap in the app (Go in the address bar) leaves the app "just
 * tapped" for a few seconds, which is all the app itself can check.
 */
function sendTab(url, fields) {
	const activation = self.navigator.userActivation;
	if (!tapped || (activation && !activation.isActive)) return;
	try {
		TOP.postMessage({ bios: "go", url, fields }, shellOrigin(self));
	} catch {
		// not in the app
	}
}

// The origin kept for the site at `wanted` in a frame under the origin
// labelled `under` ("" for the site's own). The service worker works it out;
// this script has no table of site names.
const kept = new Map();
function keptOrigin(wanted, under) {
	const key = under + " " + wanted;
	if (!kept.has(key))
		kept.set(
			key,
			self[SCRAMJET].natives.store.fetch
				.call(self, `${API}origin?o=${encodeURIComponent(wanted)}&under=${under}`)
				.then((res) => res.json())
				.then(
					(answer) => answer.origin || "",
					() => {
						// not known for good: the next message asks again
						kept.delete(key);
						return "";
					}
				)
		);
	return kept.get(key);
}
const labelOf = (origin) => new URL(origin).hostname.slice(0, -(String(bios.isolation).length + 1));

/**
 * The origin a message for the site at `wanted` may be delivered to (the
 * browser checks the window is on it before handing the message over), or ""
 * when the window can't be that site's, and nothing is sent.
 * ponytail: knows the pages above this one, the frames in it, and a window
 * that just wrote. A message with an origin on it for a frame beside this
 * one isn't sent; "*" goes anywhere, as it does in a browser.
 */
async function deliverTo(other, stand, wanted) {
	if (wanted === "*") return "*";
	try {
		// "/" is what postMessage means when no origin is given: the sender's own
		wanted = wanted === "/" ? self[SCRAMJET].url.origin : new URL(wanted).origin;
	} catch {
		return "";
	}
	// an answer to a window that just wrote goes back where its message came from
	const last = heard.get(stand);
	if (last && last.claimed === wanted) return last.origin;
	// a frame of this origin's page: the origin kept for that site under this one
	if (reachable(parentOf(other))) return keptOrigin(wanted, labelOf(location.origin));
	// a page above this one. The browser lists their origins, nearest first,
	// the app's last: is this one's the origin kept for the site named?
	const above = location.ancestorOrigins;
	// Firefox lists none. The tab's page is on its site's own origin, and the
	// browser drops the message if the window isn't.
	// ponytail: only the tab's page then; a page further up gets nothing
	if (!above && other === parentOf(self) && parentOf(other) === TOP) return keptOrigin(wanted, "");
	let w = parentOf(self);
	for (let k = 0; above && w !== TOP && k < above.length; k++, w = parentOf(w)) {
		if (w !== other) continue;
		let over = k + 1;
		while (above[over] === above[k]) over++;
		const under = over >= above.length - 1 ? "" : labelOf(above[over]);
		return (await keptOrigin(wanted, under)) === above[k] ? above[k] : "";
	}
	return "";
}

/**
 * What a script gets for a window of another origin.
 * @param {Window} other
 */
function standIn(other) {
	let stand = standIns.get(other);
	if (stand) return stand;
	const client = self[SCRAMJET];
	// the tab's own page: nothing above it for a page's scripts
	const tabs = () => parentOf(other) === TOP || parentOf(other) === other;

	function navigate(to, replace) {
		let url;
		try {
			url = new URL(String(to), client.url);
		} catch {
			return;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		// the tab's page: only the app can send the tab somewhere
		if (tabs()) return sendTab(url.href);
		// A frame inside this origin's page, or further in: through this
		// origin's worker, which sends it on to the origin that site has here.
		for (let w = other; w !== TOP && parentOf(w) !== w; w = parentOf(w)) {
			if (!reachable(parentOf(w))) continue;
			const hash = url.hash.slice(1);
			url.hash = "";
			const proxied =
				location.origin + "/scramjet/" + encodeURIComponent(url.href) + (hash ? "#" + encodeURIComponent(hash) : "");
			if (replace) other.location.replace(proxied);
			else other.location.href = proxied;
			return;
		}
		// any other window isn't this page's to send anywhere
	}

	// Messages arrive in the order they were sent, though working out where
	// each may go can take a moment.
	let queue = Promise.resolve();
	function post(message, options, transfer) {
		let wanted = "/";
		if (typeof options === "string") wanted = options;
		else if (options && typeof options === "object") {
			if (options.targetOrigin !== undefined) wanted = String(options.targetOrigin);
			transfer = options.transfer;
		}
		// wrapped as Scramjet wraps one, so the other side is told which site
		// it is from, with what it takes to check that (see hearWindows)
		const flags = pageFlags(self);
		const wrapped = {
			$scramjet$messagetype: "window",
			$scramjet$origin: client.url.origin,
			$scramjet$data: message,
			$bios$site: flags.site,
			$bios$under: flags.under || "",
		};
		const going = deliverTo(other, stand, wanted);
		queue = queue
			.then(() => going)
			.then((origin) => origin && other.postMessage(wrapped, origin, transfer || []))
			.catch(() => {});
	}

	const place = new Proxy(Object.create(null), {
		get(_, key) {
			if (key === "replace") return (to) => navigate(to, true);
			if (key === "assign") return (to) => navigate(to, false);
			if (typeof key === "symbol" || key === "then") return undefined;
			return refuse();
		},
		set(_, key, to) {
			if (key !== "href") refuse();
			navigate(to, false);
			return true;
		},
	});
	stand = new Proxy(Object.create(null), {
		// Scramjet takes a window it can ask this of for one of its own, and
		// leaves it alone
		has: (_, key) => key === SCRAMJET,
		get(_, key) {
			if (key === SCRAMJET) return NO_CLIENT;
			if (typeof key === "symbol" || key === "then") return undefined;
			if (key.startsWith(WRAPPED)) key = key.slice(WRAPPED.length);
			switch (key) {
				case "window":
				case "self":
				case "frames":
					return stand;
				// Scramjet's rewritten postMessage calls go through this first
				// (it marks the window with the caller's own, for its stand-in
				// of postMessage; ours takes the caller from this page)
				case "$scramjet$setrealm":
					return () => stand;
				case "parent":
					return tabs() ? stand : seen(parentOf(other));
				case "top": {
					let w = other;
					while (parentOf(w) !== TOP && parentOf(w) !== w) w = parentOf(w);
					return seen(w);
				}
				case "location":
					return place;
				case "postMessage":
					return post;
				case "closed":
					return other.closed;
				case "length":
					return other.length;
				case "opener":
				// (a browser throws for document; null is as closed, and what Scramjet's own frame code can live with)
				case "document":
					return null;
				case "focus":
				case "blur":
					return () => other[key]();
				case "close":
					return () => {};
			}
			// a frame inside it, by its place or its name (a consent script
			// finds "__tcfapiLocator" so), as a browser allows across origins
			let child;
			try {
				child = other[key];
			} catch {
				return refuse();
			}
			return child ? seen(child) : undefined;
		},
		set(_, key, value) {
			if (key !== "location" && key !== WRAPPED + "location") refuse();
			navigate(value, false);
			return true;
		},
	});
	standIns.set(other, stand);
	return stand;
}

const LABEL = /^s[a-z2-7]{25}$/;
const told = new WeakMap(); // message event -> what the page's scripts get of it

/**
 * Messages from another origin's window.
 *
 * Who sent it: Scramjet shows a page's scripts the origin the sender wrote
 * on the message, or the page's own when there is none. That is the sender's
 * word, where a browser gives its own, and pages decide by it whom to
 * believe. With site isolation the browser's word is the sender's origin in
 * this app, whose label is a hash of the site it serves (and, for a frame's
 * origin, of the origin it sits in): what a sender says of itself fits its
 * label or doesn't. What doesn't fit comes from "null", a browser's word for
 * a sender with no origin to its name.
 *
 * And the sender itself: its stand-in, so a script can answer it, or tell it
 * from a frame's contentWindow. Where the message came from is kept for the
 * answer (see deliverTo).
 * @param {Window} win
 */
function hearWindows(win) {
	const proto = win.MessageEvent?.prototype;
	const [source, origin, data] = ["source", "origin", "data"].map(
		(name) => proto && Object.getOwnPropertyDescriptor(proto, name)
	);
	if (!source?.get || !source.configurable || !origin?.get || !data?.get || !data.configurable || proto.__biosHeard)
		return;
	Object.defineProperty(proto, "__biosHeard", { value: true });

	// { data: what Scramjet reads, claimed: the sender's site origin once checked, or "" }
	const checked = (event) => {
		let seen = told.get(event);
		if (seen) return seen;
		const said = data.get.call(event);
		const from = origin.get.call(event);
		seen = { data: said, claimed: "" };
		// not a worker's or a port's (no origin), this origin's own, or the app's
		if (bios.isolation && from && from !== location.origin && from !== shellOrigin(self)) {
			const wrapped = !!said && typeof said === "object" && said.$scramjet$messagetype === "window";
			try {
				const { $scramjet$origin: says, $bios$site: site, $bios$under: under } = said;
				const { hostname, origin: claimed } = new URL(says);
				if (
					wrapped &&
					typeof site === "string" &&
					!/\s/.test(site) &&
					(under === "" || LABEL.test(under)) &&
					(hostname === site || hostname.endsWith("." + site)) &&
					label(under ? under + " " + site : site) === labelOf(from)
				)
					seen.claimed = claimed;
			} catch {
				// says nothing of itself that can be read
			}
			seen.data = {
				$scramjet$messagetype: "window",
				$scramjet$origin: seen.claimed || "null",
				$scramjet$data: wrapped ? said.$scramjet$data : said,
			};
		}
		told.set(event, seen);
		return seen;
	};

	Object.defineProperty(proto, "data", {
		...data,
		get() {
			return checked(this).data;
		},
	});
	Object.defineProperty(proto, "source", {
		...source,
		get() {
			const from = source.get.call(this);
			// a window (a worker's port isn't one), not the app's, and not one of this origin
			let other = false;
			try {
				other = !!from && from !== TOP && from.window === from && !reachable(from);
			} catch {
				// no window
			}
			if (!other) return from;
			const stand = standIn(from);
			heard.set(stand, { origin: origin.get.call(this), claimed: checked(this).claimed });
			return stand;
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
	// the app is the window above it, and the top one (a frame inside a page
	// has a page above it, on its own origin or another)
	const above = parentOf(win);
	if (above === win || above !== win.top) return false;
	// and not a page that escaped the app, with a frame in it
	try {
		return !!above.__biosShell;
	} catch {
		// another origin's: where the browser says which (not Firefox)
	}
	const origins = win.location.ancestorOrigins;
	// ponytail: without ancestorOrigins it's taken for the app; an escaped page puts itself back in the app at once
	return !origins || origins[origins.length - 1] === shellOrigin(win);
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

	// A page that hides its referrer (Referrer-Policy: no-referrer) leaves
	// the service worker no way to tell its own navigations from another
	// site's, and it takes them for another site's (shield.js, vouched). So
	// the page says where it's going as it goes: `kind` "url", "path" (a GET
	// form, whose fields replace the query) or "history".
	function goingTo(kind, url = "") {
		try {
			const controller = client.descriptors.get("ServiceWorkerContainer.prototype.controller", client.serviceWorker);
			if (controller)
				client.natives.call("ServiceWorker.prototype.postMessage", controller, {
					bios: "own",
					kind,
					url: kind === "history" ? "" : new URL(String(url), client.url).href,
				});
		} catch {
			// no service worker here, or no address
		}
	}
	// whether a link or a form aimed at `target` loads in this window
	const staysHere = (target) => !target || /^_self$/i.test(target) || target === win.name;

	// Scramjet leaves mailto: URLs unproxied, so `location.href = "mailto:..."`
	// would hand off to the Mail app. Drop navigations to other apps' schemes
	// (tel:, sms:, etc. are proxied into a harmless error page already).
	const toOtherApp = (url) => /^\s*mailto:/i.test(String(url));
	const urlAccessor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(client), "url");
	Object.defineProperty(client, "url", {
		get: urlAccessor.get,
		set(url) {
			if (toOtherApp(url)) return;
			goingTo("url", url);
			urlAccessor.set.call(this, url);
		},
		configurable: true,
	});
	const fakeLocation = client.locationProxy;
	for (const name of ["assign", "replace", "reload"]) {
		const real = fakeLocation?.[name];
		if (typeof real === "function")
			fakeLocation[name] = function (url) {
				if (name !== "reload" && toOtherApp(url)) return;
				goingTo("url", name === "reload" ? client.url.href : url);
				return real.apply(this, arguments);
			};
	}
	const steps = win.History?.prototype;
	for (const name of ["back", "forward", "go"]) {
		const real = steps?.[name];
		if (typeof real === "function")
			steps[name] = function () {
				goingTo("history");
				return real.apply(this, arguments);
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

	// A frame on an origin of its own (site isolation) can't send the tab's
	// page anywhere: that page is another origin's. A link or a form aimed at
	// it goes through the app, which checks for a click or tap as it does for
	// a new tab.
	const VIA_APP = "\u0000the app";
	const walled = () => hasShell() && !isTab(tabWindow());

	// Decide whether a link/form target would leave the current tab.
	// Returns the replacement target (VIA_APP: see above), or null when it is
	// already safe.
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
			// The page around this frame is another origin's: the tab's own,
			// or one further in, and then the link stays in this frame.
			if (walled()) return isTab(parentOf(win)) ? VIA_APP : "_self";
			return tabTargetName();
		}
		if (lower === "_top" || lower === "_blank" || lower === "_new")
			return walled() ? VIA_APP : tabTargetName();
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
			const fixed = fixTarget(target);
			if (fixed === VIA_APP) {
				event.preventDefault();
				sendTab(realUrl(link.href));
				return;
			}
			if (fixed) link.setAttribute("target", fixed);
			if (!event.defaultPrevented && staysHere(fixed || target)) goingTo("url", realUrl(link.href));
		},
		true
	);

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

	// True when the form is for the tab's page and only the app can send it
	// there (VIA_APP); the button's own target counts before the form's.
	function fixForm(form, submitter) {
		let viaApp = null;
		if (submitter && submitter.hasAttribute("formtarget")) {
			const fixed = fixTarget(submitter.getAttribute("formtarget"));
			viaApp = fixed === VIA_APP;
			if (fixed && !viaApp) submitter.setAttribute("formtarget", fixed);
		}
		const target = form.hasAttribute("target")
			? form.getAttribute("target")
			: baseTarget();
		const fixed = fixTarget(target);
		if (fixed && fixed !== VIA_APP) form.setAttribute("target", fixed);
		return viaApp ?? fixed === VIA_APP;
	}

	// The form's fields go to the app with its address; the tab's own page
	// posts them (see reportToShell), or they join the address for a GET form.
	function sendForm(form, submitter) {
		let entries;
		try {
			entries = new win.FormData(form, submitter);
		} catch {
			// older browsers take no button here
			entries = new win.FormData(form);
		}
		const fields = [];
		for (const [name, value] of entries) if (typeof value === "string") fields.push([name, value]);
		const action = realUrl(submitter?.hasAttribute("formaction") ? submitter.formAction : actionOf(form));
		const method = (submitter?.getAttribute("formmethod") || form.getAttribute("method") || "get").toLowerCase();
		if (method === "post") return sendTab(action, fields);
		try {
			const url = new URL(action);
			url.search = new URLSearchParams(fields).toString();
			sendTab(url.href);
		} catch {
			// no address to send it to
		}
	}

	// A form about to load in this window (see goingTo).
	function formGoes(form, submitter) {
		const target =
			(submitter?.hasAttribute("formtarget") && submitter.getAttribute("formtarget")) ||
			(form.hasAttribute("target") ? form.getAttribute("target") : baseTarget());
		const method = (submitter?.getAttribute("formmethod") || form.getAttribute("method") || "get").toLowerCase();
		if (method === "dialog" || !staysHere(target)) return;
		const action = realUrl(submitter?.hasAttribute("formaction") ? submitter.formAction : actionOf(form));
		goingTo(method === "post" ? "url" : "path", action);
	}

	win.addEventListener(
		"submit",
		(event) => {
			const form = event.target;
			if (!form || form.localName !== "form") return;
			if (!isSafeScheme(actionOf(form))) {
				event.preventDefault();
				return;
			}
			if (fixForm(form, event.submitter)) {
				event.preventDefault();
				sendForm(form, event.submitter);
			} else if (!event.defaultPrevented) formGoes(form, event.submitter);
		},
		true
	);

	// form.submit() does not fire a submit event.
	const formProto = win.HTMLFormElement.prototype;
	const realSubmit = formProto.submit;
	formProto.submit = function () {
		if (!isSafeScheme(actionOf(this))) return;
		if (fixForm(this)) return sendForm(this);
		formGoes(this);
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
		if (fixed === VIA_APP) return VIA_APP;
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
				if (event.isTrusted) touched = tapped = true;
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
		// the tab's page, from a frame on an origin of its own: through the app
		const viaApp =
			targetWin === VIA_APP &&
			((next) => {
				if (isSafeScheme(String(next))) sendTab(realUrl(next));
			});
		if (url == null || String(url).trim() === "" || url === "about:blank")
			return viaApp ? fakeWindow(null, viaApp) : fakeWindow(targetWin);
		if (!isSafeScheme(String(url))) return null;
		if (viaApp) {
			viaApp(url);
			return fakeWindow(null, viaApp);
		}
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
	quiet("alert", function () {});
	quiet("confirm", function (message) {
		return userGesture() ? nativeConfirm.call(win, message) : false;
	});
	quiet("prompt", function (message, value) {
		return userGesture() ? nativePrompt.call(win, message, value) : null;
	});
	// The print sheet too: after a tap in the page (its "Print" button), or
	// when the app's menu asks.
	const nativePrint = win.print;
	printers.set(win, () => nativePrint.call(win));
	quiet("print", function () {
		if (userGesture()) nativePrint.call(win);
	});

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
	// Location: the app asks the person, naming the site, and if they let it
	// the app reads the position and hands it over (asks, in reportToShell).
	// The site's own address in the proxy gets no permission at all. Only the
	// tab's own page may ask, as a browser only lets frames that were let.
	if (win.Geolocation) {
		const failed = (cb, code = 1, message = "User denied Geolocation") =>
			typeof cb === "function" &&
			setTimeout(() => cb({ code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
		const ask = (ok, err, options, watch) => {
			if (!isTab(win) || typeof ok !== "function") {
				failed(err);
				return 0;
			}
			return askApp(win, { want: "location", watch, high: !!options?.enableHighAccuracy }, (answer) => {
				if (answer.position) ok(positionOf(answer.position));
				else failed(err, answer.code || 1, answer.message || undefined);
			});
		};
		patch(win.Geolocation.prototype, "getCurrentPosition", (ok, err, options) => void ask(ok, err, options, false));
		patch(win.Geolocation.prototype, "watchPosition", (ok, err, options) => ask(ok, err, options, true));
		patch(win.Geolocation.prototype, "clearWatch", (id) => forget(win, id));
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
	// The camera and the microphone: the app asks the person first, naming
	// the site; then the page asks the browser, whose own prompt follows (a
	// stream can't be handed across). Only the tab's own page, as above.
	const media = win.MediaDevices?.prototype.getUserMedia;
	if (win.MediaDevices)
		patch(win.MediaDevices.prototype, "getUserMedia", function (constraints) {
			const want = [constraints?.video && "camera", constraints?.audio && "microphone"].filter(Boolean);
			if (!isTab(win) || typeof media !== "function" || !want.length) return denied();
			return new win.Promise((resolve, reject) =>
				askApp(win, { want: want.join(" ") }, (answer) =>
					answer.allowed ? media.call(this, constraints).then(resolve, reject) : denied().catch(reject)
				)
			);
		});
	patch(nav, "getUserMedia", (c, ok, err) => err && err(new Error("Blocked")));
	patch(nav, "webkitGetUserMedia", (c, ok, err) => err && err(new Error("Blocked")));
	patch(nav, "share", () => denied());
	patch(nav, "canShare", () => false);
	// the fonts installed on the device: a fingerprint, behind a prompt
	patch(win, "queryLocalFonts", () => denied());
	if (win.CredentialsContainer) {
		patch(win.CredentialsContainer.prototype, "get", () => denied());
		patch(win.CredentialsContainer.prototype, "create", () => denied());
	}
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

	function whenReady(fn) {
		if (win.document.readyState === "loading")
			win.document.addEventListener("DOMContentLoaded", fn, { once: true });
		else fn();
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
	let classes = [];
	let ids = [];
	let timer = 0;
	let style = null;

	function note(el) {
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
		const found = root.querySelectorAll("[id],[class]");
		for (let i = 0; i < found.length; i++) note(found[i]);
	}

	function flush() {
		timer = 0;
		if (!classes.length && !ids.length) return;
		const body = JSON.stringify({
			url: client.url.href,
			classes,
			ids,
		});
		classes = [];
		ids = [];
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

// Where text can be found: not in scripts, styles, or anything not shown.
const UNSEARCHED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "IFRAME", "OBJECT", "SVG"]);
// Elements that run on with the text around them: a match may cross them
// ("foo <b>bar</b>"), never the edge of a paragraph, a cell or the like.
const INLINE = new Set(
	"A ABBR B BDI BDO BIG CITE CODE DATA DFN EM FONT I KBD LABEL MARK Q S SAMP SMALL SPAN STRONG SUB SUP TIME TT U VAR".split(" ")
);
const MAX_MATCHES = 1000;

/**
 * Every match for `text` in the page's text, case aside, as Ranges in the
 * order they read. A match may run across elements ("foo <b>bar</b>").
 * @param {Window} win
 */
function matchesOf(win, text) {
	const doc = win.document;
	const nodes = [];
	let all = "";
	const walker = doc.createTreeWalker(doc.body || doc.documentElement, win.NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			if (!node.data) return 2;
			for (let el = node.parentElement; el; el = el.parentElement) if (UNSEARCHED.has(el.tagName.toUpperCase())) return 2;
			// shown at all (display: none has no boxes)
			return node.parentElement?.getClientRects().length ? 1 : 2;
		},
	});
	const blockOf = (node) => {
		let el = node.parentElement;
		while (el && INLINE.has(el.tagName.toUpperCase()) && el.parentElement) el = el.parentElement;
		return el;
	};
	let block = null;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		// (a line break between two blocks' text, which no search has in it)
		const here = blockOf(node);
		if (block && here !== block) all += "\n";
		block = here;
		nodes.push([all.length, node]);
		all += node.data;
	}
	// one character for one, so a match's place in `all` is its place in the page
	const fold = (s) => Array.from(s, (c) => (c.toLowerCase().length === c.length ? c.toLowerCase() : c)).join("");
	const haystack = fold(all);
	const needle = fold(text);
	// the text node a place in `all` falls in, and the place within it
	const at = (offset, end) => {
		let lo = 0;
		let hi = nodes.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (nodes[mid][0] < offset || (!end && nodes[mid][0] === offset)) lo = mid;
			else hi = mid - 1;
		}
		return [nodes[lo][1], offset - nodes[lo][0]];
	};
	const ranges = [];
	for (let i = haystack.indexOf(needle); i !== -1 && needle && ranges.length < MAX_MATCHES; i = haystack.indexOf(needle, i + needle.length)) {
		const range = doc.createRange();
		range.setStart(...at(i, false));
		range.setEnd(...at(i + needle.length, true));
		ranges.push(range);
	}
	return ranges;
}

const finding = new WeakMap(); // window -> { text, ranges, at }

/**
 * Find in page, for the app's find bar: every match in the page, counted
 * and marked, the current one selected and scrolled to. A CSS highlight shows
 * them: the selection of a frame that doesn't have the focus (the find bar
 * has it) is drawn faint, and on phones not at all.
 * ponytail: frames inside the page aren't searched.
 * @param {Window} win
 * @param {string} text Empty to clear the last search.
 * @param {boolean} back The match before instead of the next one.
 * @param {boolean} again The next (or last) match, rather than the first from where the last search was.
 * @returns {{ found: boolean, index: number, count: number }} index counts from 1
 */
function findInPage(win, text, back, again) {
	const selection = win.getSelection();
	const marks = win.CSS?.highlights;
	marks?.delete("bios-find");
	marks?.delete("bios-found");
	const last = finding.get(win);
	if (!text) {
		finding.delete(win);
		selection?.removeAllRanges();
		return { found: false, index: 0, count: 0 };
	}
	let state;
	if (again && last?.text === text && last.ranges.length) {
		state = last;
		state.at = (state.at + (back ? -1 : 1) + state.ranges.length) % state.ranges.length;
	} else {
		// (the page may have changed since: looked for again each time)
		const ranges = matchesOf(win, text);
		// a word still being typed stays where the shorter one was, if it can
		const from = last?.ranges[last.at];
		let at = from ? ranges.findIndex((range) => range.compareBoundaryPoints(win.Range.START_TO_START, from) >= 0) : 0;
		if (at === -1) at = 0;
		state = { text, ranges, at };
	}
	finding.set(win, state);
	const current = state.ranges[state.at];
	if (!current) {
		selection?.removeAllRanges();
		return { found: false, index: 0, count: 0 };
	}
	selection?.removeAllRanges();
	selection?.addRange(current.cloneRange());
	const shown = current.startContainer.parentElement;
	shown?.scrollIntoView({ block: "center", inline: "nearest" });
	if (marks) {
		const doc = win.document;
		if (!doc.getElementById("bios-find")) {
			const style = doc.createElement("style");
			style.id = "bios-find";
			style.textContent =
				"::highlight(bios-found){background:#fff1a8;color:#000}::highlight(bios-find){background:#ff9d2e;color:#000}";
			(doc.head || doc.documentElement).appendChild(style);
		}
		marks.set("bios-found", new win.Highlight(...state.ranges));
		marks.set("bios-find", new win.Highlight(current));
	}
	return { found: true, index: state.at + 1, count: state.ranges.length };
}

/**
 * Reader view, for the app's menu: the page's article alone (reader.js,
 * loaded into the page the first time it's asked for). Asked again, it goes.
 * @param {object} client The Scramjet client for this window.
 * @param {Window} win
 */
function reader(client, win) {
	const show = () => win.BiosReader?.toggle(win, client);
	if (win.BiosReader) return show();
	const script = win.document.createElement("script");
	// (the browser's own setAttribute: Scramjet's would take the address for the site's)
	client.natives.call("Element.prototype.setAttribute", script, "src", self.location.origin + "/bios/reader.js");
	script.addEventListener("load", show);
	(win.document.head || win.document.documentElement).append(script);
}

/**
 * Tells the shell the tab's real address. In isolation mode the shell checks
 * that the address belongs to the site this frame's origin was created for,
 * so a page can't make the address bar show another site.
 */
function reportToShell(client, win, setRepeat, whenReady) {
	const target = shellOrigin(win);
	// one for each page: the app tells a new page in the tab from the same
	// page changing its address
	const doc = crypto.randomUUID();
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
			parentOf(win).postMessage({ bios: "nav", url, title, doc }, target);
		} catch {
			// shell gone
		}
	}
	send();
	whenReady(send);
	win.addEventListener("load", send);
	setRepeat(send, 500);

	// Ctrl/⌘ with +, - or 0 zooms the page, as in a browser, not the whole app:
	// the app does it (the page's zoom is kept for its site).
	win.addEventListener(
		"keydown",
		(event) => {
			if (!event.isTrusted || !(event.ctrlKey || event.metaKey) || event.altKey) return;
			const step = { "=": 1, "+": 1, "-": -1, 0: 0 }[event.key];
			if (step === undefined) return;
			event.preventDefault();
			try {
				parentOf(win).postMessage({ bios: "zoom-key", step }, target);
			} catch {
				// shell gone
			}
		},
		true
	);

	win.addEventListener(
		"message",
		(event) => {
			// Scramjet reports this page's own site as every message's origin, so
			// check the sender instead: only the shell is the tab's parent, and
			// the browser sets event.source.
			if (event.source !== parentOf(win)) return;
			// The app's messages are for this script. The page's own would take
			// them for the page's (see above), and a frame can have the app
			// send one (the form below).
			event.stopImmediatePropagation();
			const data = event.data;
			if (!data || data.bios !== "cmd") return;
			if (data.cmd === "back") win.history.back();
			else if (data.cmd === "forward") win.history.forward();
			else if (data.cmd === "find") {
				const text = String(data.text ?? "").slice(0, 200);
				const found = findInPage(win, text, !!data.back, !!data.again);
				parentOf(win).postMessage({ bios: "found", text, ...found }, target);
			} else if (data.cmd === "zoom") {
				// the page's own zoom (CSS zoom): the app's chrome stays as it is
				const level = Math.min(5, Math.max(0.25, Number(data.level) || 1));
				win.document.documentElement.style.zoom = level === 1 ? "" : String(level);
			} else if (data.cmd === "print") printers.get(win)?.();
			else if (data.cmd === "reader") reader(client, win);
			else if (data.cmd === "answer") answered(win, data);
			else if (data.cmd === "post" && Array.isArray(data.fields)) {
				// A form from a frame inside this page, for the tab (a frame on
				// another origin can't post it here itself: see sendForm). This
				// page posts it, but it isn't this page's request: the service
				// worker's "cross" marks it first, so the site it reaches is
				// told another site sent it, and can't take it for its own.
				// (Marked, then posted: Safari drops a POST's fields when the
				// worker answers it with a redirect.)
				let to;
				try {
					to = new URL(String(data.url));
				} catch {
					return;
				}
				to.hash = "";
				const path = "/scramjet/" + encodeURIComponent(to.href);
				const nativeFetch = client.natives.store.fetch;
				// not marked, not sent: unmarked, it would go as this page's own
				if (!nativeFetch) return;
				nativeFetch
					.call(win, API + "cross?u=" + encodeURIComponent(path), { redirect: "manual" })
					.then(() => {
						const form = win.document.createElement("form");
						form.method = "post";
						// (Scramjet's own setAttribute would take the address for a site's)
						client.natives.call("Element.prototype.setAttribute", form, "action", path);
						for (const [name, value] of data.fields) {
							const input = win.document.createElement("input");
							input.type = "hidden";
							input.name = String(name);
							input.value = String(value);
							form.append(input);
						}
						(win.document.body || win.document.documentElement).append(form);
						win.HTMLFormElement.prototype.submit.call(form);
					})
					.catch(() => {});
			}
		},
		// before any listener of the page's
		true
	);
}

// Last, so everything above is in place: this page's own window.
hook(self);

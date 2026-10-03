// Runs in every proxied page (bundled to /bios/page.js). The service worker
// puts it in each HTML page right after Scramjet's own scripts, so Scramjet
// has already hooked the page. The server puts `self.__biosConfig = {...}`
// in front of it; the service worker sets `self.__biosPage` (this page's
// ad-blocking flags) just before it.
//
// This code is not rewritten by Scramjet: `location` here is the proxy's
// real address, and the site's address comes from the Scramjet client.

const SCRAMJET = Symbol.for("scramjet client global");
// Server settings: { isolation: "<domain>" | null, auth: boolean }.
const bios = self.__biosConfig || {};

/** @param {Window} win */
function hook(win) {
	const client = win[SCRAMJET];
	if (!client) return;
	noPopups(client, win);
	pageShield(client, win);
	hookFrames(win);
}

/**
 * Same-origin frames a page writes itself (about:blank, srcdoc) get
 * Scramjet's hooks from their parent but never load this script. Scramjet
 * hooks such a frame when the page first reaches into it, through
 * contentWindow or contentDocument; ours go on at the same moment, before
 * the page can write anything into the frame.
 * ponytail: a frame reached only through window.frames[i] is caught at its load event instead.
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
	win.addEventListener(
		"load",
		(event) => {
			if (event.target?.localName !== "iframe") return;
			try {
				hook(event.target.contentWindow);
			} catch {
				// cross-origin frame
			}
		},
		true
	);
}

hook(self);

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
 * True for the proxied page sitting directly in the shell's frame.
 * @param {Window} win
 */
function isTab(win) {
	if (win.parent === win) return false;
	try {
		return !!win.parent.__biosShell;
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
		try {
			win.top.postMessage({ bios: "open", url: target.href, background }, shellOrigin(win));
			return true;
		} catch {
			return false;
		}
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

			if (!isSafeScheme(link.href)) {
				event.preventDefault();
				return;
			}

			link.removeAttribute("download");

			const target = link.hasAttribute("target")
				? link.getAttribute("target")
				: baseTarget();
			const modified = event.ctrlKey || event.metaKey || event.shiftKey;
			if ((modified || opensNewWindow(target)) && openTab(link.href, modified)) {
				event.preventDefault();
				return;
			}
			const fixed = fixTarget(target);
			if (fixed) link.setAttribute("target", fixed);
		},
		true
	);

	// Middle click: open the link in a background tab.
	win.addEventListener(
		"auxclick",
		(event) => {
			if (event.button !== 1) return;
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

	function userGesture() {
		const activation = win.navigator.userActivation;
		return activation ? activation.isActive : true;
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
	quiet("alert", function () {});
	quiet("confirm", function () {
		return true;
	});
	quiet("prompt", function () {
		return null;
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
	if (win.Geolocation) {
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
		patch(win.Geolocation.prototype, "getCurrentPosition", (ok, err) =>
			geoError(err)
		);
		patch(win.Geolocation.prototype, "watchPosition", (ok, err) => {
			geoError(err);
			return 0;
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
	if (win.MediaDevices)
		patch(win.MediaDevices.prototype, "getUserMedia", () => denied());
	patch(nav, "getUserMedia", (c, ok, err) => err && err(new Error("Blocked")));
	patch(nav, "webkitGetUserMedia", (c, ok, err) => err && err(new Error("Blocked")));
	patch(nav, "share", () => denied());
	patch(nav, "canShare", () => false);
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

	let flags = win.__biosPage;
	if (!flags) {
		// about:blank / srcdoc frames written by their parent page
		try {
			flags = win.parent.__biosPage;
		} catch {
			// cross-origin parent
		}
	}
	flags ||= {};
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
}

/**
 * Generic element hiding: send the class names and ids on the page to the
 * service worker, which answers with the CSS for the matching filters.
 */
function hideGenericAds(client, win, nativeFetch, setTimer) {
	const doc = win.document;
	const endpoint = win.location.origin + "/scramjet/__bios/cosmetic";
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
			win.parent.postMessage({ bios: "nav", url, title }, target);
		} catch {
			// shell gone
		}
	}
	send();
	whenReady(send);
	win.addEventListener("load", send);
	setRepeat(send, 500);

	win.addEventListener("message", (event) => {
		// Scramjet reports this page's own site as every message's origin, so
		// check the sender instead: only the shell is the tab's parent, and
		// the browser sets event.source.
		if (event.source !== win.parent) return;
		const data = event.data;
		if (!data || data.bios !== "cmd") return;
		if (data.cmd === "reload") win.location.reload();
		else if (data.cmd === "back") win.history.back();
		else if (data.cmd === "forward") win.history.forward();
	});
}

// This file overwrites the stock UV config.js.
// It is loaded by the shell page, the service worker, and every proxied page.
// The server puts `self.__biosConfig = {...}` in front of it.

// Ultraviolet hides navigator.serviceWorker from pages; grab it first (this
// file runs before uv.handler.js).
const swContainer =
	typeof window !== "undefined" && window.navigator && window.navigator.serviceWorker;

self.__uv$config = {
	prefix: "/uv/service/",
	encodeUrl: Ultraviolet.codec.xor.encode,
	decodeUrl,
	handler: "/uv/uv.handler.js",
	client: "/uv/uv.client.js",
	bundle: "/uv/uv.bundle.js",
	config: "/uv/uv.config.js",
	sw: "/uv/uv.sw.js",
	// Server settings: { isolation: "<domain>" | null, auth: boolean }.
	bios: self.__biosConfig || {},
	// Called by the (patched) uv.handler.js for every hooked window.
	construct(__uv, win, type, client) {
		if (type !== "window") return;
		// The service worker asks open pages for a connection to the proxy
		// transport (bare-mux). Those messages only arrive once the page's
		// message queue is started, and in isolation mode the pages of a site
		// are the only ones that can answer.
		if (win === self && swContainer) {
			try {
				swContainer.startMessages();
			} catch {
				// ignore
			}
		}
		noPopups(__uv, win);
		pageShield(__uv, win, client);
	},
};

/**
 * Origin of the app shell. In isolation mode proxied pages live on
 * <site>.<domain> and the shell on <domain>; otherwise they share an origin.
 * @param {Window} win
 */
function shellOrigin(win) {
	const domain = self.__uv$config.bios.isolation;
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
		return !!win.parent.__uvShell;
	} catch {
		// cross-origin parent: only the shell (isolation mode)
		return true;
	}
}

/**
 * xor decode that survives browser-appended query strings and fragments.
 *
 * Encoded URLs never contain a literal "?" or "#" (encodeURIComponent escapes
 * them), so any that appear were added by the browser: a GET form submission
 * (which replaces the original query) or a #fragment.
 * @param {string} str
 */
function decodeUrl(str) {
	if (!str) return str;
	const match = /[?#]/.exec(str);
	if (!match) return Ultraviolet.codec.xor.decode(str);

	const decoded = Ultraviolet.codec.xor.decode(str.slice(0, match.index));
	const rest = str.slice(match.index);
	try {
		const url = new URL(decoded);
		const hashAt = rest.indexOf("#");
		const search = hashAt === -1 ? rest : rest.slice(0, hashAt);
		const hash = hashAt === -1 ? "" : rest.slice(hashAt);
		if (search) url.search = search;
		if (hash) url.hash = hash;
		return url.href;
	} catch {
		return decoded + rest;
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
 * @param {object} __uv The Ultraviolet instance for this window.
 * @param {Window} win The window being hooked.
 */
function noPopups(__uv, win) {
	if (win.__noPopups) return;
	win.__noPopups = true;

	// UV leaves mailto: URLs unproxied, so `location.href = "mailto:..."` would
	// hand off to the Mail app. Proxying them turns that into a harmless error
	// page inside the tab (tel:, sms:, etc. are already proxied).
	__uv.urlRegex = /^(#|about:|data:)/;

	const doc = win.document;
	const proxyPrefix = __uv.meta.origin + __uv.prefix;
	const SHELL_FRAME = "uvframe";
	const SAFE_SCHEMES = ["http:", "https:", "javascript:", "about:", "blob:"];

	function hasShell() {
		try {
			return !!win.top.__uvShell;
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
			while (w.parent !== w && !w.parent.__uvShell) w = w.parent;
		} catch {
			// cross-origin ancestor; stay where we are
		}
		return w;
	}

	function tabTargetName() {
		return hasShell() ? SHELL_FRAME : "_top";
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
	if (win === win.top && !win.__uvShell) {
		try {
			const source = __uv.sourceUrl(win.location.href);
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
				if (win.parent !== win && !win.parent.__uvShell) return null;
			} catch {
				// fall through
			}
			return tabTargetName();
		}
		if (lower === "_top" || lower === "_blank" || lower === "_new")
			return tabTargetName();
		if (target === SHELL_FRAME) return null;
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
			const fixed = fixTarget(target);
			if (fixed) link.setAttribute("target", fixed);
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
		let proxied;
		try {
			proxied = __uv.rewriteUrl(String(url));
		} catch {
			return false;
		}
		if (!proxied.startsWith(proxyPrefix) && !proxied.startsWith(__uv.prefix))
			return false;
		targetWin.location.href = proxied;
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

	function fakeWindow(targetWin) {
		const location = {
			assign: (url) => navigateTo(targetWin, url),
			replace: (url) => navigateTo(targetWin, url),
			reload: () => {},
			toString: () => "about:blank",
		};
		Object.defineProperty(location, "href", {
			get: () => "about:blank",
			set: (url) => navigateTo(targetWin, url),
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
			set: (url) => navigateTo(targetWin, url),
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
 * @param {object} __uv
 * @param {Window} win
 * @param {object} [client] UV client (for the unhooked fetch)
 */
function pageShield(__uv, win, client) {
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

	if (flags.cosmetic && client && client.fetch && client.fetch.fetch)
		hideGenericAds(win, client.fetch.fetch, setTimer);
	if (flags.videoAds) skipVideoAds(__uv, win, setRepeat, whenReady);
	if (isTab(win)) reportToShell(__uv, win, setRepeat, whenReady);
}

/**
 * Generic element hiding: send the class names and ids on the page to the
 * service worker, which answers with the CSS for the matching filters.
 */
function hideGenericAds(win, nativeFetch, setTimer) {
	const doc = win.document;
	const endpoint = win.location.origin + "/uv/__bios/cosmetic";
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
			url: win.__uv.location.href,
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
function skipVideoAds(__uv, win, setRepeat, whenReady) {
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
function reportToShell(__uv, win, setRepeat, whenReady) {
	const target = shellOrigin(win);
	let last = "";
	function send() {
		let url;
		try {
			url = __uv.location.href;
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
		if (event.source !== win.parent || event.origin !== target) return;
		const data = event.data;
		if (!data || data.bios !== "cmd") return;
		if (data.cmd === "reload") win.location.reload();
	});
}

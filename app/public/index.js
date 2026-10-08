"use strict";

// Marks this window as the shell so the no-popup layer in proxied pages
// (src/client/page.js) can find its tab's frame and never navigate the shell.
window.__biosShell = true;

// Keys match SEARCH_ENGINES in src/settings.js.
const SEARCH = {
	google: "https://www.google.com/search?q=%s",
	duckduckgo: "https://duckduckgo.com/?q=%s",
	bing: "https://www.bing.com/search?q=%s",
	brave: "https://search.brave.com/search?q=%s",
};

const config = self.__biosConfig || {};
// Isolation mode: the shell runs on ISOLATION_DOMAIN and every site on its
// own <key>.ISOLATION_DOMAIN origin, walled off from the shell and each other.
const isolated = !!config.isolation && location.hostname === config.isolation;
const port = location.port ? ":" + location.port : "";
const originFor = (key) =>
	`${location.protocol}//${key}.${config.isolation}${port}`;
const SITE_ORIGIN = config.isolation
	? new RegExp(
			"^" +
				location.protocol.replace(":", "") +
				"://(s[a-z2-7]{25})\\." +
				config.isolation.replace(/\./g, "\\.") +
				port.replace(/\W/g, "\\$&") +
				"$"
		)
	: null;

const $ = (id) => document.getElementById(id);
// not `chrome`: Chromium browsers have a global of that name
const chromeEl = $("chrome");
const framesEl = $("frames");
const homeForm = $("home-form");
const homeInput = $("home-input");
const barForm = $("bar-form");
const barInput = $("bar-input");
const siteBtn = $("site-btn");
const splitBtn = $("split-btn");
const star = $("star");
const error = $("error");
const sheet = $("sheet");
const library = $("library");
const downloadsPanel = $("downloads");
const switcher = $("switcher");
const suggestEl = $("suggest");

// The page area starts below the chrome, whose height changes with the
// bookmarks bar.
new ResizeObserver(() =>
	document.documentElement.style.setProperty("--chrome-h", chromeEl.offsetHeight + "px")
).observe(chromeEl);

// Small motions that show a tap did something. None for people who've asked
// their device for less motion.
const calm = matchMedia("(prefers-reduced-motion: reduce)");
function pulse(el, frames, duration = 250) {
	if (el && !calm.matches) el.animate(frames, { duration, easing: "ease-out" });
}
const RISE = [
	{ opacity: 0, transform: "translateY(8px)" },
	{ opacity: 1, transform: "none" },
];

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
// iPadOS calls itself a Mac, but has a touch screen
const MOBILE =
	/iPhone|iPad|iPod|Android/.test(navigator.userAgent) ||
	(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ||
	// Android tablets ask for desktop sites, with a desktop's user agent
	matchMedia("(hover: none) and (pointer: coarse)").matches;
// The desktop app's installer, offered to Windows browsers. Not inside the
// app itself, which is Chromium with no browser's brand of its own.
// ponytail: plain Chromium builds look like the app and miss the link.
const brands = navigator.userAgentData?.brands.map((b) => b.brand) || [];
const inApp = brands.length > 0 && brands.every((b) => b === "Chromium" || /not.*brand/i.test(b));
$("get-app").hidden = MOBILE || inApp || !/Windows/.test(navigator.userAgent);

for (const kbd of document.querySelectorAll(".kbd"))
	kbd.textContent = isMac ? "⌘K" : "Ctrl K";

/**
 * @param {string} input
 * @returns {string} Fully qualified URL
 */
function toUrl(input) {
	input = input.trim();
	try {
		const url = new URL(input);
		if (url.protocol === "http:" || url.protocol === "https:")
			return url.toString();
	} catch {
		// not a full URL
	}

	try {
		const url = new URL(`https://${input}`);
		if (url.hostname.includes(".") && !input.includes(" "))
			return url.toString();
	} catch {
		// not a hostname
	}

	return searchUrl(input);
}

function searchUrl(query) {
	const engine = SEARCH[settings?.search] || SEARCH.brave;
	return engine.replace("%s", encodeURIComponent(query.trim()));
}

let ready;
function ensureReady() {
	// In isolation mode each site origin sets itself up on first load.
	if (isolated) return Promise.resolve();
	ready ||= (async () => {
		await registerSW();
		await setupTransport();
	})().catch((err) => {
		ready = null;
		throw err;
	});
	return ready;
}

function displayHost(url) {
	try {
		// URL.hostname is ASCII (punycode), so look-alike letters from other
		// alphabets show up as xn--... instead of passing for a real domain.
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

// A site's "favicon": the first letter of its name on a dark square.
// (Sites' real icons would mean fetching them, and telling them.)
function markFor(url) {
	const mark = document.createElement("span");
	mark.className = "mark";
	mark.setAttribute("aria-hidden", "true");
	mark.textContent = (displayHost(url).replace(/^www\./, "")[0] || "?").toUpperCase();
	return mark;
}

function badgerMark() {
	const img = document.createElement("img");
	img.className = "mark";
	img.src = "/icons/badger.png";
	img.alt = "";
	return img;
}

function svgIcon(paths) {
	const span = document.createElement("span");
	span.className = "glyph";
	span.setAttribute("aria-hidden", "true");
	span.innerHTML = `<svg viewBox="0 0 24 24">${paths}</svg>`;
	return span;
}

// ----------------------------------------------------------- site origins

// Sites' own origins: the ones the app sent a tab to, or a tab's page
// reported from (which the app checks). Their data stays until it is cleared.
function rememberOrigin(key) {
	const keys = new Set(readList("bios:origins"));
	if (keys.has(key)) return;
	keys.add(key);
	localStorage.setItem("bios:origins", JSON.stringify([...keys]));
	// a site's own from here on, whatever asked for it before
	localStorage.setItem("bios:frames", JSON.stringify(readList("bios:frames").filter((k) => k !== key)));
}

// Origins a page asked for (see "need-anchor"): a frame's, or one a tab went
// to by itself, until its page says which site it is. A page can ask for any
// number of them, and each keeps a service worker. So only the latest stay:
// an older one that no open tab uses is wiped whole (clearOrigin).
const FRAME_ORIGINS = 40;
const wiping = new Map(); // origin -> promise, while it is being wiped
// The site of the tab each frame origin was asked for in (its key), so a
// frame in a site kept signed in stays with it (see clearAllSiteData).
function frameTabs() {
	try {
		return JSON.parse(localStorage.getItem("bios:frame-tabs") || "{}");
	} catch {
		return {};
	}
}
function rememberFrame(key, tabKey) {
	if (readList("bios:origins").includes(key)) return;
	const keys = readList("bios:frames").filter((k) => k !== key);
	keys.push(key);
	const inUse = new Set(tabs.flatMap((t) => [t.siteOrigin, ...t.frameOrigins.keys()]));
	// (never the one just asked for)
	// ponytail: a frame in a kept site's page is forgotten too, when it is old and not open
	for (let i = 0; keys.length > FRAME_ORIGINS && i < keys.length - 1; ) {
		if (inUse.has(originFor(keys[i]))) i++;
		else forgetOrigin(originFor(keys.splice(i, 1)[0]));
	}
	localStorage.setItem("bios:frames", JSON.stringify(keys));
	const was = frameTabs();
	const tabOfFrame = Object.fromEntries(keys.filter((k) => was[k]).map((k) => [k, was[k]]));
	if (tabKey && !tabOfFrame[key]) tabOfFrame[key] = tabKey;
	localStorage.setItem("bios:frame-tabs", JSON.stringify(tabOfFrame));
}
function forgetOrigin(origin) {
	anchors.get(origin)?.frame.remove();
	anchors.delete(origin);
	const done = clearOrigin(origin, true).finally(() => wiping.get(origin) === done && wiping.delete(origin));
	wiping.set(origin, done);
	return done;
}

// With a passphrase lock (see "passphrase lock" below) these live only in the
// encrypted vault, decrypted in memory.
const PRIVATE = new Set(["bios:history", "bios:bookmarks", "bios:tabs", "bios:downloads", "bios:zoom", "bios:permissions"]);
let vault = null;

function readList(name) {
	if (vault && PRIVATE.has(name)) return vault.data[name] ?? [];
	try {
		return JSON.parse(localStorage.getItem(name) || "[]");
	} catch {
		return [];
	}
}

// Scramjet's address for a site URL (src/codec.js encodeUrl).
function proxyPath(url) {
	const target = new URL(url);
	if (target.protocol !== "http:" && target.protocol !== "https:")
		throw new Error("Only http and https addresses can be opened.");
	const hash = target.hash.slice(1);
	target.hash = "";
	return (
		"/scramjet/" +
		encodeURIComponent(target.href) +
		(hash ? "#" + encodeURIComponent(hash) : "")
	);
}

async function frameUrlFor(url, tab) {
	const path = proxyPath(url);
	if (!isolated) return path;
	const key = await BiosSiteKey.siteKey(new URL(url).hostname);
	rememberOrigin(key);
	const origin = originFor(key);
	tab.siteOrigin = origin;
	await ensureAnchor(origin);
	return origin + path;
}

// A page the app loads itself (an address typed, a bookmark, reload, back)
// is the person's own request. To the site's service worker it looks just
// like a page sending its tab there without a referrer, which it takes for
// another site's (shield.js, vouched): so the app tells it first, through
// the site's anchor frame. `src`: the address the tab's frame is given.
function markTyped(src) {
	if (!isolated) return Promise.resolve();
	const url = new URL(src);
	const anchor = anchors.get(url.origin);
	if (!anchor) return Promise.resolve();
	return anchor.ready.then(
		() =>
			new Promise((resolve) => {
				const channel = new MessageChannel();
				const timer = setTimeout(resolve, 2000);
				channel.port1.onmessage = () => {
					clearTimeout(timer);
					resolve();
				};
				anchor.frame.contentWindow.postMessage({ bios: "typed", path: url.pathname + url.search }, url.origin, [
					channel.port2,
				]);
			})
	);
}

// Isolation mode: one hidden /anchor.html frame per recently used site
// origin. It registers that origin's service worker and keeps its proxy
// connection open while the site's own pages come and go.
const MAX_ANCHORS = 4;
const anchors = new Map(); // origin -> { frame, ready }

function ensureAnchor(origin) {
	let anchor = anchors.get(origin);
	if (anchor) {
		// most recently used last
		anchors.delete(origin);
		anchors.set(origin, anchor);
		return anchor.ready;
	}
	const holder = document.createElement("iframe");
	holder.hidden = true;
	holder.title = "";
	const ready = new Promise((resolve) => {
		const timer = setTimeout(resolve, 10000);
		const onMessage = (event) => {
			if (
				event.source !== holder.contentWindow ||
				event.data?.bios !== "anchor-ready"
			)
				return;
			window.removeEventListener("message", onMessage);
			clearTimeout(timer);
			if (event.data.error) console.warn("anchor:", event.data.error);
			resolve();
		};
		window.addEventListener("message", onMessage);
	});
	holder.src = origin + "/anchor.html";
	document.body.appendChild(holder);
	anchor = { frame: holder, ready };
	anchors.set(origin, anchor);

	// Drop the least recently used anchors, but never one an open tab is on,
	// or one for a frame in an open tab's page.
	const inUse = new Set(tabs.flatMap((t) => [t.siteOrigin, ...t.frameOrigins.keys()]));
	for (const [old, entry] of anchors) {
		if (anchors.size <= MAX_ANCHORS) break;
		if (old === origin || inUse.has(old)) continue;
		entry.frame.remove();
		anchors.delete(old);
	}
	return ready;
}

// -------------------------------------------------------------------- tabs

/**
 * @typedef {{ id: number, frame: HTMLIFrameElement, url: string, title: string,
 *   siteOrigin: string, loading: boolean, pending: boolean, back: string[],
 *   fwd: string[], landing: boolean, navigated: boolean, ownHistory: boolean,
 *   frameOrigins: Map<string, number>, doc: string }} Tab
 * `frameOrigins`: the origins of the frames in the tab's page (site isolation
 * gives a frame of another site its own), each with when it last asked; `doc` tells one page from the next.
 * `pending`: a restored tab whose page loads the first time it's shown.
 * `back`/`fwd`: the tab's own history (see step()). `landing`: go() started a
 * load and recorded it; the page's first report only confirms where it landed.
 */
/** @type {Tab[]} */
const tabs = [];
/** @type {Tab | null} */
let active = null;
let lastActive = null;
/** @type {[Tab, Tab] | null} the two tabs side by side in split view */
let split = null;
let nextTabId = 1;
const MAX_TABS = 50;

function createTab(url = "", { after = null, lazy = false, title = "", select = true, cross = false } = {}) {
	if (tabs.length >= MAX_TABS) return null;
	const id = nextTabId++;
	const frame = document.createElement("iframe");
	// unique per tab: page.js aims links at its own tab's name
	frame.name = `uvframe-${id}`;
	frame.title = "Page";
	// (the camera and microphone for a page the person let, through the app
	// first and then the browser's own prompt: see "permissions")
	frame.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write; camera *; microphone *";
	// Phones and tablets: the browser itself keeps a page from opening a
	// window or replacing the app (no allow-popups, no allow-top-navigation),
	// which would load a site directly, around the proxy. page.js already
	// turns new windows into tabs, but a page can reach around it.
	// ponytail: not on desktop, where a sandboxed frame can't show a PDF; the
	// desktop app refuses windows and navigations in Electron instead.
	if (MOBILE)
		frame.setAttribute(
			"sandbox",
			"allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock"
		);
	frame.hidden = true;
	framesEl.appendChild(frame);

	/** @type {Tab} */
	const tab = {
		id,
		frame,
		url: lazy ? url : "",
		title: lazy ? title : "",
		siteOrigin: "",
		loading: false,
		pending: lazy,
		back: [],
		fwd: [],
		landing: false,
		navigated: false,
		ownHistory: true,
		frameOrigins: new Map(),
		doc: "",
	};
	frame.addEventListener("load", () => {
		if (!tab.url || tab.pending) return;
		setLoading(tab, false);
		// a page without page.js (an image, a PDF) never reports itself
		tab.landing = false;
		syncAddress(tab);
		try {
			frame.contentWindow.addEventListener("pagehide", () => setLoading(tab, true));
		} catch {
			// cross-origin frame
		}
	});

	const at = after && tabs.includes(after) ? tabs.indexOf(after) + 1 : tabs.length;
	tabs.splice(at, 0, tab);
	if (select) selectTab(tab);
	else renderTabs();
	if (url && !lazy) go(url, tab, true, cross);
	else if (!url && select) {
		homeInput.focus({ preventScroll: true });
		pulse($("newtab"), RISE);
	}
	if (!lazy) pulse($("tabs").children[at], RISE);
	return tab;
}

function selectTab(tab) {
	if (active && active !== tab) lastActive = active;
	active = tab;
	if (split && !split.includes(tab)) {
		// a tab picked from the strip replaces the pane that was focused
		if (tab.url) split[Math.max(0, split.indexOf(lastActive))] = tab;
		else split = null;
	}
	if (tab.pending) {
		tab.pending = false;
		go(tab.url, tab);
	}
	error.textContent = "";
	homeInput.value = "";
	hideSuggest();
	if (!tab.url) renderNewTab();
	layout();
	renderTabs();
	showAddress();
}

function closeTab(tab) {
	const i = tabs.indexOf(tab);
	if (i === -1) return;
	if (split?.includes(tab)) split = null;
	tabs.splice(i, 1);
	tab.frame.remove();
	// what it was watching or still asking about goes with it
	stopWatching(tab);
	if (asking.some((question) => question.tab === tab)) {
		asking.splice(0, asking.length, ...asking.filter((question) => question.tab !== tab));
		showAsk();
	}
	if (lastActive === tab) lastActive = null;
	if (!tabs.length) createTab();
	else if (tab === active) selectTab(tabs[Math.min(i, tabs.length - 1)]);
	else {
		layout();
		renderTabs();
	}
}

function setLoading(tab, loading) {
	tab.loading = loading;
	if (tab === active) document.body.classList.toggle("loading", loading);
}

// Which frames show: the active tab, or both tabs in split view.
function layout() {
	if (!active) return;
	const shown = split || [active];
	for (const t of tabs) {
		t.frame.hidden = !shown.includes(t) || !t.url;
		t.frame.classList.toggle("focused", !!split && t === active);
		t.frame.style.order = split ? String(split.indexOf(t)) : "";
	}
	framesEl.classList.toggle("split", !!split);
	document.body.classList.toggle("browsing", !!active.url);
	document.body.classList.toggle("loading", active.loading);
}

function tabLabel(tab) {
	return tab.title || (tab.url ? displayHost(tab.url) : "New Tab");
}

function renderTabs() {
	$("tabs").replaceChildren(
		...tabs.map((tab) => {
			const el = document.createElement("div");
			el.className = "tab";
			el.classList.toggle("paired", !!split && split.includes(tab) && tab !== active);
			el.setAttribute("role", "tab");
			el.setAttribute("aria-selected", String(tab === active));
			el.tabIndex = tab === active ? 0 : -1;
			el.title = tabLabel(tab);
			const title = document.createElement("span");
			title.className = "tab-title";
			title.textContent = tabLabel(tab);
			const close = document.createElement("button");
			close.type = "button";
			close.className = "tab-close";
			close.setAttribute("aria-label", `Close ${tabLabel(tab)}`);
			close.innerHTML =
				'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
			close.addEventListener("click", (event) => {
				event.stopPropagation();
				closeTab(tab);
			});
			el.append(tab.url ? markFor(tab.url) : badgerMark(), title, close);
			el.addEventListener("click", () => selectTab(tab));
			el.addEventListener("keydown", (event) => {
				if (event.target !== el) return;
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					selectTab(tab);
				} else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
					const next = tabs[tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1)];
					if (next) {
						selectTab(next);
						$("tabs").querySelector('[aria-selected="true"]')?.focus();
					}
				}
			});
			// middle click closes, like any browser
			el.addEventListener("auxclick", (event) => {
				if (event.button === 1) closeTab(tab);
			});
			return el;
		})
	);
	$("tabs").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
	renderSwitcher();
	document.title = active?.url ? tabLabel(active) : "Badger";

	const canSplitNow = canSplit();
	splitBtn.disabled = !split && !canSplitNow;
	splitBtn.setAttribute("aria-pressed", String(!!split));
	splitBtn.title = split
		? "Close split view"
		: canSplitNow
			? "Show two tabs side by side"
			: "Open another page in a tab to use split view";
	saveTabs();
}

// Phones have no room for a tab strip: a button in the bottom bar shows how
// many tabs are open, and lists them.
function renderSwitcher() {
	const count = $("tab-count");
	if (count.textContent !== String(tabs.length)) {
		count.textContent = String(tabs.length);
		pulse(count, [{ transform: "scale(1.5)" }, { transform: "none" }], 350);
	}
	$("tabs-btn").setAttribute("aria-label", `Tabs: ${tabs.length} open`);
	$("tab-list").replaceChildren(
		...tabs.map((tab) => {
			const li = document.createElement("li");
			const open = document.createElement("button");
			open.type = "button";
			open.className = "link";
			if (tab === active) open.setAttribute("aria-current", "true");
			const text = document.createElement("span");
			text.className = "text";
			const title = document.createElement("span");
			title.textContent = tabLabel(tab);
			const small = document.createElement("small");
			small.textContent = tab.url ? displayHost(tab.url) : "";
			text.append(title, small);
			open.append(tab.url ? markFor(tab.url) : badgerMark(), text);
			open.addEventListener("click", () => {
				switcher.hidden = true;
				selectTab(tab);
			});
			const close = document.createElement("button");
			close.type = "button";
			close.className = "tab-close";
			close.setAttribute("aria-label", `Close ${tabLabel(tab)}`);
			close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
			close.addEventListener("click", () => closeTab(tab));
			li.append(open, close);
			return li;
		})
	);
}

$("tabs-btn").addEventListener("click", () => {
	switcher.hidden = false;
	$("tab-list").querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" });
});
$("switcher-close").addEventListener("click", () => {
	switcher.hidden = true;
});
for (const id of ["dock-new", "switcher-new"])
	$(id).addEventListener("click", () => {
		switcher.hidden = true;
		createTab();
	});

// On a phone, back, forward and the menu move to the bar at the bottom, in
// reach of a thumb; on a wider screen they go back to the toolbar.
const phone = matchMedia("(max-width: 719px)");
const dock = document.getElementById("dock");
const docked = ["back", "forward", "menu-btn"].map((id) => {
	const el = document.getElementById(id);
	return { el, home: el.parentNode, next: el.nextSibling };
});

function placeControls() {
	if (phone.matches) {
		dock.prepend(docked[0].el, docked[1].el);
		dock.append(docked[2].el);
	} else {
		for (const { el, home, next } of docked) home.insertBefore(el, next);
		switcher.hidden = true;
	}
}
phone.addEventListener("change", placeControls);
placeControls();

// Open tabs are kept on this device so they come back when the app reopens.
const TABS = "bios:tabs";

function saveTabs() {
	const open = tabs.filter((t) => t.url);
	saveEntries(TABS, {
		tabs: open.map(({ url, title }) => ({ url, title })),
		active: open.indexOf(active),
	});
}

function restoreTabs() {
	const saved = readList(TABS);
	const list = Array.isArray(saved?.tabs)
		? saved.tabs
				.filter((t) => typeof t?.url === "string" && /^https?:/.test(t.url))
				.slice(0, MAX_TABS)
		: [];
	if (!list.length) return false;
	const made = list.map((t) =>
		createTab(t.url, { lazy: true, title: String(t.title || "").slice(0, 300), select: false })
	);
	selectTab((Number.isInteger(saved.active) && made[saved.active]) || made[0]);
	return true;
}

// ------------------------------------------------------------- split view

const wide = matchMedia("(min-width: 900px)");

function canSplit() {
	return wide.matches && !!active?.url && tabs.some((t) => t !== active && t.url);
}

function toggleSplit() {
	if (split) split = null;
	else {
		if (!canSplit()) return;
		const partner = [lastActive, ...tabs].find(
			(t) => t && t !== active && t.url && tabs.includes(t)
		);
		if (partner.pending) {
			partner.pending = false;
			go(partner.url, partner);
		}
		split = [active, partner];
	}
	layout();
	renderTabs();
}

splitBtn.addEventListener("click", toggleSplit);
wide.addEventListener("change", () => {
	if (!wide.matches && split) toggleSplit();
	else renderTabs();
});

// In split view, clicking into a pane makes it the active tab. Clicks inside
// a frame never reach the shell, so watch which frame has focus.
function followPaneFocus() {
	if (!split) return;
	const tab = split.find((t) => t.frame === document.activeElement);
	if (tab && tab !== active) selectTab(tab);
}
window.addEventListener("blur", () => setTimeout(followPaneFocus, 0));

// ------------------------------------------------------------- navigation

let startup = Promise.resolve();

// `cross`: a page of another site asked for it (see crossSite).
async function go(input, tab = active, record = true, cross = false) {
	if (!input.trim() || !tab) return;
	error.textContent = "";
	hideSuggest();
	try {
		await startup;
		await ensureReady();
		const url = toUrl(input);
		// before touching the tab: throws for addresses that can't be opened
		let src = await frameUrlFor(url, tab);
		// through the service worker's "cross", which marks it (shield.js)
		if (cross)
			src = src.replace(
				/\/scramjet\/([^#]*)/,
				(_, page) => "/scramjet/__bios/cross?u=" + encodeURIComponent("/scramjet/" + page)
			);
		else await markTyped(src);
		if (!tabs.includes(tab)) return;
		if (record && tab.url && tab.url !== url && !tab.pending) {
			pushStep(tab.back, tab.url);
			tab.fwd = [];
		}
		tab.url = url;
		tab.title = "";
		tab.pending = false;
		tab.landing = true;
		tab.navigated = true;
		setLoading(tab, true);
		if (tab === active) {
			layout();
			showAddress();
		}
		renderTabs();
		tab.frame.src = src;
	} catch (err) {
		error.textContent = err.message || String(err);
	}
}

// The site address a proxied address stands for (the reverse of proxyPath), or "".
function siteUrl(href) {
	const url = BiosSiteKey.decodeUrl(href);
	if (!url) return "";
	try {
		url.hash = decodeURIComponent(new URL(href).hash.slice(1));
	} catch {
		// without its #fragment, then
	}
	return url.href;
}

function showAddress() {
	const url = active?.url || "";
	let state = "shield";
	if (url.startsWith("https:")) state = "lock";
	else if (url.startsWith("http:")) state = "warn";
	siteBtn.dataset.state = state;
	star.hidden = !url;
	$("back").disabled = !active?.back.length;
	$("forward").disabled = !active?.fwd.length;
	$("reload").disabled = !url;
	const marked = isBookmarked(url);
	star.setAttribute("aria-pressed", String(marked));
	star.setAttribute("aria-label", marked ? "Remove bookmark" : "Bookmark this page");
	if (document.activeElement === barInput) return;
	const shown = url ? displayHost(url) : "";
	if (barInput.value !== shown) barInput.value = shown;
}

const MAX_STEPS = 50;

function pushStep(list, url) {
	list.push(url);
	if (list.length > MAX_STEPS) list.shift();
}

function updateTab(tab, url, title) {
	const changed = url !== tab.url || title !== tab.title;
	if (tab.landing) {
		// go() already recorded this step; a redirect may land elsewhere
		tab.landing = false;
	} else if (url !== tab.url && tab.url) {
		// The page moved by itself: a link, or its own history.back().
		if (url === tab.back.at(-1)) {
			tab.back.pop();
			pushStep(tab.fwd, tab.url);
		} else if (url === tab.fwd.at(-1)) {
			tab.fwd.pop();
			pushStep(tab.back, tab.url);
		} else {
			pushStep(tab.back, tab.url);
			tab.fwd = [];
		}
	}
	tab.url = url;
	tab.title = title;
	if (!changed) return;
	recordVisit(tab);
	renderTabs();
	if (tab === active) showAddress();
}

// Shared mode only: the frame is same-origin, so read its address directly.
// (In isolation mode the site's anchor frame does, see the "docs" message.)
function syncAddress(tab) {
	// while a new page loads, the frame still holds the old one
	if (isolated || tab.landing) return;
	let url;
	let title = tab.title;
	try {
		const win = tab.frame.contentWindow;
		const client = win[Symbol.for("scramjet client global")];
		if (client) url = client.url.href;
		else {
			// no Scramjet in it (a JSON file, an image, a warning page): its
			// proxied address still says where it is, and it has no title
			url = siteUrl(win.location.href);
			title = "";
		}
	} catch {
		return;
	}
	if (url && url !== tab.url) updateTab(tab, url, title);
}

const tabFor = (source) => tabs.find((t) => t.frame.contentWindow === source);

// The tab a message came from: its own page, or a frame inside it.
function tabOf(source) {
	for (let w = source, depth = 0; w && depth < 20; depth++) {
		const tab = tabFor(w);
		if (tab) return tab;
		if (w.parent === w) break;
		w = w.parent;
	}
	return null;
}

// A page asked for a new window (target=_blank, window.open, Ctrl/Cmd-click,
// middle click): open a tab next to it. Only right after a real click or
// tap, and one tab per click, so a page can't open tabs by itself.
let lastOpen = 0;
function openFromPage(event) {
	const tab = tabOf(event.source);
	if (!tab || typeof event.data.url !== "string") return;
	if (isolated ? !SITE_ORIGIN.test(event.origin) : event.origin !== location.origin) return;
	if (navigator.userActivation && !navigator.userActivation.isActive) return;
	if (Date.now() - lastOpen < 400) return;
	let url;
	try {
		url = new URL(event.data.url);
	} catch {
		return;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return;
	lastOpen = Date.now();
	createTab(url.href, { after: tab, select: !event.data.background, cross: crossSite(event, tab, url) });
}

// A page asked the app to load `to` (a new tab, or the whole tab from a frame
// inside it). When the page is another site's than `to`, that site is told so,
// as a browser tells it: it then keeps back the cookies it marked for its own
// pages only, and can refuse a request another site made up. To the service
// worker a page the app loads is an address typed into the bar otherwise.
// ponytail: a frame on an origin of its own always counts as another site,
// its own included; that only keeps cookies back.
function crossSite(event, tab, to) {
	if (isolated && event.origin !== tab.siteOrigin) return true;
	try {
		return BiosSiteKey.siteOf(new URL(tab.url).hostname) !== BiosSiteKey.siteOf(to.hostname);
	} catch {
		return true;
	}
}

// A frame inside a tab's page asked for the tab itself to go somewhere (a
// link or a form aimed at the top window). With site isolation the frame is
// on another origin than the tab's page and can't send it there itself. As
// for a new tab: only right after a real click or tap in the page.
function goFromPage(event) {
	const tab = tabOf(event.source);
	const { url, fields } = event.data;
	if (!tab || typeof url !== "string") return;
	if (isolated ? !SITE_ORIGIN.test(event.origin) : event.origin !== location.origin) return;
	if (navigator.userActivation && !navigator.userActivation.isActive) return;
	if (Date.now() - lastOpen < 400) return;
	let to;
	try {
		to = new URL(url);
	} catch {
		return;
	}
	if (to.protocol !== "http:" && to.protocol !== "https:") return;
	lastOpen = Date.now();
	if (!Array.isArray(fields) || !tab.siteOrigin) return void go(to.href, tab, true, crossSite(event, tab, to));
	// a posted form: the tab's own page posts it (page.js), marked as another site's
	window.postMessage.call(
		tab.frame.contentWindow,
		{
			bios: "cmd",
			cmd: "post",
			url: to.href,
			fields: fields
				.slice(0, 500)
				.filter((pair) => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string"),
		},
		tab.siteOrigin
	);
}

async function onFrameMessage(event) {
	const data = event.data;

	// Isolation mode: a site's anchor frame passing on its service worker's
	// count of blocked requests.
	if (data?.bios === "blocked") {
		for (const [origin, anchor] of anchors)
			if (anchor.frame.contentWindow === event.source && event.origin === origin) {
				addBlocked(data.count);
				// what a frame's own origin blocked counts for the page the frame is in
				const holder = tabs.find((t) => t.frameOrigins.has(origin));
				noteBlocked(
					holder && Array.isArray(data.hosts) ? data.hosts.map((pair) => [holder.url, pair?.[1]]) : data.hosts
				);
			}
		return;
	}

	// Isolation mode: a site's anchor frame passing on a file its pages sent to save.
	if (data?.bios === "download") {
		for (const [origin, anchor] of anchors)
			if (anchor.frame.contentWindow === event.source && event.origin === origin) noteDownload(data.download);
		return;
	}

	if (data?.bios === "open") return openFromPage(event);
	if (data?.bios === "go") return goFromPage(event);

	// A page on a site origin with no proxy connection yet: the tab's own, or
	// a frame inside it, which also asks for the origin it is about to go to
	// (a frame of another site has an origin of its own). The tab keeps its
	// frames' origins in use for as long as it shows the page they are in.
	if (data?.bios === "need-anchor") {
		const tab = tabOf(event.source);
		const origin = typeof data.origin === "string" ? data.origin : event.origin;
		if (!isolated || !tab || !SITE_ORIGIN.test(event.origin) || !SITE_ORIGIN.test(origin)) return;
		if (tabFor(event.source) !== tab || origin !== event.origin) {
			// (to the end: the latest last)
			tab.frameOrigins.delete(origin);
			tab.frameOrigins.set(origin, performance.now());
			// ponytail: the latest twelve; a page with frames from more sites
			// than that may lose the oldest's proxy connection
			if (tab.frameOrigins.size > 12) tab.frameOrigins.delete(tab.frameOrigins.keys().next().value);
		}
		rememberFrame(SITE_ORIGIN.exec(origin)[1], SITE_ORIGIN.exec(tab.siteOrigin)?.[1]);
		// (not one that is on its way out)
		await wiping.get(origin);
		await ensureAnchor(origin);
		event.source.postMessage({ bios: "anchor-ready" }, event.origin);
		return;
	}

	// Isolation mode: a site's anchor frame saying where the pages of its
	// site are that can't say so themselves (a JSON file, an image, a PDF, a
	// warning page). That is only a hint: a page of that site could reach
	// into its anchor and name any tab. So the shell sends the tab's own
	// frame a one-time word, in a message the browser delivers only if the
	// frame is on the anchor's origin, and believes the address that comes
	// back with the word. It must belong to the anchor's site, as a page's
	// own report must.
	if (data?.bios === "docs") {
		const key = SITE_ORIGIN?.exec(event.origin)?.[1];
		if (!isolated || !key || anchors.get(event.origin)?.frame.contentWindow !== event.source) return;
		const here = (href) => (String(href).startsWith(event.origin + "/scramjet/") ? siteUrl(href) : "");
		if (typeof data.word === "string") {
			const tab = tabs.find((t) => t.asked?.word === data.word && t.asked.origin === event.origin);
			const url = here(data.href);
			if (!tab || !url) return;
			tab.asked = null;
			// while the shell loads a page into the tab, the old one is still there
			if (tab.loading || url === tab.url) return;
			if ((await BiosSiteKey.siteKey(new URL(url).hostname)) !== key) return;
			tab.siteOrigin = event.origin;
			updateTab(tab, url, "");
			return;
		}
		for (const doc of Array.isArray(data.docs) ? data.docs.slice(0, MAX_TABS) : []) {
			const tab = tabFor(window.frames[doc?.index]);
			if (!tab || tab.loading || tab.frame.name !== doc.name) continue;
			const url = here(doc.href);
			if (!url || url === tab.url) continue;
			tab.asked = { word: crypto.randomUUID(), origin: event.origin };
			tab.frame.contentWindow.postMessage({ bios: "where", word: tab.asked.word }, event.origin);
		}
		return;
	}

	const tab = tabFor(event.source);
	if (!tab) return;

	// the page's answer to the find bar: which match of how many
	if (data?.bios === "found") {
		if (tab !== active || findBar.hidden || data.text !== findInput.value) return;
		const [index, count] = [data.index, data.count].map((n) => (Number.isInteger(n) && n >= 0 ? n : 0));
		$("find-status").textContent = !data.text ? "" : data.found && count ? `${Math.min(index, count)} of ${count}` : "No matches";
		return;
	}

	// the location, the camera or the microphone (see "permissions")
	if (data?.bios === "ask") return askedFromPage(event);
	if (data?.bios === "ask-done") {
		if (Number.isInteger(data.id) && event.origin === (tab.siteOrigin || location.origin)) stopWatching(tab, data.id);
		return;
	}

	// Ctrl/⌘ with +, - or 0, pressed in the page
	if (data?.bios === "zoom-key") {
		if (tab === active && event.origin === (tab.siteOrigin || location.origin)) zoomBy(data.step);
		return;
	}


	if (!data || data.bios !== "nav" || typeof data.url !== "string") return;
	// (a new page's frames may ask for their origins during the waits below)
	const heard = performance.now();

	let url;
	try {
		url = new URL(data.url);
	} catch {
		return;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return;

	if (isolated) {
		// Only believe an address that belongs to the site this frame's
		// origin was created for. The browser sets event.origin, so a page
		// can't fake it.
		const match = SITE_ORIGIN.exec(event.origin);
		if (!match) return;
		if ((await BiosSiteKey.siteKey(url.hostname)) !== match[1]) {
			console.warn("Ignored address from the wrong site:", url.href);
			return;
		}
		rememberOrigin(match[1]);
		tab.siteOrigin = event.origin;
		ensureAnchor(event.origin);
	} else if (event.origin !== location.origin) {
		return;
	}

	// a new page in the tab: the frames of the one before are gone, and it
	// gets its site's zoom
	const fresh = typeof data.doc === "string" && data.doc !== tab.doc;
	if (fresh) {
		tab.doc = data.doc;
		for (const [origin, at] of tab.frameOrigins) if (at < heard) tab.frameOrigins.delete(origin);
		// the location the page before was watching, it watches no more
		stopWatching(tab);
	}
	updateTab(tab, url.href, String(data.title || "").slice(0, 300));
	if (fresh && zoomOf(url.href) !== 1) tellPage(tab, { cmd: "zoom", level: zoomOf(url.href) });
}

window.addEventListener("message", onFrameMessage);

// catches pushState/SPA navigations, and focus moving between split panes
setInterval(() => {
	followPaneFocus();
	if (active) syncAddress(active);
}, 400);

// Back and forward act on the tab's own page. In isolation mode the frame is
// cross-origin, so the page does it when the shell asks.
function tabCommand(cmd, tab = active) {
	if (!tab?.url) return;
	try {
		const win = tab.frame.contentWindow;
		if (cmd === "back") win.history.back();
		else win.history.forward();
	} catch {
		if (tab.siteOrigin)
			tab.frame.contentWindow.postMessage({ bios: "cmd", cmd }, tab.siteOrigin);
	}
}

// In isolation mode the frame is cross-origin and can't be told to reload,
// and a page that is stuck or never loaded wouldn't hear the shell ask. The
// shell loads the tab's address again instead, in place of the page that's
// there, so the tab's history gains no step.
function reload(tab = active) {
	if (!tab?.url) return;
	setLoading(tab, true);
	// one full turn, even when the page comes back at once
	if (tab === active)
		pulse($("reload").firstElementChild, [{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], 600);
	const win = tab.frame.contentWindow;
	try {
		win.location.reload();
	} catch {
		frameUrlFor(tab.url, tab)
			.then(async (src) => {
				await markTyped(src);
				const load = () => {
					tab.landing = true;
					setLoading(tab, true);
					win.location.replace(src);
				};
				if (!tab.url.includes("#")) return load();
				// the same address with a # would only scroll the page: empty the frame first
				tab.frame.addEventListener("load", load, { once: true });
				win.location.replace("about:blank");
			})
			.catch((err) => {
				setLoading(tab, false);
				error.textContent = err.message || String(err);
			});
	}
}

// Back (-1) or forward (+1). Every tab's frame shares one session history,
// so the frame's own history.back() can move whichever tab navigated last.
// With a single tab that has pages it's still right, and it brings the page
// back where it was scrolled; otherwise the shell reloads the address from
// the tab's own history.
// ponytail: with several tabs open, back reloads the page instead of restoring it.
function step(dir, tab = active) {
	if (!tab?.url) return;
	const from = dir < 0 ? tab.back : tab.fwd;
	if (!from.length) return;
	const browsing = tabs.filter((t) => t.navigated);
	if (tab.ownHistory && browsing.length === 1 && browsing[0] === tab)
		return markStep(from.at(-1)).then(() => tabCommand(dir < 0 ? "back" : "forward", tab));
	// once the shell has stepped, the frame's history no longer matches
	tab.ownHistory = false;
	const url = from.pop();
	pushStep(dir < 0 ? tab.fwd : tab.back, tab.url);
	go(url, tab, false);
}

// The page a step back or forward goes to is told it's the person's own
// step (see markTyped): it may be another site's origin, which the page
// taking the step can't speak for.
async function markStep(url) {
	if (!isolated) return;
	try {
		const origin = originFor(await BiosSiteKey.siteKey(new URL(url).hostname));
		await ensureAnchor(origin);
		await markTyped(origin + proxyPath(url));
	} catch {
		// not an address the app opens
	}
}

// A command for the page in a tab (page.js does it: the shell can't reach
// into a tab on another origin). The shell's own postMessage, applied to the
// frame: without isolation the frame's is Scramjet's stand-in, which builds
// a function from a string in the caller's window, and the shell's policy
// forbids that here.
function tellPage(tab, command) {
	if (!tab?.url) return;
	window.postMessage.call(tab.frame.contentWindow, { bios: "cmd", ...command }, tab.siteOrigin || location.origin);
}

// Find in page. The page does the looking and the counting (page.js): a
// phone's home-screen app has no find of its own.
const findBar = $("find");
const findInput = $("find-input");

// `again`: the next match (or the one before, with `back`) rather than the first
function findInPage(text, back = false, again = false) {
	$("find-status").textContent = "";
	tellPage(active, { cmd: "find", text, back, again });
}

function openFind() {
	sheet.hidden = true;
	findBar.hidden = false;
	findInput.focus();
	findInput.select();
	if (findInput.value) findInPage(findInput.value);
}

function closeFind() {
	if (findBar.hidden) return;
	findBar.hidden = true;
	findInPage("");
}

findInput.addEventListener("input", () => findInPage(findInput.value));
findInput.addEventListener("keydown", (event) => {
	if (event.key !== "Enter" || !event.shiftKey) return;
	event.preventDefault();
	findInPage(findInput.value, true, true);
});
findBar.addEventListener("submit", (event) => {
	event.preventDefault();
	findInPage(findInput.value, false, true);
});
$("find-prev").addEventListener("click", () => findInPage(findInput.value, true, true));
$("find-close").addEventListener("click", closeFind);
$("find-open").addEventListener("click", openFind);

// Zoom, kept for each site (on this device, with history and bookmarks). The
// page zooms itself (CSS zoom, page.js); the app's chrome stays as it is.
const ZOOM = "bios:zoom";
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function zoomOf(url) {
	try {
		const levels = readList(ZOOM);
		const level = levels?.[BiosSiteKey.siteOf(new URL(url).hostname)];
		return ZOOM_STEPS.includes(level) ? level : 1;
	} catch {
		return 1;
	}
}

// `step`: one step in (1) or out (-1), or back to 100% (0), for the active tab's site
function zoomBy(step) {
	if (!active?.url) return;
	const site = BiosSiteKey.siteOf(new URL(active.url).hostname);
	const now = ZOOM_STEPS.indexOf(zoomOf(active.url));
	const level = step === 0 ? 1 : ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, now + Math.sign(step)))];
	const levels = readList(ZOOM);
	const kept = levels && typeof levels === "object" && !Array.isArray(levels) ? levels : {};
	if (level === 1) delete kept[site];
	else kept[site] = level;
	saveEntries(ZOOM, kept);
	// every open tab of the site
	for (const tab of tabs)
		if (tab.url && BiosSiteKey.siteOf(new URL(tab.url).hostname) === site) tellPage(tab, { cmd: "zoom", level });
	showZoom();
}

function showZoom() {
	$("zoom-level").textContent = Math.round(zoomOf(active?.url || "") * 100) + "%";
}

$("zoom-in").addEventListener("click", () => zoomBy(1));
$("zoom-out").addEventListener("click", () => zoomBy(-1));

// Reader view (page.js and reader.js) and printing: the page does them.
function readerView() {
	sheet.hidden = true;
	tellPage(active, { cmd: "reader" });
}
function printPage() {
	sheet.hidden = true;
	tellPage(active, { cmd: "print" });
}

// Translation through Google Translate's own proxy for web pages
// (example-com.translate.goog): Google fetches the page and translates it.
// It sees the page's address and its words, as the menu says; it's only
// ever asked for this way.
function translated(url) {
	const at = new URL(url);
	if (at.hostname.endsWith(".translate.goog")) return null;
	const wanted = (navigator.language || "en").toLowerCase();
	const lang = /^zh-(tw|hk|hant)/.test(wanted) ? "zh-TW" : wanted.startsWith("zh") ? "zh-CN" : wanted.split("-")[0];
	const out = new URL(`https://${at.hostname.replace(/-/g, "--").replace(/\./g, "-")}.translate.goog${at.pathname}${at.search}`);
	for (const [name, value] of [["_x_tr_sl", "auto"], ["_x_tr_tl", lang], ["_x_tr_hl", lang]]) out.searchParams.set(name, value);
	out.hash = at.hash;
	return out.href;
}
function translatePage() {
	sheet.hidden = true;
	const to = active?.url && translated(active.url);
	if (to) go(to);
}

$("reader-open").addEventListener("click", readerView);
$("print-open").addEventListener("click", printPage);
$("translate-open").addEventListener("click", translatePage);

// ------------------------------------------------------------ permissions
// A page asking for the location, the camera or the microphone (page.js).
// The app asks the person first, naming the site from the tab's own verified
// address, and keeps the answer for the site until site data is cleared. The
// location the app reads itself and hands over: the site's address in the
// proxy never gets a permission. For the camera and the microphone the page
// then asks the browser, whose own prompt follows (a stream can't be handed
// across windows).
const PERMISSIONS = "bios:permissions";
const KINDS = new Set(["location", "camera", "microphone"]);
const asking = []; // { tab, site, kinds, answer }, the first one shown
const watching = new Map(); // "<tab id> <question id>" -> the location watch

function permissionsOf(site) {
	const kept = readList(PERMISSIONS);
	const all = kept && typeof kept === "object" && !Array.isArray(kept) ? kept : {};
	return { all, here: all[site] && typeof all[site] === "object" ? all[site] : {} };
}

function askedFromPage(event) {
	const tab = tabFor(event.source);
	const { id, want, watch, high } = event.data;
	// the tab's own page only (page.js asks for no frame inside it)
	if (!tab?.url || !Number.isInteger(id) || typeof want !== "string") return;
	if (event.origin !== (tab.siteOrigin || location.origin)) return;
	const kinds = [...new Set(want.split(" "))].filter((kind) => KINDS.has(kind));
	if (!kinds.length || (kinds.includes("location") && kinds.length > 1)) return;
	const site = BiosSiteKey.siteOf(new URL(tab.url).hostname);
	const reply = (answer) => tellPage(tab, { cmd: "answer", id, ...answer });
	const answer = (allowed) => {
		if (kinds[0] !== "location") return reply({ allowed });
		if (!allowed) return reply({ code: 1, message: "User denied Geolocation" });
		locate(tab, id, !!watch, !!high, reply);
	};
	const { here } = permissionsOf(site);
	if (kinds.every((kind) => here[kind] === "allow")) return answer(true);
	if (kinds.some((kind) => here[kind] === "deny")) return answer(false);
	asking.push({ tab, site, kinds, answer });
	if (asking.length === 1) showAsk();
}

function showAsk() {
	const question = asking[0];
	$("ask").hidden = !question;
	if (!question) return;
	$("ask-text").textContent = `${displayHost(question.tab.url)} wants to use your ${question.kinds.join(" and ")}.`;
}

function answerAsk(allowed) {
	const question = asking.shift();
	if (question) {
		const { all, here } = permissionsOf(question.site);
		for (const kind of question.kinds) here[kind] = allowed ? "allow" : "deny";
		all[question.site] = here;
		saveEntries(PERMISSIONS, all);
		// (a tab closed while it asked has no page left to answer)
		if (tabs.includes(question.tab)) question.answer(allowed);
	}
	showAsk();
	if (!sheet.hidden) renderSheet();
}

$("ask-yes").addEventListener("click", () => answerAsk(true));
$("ask-no").addEventListener("click", () => answerAsk(false));

// The app's own reading of the location, for a page the person let.
function locate(tab, id, watch, high, reply) {
	const send = ({ coords, timestamp }) => {
		const position = { timestamp };
		for (const name of ["latitude", "longitude", "accuracy", "altitude", "altitudeAccuracy", "heading", "speed"])
			position[name] = coords[name];
		reply({ position });
	};
	const fail = (err) => reply({ code: err?.code || 2, message: String(err?.message || "Position unavailable") });
	if (!navigator.geolocation) return fail();
	const options = { enableHighAccuracy: high, timeout: 30_000, maximumAge: 60_000 };
	if (!watch) return navigator.geolocation.getCurrentPosition(send, fail, options);
	stopWatching(tab, id);
	watching.set(`${tab.id} ${id}`, navigator.geolocation.watchPosition(send, fail, options));
}

// A watch the page let go of, or every watch of a tab whose page went (no `id`).
function stopWatching(tab, id) {
	for (const [key, watch] of watching)
		if (key === `${tab.id} ${id}` || (id === undefined && key.startsWith(tab.id + " "))) {
			navigator.geolocation?.clearWatch(watch);
			watching.delete(key);
		}
}

function forgetPermissions() {
	const site = currentSite();
	if (!site) return;
	const { all } = permissionsOf(site);
	delete all[site];
	saveEntries(PERMISSIONS, all);
	renderSheet();
}

$("allowed-forget").addEventListener("click", forgetPermissions);

$("back").addEventListener("click", () => step(-1));
$("forward").addEventListener("click", () => step(1));
$("reload").addEventListener("click", () => reload());
$("new-tab").addEventListener("click", () => createTab());

homeForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const value = homeInput.value;
	homeInput.blur();
	go(value);
});

barForm.addEventListener("submit", (event) => {
	event.preventDefault();
	// read before blur: blurring puts the current host back in the field
	const value = barInput.value;
	barInput.blur();
	go(value);
});

barInput.addEventListener("focus", () => {
	if (active?.url) barInput.value = active.url;
	barInput.select();
});
barInput.addEventListener("blur", showAddress);

// Cmd/Ctrl+K or +L: jump to the address bar (or the new tab's search box).
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		sheet.hidden = library.hidden = downloadsPanel.hidden = switcher.hidden = true;
		hideSuggest();
		closeFind();
		return;
	}
	if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
	// the page's zoom, not the whole app's
	const zoom = { "=": 1, "+": 1, "-": -1, 0: 0 }[event.key];
	if (zoom !== undefined && active?.url) {
		event.preventDefault();
		return zoomBy(zoom);
	}
	const key = event.key.toLowerCase();
	if (key !== "k" && key !== "l") return;
	event.preventDefault();
	(active?.url ? barInput : homeInput).focus();
});

// ---------------------------------------- address bar suggestions/commands

const COMMANDS = [
	{ name: "New tab", run: () => createTab() },
	{ name: "Close tab", run: () => closeTab(active) },
	{ name: "History", run: openHistory },
	{ name: "Settings", run: openSheet },
	{ name: "Bookmark this page", when: () => !!active?.url && !isBookmarked(active.url), run: toggleBookmark },
	{ name: "Remove bookmark", when: () => isBookmarked(active?.url), run: toggleBookmark },
	{ name: "Split view", when: () => !split && canSplit(), run: toggleSplit },
	{ name: "Close split view", when: () => !!split, run: toggleSplit },
	{ name: "Reload page", when: () => !!active?.url, run: () => reload() },
	{ name: "Find in page", when: () => !!active?.url, run: () => openFind() },
	{ name: "Reader view", when: () => !!active?.url, run: readerView },
	{ name: "Translate page", when: () => !!active?.url && !!translated(active.url), run: translatePage },
	{ name: "Print", when: () => !!active?.url, run: printPage },
	{ name: "Zoom in", when: () => !!active?.url, run: () => zoomBy(1) },
	{ name: "Zoom out", when: () => !!active?.url, run: () => zoomBy(-1) },
	{ name: "Actual size", when: () => !!active?.url && zoomOf(active.url) !== 1, run: () => zoomBy(0) },
	{ name: "Downloads", run: () => openDownloads() },
	{ name: "New identity", run: () => newIdentity() },
	// opens Settings on the button rather than wiping from a typo
	{
		name: "Clear history and site data",
		run: () => openSheet().then(() => $("wipe-now").focus()),
	},
];

const SEARCH_GLYPH = '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>';
const COMMAND_GLYPH = '<path d="M5 7l5 5-5 5M12 17h7"/>';

let suggestFor = null;
let suggestItems = [];
let suggestIndex = 0;

function suggestions(query) {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const target = toUrl(query);
	const items = [
		{
			glyph: SEARCH_GLYPH,
			label: query.trim(),
			detail: target === searchUrl(query) ? "Search" : "Go to address",
			run: () => go(query),
		},
	];
	if (q.length >= 2)
		for (const c of COMMANDS)
			if ((!c.when || c.when()) && c.name.toLowerCase().includes(q))
				items.push({ glyph: COMMAND_GLYPH, label: c.name, detail: "Command", run: c.run });
	const seen = new Set();
	const pages = [
		...readEntries(BOOKMARKS).map((e) => ({ ...e, bookmark: true })),
		...readEntries(HISTORY),
	];
	for (const page of pages) {
		if (items.length >= 8) break;
		if (seen.has(page.url)) continue;
		if (!(page.title || "").toLowerCase().includes(q) && !page.url.toLowerCase().includes(q))
			continue;
		seen.add(page.url);
		items.push({
			url: page.url,
			label: nameOf(page),
			detail: (page.bookmark ? "Bookmark · " : "") + displayHost(page.url),
			run: () => go(page.url),
		});
	}
	return items;
}

function showSuggest(input) {
	suggestFor = input;
	suggestItems = suggestions(input.value);
	suggestIndex = 0;
	// just "search for what you typed": nothing worth a list
	if (suggestItems.length < 2) return hideSuggest();
	const box = input.closest("form").getBoundingClientRect();
	suggestEl.style.left = box.left + "px";
	suggestEl.style.top = box.bottom + 6 + "px";
	suggestEl.style.width = box.width + "px";
	suggestEl.replaceChildren(
		...suggestItems.map((item, i) => {
			const li = document.createElement("li");
			li.id = `suggest-${i}`;
			li.setAttribute("role", "option");
			const label = document.createElement("span");
			label.className = "label";
			label.textContent = item.label;
			const detail = document.createElement("span");
			detail.className = "detail";
			detail.textContent = item.detail;
			li.append(item.url ? markFor(item.url) : svgIcon(item.glyph), label, detail);
			// mousedown: before the input's blur hides the list
			li.addEventListener("mousedown", (event) => {
				event.preventDefault();
				pickSuggestion(i);
			});
			return li;
		})
	);
	suggestEl.hidden = false;
	input.setAttribute("aria-expanded", "true");
	markSuggestion();
}

function markSuggestion() {
	suggestEl.querySelectorAll("li").forEach((li, i) =>
		li.setAttribute("aria-selected", String(i === suggestIndex))
	);
	suggestFor?.setAttribute("aria-activedescendant", `suggest-${suggestIndex}`);
}

function hideSuggest() {
	suggestEl.hidden = true;
	suggestItems = [];
	suggestFor?.setAttribute("aria-expanded", "false");
	suggestFor?.removeAttribute("aria-activedescendant");
}

function pickSuggestion(i) {
	const item = suggestItems[i];
	const input = suggestFor;
	hideSuggest();
	input?.blur();
	item?.run();
}

for (const input of [barInput, homeInput]) {
	input.setAttribute("role", "combobox");
	input.setAttribute("aria-autocomplete", "list");
	input.setAttribute("aria-controls", "suggest");
	input.setAttribute("aria-expanded", "false");
	input.addEventListener("input", () => showSuggest(input));
	input.addEventListener("keydown", (event) => {
		if (suggestEl.hidden || suggestFor !== input) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			suggestIndex = (suggestIndex + step + suggestItems.length) % suggestItems.length;
			markSuggestion();
		} else if (event.key === "Enter" && suggestIndex > 0) {
			// the first item is a plain search/go, which the form handles
			event.preventDefault();
			pickSuggestion(suggestIndex);
		}
	});
	input.addEventListener("blur", () => setTimeout(() => suggestFor === input && hideSuggest(), 150));
}
window.addEventListener("resize", hideSuggest);

// --------------------------------------------------------------- settings

let settings = null;

async function loadSettings() {
	const res = await fetch("/api/settings", { cache: "no-store" });
	if (res.status === 401) location.replace("/login");
	if (!res.ok) throw new Error(`Couldn't load settings (${res.status})`);
	settings = await res.json();
	return settings;
}

async function saveSettings(next) {
	const res = await fetch("/api/settings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(next),
	});
	if (!res.ok) throw new Error(`Couldn't save settings (${res.status})`);
	settings = await res.json();
	renderSheet();
}

function currentSite() {
	const host = active?.url && displayHost(active.url);
	return host ? BiosSiteKey.siteOf(host) : "";
}

function timeAgo(ms) {
	const minutes = Math.round((Date.now() - ms) / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.round(hours / 24)} days ago`;
}

function renderSheet() {
	if (!settings) return;
	const site = currentSite();
	$("sheet-site").textContent = site ? displayHost(active.url) : "Settings";

	const trust = $("sheet-trust");
	if (!site) trust.textContent = "";
	else if (active.url.startsWith("http:"))
		trust.textContent = "Not secure: this connection isn't encrypted.";
	else if (isolated)
		trust.textContent =
			"Address verified. This site runs walled off from other sites.";
	else trust.textContent = "Encrypted connection.";

	$("site-row").hidden = $("scripts-row").hidden = $("page-tools").hidden = $("zoom-row").hidden = !site;
	$("translate-open").hidden = !site || !translated(active.url);
	showZoom();
	// what the person said to the site's asking (see "permissions")
	const said = Object.entries(site ? permissionsOf(site).here : {}).filter(([kind]) => KINDS.has(kind));
	$("allowed-row").hidden = !said.length;
	$("allowed-text").textContent = said
		.map(([kind, answer]) => `${kind[0].toUpperCase() + kind.slice(1)} ${answer === "allow" ? "allowed" : "not allowed"}`)
		.join(" · ");
	// only with isolation does a site have storage of its own to keep
	$("keep-row").hidden = !site || !isolated;
	$("site-toggle").checked = !settings.allow.includes(site);
	$("scripts-toggle").checked = !settings.noScripts.includes(site);
	$("keep-toggle").checked = settings.keep.includes(site);
	renderBlocked();

	for (const input of sheet.querySelectorAll("[data-setting]"))
		input.checked = !!settings[input.dataset.setting];
	$("search-engine").value = settings.search;
	$("security-level").value = settings.level;
	$("level-note").textContent = LEVEL_NOTES[settings.level] || "";

	$("lock-form").hidden = !config.auth;

	const iso = $("isolation-status");
	if (isolated)
		iso.textContent =
			"Site isolation is on: each site gets its own separate space.";
	else if (config.isolation)
		iso.textContent = `Site isolation is off at this address. Open https://${config.isolation} and add that to your home screen instead.`;
	else
		iso.textContent =
			"Site isolation is off: all sites share one space, so a malicious site could read data from others. Set ISOLATION_DOMAIN on the server to turn it on.";
}

// The certificate of the site in the active tab, as the server sees it (the
// app's own connection, on the device, checks the one it gets itself).
async function showCertificate() {
	const box = $("cert");
	box.hidden = true;
	if (!active?.url?.startsWith("https:")) return;
	const url = new URL(active.url);
	let cert = null;
	try {
		const res = await fetch("/api/cert", {
			cache: "no-store",
			headers: { "x-bios-host": url.hostname, "x-bios-https": url.port || "443" },
		});
		cert = (await res.json()).cert;
	} catch {
		// no answer: nothing to show
	}
	if (!cert || sheet.hidden || active?.url !== url.href) return;
	const day = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
	$("cert-summary").textContent =
		`Certificate: issued to ${cert.subject} by ${cert.issuer || "an unknown issuer"}, valid until ${day(cert.validTo)}` +
		(cert.revoked ? ". Revoked." : "");
	const rows = [
		["Issued to", [cert.subject, cert.organization].filter(Boolean).join(", ")],
		["For", cert.names.join(", ")],
		["Issued by", cert.issuer],
		["Valid", `${day(cert.validFrom)} to ${day(cert.validTo)}`],
		[
			"Revoked",
			cert.revoked === true
				? "Yes, by its issuer"
				: cert.revoked === false
					? "No (checked on the issuer's list)"
					: "Not checked: no revocation list to look in",
		],
		["SHA-256", cert.fingerprint],
		["Serial", cert.serial],
	];
	if (!cert.trusted) rows.unshift(["Problem", cert.problem || "not trusted"]);
	$("cert-details").replaceChildren(
		...rows.flatMap(([name, value]) => {
			const dt = document.createElement("dt");
			dt.textContent = name;
			const dd = document.createElement("dd");
			dd.textContent = value || "—";
			return [dt, dd];
		})
	);
	box.hidden = false;
}

async function openSheet() {
	library.hidden = true;
	sheet.hidden = false;
	renderSheet();
	showCertificate();
	fetch("/filters/status", { cache: "no-store" })
		.then((res) => res.json())
		.then((status) => {
			$("filter-status").textContent = status.updatedAt
				? `Block lists updated ${timeAgo(status.updatedAt)}: ${(
						status.networkFilters + status.cosmeticFilters
					).toLocaleString()} ad rules, ${(
						(status.phishing || 0) + (status.malware || 0)
					).toLocaleString()} dangerous sites.`
				: "Block lists are still downloading. Ads aren't blocked until they finish.";
		})
		.catch(() => {});
	try {
		await loadSettings();
		renderSheet();
	} catch (err) {
		$("filter-status").textContent = err.message;
	}
}

siteBtn.addEventListener("click", openSheet);
$("menu-btn").addEventListener("click", openSheet);
$("sheet-close").addEventListener("click", () => {
	sheet.hidden = true;
});
for (const panel of [sheet, library, downloadsPanel, switcher])
	panel.addEventListener("click", (event) => {
		if (event.target === panel) panel.hidden = true;
	});

for (const input of sheet.querySelectorAll("[data-setting]")) {
	input.addEventListener("change", async () => {
		try {
			await saveSettings({
				...settings,
				[input.dataset.setting]: input.checked,
			});
			if (input.dataset.setting !== "wipe") reload();
		} catch (err) {
			input.checked = !input.checked;
			$("filter-status").textContent = err.message;
		}
	});
}

const LEVEL_NOTES = {
	standard: "Every site works as usual",
	safer: "No web fonts, WebGL or WebGPU on any site, no scripts on sites without https, and sites learn less about this device: they see English, and times in UTC. Some sites look or work worse.",
	safest: "Everything in Safer, and no site's own scripts at all. Many sites stop working: menus, videos, sign-ins.",
};

const levelSelect = $("security-level");
levelSelect.addEventListener("change", async () => {
	try {
		await saveSettings({ ...settings, level: levelSelect.value });
		reload();
	} catch (err) {
		levelSelect.value = settings.level;
		$("filter-status").textContent = err.message;
	}
});

const searchSelect = $("search-engine");
searchSelect.addEventListener("change", async () => {
	try {
		await saveSettings({ ...settings, search: searchSelect.value });
	} catch (err) {
		searchSelect.value = settings.search;
		$("filter-status").textContent = err.message;
	}
});

// The switches for the site in the active tab. Each is a list of sites in
// the settings; `on` says which way a listed site's switch shows.
for (const [id, list, on] of [
	["site-toggle", "allow", false],
	["scripts-toggle", "noScripts", false],
	["keep-toggle", "keep", true],
])
	$(id).addEventListener("change", async (event) => {
		const site = currentSite();
		if (!site) return;
		const sites = new Set(settings[list]);
		if (event.target.checked === on) sites.add(site);
		else sites.delete(site);
		try {
			await saveSettings({ ...settings, [list]: [...sites] });
			// staying signed in changes nothing on the page
			if (list !== "keep") reload();
		} catch (err) {
			event.target.checked = !event.target.checked;
			$("filter-status").textContent = err.message;
		}
	});

// ------------------------------------------------------------------ wiping

async function clearStorageHere() {
	const keep = (key) => key.startsWith("bios:") || key === "bare-mux-path";
	for (const key of Object.keys(localStorage))
		if (!keep(key)) localStorage.removeItem(key);
	for (const key of Object.keys(sessionStorage))
		if (!keep(key)) sessionStorage.removeItem(key);
	const names = (
		indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name) : []
	).filter((name) => name !== "$scramjet");
	await clearProxyCookies();
	await Promise.all(
		names.map(
			(name) =>
				new Promise((resolve) => {
					const req = indexedDB.deleteDatabase(name);
					req.onsuccess = req.onerror = req.onblocked = resolve;
				})
		)
	);
	for (const name of await caches.keys())
		if (name !== "bios-filters") await caches.delete(name);
}

// `whole`: nothing of the origin is left, its service worker neither (an
// origin a page asked for; a site's own keeps its worker).
function clearOrigin(origin, whole = false) {
	return new Promise((resolve) => {
		const wiper = document.createElement("iframe");
		wiper.hidden = true;
		const done = () => {
			window.removeEventListener("message", onMessage);
			clearTimeout(timer);
			wiper.remove();
			resolve();
		};
		const onMessage = (event) => {
			if (event.source !== wiper.contentWindow || event.origin !== origin) return;
			// the page wipes when the app says so, and nobody else
			if (event.data?.bios === "wipe-ready") wiper.contentWindow.postMessage({ bios: "wipe", whole }, origin);
			else if (event.data?.bios === "wiped") done();
		};
		const timer = setTimeout(done, 8000);
		window.addEventListener("message", onMessage);
		wiper.src = origin + "/wipe.html";
		document.body.appendChild(wiper);
	});
}

// Deletes every site's cookies, storage and logins, the history and the open
// tabs. Every tab closes first so no page holds its databases open. The sites
// the person chose to stay signed in to keep their cookies and storage (not
// their history), unless `everything` goes.
async function clearAllSiteData(everything = false) {
	saveEntries(HISTORY, []);
	saveEntries(DOWNLOADS, []);
	// what sites were let use, with their data
	saveEntries(PERMISSIONS, {});
	// New identity: the zoom kept for each site too, which names sites visited
	if (everything) saveEntries(ZOOM, {});
	split = null;
	for (const tab of [...tabs]) closeTab(tab);
	saveEntries(TABS, []);
	// let the closed pages release their databases first
	await new Promise((resolve) => setTimeout(resolve, 50));
	await clearStorageHere();
	if (config.isolation) {
		const keys = readList("bios:origins").filter((key) => /^s[a-z2-7]{25}$/.test(key));
		const kept = new Set(
			everything ? [] : await Promise.all((settings?.keep || []).map((site) => BiosSiteKey.siteKey(site)))
		);
		// a few at a time: each is a frame that loads a page
		const stale = keys.filter((key) => !kept.has(key));
		for (let i = 0; i < stale.length; i += 6)
			await Promise.all(stale.slice(i, i + 6).map((key) => clearOrigin(originFor(key))));
		localStorage.setItem("bios:origins", JSON.stringify(keys.filter((key) => kept.has(key))));
		// and the origins pages asked for (frames'), whole, but for the frames
		// in a kept site's pages
		const tabOfFrame = frameTabs();
		const frames = readList("bios:frames").filter((key) => /^s[a-z2-7]{25}$/.test(key));
		const keptFrames = frames.filter((key) => kept.has(tabOfFrame[key]));
		const gone = frames.filter((key) => !kept.has(tabOfFrame[key]));
		for (let i = 0; i < gone.length; i += 6)
			await Promise.all(gone.slice(i, i + 6).map((key) => forgetOrigin(originFor(key))));
		localStorage.setItem("bios:frames", JSON.stringify(keptFrames));
		localStorage.setItem(
			"bios:frame-tabs",
			JSON.stringify(Object.fromEntries(keptFrames.map((key) => [key, tabOfFrame[key]])))
		);
	}
	renderNewTab();
}

// New Identity, as in Tor Browser: a fresh start that sites can't link to
// the last one. Every site's cookies, storage and logins, the history and
// the open tabs go, the service workers forget the warnings clicked
// through, and the app reloads. Settings and bookmarks stay.
async function newIdentity() {
	if (
		!confirm(
			"New identity: close every tab and sign out of every site?\n\nHistory and site data are cleared. Bookmarks and settings stay."
		)
	)
		return;
	await clearAllSiteData(true);
	location.reload();
}

$("new-identity").addEventListener("click", () => newIdentity());

$("wipe-now").addEventListener("click", async (event) => {
	const button = event.currentTarget;
	button.disabled = true;
	button.textContent = "Clearing…";
	try {
		await clearAllSiteData();
		button.textContent = "Cleared";
	} catch (err) {
		button.textContent = "Couldn't clear: " + (err.message || err);
	}
	setTimeout(() => {
		button.disabled = false;
		button.textContent = "Clear history and site data now";
	}, 2000);
});

// -------------------------------------------------- history and bookmarks
// Kept only in this device's storage for the app's own address, never sent to
// the server. With site isolation, sites can't read it: they run on other
// addresses.

const HISTORY = "bios:history";
const BOOKMARKS = "bios:bookmarks";
const MAX_HISTORY = 1000;

function readEntries(name) {
	const list = readList(name);
	return Array.isArray(list)
		? list.filter((e) => typeof e?.url === "string" && /^https?:/.test(e.url))
		: [];
}

function saveEntries(name, list) {
	if (vault && PRIVATE.has(name)) {
		vault.data[name] = list;
		seal();
		return;
	}
	try {
		localStorage.setItem(name, JSON.stringify(list));
	} catch {
		// storage full or blocked: skip rather than break browsing
	}
}

// ------------------------------------------------------- passphrase lock
// Optional. History, bookmarks and open tabs are kept in one AES-GCM blob
// whose key comes from the passphrase (PBKDF2) and lives only in memory, so
// someone holding the device can't read them. Site logins live in each
// site's own storage, out of reach here: clearing on launch covers those.

const VAULT = "bios:vault";
const encoder = new TextEncoder();

function toBase64(bytes) {
	let text = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(text);
}

const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt) {
	const base = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		// OWASP's 2023 figure for PBKDF2-SHA256: about a second on a phone
		{ name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"]
	);
}

// Writes are chained so an older snapshot never lands after a newer one.
let sealing = Promise.resolve();

function seal() {
	const { key, salt } = vault;
	const plain = encoder.encode(JSON.stringify(vault.data));
	sealing = sealing.then(async () => {
		try {
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const box = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
			localStorage.setItem(
				VAULT,
				JSON.stringify({ salt: toBase64(salt), iv: toBase64(iv), box: toBase64(box) })
			);
		} catch {
			// storage full or blocked: skip this save rather than stall every later one
		}
	});
	return sealing;
}

// Throws on a wrong passphrase (AES-GCM refuses to decrypt).
async function openVault(passphrase) {
	const sealed = JSON.parse(localStorage.getItem(VAULT));
	const salt = fromBase64(sealed.salt);
	const key = await deriveKey(passphrase, salt);
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64(sealed.iv) },
		key,
		fromBase64(sealed.box)
	);
	vault = { key, salt, data: JSON.parse(new TextDecoder().decode(plain)) };
}

// Turns the lock on, or changes the passphrase.
async function setPassphrase(passphrase) {
	if (passphrase.length < 8) throw new Error("Use at least 8 characters.");
	const data = vault ? vault.data : Object.fromEntries([...PRIVATE].map((n) => [n, readList(n)]));
	const salt = crypto.getRandomValues(new Uint8Array(16));
	vault = { key: await deriveKey(passphrase, salt), salt, data };
	await seal();
	for (const name of PRIVATE) localStorage.removeItem(name);
}

async function removePassphrase() {
	const { data } = vault;
	vault = null;
	await sealing;
	for (const name of PRIVATE) saveEntries(name, data[name] ?? []);
	localStorage.removeItem(VAULT);
}

// A phone keeps a home-screen app alive in the background for days, so "each
// time the app opens" would almost never come. Away this long counts as
// closed. Five minutes: the reload forgets the key and asks for the
// passphrase again. Fifteen: it's a fresh launch, which clears site data
// when that setting is on.
const RELOCK_MS = 5 * 60_000;
const RELAUNCH_MS = 15 * 60_000;
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
	// ponytail: best effort at keeping the page out of the phone's app
	// switcher preview; the phone may take its picture before this runs.
	document.body.classList.toggle("away", document.hidden);
	if (document.hidden) return void (hiddenAt = Date.now());
	const away = hiddenAt ? Date.now() - hiddenAt : 0;
	if (settings?.wipe && away > RELAUNCH_MS) {
		sessionStorage.removeItem("bios:session");
		location.reload();
	} else if (vault && away > RELOCK_MS) location.reload();
});

const vaultPanel = $("vault");
let vaultDone = null;

// mode "unlock" (on launch) or "set"; resolves once done or cancelled
function askPassphrase(mode) {
	const setting = mode === "set";
	$("vault-title").textContent = setting ? "Set a passphrase" : "Unlock Badger";
	$("vault-note").textContent = setting
		? "History, bookmarks and open tabs are encrypted with it on this device, and it's asked each time the app opens. If you forget it, they can't be recovered."
		: "Enter your passphrase to open your history, bookmarks and tabs.";
	$("vault-form").reset();
	$("vault-confirm").hidden = !setting;
	$("vault-confirm").required = setting;
	$("vault-pass").autocomplete = setting ? "new-password" : "current-password";
	$("vault-submit").textContent = setting ? "Set passphrase" : "Unlock";
	$("vault-cancel").hidden = !setting;
	$("vault-erase").hidden = setting;
	$("vault-error").textContent = "";
	vaultPanel.hidden = false;
	$("vault-pass").focus();
	return new Promise((resolve) => {
		vaultDone = resolve;
	});
}

function closeVaultPanel() {
	vaultPanel.hidden = true;
	$("vault-form").reset();
	vaultDone?.();
	vaultDone = null;
}

function showVaultButtons() {
	$("vault-set").textContent = vault
		? "Change passphrase"
		: "Lock history and bookmarks with a passphrase";
	$("vault-off").hidden = !vault;
}

$("vault-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const setting = !$("vault-confirm").hidden;
	const passphrase = $("vault-pass").value;
	const button = $("vault-submit");
	button.disabled = true;
	$("vault-error").textContent = "";
	try {
		if (!setting) {
			await openVault(passphrase).catch(() => {
				throw new Error("Wrong passphrase.");
			});
		} else if (passphrase !== $("vault-confirm").value) {
			throw new Error("The passphrases don't match.");
		} else {
			await setPassphrase(passphrase);
		}
		closeVaultPanel();
	} catch (err) {
		$("vault-error").textContent = err.message;
	} finally {
		button.disabled = false;
	}
});

$("vault-cancel").addEventListener("click", closeVaultPanel);

// Forgotten passphrase: start over. Site logins go too, so the lock can't
// be skipped to reach the sites the last person was signed in to.
$("vault-erase").addEventListener("click", async () => {
	if (
		!confirm(
			"Erase your history, bookmarks and open tabs, and sign out of every site?\n\nThis can't be undone."
		)
	)
		return;
	localStorage.removeItem(VAULT);
	await clearAllSiteData(true);
	closeVaultPanel();
});

$("vault-set").addEventListener("click", async () => {
	sheet.hidden = true;
	await askPassphrase("set");
	showVaultButtons();
});

$("vault-off").addEventListener("click", async () => {
	if (
		!confirm(
			"Turn off the passphrase lock?\n\nHistory, bookmarks and open tabs will be kept unencrypted on this device."
		)
	)
		return;
	await removePassphrase();
	showVaultButtons();
});

function recordVisit({ url, title }) {
	if (!/^https?:/.test(url)) return;
	const list = readEntries(HISTORY);
	title = String(title || "").slice(0, 200);
	// a page reporting its title after its address: update, don't duplicate
	if (list[0]?.url === url) list[0].title = title || list[0].title;
	else list.unshift({ url, title, at: Date.now() });
	// ponytail: rewrites the whole list per visit; fine at 1000 entries,
	// move to IndexedDB if it ever needs to hold much more.
	saveEntries(HISTORY, list.slice(0, MAX_HISTORY));
}

const isBookmarked = (url) => !!url && readEntries(BOOKMARKS).some((b) => b.url === url);

const nameOf = (entry) => entry.title || displayHost(entry.url).replace(/^www\./, "");

function linkRow(item, detail) {
	const li = document.createElement("li");
	const open = document.createElement("button");
	open.type = "button";
	open.className = "link";
	const text = document.createElement("span");
	text.className = "text";
	const title = document.createElement("span");
	title.textContent = nameOf(item);
	const small = document.createElement("small");
	small.textContent = detail;
	text.append(title, small);
	open.append(markFor(item.url), text);
	open.addEventListener("click", () => {
		library.hidden = downloadsPanel.hidden = true;
		go(item.url);
	});
	li.append(open);
	return li;
}

function renderBookmarksBar() {
	const list = readEntries(BOOKMARKS);
	const bar = $("bookmarks-bar");
	bar.hidden = !list.length;
	bar.replaceChildren(
		...list.map((b) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "bookmark";
			button.title = b.url;
			const label = document.createElement("span");
			label.textContent = nameOf(b);
			button.append(markFor(b.url), label);
			button.addEventListener("click", () => go(b.url));
			// middle click: open in a new tab
			button.addEventListener("auxclick", (event) => {
				if (event.button === 1) createTab(b.url, { after: active, select: false });
			});
			return button;
		})
	);
}

function toggleBookmark() {
	const url = active?.url;
	if (!url) return;
	const list = readEntries(BOOKMARKS);
	const i = list.findIndex((b) => b.url === url);
	if (i === -1)
		list.unshift({ url, title: nameOf({ url, title: active.title }).slice(0, 200) });
	else list.splice(i, 1);
	saveEntries(BOOKMARKS, list);
	renderBookmarksBar();
	showAddress();
}

star.addEventListener("click", toggleBookmark);

function renderHistory() {
	const list = readEntries(HISTORY).slice(0, 300);
	$("history-empty").hidden = list.length > 0;
	$("history-clear").hidden = !list.length;
	$("history-list").replaceChildren(
		...list.map((h) => linkRow(h, `${displayHost(h.url)} · ${timeAgo(h.at)}`))
	);
}

function openHistory() {
	sheet.hidden = true;
	renderHistory();
	library.hidden = false;
}

$("history-open").addEventListener("click", openHistory);
$("library-close").addEventListener("click", () => {
	library.hidden = true;
});
$("history-clear").addEventListener("click", () => {
	saveEntries(HISTORY, []);
	renderHistory();
	if (!active?.url) renderNewTab();
});

// Files sites sent to save. The browser saves them as always; the service
// worker tells the app (shield.js), which lists them like the history: on
// this device only, and cleared with it.
const DOWNLOADS = "bios:downloads";

function noteDownload(download) {
	if (!download || typeof download.url !== "string" || !/^https?:/.test(download.url)) return;
	const entry = {
		url: download.url.slice(0, 2000),
		name: String(download.name || "").slice(0, 200) || displayHost(download.url),
		size: Math.max(0, Math.floor(Number(download.size) || 0)),
		at: Date.now(),
	};
	// (a file a page asks for twice at once is one download)
	const list = readEntries(DOWNLOADS).filter((d) => !(d.url === entry.url && entry.at - d.at < 5000));
	list.unshift(entry);
	saveEntries(DOWNLOADS, list.slice(0, 200));
	if (!downloadsPanel.hidden) renderDownloads();
}

function sizeText(bytes) {
	if (bytes < 1000) return `${bytes} bytes`;
	const [unit, value] = bytes < 1e6 ? ["KB", bytes / 1e3] : bytes < 1e9 ? ["MB", bytes / 1e6] : ["GB", bytes / 1e9];
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

function renderDownloads() {
	const list = readEntries(DOWNLOADS);
	$("downloads-empty").hidden = list.length > 0;
	$("downloads-clear").hidden = !list.length;
	$("downloads-list").replaceChildren(
		...list.map((d) =>
			linkRow(
				{ url: d.url, title: d.name },
				[displayHost(d.url), d.size ? sizeText(d.size) : "", timeAgo(d.at)].filter(Boolean).join(" · ")
			)
		)
	);
}

function openDownloads() {
	sheet.hidden = true;
	renderDownloads();
	downloadsPanel.hidden = false;
}

$("downloads-open").addEventListener("click", openDownloads);
$("downloads-close").addEventListener("click", () => {
	downloadsPanel.hidden = true;
});
$("downloads-clear").addEventListener("click", () => {
	saveEntries(DOWNLOADS, []);
	renderDownloads();
});

// ---------------------------------------------------------------- new tab

// Shortcuts: bookmarks first, then the most visited sites from history.
function shortcuts() {
	const picked = new Map();
	for (const b of readEntries(BOOKMARKS)) picked.set(displayHost(b.url), b);
	const visits = new Map();
	for (const h of readEntries(HISTORY)) {
		const host = displayHost(h.url);
		const seen = visits.get(host);
		if (seen) seen.count++;
		else visits.set(host, { count: 1, entry: { url: new URL(h.url).origin + "/", title: "" } });
	}
	for (const [host, { entry }] of [...visits].sort((a, b) => b[1].count - a[1].count))
		if (!picked.has(host)) picked.set(host, entry);
	return [...picked.values()].slice(0, 10);
}

function renderNewTab() {
	$("tiles").replaceChildren(
		...shortcuts().map((s) => {
			const li = document.createElement("li");
			const button = document.createElement("button");
			button.type = "button";
			button.className = "tile";
			button.title = s.url;
			const label = document.createElement("span");
			label.textContent = nameOf(s);
			button.append(markFor(s.url), label);
			button.addEventListener("click", () => go(s.url));
			li.append(button);
			return li;
		})
	);
	$("stat-blocked").textContent = blockedThisWeek().toLocaleString();
}

// Trackers blocked: the proxy's service worker reports how many requests it
// blocked (directly in shared mode, through each site's anchor frame in
// isolation mode). Counted per day, on this device only.
const BLOCKED = "bios:blocked";
// local calendar day, YYYY-MM-DD
const dayKey = (ms) => new Date(ms).toLocaleDateString("en-CA");
const lastWeek = () =>
	new Set(Array.from({ length: 7 }, (_, i) => dayKey(Date.now() - i * 86_400_000)));

function blockedByDay() {
	const byDay = readList(BLOCKED);
	return byDay && typeof byDay === "object" && !Array.isArray(byDay) ? byDay : {};
}

function addBlocked(count) {
	count = Math.min(Math.max(0, Math.floor(Number(count) || 0)), 10_000);
	if (!count) return;
	const byDay = blockedByDay();
	const today = dayKey(Date.now());
	byDay[today] = (byDay[today] || 0) + count;
	const week = lastWeek();
	for (const day of Object.keys(byDay)) if (!week.has(day)) delete byDay[day];
	saveEntries(BLOCKED, byDay);
	if (!active?.url) $("stat-blocked").textContent = blockedThisWeek().toLocaleString();
}

// What was blocked on each page, for the shield menu: page address (without
// its #) -> host -> how often. In memory only, for the last pages seen.
const blockedOn = new Map();

function noteBlocked(hosts) {
	for (const pair of Array.isArray(hosts) ? hosts.slice(0, 200) : []) {
		const [page, host] = Array.isArray(pair) ? pair : [];
		if (typeof page !== "string" || typeof host !== "string") continue;
		const key = page.split("#")[0].slice(0, 2000);
		const seen = blockedOn.get(key) || new Map();
		// most recently blocked last, so the oldest page goes first
		blockedOn.delete(key);
		blockedOn.set(key, seen.set(host.slice(0, 100), (seen.get(host.slice(0, 100)) || 0) + 1));
		if (blockedOn.size > 30) blockedOn.delete(blockedOn.keys().next().value);
	}
	if (!sheet.hidden) renderBlocked();
}

function renderBlocked() {
	const hosts = active?.url ? blockedOn.get(active.url.split("#")[0]) : null;
	$("blocked-here").hidden = !hosts;
	if (!hosts) return;
	const total = [...hosts.values()].reduce((sum, n) => sum + n, 0);
	$("blocked-here").firstElementChild.textContent = `${total} request${total === 1 ? "" : "s"} blocked on this page`;
	$("blocked-hosts").textContent = [...hosts]
		.sort((a, b) => b[1] - a[1])
		.map(([host, n]) => (n > 1 ? `${host} (${n})` : host))
		.join(", ");
}

function blockedThisWeek() {
	const week = lastWeek();
	return Object.entries(blockedByDay()).reduce(
		(sum, [day, n]) => sum + (week.has(day) ? Number(n) || 0 : 0),
		0
	);
}

navigator.serviceWorker?.addEventListener("message", (event) => {
	if (event.data?.bios === "download") return noteDownload(event.data.download);
	if (event.data?.bios !== "blocked") return;
	addBlocked(event.data.count);
	noteBlocked(event.data.hosts);
});
navigator.serviceWorker?.startMessages();

// ----------------------------------------------------------------- startup

// The passphrase comes first (nothing private can be read before it), then a
// fresh launch (sessionStorage is empty after iOS closes the app) clears
// site data when that setting is on, and only then do the tabs open.
startup = (async () => {
	if (localStorage.getItem(VAULT)) await askPassphrase("unlock");
	showVaultButtons();
	const firstLaunch = !sessionStorage.getItem("bios:session");
	sessionStorage.setItem("bios:session", "1");
	const loaded = await loadSettings().catch(() => null);
	if (firstLaunch && loaded && loaded.wipe) await clearAllSiteData();
})().catch((err) => console.warn("startup:", err));

startup.then(() => {
	renderBookmarksBar();

	// A proxied page that escaped to the top level redirects to /#<url>.
	if (location.hash.length > 1) {
		let target = "";
		try {
			target = decodeURIComponent(location.hash.slice(1));
		} catch {
			// malformed: just open the app
		}
		history.replaceState(null, "", "/");
		restoreTabs();
		if (target) createTab(target);
		else if (!tabs.length) createTab();
	} else {
		if (!restoreTabs()) createTab();
		// warm up the service worker and transport so the first search is fast
		ensureReady().catch((err) => {
			error.textContent = err.message || String(err);
		});
	}
});

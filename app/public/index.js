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
const chrome = $("chrome");
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
const suggestEl = $("suggest");

// The page area starts below the chrome, whose height changes with the
// bookmarks bar.
new ResizeObserver(() =>
	document.documentElement.style.setProperty("--chrome-h", chrome.offsetHeight + "px")
).observe(chrome);

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
// iPadOS calls itself a Mac, but has a touch screen
const MOBILE =
	/iPhone|iPad|iPod|Android/.test(navigator.userAgent) ||
	(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
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

function rememberOrigin(key) {
	const keys = new Set(readList("bios:origins"));
	if (keys.has(key)) return;
	keys.add(key);
	localStorage.setItem("bios:origins", JSON.stringify([...keys]));
}

// With a passphrase lock (see "passphrase lock" below) these live only in the
// encrypted vault, decrypted in memory.
const PRIVATE = new Set(["bios:history", "bios:bookmarks", "bios:tabs"]);
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

	// Drop the least recently used anchors, but never one an open tab is on.
	const inUse = new Set(tabs.map((t) => t.siteOrigin));
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
 *   fwd: string[], landing: boolean, navigated: boolean, ownHistory: boolean }} Tab
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

function createTab(url = "", { after = null, lazy = false, title = "", select = true } = {}) {
	if (tabs.length >= MAX_TABS) return null;
	const id = nextTabId++;
	const frame = document.createElement("iframe");
	// unique per tab: page.js aims links at its own tab's name
	frame.name = `uvframe-${id}`;
	frame.title = "Page";
	frame.allow =
		"autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write";
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
	if (url && !lazy) go(url, tab);
	else if (!url && select) homeInput.focus({ preventScroll: true });
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

async function go(input, tab = active, record = true) {
	if (!input.trim() || !tab) return;
	error.textContent = "";
	hideSuggest();
	try {
		await startup;
		await ensureReady();
		const url = toUrl(input);
		// before touching the tab: throws for addresses that can't be opened
		const src = await frameUrlFor(url, tab);
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

// Shared mode only: the frame is same-origin, so read its address directly.
function frameLocation(tab) {
	if (isolated) return "";
	try {
		const client = tab.frame.contentWindow[Symbol.for("scramjet client global")];
		return client ? client.url.href : "";
	} catch {
		return "";
	}
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

function syncAddress(tab) {
	// while a new page loads, the frame still holds the old one
	if (tab.landing) return;
	const url = frameLocation(tab);
	if (url && url !== tab.url) updateTab(tab, url, tab.title);
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
	createTab(url.href, { after: tab, select: !event.data.background });
}

async function onFrameMessage(event) {
	const data = event.data;

	// Isolation mode: a site's anchor frame passing on its service worker's
	// count of blocked requests.
	if (data?.bios === "blocked") {
		for (const [origin, anchor] of anchors)
			if (anchor.frame.contentWindow === event.source && event.origin === origin)
				addBlocked(data.count);
		return;
	}

	if (data?.bios === "open") return openFromPage(event);

	const tab = tabFor(event.source);
	if (!tab) return;

	// The tab landed on a site origin with no proxy connection yet.
	if (isolated && data?.bios === "need-anchor" && SITE_ORIGIN.test(event.origin)) {
		await ensureAnchor(event.origin);
		event.source.postMessage({ bios: "anchor-ready" }, event.origin);
		return;
	}

	if (!data || data.bios !== "nav" || typeof data.url !== "string") return;

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

	updateTab(tab, url.href, String(data.title || "").slice(0, 300));
}

window.addEventListener("message", onFrameMessage);

// catches pushState/SPA navigations, and focus moving between split panes
setInterval(() => {
	followPaneFocus();
	if (active) syncAddress(active);
}, 400);

// Back, forward and reload act on the tab's own page. In isolation mode the
// frame is cross-origin, so the page does it when the shell asks.
function tabCommand(cmd, tab = active) {
	if (!tab?.url) return;
	if (cmd === "reload") setLoading(tab, true);
	try {
		const win = tab.frame.contentWindow;
		if (cmd === "back") win.history.back();
		else if (cmd === "forward") win.history.forward();
		else win.location.reload();
	} catch {
		if (tab.siteOrigin)
			tab.frame.contentWindow.postMessage({ bios: "cmd", cmd }, tab.siteOrigin);
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
		return tabCommand(dir < 0 ? "back" : "forward", tab);
	// once the shell has stepped, the frame's history no longer matches
	tab.ownHistory = false;
	const url = from.pop();
	pushStep(dir < 0 ? tab.fwd : tab.back, tab.url);
	go(url, tab, false);
}

$("back").addEventListener("click", () => step(-1));
$("forward").addEventListener("click", () => step(1));
$("reload").addEventListener("click", () => tabCommand("reload"));
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
		sheet.hidden = library.hidden = true;
		hideSuggest();
		return;
	}
	if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
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
	{ name: "Reload page", when: () => !!active?.url, run: () => tabCommand("reload") },
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

	$("site-row").hidden = !site;
	$("site-toggle").checked = !settings.allow.includes(site);

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

async function openSheet() {
	library.hidden = true;
	sheet.hidden = false;
	renderSheet();
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
for (const panel of [sheet, library])
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
			if (input.dataset.setting !== "wipe") tabCommand("reload");
		} catch (err) {
			input.checked = !input.checked;
			$("filter-status").textContent = err.message;
		}
	});
}

const LEVEL_NOTES = {
	standard: "Every site works as usual",
	safer: "No web fonts, WebGL or WebGPU on any site, and no scripts on sites without https. Some sites look or work worse.",
	safest: "Everything in Safer, and no site's own scripts at all. Many sites stop working: menus, videos, sign-ins.",
};

const levelSelect = $("security-level");
levelSelect.addEventListener("change", async () => {
	try {
		await saveSettings({ ...settings, level: levelSelect.value });
		tabCommand("reload");
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

$("site-toggle").addEventListener("change", async (event) => {
	const site = currentSite();
	if (!site) return;
	const allow = new Set(settings.allow);
	if (event.target.checked) allow.delete(site);
	else allow.add(site);
	try {
		await saveSettings({ ...settings, allow: [...allow] });
		tabCommand("reload");
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

function clearOrigin(origin) {
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
			if (event.source === wiper.contentWindow && event.data?.bios === "wiped")
				done();
		};
		const timer = setTimeout(done, 8000);
		window.addEventListener("message", onMessage);
		wiper.src = origin + "/wipe.html";
		document.body.appendChild(wiper);
	});
}

// Deletes every site's cookies, storage and logins, the history and the open
// tabs. Every tab closes first so no page holds its databases open.
async function clearAllSiteData() {
	saveEntries(HISTORY, []);
	split = null;
	for (const tab of [...tabs]) closeTab(tab);
	saveEntries(TABS, []);
	// let the closed pages release their databases first
	await new Promise((resolve) => setTimeout(resolve, 50));
	await clearStorageHere();
	if (config.isolation) {
		const keys = readList("bios:origins").filter((key) => /^s[a-z2-7]{25}$/.test(key));
		await Promise.all(keys.map((key) => clearOrigin(originFor(key))));
		localStorage.setItem("bios:origins", "[]");
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
	await clearAllSiteData();
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
	await clearAllSiteData();
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
		library.hidden = true;
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

function blockedThisWeek() {
	const week = lastWeek();
	return Object.entries(blockedByDay()).reduce(
		(sum, [day, n]) => sum + (week.has(day) ? Number(n) || 0 : 0),
		0
	);
}

navigator.serviceWorker?.addEventListener("message", (event) => {
	if (event.data?.bios === "blocked") addBlocked(event.data.count);
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

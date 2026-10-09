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
const siteOrigin = (labels) =>
	config.isolation
		? new RegExp(
				"^" +
					location.protocol.replace(":", "") +
					`://(${labels}[a-z2-7]{25})\\.` +
					config.isolation.replace(/\./g, "\\.") +
					port.replace(/\W/g, "\\$&") +
					"$"
			)
		: null;
// A tab's site's origin (s…, or t… in a Tor tab)...
const SITE_ORIGIN = siteOrigin("[st]");
// ...or a frame's of another site inside a page (f…, g…; see shield.js inFrame).
const ANY_SITE_ORIGIN = siteOrigin("[stfg]");

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

function rememberOrigin(key) {
	const keys = new Set(readList("bios:origins"));
	if (keys.has(key)) return;
	keys.add(key);
	localStorage.setItem("bios:origins", JSON.stringify([...keys]));
}

// With a passphrase lock (see "passphrase lock" below) these live only in the
// encrypted vault, decrypted in memory.
const PRIVATE = new Set([
	"bios:history",
	"bios:bookmarks",
	"bios:tabs",
	"bios:zoom",
	"bios:downloads",
	"bios:permissions",
	"bios:logins",
	"bios:passkeys",
	"bios:never",
]);
// Without the passphrase lock these still never sit in storage as text: they
// are sealed with a key that can't leave this browser (see "secrets" below).
const SEALED = new Set(["bios:logins", "bios:passkeys", "bios:never"]);
let vault = null;
let sealedData = {};

function readList(name) {
	if (vault && PRIVATE.has(name)) return vault.data[name] ?? [];
	if (SEALED.has(name)) return sealedData[name] ?? [];
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
	// a Tor tab's sites have origins of their own, connected through Tor
	const key = tab.tor ? await BiosSiteKey.torKey(new URL(url).hostname) : await BiosSiteKey.siteKey(new URL(url).hostname);
	rememberOrigin(key);
	const origin = originFor(key);
	tab.siteOrigin = origin;
	await ensureAnchor(origin);
	return origin + path;
}

// Isolation mode: one hidden /anchor.html frame per recently used site
// origin. It registers that origin's service worker and keeps its proxy
// connection open while the site's own pages come and go.
// (frames of other sites inside pages have origins, and anchors, of their own)
const MAX_ANCHORS = 8;
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

// Workspaces keep each task's tabs together (like Min's tasks or Zen's
// workspaces): the strip and the phone's switcher show only the current
// workspace's tabs, and the others' pages stay as they were, out of sight.
const WS_COLORS = {
	gray: "#6f6c68",
	blue: "#3a6fd8",
	green: "#2f9e64",
	amber: "#c98418",
	red: "#d0473f",
	purple: "#8a55d6",
	pink: "#cf4a8e",
};
const MAX_WORKSPACES = 12;
/**
 * @typedef {{ id: number, name: string, color: string, last: Tab | null }} Workspace
 * `last`: its tab that was showing, to come back to.
 */
/** @type {Workspace[]} */
let workspaces = [{ id: 1, name: "Personal", color: "gray", last: null }];
let currentWs = 1;
const wsById = (id) => workspaces.find((w) => w.id === id);
const wsTabs = (id = currentWs) => tabs.filter((t) => t.ws === id);

function createTab(
	url = "",
	{ after = null, lazy = false, title = "", select = true, openedBy = null, tor = false, ws = null } = {}
) {
	if (tor && !torAvailable) return null;
	if (tabs.length >= MAX_TABS) return null;
	const id = nextTabId++;
	const frame = document.createElement("iframe");
	// unique per tab: page.js aims links at its own tab's name
	frame.name = `uvframe-${id}`;
	frame.title = "Page";
	// location, camera and microphone only after the app's own prompt (page.js asks it)
	frame.allow =
		"autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write; geolocation; camera; microphone";
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
		// the page that opened this tab, for its first navigation
		openedBy,
		// a Tor tab: its sites' connections go through Tor (src/tor.js), and
		// it keeps no history and isn't kept when the app closes
		tor,
		// its workspace: the opener's, or the one showing
		ws: ws ?? (after && tabs.includes(after) ? after.ws : currentWs),
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
	else if (!url && select) {
		homeInput.focus({ preventScroll: true });
		pulse($("newtab"), RISE);
	}
	if (!lazy) pulse($("tabs").querySelector(`[data-tab="${id}"]`), RISE);
	return tab;
}

function selectTab(tab) {
	if (active && active !== tab) lastActive = active;
	// a tab in another workspace (a page asking for the camera, say) brings it along
	if (tab.ws !== currentWs) {
		currentWs = tab.ws;
		split = null;
	}
	const ws = wsById(tab.ws);
	if (ws) ws.last = tab;
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
	// the last Tor tab took its sites' cookies and storage with it
	if (tab.tor && !tabs.some((t) => t.tor)) setTimeout(forgetTor, 50);
	if (lastActive === tab) lastActive = null;
	if (tab !== active) {
		layout();
		renderTabs();
		return;
	}
	const next = neighbour(tab, i);
	active = null;
	if (next) selectTab(next);
	// the last tab of a workspace leaves a new tab there; of a deleted one,
	// another workspace
	else if (wsById(tab.ws)) createTab();
	else switchWorkspace((workspaces.find((w) => wsTabs(w.id).length) || workspaces[0]).id);
}

// The tab to show once `tab` (at index `i`) closes or leaves its workspace:
// the next one in the workspace, or else the one before.
function neighbour(tab, i) {
	const same = (t) => t !== tab && t.ws === tab.ws;
	return tabs.slice(i).find(same) || tabs.slice(0, i).findLast(same) || null;
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
	document.body.classList.toggle("tor", !!active.tor);
	document.body.classList.toggle("loading", active.loading);
}

function tabLabel(tab) {
	return tab.title || (tab.url ? displayHost(tab.url) : "New Tab");
}

function renderTabs() {
	const shown = wsTabs();
	$("tabs").replaceChildren(
		...shown.map((tab) => {
			const el = document.createElement("div");
			el.dataset.tab = String(tab.id);
			el.className = tab.tor ? "tab tor" : "tab";
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
					const next = shown[shown.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1)];
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
	renderWorkspaceButton();
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
	const shown = wsTabs();
	const count = $("tab-count");
	if (count.textContent !== String(shown.length)) {
		count.textContent = String(shown.length);
		pulse(count, [{ transform: "scale(1.5)" }, { transform: "none" }], 350);
	}
	const ws = wsById(currentWs);
	$("tabs-btn").setAttribute(
		"aria-label",
		workspaces.length > 1 ? `Tabs: ${shown.length} open in ${ws.name}` : `Tabs: ${shown.length} open`
	);
	renderWorkspaceChips();
	$("tab-list").replaceChildren(
		...shown.map((tab) => {
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
	$("ws-chips").querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
});
$("switcher-close").addEventListener("click", () => {
	switcher.hidden = true;
});
for (const id of ["dock-new", "switcher-new"])
	$(id).addEventListener("click", () => {
		switcher.hidden = true;
		createTab();
	});

// ------------------------------------------------------------- workspaces

const PLUS_GLYPH = '<path d="M12 5v14M5 12h14"/>';
const EDIT_GLYPH = '<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/>';

function wsDot(ws) {
	const dot = document.createElement("span");
	dot.className = "ws-dot";
	dot.style.background = WS_COLORS[ws.color];
	return dot;
}

function plural(n, word) {
	return n === 0 ? `No ${word}s` : `${n} ${word}${n === 1 ? "" : "s"}`;
}

function switchWorkspace(id) {
	const ws = wsById(id);
	if (!ws) return;
	const tab = (ws.last?.ws === id && tabs.includes(ws.last) && ws.last) || wsTabs(id)[0];
	if (tab) selectTab(tab);
	else if (tabs.length >= MAX_TABS) toast(`Close a tab first: up to ${MAX_TABS} tabs can be open.`);
	else {
		currentWs = id;
		split = null;
		createTab();
	}
	pulse($("ws-btn"), [{ transform: "scale(0.94)" }, { transform: "none" }]);
}

function newWorkspace() {
	if (workspaces.length >= MAX_WORKSPACES) return toast(`Up to ${MAX_WORKSPACES} workspaces`);
	if (tabs.length >= MAX_TABS) return toast(`Close a tab first: up to ${MAX_TABS} tabs can be open.`);
	const id = Math.max(0, ...workspaces.map((w) => w.id)) + 1;
	const used = new Set(workspaces.map((w) => w.color));
	const color = Object.keys(WS_COLORS).find((c) => !used.has(c)) || "gray";
	workspaces.push({ id, name: `Workspace ${workspaces.length + 1}`, color, last: null });
	switchWorkspace(id);
	// named first thing, while it's clear what it's for
	openWorkspaces(id);
}

// Sends a tab to another workspace, where it goes last. The workspace on show
// stays, unless that was its only tab.
function moveTab(tab, id) {
	const ws = wsById(id);
	if (!ws || !tabs.includes(tab) || tab.ws === id) return;
	if (split?.includes(tab)) split = null;
	const i = tabs.indexOf(tab);
	const next = tab === active ? neighbour(tab, i) : null;
	tabs.splice(i, 1);
	tabs.push(tab);
	tab.ws = id;
	ws.last = tab;
	if (next) selectTab(next);
	else if (tab === active) selectTab(tab);
	else {
		layout();
		renderTabs();
	}
	renderWorkspaces();
	if (currentWs !== id) toast(`Moved to ${ws.name}`, "Show", () => switchWorkspace(id));
}

async function deleteWorkspace(ws) {
	if (workspaces.length < 2) return;
	const open = wsTabs(ws.id).filter((t) => t.url).length;
	if (open) {
		const sure = await choose({
			title: `Delete ${ws.name}?`,
			note: open === 1 ? "Its tab closes too." : `Its ${open} tabs close too.`,
			ok: "Delete",
		});
		if (!sure) return;
	}
	if (!workspaces.includes(ws)) return;
	workspaces = workspaces.filter((w) => w !== ws);
	if (editingWs === ws.id) editingWs = null;
	// the tab on show last, so the others' places are free for its replacement
	const doomed = wsTabs(ws.id).sort((a, b) => (a === active) - (b === active));
	for (const tab of doomed) closeTab(tab);
	if (currentWs === ws.id) switchWorkspace(workspaces[0].id);
	renderTabs();
	renderWorkspaces();
}

function workspaceCommands() {
	return workspaces
		.filter((w) => w.id !== currentWs)
		.flatMap((w) => [
			{ name: `Switch to ${w.name}`, run: () => switchWorkspace(w.id) },
			{ name: `Move tab to ${w.name}`, when: () => !!active?.url, run: () => moveTab(active, w.id) },
		]);
}

// Desktop: the current workspace at the start of the tab strip.
function renderWorkspaceButton() {
	const ws = wsById(currentWs);
	if (!ws) return;
	$("ws-name").textContent = ws.name;
	$("ws-btn").setAttribute("aria-label", `Workspace: ${ws.name}. Switch workspaces`);
	$("ws-btn").title = "Workspaces";
	$("ws-btn").querySelector(".ws-dot").style.background = WS_COLORS[ws.color];
	// with more than one, the workspace's color marks the phone's tab button
	if (workspaces.length > 1) document.documentElement.style.setProperty("--ws", WS_COLORS[ws.color]);
	else document.documentElement.style.removeProperty("--ws");
}

// Phones: the workspaces as chips above the tab list, to flip between.
function renderWorkspaceChips() {
	const chip = (onClick) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "ws-chip";
		button.addEventListener("click", onClick);
		return button;
	};
	const iconChip = (label, glyph, onClick) => {
		const button = chip(onClick);
		button.classList.add("ws-icon");
		button.setAttribute("aria-label", label);
		button.append(svgIcon(glyph));
		return button;
	};
	$("ws-chips").replaceChildren(
		...workspaces.map((ws) => {
			const button = chip(() => {
				if (ws.id === currentWs) return;
				// an empty workspace opens a new tab, which wants the whole screen
				if (!wsTabs(ws.id).length) switcher.hidden = true;
				switchWorkspace(ws.id);
			});
			button.setAttribute("aria-pressed", String(ws.id === currentWs));
			const name = document.createElement("span");
			name.className = "ws-chip-name";
			name.textContent = ws.name;
			const count = document.createElement("small");
			count.textContent = String(wsTabs(ws.id).length);
			button.setAttribute("aria-label", `${ws.name}: ${plural(wsTabs(ws.id).length, "tab")}`);
			button.append(wsDot(ws), name, count);
			return button;
		}),
		iconChip("New workspace", PLUS_GLYPH, () => {
			switcher.hidden = true;
			newWorkspace();
		}),
		iconChip("Edit workspaces", EDIT_GLYPH, () => openWorkspaces())
	);
}

// The workspaces panel: switch, send the tab on show to another, rename,
// recolor, delete.
const wsPanel = $("workspaces");
let editingWs = null;
let commitEdit = null;

function openWorkspaces(edit = null) {
	editingWs = edit;
	switcher.hidden = true;
	wsPanel.hidden = false;
	renderWorkspaces();
	if (edit === null) $("ws-list").querySelector("[aria-current]")?.focus();
}

function closeWorkspaces() {
	commitEdit?.();
	wsPanel.hidden = true;
}

function renderWorkspaces() {
	if (wsPanel.hidden) return;
	commitEdit = null;
	$("ws-new").disabled = workspaces.length >= MAX_WORKSPACES;
	$("ws-list").replaceChildren(...workspaces.map((ws) => (ws.id === editingWs ? editRow(ws) : wsRow(ws))));
}

function smallButton(label, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.addEventListener("click", onClick);
	return button;
}

function wsRow(ws) {
	const li = document.createElement("li");
	const open = document.createElement("button");
	open.type = "button";
	open.className = "link";
	if (ws.id === currentWs) open.setAttribute("aria-current", "true");
	const text = document.createElement("span");
	text.className = "text";
	const name = document.createElement("span");
	name.textContent = ws.name;
	const small = document.createElement("small");
	small.textContent = ws.id === currentWs ? `${plural(wsTabs(ws.id).length, "tab")} · Showing` : plural(wsTabs(ws.id).length, "tab");
	text.append(name, small);
	open.append(wsDot(ws), text);
	open.addEventListener("click", () => {
		wsPanel.hidden = true;
		if (ws.id !== currentWs) switchWorkspace(ws.id);
	});
	const actions = document.createElement("span");
	actions.className = "row-actions";
	if (active?.url && ws.id !== currentWs) {
		const move = smallButton("Move tab here", () => moveTab(active, ws.id));
		move.title = `Move ${tabLabel(active)} to ${ws.name}`;
		actions.append(move);
	}
	const edit = smallButton("Edit", () => {
		commitEdit?.();
		editingWs = ws.id;
		renderWorkspaces();
	});
	edit.setAttribute("aria-label", `Edit ${ws.name}`);
	actions.append(edit);
	li.append(open, actions);
	return li;
}

function editRow(ws) {
	const li = document.createElement("li");
	li.className = "ws-edit";
	const form = document.createElement("form");
	form.autocomplete = "off";
	const name = document.createElement("input");
	name.type = "text";
	name.value = ws.name;
	name.maxLength = 40;
	name.enterKeyHint = "done";
	name.spellcheck = false;
	name.setAttribute("aria-label", "Workspace name");
	const colors = document.createElement("div");
	colors.className = "ws-colors";
	colors.setAttribute("role", "radiogroup");
	colors.setAttribute("aria-label", "Color");
	for (const [key, hex] of Object.entries(WS_COLORS)) {
		const swatch = document.createElement("button");
		swatch.type = "button";
		swatch.className = "ws-swatch";
		swatch.style.background = hex;
		swatch.setAttribute("role", "radio");
		swatch.setAttribute("aria-label", key[0].toUpperCase() + key.slice(1));
		swatch.setAttribute("aria-checked", String(key === ws.color));
		swatch.addEventListener("click", () => {
			ws.color = key;
			for (const s of colors.children) s.setAttribute("aria-checked", String(s === swatch));
			renderTabs();
		});
		colors.append(swatch);
	}
	const tools = document.createElement("div");
	tools.className = "tools";
	const remove = smallButton("Delete", () => deleteWorkspace(ws));
	remove.className = "danger";
	remove.disabled = workspaces.length < 2;
	if (remove.disabled) remove.title = "There has to be one workspace";
	const save = document.createElement("button");
	save.type = "submit";
	save.textContent = "Save";
	tools.append(remove, save);
	commitEdit = () => {
		commitEdit = null;
		ws.name = name.value.trim().slice(0, 40) || ws.name;
		editingWs = null;
		renderTabs();
	};
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		commitEdit();
		renderWorkspaces();
	});
	form.append(name, colors, tools);
	li.append(form);
	requestAnimationFrame(() => {
		name.focus({ preventScroll: true });
		name.select();
		li.scrollIntoView({ block: "nearest" });
	});
	return li;
}

$("ws-btn").addEventListener("click", () => openWorkspaces());
$("workspaces-close").addEventListener("click", closeWorkspaces);
$("ws-new").addEventListener("click", () => {
	commitEdit?.();
	newWorkspace();
});
// a tap outside the card, as with the other panels
wsPanel.addEventListener("click", (event) => {
	if (event.target === wsPanel) closeWorkspaces();
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
	const open = tabs.filter((t) => t.url && !t.tor);
	saveEntries(TABS, {
		tabs: open.map(({ url, title, ws }) => ({ url, title, ws })),
		active: open.indexOf(active),
		workspaces: workspaces.map(({ id, name, color, last }) => ({ id, name, color, last: open.indexOf(last) })),
		current: currentWs,
	});
}

// Whether a tab was opened: false when the current workspace has none, for
// the caller to open one.
function restoreTabs() {
	const saved = readList(TABS);
	const kept = Array.isArray(saved?.workspaces)
		? saved.workspaces.filter((w, i, all) =>
				Number.isInteger(w?.id) && w.id > 0 && typeof w.name === "string" &&
				all.findIndex((o) => o?.id === w.id) === i
			)
		: [];
	if (kept.length) {
		workspaces = kept.slice(0, MAX_WORKSPACES).map((w) => ({
			id: w.id,
			name: w.name.trim().slice(0, 40) || "Workspace",
			color: Object.hasOwn(WS_COLORS, w.color) ? w.color : "gray",
			last: null,
		}));
		currentWs = wsById(saved.current) ? saved.current : workspaces[0].id;
	}
	// indexed like the saved list, so `active` and `last` still point right
	let count = 0;
	const made = (Array.isArray(saved?.tabs) ? saved.tabs : []).map((t) =>
		typeof t?.url === "string" && /^https?:/.test(t.url) && count++ < MAX_TABS
			? createTab(t.url, {
					lazy: true,
					title: String(t.title || "").slice(0, 300),
					select: false,
					ws: wsById(t.ws) ? t.ws : workspaces[0].id,
				})
			: null
	);
	for (const w of kept) {
		const ws = wsById(w.id);
		if (ws && Number.isInteger(w.last)) ws.last = made[w.last] || null;
	}
	const want = Number.isInteger(saved?.active) ? made[saved.active] : null;
	const pick = want?.ws === currentWs ? want : wsTabs()[0];
	if (!pick) {
		renderTabs();
		return false;
	}
	selectTab(pick);
	return true;
}

// ------------------------------------------------------------- split view

const wide = matchMedia("(min-width: 900px)");

function canSplit() {
	return wide.matches && !!active?.url && tabs.some((t) => t !== active && t.url && t.ws === active.ws);
}

function toggleSplit() {
	if (split) split = null;
	else {
		if (!canSplit()) return;
		const partner = [lastActive, ...tabs].find(
			(t) => t && t !== active && t.url && tabs.includes(t) && t.ws === active.ws
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
		// an onion site only opens in a Tor tab
		if (!tab.tor && /\.onion$/i.test(new URL(url).hostname)) {
			if (!torAvailable) throw new Error("Onion sites open in Tor tabs, which this server doesn't offer.");
			if (!tab.url) closeTab(tab);
			createTab(url, { tor: true, after: tab });
			return;
		}
		if (tab.tor) await torReady(tab);
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
		await announce(tab, src);
		tab.frame.src = src;
	} catch (err) {
		error.textContent = err.message || String(err);
	}
}

// Isolation: tells the site's service worker that the navigation to `src`
// is the app's own (the person's, or from the page that opened the tab), so
// the site is told so. Any other navigation without a referrer counts as
// another site's (shield.js, "announced").
let announceId = 0;
function announce(tab, src) {
	const from = tab.openedBy || null;
	tab.openedBy = null;
	const anchor = isolated && tab.siteOrigin ? anchors.get(tab.siteOrigin) : null;
	if (!anchor) return;
	const id = ++announceId;
	return new Promise((resolve) => {
		const timer = setTimeout(done, 1000);
		function done() {
			clearTimeout(timer);
			window.removeEventListener("message", onMessage);
			resolve();
		}
		function onMessage(event) {
			if (event.source === anchor.frame.contentWindow && event.data?.bios === "typed-ok" && event.data.id === id) done();
		}
		window.addEventListener("message", onMessage);
		anchor.frame.contentWindow.postMessage({ bios: "typed", id, url: src, from }, tab.siteOrigin);
	});
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
	showKeyButton();
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
	// a page that loaded keeps its site's zoom
	if (zoomOf(siteFor(url)) !== 100) toTab(tab, { cmd: "zoom", level: zoomOf(siteFor(url)) });
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
	if (isolated ? !ANY_SITE_ORIGIN.test(event.origin) : event.origin !== location.origin) return;
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
	// the site is told the page that opened it asked, as a browser does
	createTab(url.href, { after: tab, select: !event.data.background, openedBy: tab.url });
}

async function onFrameMessage(event) {
	const data = event.data;

	// Isolation mode: a site's anchor frame passing on its service worker's
	// count of blocked requests.
	if (data?.bios === "blocked") {
		for (const [origin, anchor] of anchors)
			if (anchor.frame.contentWindow === event.source && event.origin === origin) {
				addBlocked(data.count);
				noteBlocked(data.hosts);
			}
		return;
	}

	if (data?.bios === "open") return openFromPage(event);

	// "Open in a Tor tab", from the warning an onion address gets in an ordinary tab
	if (data?.bios === "open-tor") {
		const from = tabOf(event.source);
		if (!from || !torAvailable || (navigator.userActivation && !navigator.userActivation.isActive)) return;
		try {
			const url = new URL(data.url);
			if (/^https?:$/.test(url.protocol)) createTab(url.href, { tor: true, after: from });
		} catch {
			// not an address
		}
		return;
	}

	// a page in a tab, or a frame in one, asks for location, camera or
	// microphone; the tab's own page, for a passkey
	if (data?.bios === "ask") return data.kind === "passkey-create" || data.kind === "passkey-get" ? passkeyAsked(event) : askPerson(event);

	// A frame on its own origin (see shield.js inFrame): kept in mind, so
	// clearing site data reaches it.
	if (data?.bios === "frame-origin") {
		const key = ANY_SITE_ORIGIN?.exec(event.origin)?.[1];
		if (key && /^[fg]/.test(key) && tabOf(event.source)) rememberOrigin(key);
		return;
	}

	// A frame on its own origin, sending the tab's page elsewhere (a link
	// meant for the top, frame-busting): the app does it, after a tap.
	if (data?.bios === "navigate") {
		const tab = tabOf(event.source);
		if (!tab || !isolated || !ANY_SITE_ORIGIN.test(event.origin)) return;
		if (navigator.userActivation && !navigator.userActivation.isActive) return;
		try {
			const url = new URL(data.url);
			if (/^https?:$/.test(url.protocol)) {
				tab.openedBy = tab.url;
				go(url.href, tab);
			}
		} catch {
			// not an address
		}
		return;
	}

	// A file from a page in a tab, or from a frame inside one (the worker's
	// download page, or an <a download> the person tapped).
	if (data?.bios === "download") {
		const tab = tabOf(event.source);
		if (!tab || (isolated ? !ANY_SITE_ORIGIN.test(event.origin) : event.origin !== location.origin)) return;
		return addDownload(tab, data).catch((err) => toast("Couldn't save the download: " + (err.message || err)));
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
			if ((await BiosSiteKey.keyLike(key, new URL(url).hostname)) !== key) return;
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

	// An anchor frame for a site origin: the tab's own, which it landed on
	// with no proxy connection yet; another site's, which its page is about
	// to post a form to; or, from a frame inside a page, the origin of its
	// own that a frame of another site is about to load on (shield.js
	// inFrame). The anchor registers that origin's worker and holds its proxy
	// connection, so the page never waits for either.
	if (isolated && data?.bios === "need-anchor" && ANY_SITE_ORIGIN.test(event.origin) && tabOf(event.source)) {
		const other = typeof data.origin === "string" && ANY_SITE_ORIGIN.test(data.origin) ? data.origin : null;
		if (!other && !SITE_ORIGIN.test(event.origin)) return;
		await ensureAnchor(other || event.origin);
		window.postMessage.call(event.source, { bios: "anchor-ready" }, event.origin);
		return;
	}

	const tab = tabFor(event.source);
	if (!tab) return;

	// the page's answer to the find bar
	if (data?.bios === "found") {
		if (tab === active && !findBar.hidden && data.text === findInput.value) {
			const total = Math.max(0, Math.floor(Number(data.total) || 0));
			const index = Math.min(Math.max(0, Math.floor(Number(data.index) || 0)), total);
			$("find-status").textContent = !data.text
				? ""
				: !data.found
					? "No matches"
					: total
						? `${index} of ${total >= 1000 ? "1000+" : total}`
						: "";
		}
		return;
	}

	// a sign-in form on the page, and a password just used in one (client/logins.js)
	if (data?.bios === "login-form") {
		tab.loginForm = ["login", "new"].includes(data.form) ? data.form : "";
		if (tab === active) showKeyButton();
		return;
	}
	if (data?.bios === "login-seen") return offerToKeep(tab, data);

	// the page answered a cookie notice (client/consent.js)
	if (data?.bios === "consent") {
		tab.consent = { url: tab.url, cmp: String(data.cmp || "").slice(0, 60), result: !!data.result };
		if (tab === active && !sheet.hidden) renderSheet();
		return;
	}

	// reader view: the page's markup, then its images
	if (data?.bios === "reader-source") return showReader(tab, data);
	if (data?.bios === "images") return readerImagesArrived(tab, data.images);


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
		if ((await BiosSiteKey.keyLike(match[1], url.hostname)) !== match[1]) {
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

// Back and forward act on the tab's own page. In isolation mode the frame is
// cross-origin, so the page does it when the shell asks.
async function tabCommand(cmd, tab = active) {
	if (!tab?.url) return;
	try {
		const win = tab.frame.contentWindow;
		if (cmd === "back") win.history.back();
		else win.history.forward();
	} catch {
		if (!tab.siteOrigin) return;
		// a page the person typed comes back without a referrer: say it's theirs
		const to = cmd === "back" ? tab.back.at(-1) : tab.fwd.at(-1);
		if (to) await announce(tab, tab.siteOrigin + proxyPath(to)).catch(() => {});
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
			.then((src) => {
				const load = async () => {
					tab.landing = true;
					setLoading(tab, true);
					await announce(tab, src);
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
		return tabCommand(dir < 0 ? "back" : "forward", tab);
	// once the shell has stepped, the frame's history no longer matches
	tab.ownHistory = false;
	const url = from.pop();
	pushStep(dir < 0 ? tab.fwd : tab.back, tab.url);
	go(url, tab, false);
}

// Find in page. The page does the looking (page.js, with the browser's own
// text search): the shell can't reach into a tab on another origin, and a
// phone's home-screen app has no find of its own.
const findBar = $("find");
const findInput = $("find-input");

// A command for the page in `tab` (page.js answers it). The shell's own
// postMessage, applied to the frame: without isolation the frame's is
// Scramjet's stand-in, which builds a function from a string in the caller's
// window, and the shell's policy forbids that here.
function toTab(tab, message) {
	if (!tab?.url) return;
	try {
		window.postMessage.call(tab.frame.contentWindow, { bios: "cmd", ...message }, tab.siteOrigin || location.origin);
	} catch {
		// the frame is between pages
	}
}

// `again`: the next match (or the one before, with `back`) rather than the first
function findInPage(text, back = false, again = false) {
	$("find-status").textContent = "";
	if (!active?.url) return;
	toTab(active, { cmd: "find", text, back, again });
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

// ------------------------------------------------------------- page tools

function siteFor(url) {
	try {
		return BiosSiteKey.siteOf(new URL(url).hostname);
	} catch {
		return "";
	}
}

// Zoom, per site, kept on this device: the page's own size, as a browser zooms.
const ZOOM = "bios:zoom";
const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250];
function zoomOf(site) {
	const levels = readList(ZOOM);
	const level = levels && typeof levels === "object" && !Array.isArray(levels) ? Number(levels[site]) : 0;
	return ZOOM_STEPS.includes(level) ? level : 100;
}

function zoomBy(step) {
	const site = currentSite();
	if (!site) return;
	const at = ZOOM_STEPS.indexOf(zoomOf(site));
	const level = ZOOM_STEPS[Math.min(Math.max(at + step, 0), ZOOM_STEPS.length - 1)];
	const levels = readList(ZOOM);
	const next = levels && typeof levels === "object" && !Array.isArray(levels) ? levels : {};
	if (level === 100) delete next[site];
	else next[site] = level;
	saveEntries(ZOOM, next);
	$("zoom-level").textContent = level + "%";
	for (const tab of tabs) if (siteFor(tab.url) === site) toTab(tab, { cmd: "zoom", level });
}
$("zoom-in").addEventListener("click", () => zoomBy(1));
$("zoom-out").addEventListener("click", () => zoomBy(-1));

$("print-page").addEventListener("click", () => {
	sheet.hidden = true;
	toTab(active, { cmd: "print" });
});

// Translation by Google's page translator, which fetches the page itself (as
// a visitor without cookies) and shows it translated, through the proxy like
// any site. Google learns the address; the page's own visit stays private.
function translateUrl(url) {
	const to = (navigator.language || "en").split("-")[0].toLowerCase() || "en";
	return `https://translate.google.com/translate?sl=auto&tl=${encodeURIComponent(to)}&u=${encodeURIComponent(url)}`;
}
$("translate-page").addEventListener("click", () => {
	sheet.hidden = true;
	if (active?.url) go(translateUrl(active.url));
});

// Reader view: the page sends its markup, the shell finds the article in it
// (Readability) and cleans it (DOMPurify, client/reader.js), and the page
// fetches the article's images through the proxy. Nothing here loads or runs
// anything from the site.
const readerPanel = $("reader");
let reading = null; // { tab, images: Map<url, img[]> }
let readerLib = null;

function loadReader() {
	readerLib ||= new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = "/bios/reader.js";
		script.onload = () => resolve(window.BiosReader);
		script.onerror = () => {
			readerLib = null;
			reject(new Error("Couldn't load reader view."));
		};
		document.head.append(script);
	});
	return readerLib;
}

function openReader() {
	if (!active?.url) return;
	sheet.hidden = true;
	reading = { tab: active, images: new Map() };
	$("reader-site").textContent = displayHost(active.url);
	$("reader-title").textContent = active.title || "Reader view";
	$("reader-byline").textContent = "";
	$("reader-article").replaceChildren();
	$("reader-status").textContent = "Loading…";
	readerPanel.hidden = false;
	loadReader().catch(() => {});
	toTab(active, { cmd: "reader" });
}

async function showReader(tab, data) {
	if (!reading || reading.tab !== tab || readerPanel.hidden) return;
	let article = null;
	try {
		const lib = await loadReader();
		if (typeof data.html === "string" && typeof data.url === "string" && /^https?:/.test(data.url))
			article = lib.extract(data.html, data.url);
	} catch {
		// shown as "no article" below
	}
	if (!reading || reading.tab !== tab) return;
	if (!article) {
		$("reader-status").textContent = "Reader view isn't available for this page.";
		return;
	}
	$("reader-site").textContent = article.siteName || displayHost(tab.url);
	$("reader-title").textContent = article.title || tab.title || displayHost(tab.url);
	$("reader-byline").textContent = article.byline;
	$("reader-status").textContent = "";
	$("reader-article").replaceChildren(article.content);
	for (const img of $("reader-article").querySelectorAll("img[data-src]")) {
		const list = reading.images.get(img.dataset.src) || [];
		list.push(img);
		reading.images.set(img.dataset.src, list);
	}
	if (article.images.length) toTab(tab, { cmd: "images", urls: article.images });
}

function readerImagesArrived(tab, images) {
	if (!reading || reading.tab !== tab || !Array.isArray(images)) return;
	for (const pair of images.slice(0, 40)) {
		const [url, data] = Array.isArray(pair) ? pair : [];
		// only pictures, as data: addresses: the app's policy refuses anything else
		if (typeof data !== "string" || !/^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=]+$/i.test(data)) continue;
		for (const img of reading.images.get(url) || []) img.src = data;
	}
}

function closeReader() {
	readerPanel.hidden = true;
	reading = null;
	$("reader-article").replaceChildren();
}

$("reader-open").addEventListener("click", openReader);
$("reader-close").addEventListener("click", closeReader);
$("reader-article").addEventListener("click", (event) => {
	const link = event.target.closest?.("a[data-href]");
	if (!link) return;
	event.preventDefault();
	closeReader();
	go(link.dataset.href);
});
$("reader-article").addEventListener("keydown", (event) => {
	const link = event.target.closest?.("a[data-href]");
	if (!link || event.key !== "Enter") return;
	closeReader();
	go(link.dataset.href);
});

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
		sheet.hidden = library.hidden = switcher.hidden = true;
		if (!$("workspaces").hidden) closeWorkspaces();
		if (!readerPanel.hidden) closeReader();
		$("downloads").hidden = $("cert").hidden = $("passwords").hidden = $("offer").hidden = true;
		if (!$("choice").hidden) finishChoice(null);
		hideSuggest();
		closeFind();
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
	{ name: "New Tor tab", when: () => torAvailable, run: () => newTorTab() },
	{ name: "Close tab", run: () => closeTab(active) },
	{ name: "Workspaces", run: () => openWorkspaces() },
	{ name: "New workspace", run: () => newWorkspace() },
	{ name: "History", run: openHistory },
	{ name: "Downloads", run: openDownloads },
	{ name: "Passwords", run: openPasswords },
	{ name: "Sync with another device", run: openSyncPanel },
	{ name: "Certificate", when: () => !!active?.url?.startsWith("https:"), run: openCert },
	{ name: "Settings", run: openSheet },
	{ name: "Bookmark this page", when: () => !!active?.url && !isBookmarked(active.url), run: toggleBookmark },
	{ name: "Remove bookmark", when: () => isBookmarked(active?.url), run: toggleBookmark },
	{ name: "Split view", when: () => !split && canSplit(), run: toggleSplit },
	{ name: "Close split view", when: () => !!split, run: toggleSplit },
	{ name: "Reload page", when: () => !!active?.url, run: () => reload() },
	{ name: "Find in page", when: () => !!active?.url, run: () => openFind() },
	{ name: "Reader view", when: () => !!active?.url, run: () => openReader() },
	{ name: "Print", when: () => !!active?.url, run: () => toTab(active, { cmd: "print" }) },
	{ name: "Translate page", when: () => !!active?.url, run: () => go(translateUrl(active.url)) },
	{ name: "Zoom in", when: () => !!active?.url, run: () => zoomBy(1) },
	{ name: "Zoom out", when: () => !!active?.url, run: () => zoomBy(-1) },
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
		for (const c of [...COMMANDS, ...workspaceCommands()])
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
	$("cert-open").hidden = !site || !active.url.startsWith("https:");
	$("zoom-level").textContent = zoomOf(site) + "%";
	renderPermissions(site);
	const consent = active?.consent?.url === active?.url ? active.consent : null;
	$("consent-here").hidden = !consent;
	if (consent)
		$("consent-here").textContent = consent.result
			? `Cookie notice answered: no to tracking${consent.cmp ? ` (${consent.cmp})` : ""}.`
			: "A cookie notice was found here, but it couldn't be answered.";
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
for (const panel of [sheet, library, switcher])
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
	// the downloads are the person's files, not a site's data
	const names = (
		indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name) : []
	).filter((name) => name !== "$scramjet" && name !== DOWNLOAD_DB && name !== KEY_DB);
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
// tabs. Every tab closes first so no page holds its databases open. The sites
// the person chose to stay signed in to keep their cookies and storage (not
// their history), unless `everything` goes.
async function clearAllSiteData(everything = false) {
	saveEntries(HISTORY, []);
	split = null;
	for (const tab of [...tabs]) closeTab(tab);
	saveEntries(TABS, []);
	// let the closed pages release their databases first
	await new Promise((resolve) => setTimeout(resolve, 50));
	await clearStorageHere();
	if (config.isolation) {
		const keys = readList("bios:origins").filter((key) => /^[stfg][a-z2-7]{25}$/.test(key));
		const kept = new Set(
			everything ? [] : await Promise.all((settings?.keep || []).map((site) => BiosSiteKey.siteKey(site)))
		);
		await Promise.all(keys.filter((key) => !kept.has(key)).map((key) => clearOrigin(originFor(key))));
		localStorage.setItem("bios:origins", JSON.stringify(keys.filter((key) => kept.has(key))));
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
	if (SEALED.has(name)) {
		sealedData[name] = list;
		sealOnDevice();
		return;
	}
	try {
		localStorage.setItem(name, JSON.stringify(list));
	} catch {
		// storage full or blocked: skip rather than break browsing
	}
}

// ------------------------------------------------------------ permissions
// Location, camera and microphone: a page asks the app (page.js, askApp), and
// the app asks the person, with a prompt the page can't draw or answer. The
// answer can be kept for the site (the tab's site, as browsers keep it).

const PERMISSIONS = "bios:permissions";
const PERMISSION_KINDS = { location: "your location", camera: "your camera", microphone: "your microphone", "camera+microphone": "your camera and microphone" };
const askQueue = [];
let askShown = null;

function savedPermissions() {
	const saved = readList(PERMISSIONS);
	return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
}

// "allow", "approximate", "deny", or undefined (ask)
function permissionFor(site, kind) {
	const kept = savedPermissions()[site] || {};
	const answers = kind.split("+").map((k) => kept[k]);
	if (answers.some((a) => a === "deny")) return "deny";
	if (answers.every((a) => a === "allow" || a === "approximate")) return answers[0];
	return undefined;
}

function keepPermission(site, kind, answer) {
	const saved = savedPermissions();
	const kept = { ...(saved[site] || {}) };
	for (const k of kind.split("+")) kept[k] = answer;
	saved[site] = kept;
	saveEntries(PERMISSIONS, saved);
}

function answerPage(event, id, answer) {
	try {
		// the shell's own postMessage (see toTab): a same-origin page's is Scramjet's
		window.postMessage.call(event.source, { bios: "answer", id, ...answer }, event.origin);
	} catch {
		// the page is gone
	}
}

function askPerson(event) {
	const data = event.data;
	const tab = tabOf(event.source);
	if (!tab?.url || typeof data.id !== "string" || !PERMISSION_KINDS[data.kind]) return;
	if (isolated ? !ANY_SITE_ORIGIN.test(event.origin) : event.origin !== location.origin) return;
	const site = siteFor(tab.url);
	const kept = permissionFor(site, data.kind);
	if (kept) return answerPage(event, data.id, { allow: kept !== "deny", approximate: kept === "approximate" });
	askQueue.push({ event, id: data.id, kind: data.kind, site, tab });
	showNextAsk();
}

function showNextAsk() {
	if (askShown || !askQueue.length) return;
	askShown = askQueue.shift();
	const { kind, site, tab } = askShown;
	$("ask-title").textContent = `${site} wants to use ${PERMISSION_KINDS[kind]}`;
	$("ask-note").textContent =
		kind === "location"
			? "Sites learn where you are. Approximate tells them roughly, within about a kilometre."
			: "The site can see and hear what the camera and microphone pick up while it's open.";
	$("ask-remember").checked = false;
	$("ask-approximate").hidden = kind !== "location";
	$("ask").hidden = false;
	if (tab !== active) selectTab(tab);
	$("ask-allow").focus();
}

function finishAsk(answer) {
	const asked = askShown;
	askShown = null;
	$("ask").hidden = true;
	if (!asked) return;
	if ($("ask-remember").checked) keepPermission(asked.site, asked.kind, answer);
	answerPage(asked.event, asked.id, { allow: answer !== "deny", approximate: answer === "approximate" });
	// the same question from the same site, waiting behind this one, gets the same answer
	for (let i = askQueue.length - 1; i >= 0; i--) {
		const next = askQueue[i];
		if (next.site === asked.site && next.kind === asked.kind) {
			askQueue.splice(i, 1);
			answerPage(next.event, next.id, { allow: answer !== "deny", approximate: answer === "approximate" });
		}
	}
	showNextAsk();
}

$("ask-form").addEventListener("submit", (event) => {
	event.preventDefault();
	finishAsk("allow");
});
$("ask-deny").addEventListener("click", () => finishAsk("deny"));
$("ask-approximate").addEventListener("click", () => finishAsk("approximate"));

const ANSWER_TEXT = { allow: "Allowed", approximate: "Approximate", deny: "Not allowed" };

function renderPermissions(site) {
	const kept = site ? savedPermissions()[site] || {} : {};
	const entries = Object.entries(kept).filter(([kind]) => PERMISSION_KINDS[kind]);
	$("permissions-here").hidden = !entries.length;
	$("permissions-list").replaceChildren(
		...entries.map(([kind, answer]) => {
			const li = document.createElement("li");
			const text = document.createElement("span");
			text.className = "text link";
			const title = document.createElement("span");
			title.textContent = PERMISSION_KINDS[kind].replace(/^your /, "").replace(/^./, (c) => c.toUpperCase());
			const small = document.createElement("small");
			small.textContent = ANSWER_TEXT[answer] || answer;
			text.append(title, small);
			const forget = document.createElement("button");
			forget.type = "button";
			forget.className = "text-btn";
			forget.textContent = "Ask again";
			forget.addEventListener("click", () => {
				const saved = savedPermissions();
				delete saved[site]?.[kind];
				if (saved[site] && !Object.keys(saved[site]).length) delete saved[site];
				saveEntries(PERMISSIONS, saved);
				renderPermissions(site);
			});
			li.append(text, forget);
			return li;
		})
	);
}

// --------------------------------------------------------------- Tor tabs
// A Tor tab's sites run on origins of their own (t<key>, src/client/sitekey.js)
// whose connections go out through Tor from the server (src/tor.js): sites
// see a Tor exit, a different one for each site, and onion sites open. Like
// a private window, a Tor tab keeps no history, isn't brought back when the
// app opens, and its sites' cookies and storage go with the last Tor tab.

let torAvailable = false;

async function torState() {
	try {
		return await (await fetch("/api/tor", { cache: "no-store" })).json();
	} catch {
		return { available: false };
	}
}

// Waits (up to a minute and a half) for Tor to finish connecting, saying how far it is.
async function torReady(tab) {
	for (let tries = 0; tries < 90; tries++) {
		const state = await torState();
		if (!state.available) throw new Error("Tor isn't available on this server.");
		if (state.ready) {
			if (tab === active) error.textContent = "";
			return;
		}
		if (tab === active) error.textContent = `Connecting to Tor… ${state.progress || 0}%`;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error("Tor didn't connect. Try again in a minute.");
}

function newTorTab(url = "") {
	sheet.hidden = true;
	const tab = createTab(url, { tor: true });
	if (!tab) return;
	if (!url) torReady(tab).catch((err) => (error.textContent = err.message));
}

// Every Tor origin's cookies and storage: when the last Tor tab closes, and
// when the app opens (a Tor tab never outlives the app).
async function forgetTor() {
	if (!config.isolation) return;
	const keys = readList("bios:origins").filter((key) => /^[stfg][a-z2-7]{25}$/.test(key));
	const tor = keys.filter((key) => /^[tg]/.test(key));
	if (!tor.length) return;
	await Promise.all(tor.map((key) => clearOrigin(originFor(key))));
	localStorage.setItem("bios:origins", JSON.stringify(keys.filter((key) => !/^[tg]/.test(key))));
	for (const key of tor) {
		const anchor = anchors.get(originFor(key));
		anchor?.frame.remove();
		anchors.delete(originFor(key));
	}
}

$("tor-tab").addEventListener("click", () => newTorTab());

// ---------------------------------------------------------------- secrets
// Passwords and passkeys. With the passphrase lock they live in its vault;
// without it, they are sealed with an AES key the browser keeps and won't
// hand out (a non-extractable key in IndexedDB), so they never sit in
// storage as text. Either way they stay on this device.

const SEALED_KEY = "bios:sealed";
const KEY_DB = "bios-keys";
let deviceKey = null;

function keyStore(mode, work) {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(KEY_DB, 1);
		req.onupgradeneeded = () => req.result.createObjectStore("keys");
		req.onerror = () => reject(req.error);
		req.onsuccess = () => {
			const db = req.result;
			const tx = db.transaction("keys", mode);
			const result = work(tx.objectStore("keys"));
			tx.oncomplete = () => {
				db.close();
				resolve(result?.result);
			};
			tx.onerror = tx.onabort = () => {
				db.close();
				reject(tx.error);
			};
		};
	});
}

async function openOnDevice() {
	try {
		deviceKey = await keyStore("readonly", (store) => store.get("device"));
		if (!deviceKey) {
			deviceKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
			await keyStore("readwrite", (store) => store.put(deviceKey, "device"));
		}
		const sealed = JSON.parse(localStorage.getItem(SEALED_KEY) || "null");
		if (!sealed) return;
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv) }, deviceKey, fromBase64(sealed.box));
		sealedData = JSON.parse(new TextDecoder().decode(plain));
	} catch (err) {
		// a browser that won't keep the key: passwords last until the app closes
		console.warn("secrets:", err);
	}
}

let sealingOnDevice = Promise.resolve();
function sealOnDevice() {
	if (!deviceKey) return;
	const plain = encoder.encode(JSON.stringify(sealedData));
	sealingOnDevice = sealingOnDevice.then(async () => {
		try {
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const box = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, deviceKey, plain));
			localStorage.setItem(SEALED_KEY, JSON.stringify({ iv: toBase64(iv), box: toBase64(box) }));
		} catch {
			// storage full or blocked
		}
	});
}

// ---------------------------------------------------------------- choices
// The app's own question with a list to pick from (an account, a passkey),
// which a page can't draw or answer.

let choiceDone = null;
function choose({ title, note = "", options = [], ok = "" }) {
	choiceDone?.(null);
	$("choice-title").textContent = title;
	$("choice-note").textContent = note;
	$("choice-ok").textContent = ok;
	$("choice-ok").hidden = !ok;
	$("choice-list").replaceChildren(
		...options.map((option) => {
			const li = document.createElement("li");
			const button = document.createElement("button");
			button.type = "button";
			button.className = "link";
			const text = document.createElement("span");
			text.className = "text";
			const label = document.createElement("span");
			label.textContent = option.label;
			text.append(label);
			if (option.detail) {
				const small = document.createElement("small");
				small.textContent = option.detail;
				text.append(small);
			}
			button.append(text);
			button.addEventListener("click", () => finishChoice(option.value));
			li.append(button);
			return li;
		})
	);
	$("choice").hidden = false;
	($("choice-list").querySelector("button") || $("choice-ok")).focus();
	return new Promise((resolve) => (choiceDone = resolve));
}

function finishChoice(value) {
	$("choice").hidden = true;
	const done = choiceDone;
	choiceDone = null;
	done?.(value);
}

$("choice-cancel").addEventListener("click", () => finishChoice(null));
$("choice-ok").addEventListener("click", () => finishChoice(true));

// An offer at the bottom of the screen that waits for an answer.
function offer(text, actions) {
	$("offer-text").textContent = text;
	$("offer").querySelector(".offer-actions").replaceChildren(
		...actions.map(({ label, primary, run }) => {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = label;
			if (primary) button.className = "primary";
			button.addEventListener("click", () => {
				$("offer").hidden = true;
				run?.();
			});
			return button;
		})
	);
	$("offer").hidden = false;
	pulse($("offer"), RISE);
}

// -------------------------------------------------------------- passwords

const LOGINS = "bios:logins";
const NEVER = "bios:never";

function readLogins() {
	const list = readList(LOGINS);
	return Array.isArray(list) ? list.filter((l) => typeof l?.site === "string" && typeof l?.password === "string") : [];
}

const loginsFor = (site) => readLogins().filter((l) => l.site === site);

function showKeyButton() {
	const btn = $("key-btn");
	const site = currentSite();
	const form = active?.url?.startsWith("https:") ? active.loginForm : "";
	btn.hidden = !site || !form || (form === "login" && !loginsFor(site).length);
	btn.setAttribute("aria-label", form === "new" && !loginsFor(site).length ? "Suggest a strong password" : "Sign in with a saved password");
}

function strongPassword() {
	const letters = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const bytes = crypto.getRandomValues(new Uint8Array(18));
	const chars = [...bytes].map((b) => letters[b % letters.length]);
	// three groups, as Safari suggests them: easier to read out, as strong
	return [chars.slice(0, 6), chars.slice(6, 12), chars.slice(12)].map((g) => g.join("")).join("-");
}

async function fillFromKey() {
	const tab = active;
	const site = currentSite();
	if (!tab?.url?.startsWith("https:") || !site) return;
	const options = loginsFor(site).map((login) => ({
		label: login.username || "(no username)",
		detail: `${login.site} · saved ${timeAgo(login.created || Date.now())}`,
		value: login,
	}));
	if (tab.loginForm === "new") options.push({ label: "Use a strong password", detail: "Made up here and filled in; saved when you sign up", value: "new" });
	const picked = options.length === 1 && options[0].value !== "new" ? options[0].value : await choose({ title: `Sign in to ${site}`, options });
	if (!picked || tab !== active) return;
	const login = picked === "new" ? { username: "", password: strongPassword() } : picked;
	toTab(tab, { cmd: "fill", username: login.username, password: login.password });
	if (picked !== "new") {
		picked.used = Date.now();
		saveEntries(LOGINS, readLogins().map((l) => (l.id === picked.id ? { ...l, used: picked.used } : l)));
	}
}

$("key-btn").addEventListener("click", fillFromKey);

// A password the person just used on the tab's site: keep it?
function offerToKeep(tab, data) {
	const site = siteFor(tab.url);
	if (!site || typeof data.password !== "string" || !data.password) return;
	if (!tab.url.startsWith("https:")) return;
	const never = readList(NEVER);
	if (Array.isArray(never) && never.includes(site)) return;
	const username = String(data.username || "").slice(0, 300);
	const password = data.password.slice(0, 500);
	const logins = readLogins();
	const same = logins.find((l) => l.site === site && l.username === username);
	if (same?.password === password) return;
	const keep = () => {
		const now = Date.now();
		const rest = readLogins().filter((l) => !(l.site === site && l.username === username));
		rest.unshift({ id: same?.id || crypto.randomUUID(), site, origin: new URL(tab.url).origin, username, password, created: same?.created || now, used: now });
		saveEntries(LOGINS, rest);
		showKeyButton();
		toast(same ? "Password updated" : "Password saved", "Show", openPasswords);
	};
	offer(same ? `Update the saved password for ${username || site}?` : `Save the password${username ? ` for ${username}` : ""} on ${site}?`, [
		{
			label: "Never for this site",
			run: () => saveEntries(NEVER, [...(Array.isArray(never) ? never : []), site].slice(-500)),
		},
		{ label: "Not now" },
		{ label: same ? "Update" : "Save", primary: true, run: keep },
	]);
}

// --------------------------------------------------------------- passkeys
// The app is the passkey's authenticator, as a password manager's is: it
// makes a key pair for the site, keeps the private key (in the vault, so
// passkeys need the passphrase lock), and signs the site's challenges after
// the person says yes. Each passkey belongs to the site whose real address
// the tab shows (the address the app verified), so another site can't use
// it, and the site sees an ordinary passkey (ES256, no attestation).

const PASSKEYS = "bios:passkeys";
const bytesOf = (buffer) => new Uint8Array(buffer instanceof ArrayBuffer ? buffer : ArrayBuffer.isView(buffer) ? buffer.buffer : new ArrayBuffer(0));
const b64url = (buffer) => toBase64(bytesOf(buffer)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text) => fromBase64(text.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (text.length % 4)) % 4));
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const concat = (...parts) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

// CBOR, the little of it WebAuthn needs: integers, text, bytes and maps.
function cbor(value) {
	const out = [];
	const head = (major, n) => {
		if (n < 24) out.push((major << 5) | n);
		else if (n < 0x100) out.push((major << 5) | 24, n);
		else if (n < 0x10000) out.push((major << 5) | 25, n >> 8, n & 255);
		else out.push((major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
	};
	const write = (v) => {
		if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
		if (typeof v === "string") {
			const bytes = encoder.encode(v);
			head(3, bytes.length);
			for (const b of bytes) out.push(b);
			return;
		}
		if (v instanceof Uint8Array) {
			head(2, v.length);
			for (const b of v) out.push(b);
			return;
		}
		if (v instanceof Map) {
			head(5, v.size);
			for (const [k, x] of v) {
				write(k);
				write(x);
			}
			return;
		}
		throw new Error("can't encode that");
	};
	write(value);
	return new Uint8Array(out);
}

// WebCrypto signs ECDSA as r||s; WebAuthn wants it in DER.
function derSignature(raw) {
	const integer = (bytes) => {
		let i = 0;
		while (i < bytes.length - 1 && bytes[i] === 0) i++;
		let body = [...bytes.slice(i)];
		if (body[0] & 0x80) body = [0, ...body];
		return [0x02, body.length, ...body];
	};
	const body = [...integer(raw.slice(0, raw.length / 2)), ...integer(raw.slice(raw.length / 2))];
	return new Uint8Array([0x30, body.length, ...body]);
}

// A relying party id the page's real address may claim: its own host, or a
// domain it is under, but never a public suffix (WebAuthn's rule).
function validRpId(rpId, host) {
	rpId = String(rpId || host).toLowerCase();
	if (host !== rpId && !host.endsWith("." + rpId)) return null;
	const site = BiosSiteKey.siteOf(host);
	return rpId === site || rpId.endsWith("." + site) ? rpId : null;
}

function readPasskeys() {
	const list = readList(PASSKEYS);
	return Array.isArray(list) ? list.filter((k) => typeof k?.id === "string" && typeof k?.rpId === "string" && k.key) : [];
}

const FLAGS = { up: 0x01, uv: 0x04, at: 0x40 };

async function passkeyAsked(event) {
	const data = event.data;
	const tab = tabFor(event.source);
	const answer = (result) => answerPage(event, data.id, result);
	const refuse = (error, name = "NotAllowedError") => answer({ ok: false, error, name });
	// only the tab's own page, on its verified address, over https
	if (!tab?.url?.startsWith("https:")) return refuse("Passkeys need a secure page.", "SecurityError");
	if (isolated ? !SITE_ORIGIN.test(event.origin) : event.origin !== location.origin) return refuse();
	const page = new URL(tab.url);
	const request = data.request || {};
	try {
		if (data.kind === "passkey-create") return answer(await makePasskey(tab, page, request));
		return answer(await usePasskey(tab, page, request));
	} catch (err) {
		return refuse(err.message || String(err), err.name || "NotAllowedError");
	}
}

function failure(message, name = "NotAllowedError") {
	return Object.assign(new Error(message), { name });
}

async function needVault() {
	if (vault) return true;
	const set = await choose({
		title: "Passkeys need the passphrase lock",
		note: "The app keeps passkeys encrypted with your passphrase, and asks for it when the app opens.",
		ok: "Set a passphrase",
	});
	if (set) await askPassphrase("set");
	return !!vault;
}

async function makePasskey(tab, page, request) {
	const url = tab.url;
	const rpId = validRpId(request.rp?.id || page.hostname, page.hostname);
	if (!rpId) throw failure("That site name doesn't match the page's address.", "SecurityError");
	const algorithms = Array.isArray(request.algorithms) ? request.algorithms : [];
	if (algorithms.length && !algorithms.includes(-7)) throw failure("The site asked for a kind of key this app doesn't make.", "NotSupportedError");
	const userId = bytesOf(request.user?.id);
	if (!userId.length || userId.length > 64) throw failure("The site gave no valid user.", "TypeError");
	const known = new Set(readPasskeys().filter((k) => k.rpId === rpId).map((k) => k.id));
	if ((request.exclude || []).some((id) => known.has(b64url(id)))) throw failure("A passkey for this account is already here.", "InvalidStateError");
	if (!(await needVault())) throw failure("No passkey was made.");
	const name = String(request.user?.name || "").slice(0, 200);
	const yes = await choose({
		title: `Make a passkey for ${rpId}?`,
		note: `${name ? `For ${name}. ` : ""}Kept in this app, encrypted with your passphrase. Sites can't use it except ${rpId}.`,
		ok: "Make passkey",
	});
	if (!yes || tab.url !== url) throw failure("No passkey was made.");

	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
	const key = await crypto.subtle.exportKey("jwk", pair.privateKey);
	const credentialId = crypto.getRandomValues(new Uint8Array(16));
	const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33, 65)]]));
	const authData = concat(
		await sha256(encoder.encode(rpId)),
		new Uint8Array([FLAGS.up | FLAGS.uv | FLAGS.at, 0, 0, 0, 0]),
		new Uint8Array(16), // AAGUID: none
		new Uint8Array([credentialId.length >> 8, credentialId.length & 255]),
		credentialId,
		cose
	);
	const clientData = encoder.encode(
		JSON.stringify({ type: "webauthn.create", challenge: b64url(request.challenge), origin: page.origin, crossOrigin: false })
	);
	const attestation = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
	const list = readPasskeys();
	list.unshift({
		id: b64url(credentialId),
		rpId,
		user: b64url(userId),
		name,
		displayName: String(request.user?.displayName || "").slice(0, 200),
		key,
		created: Date.now(),
	});
	saveEntries(PASSKEYS, list);
	toast(`Passkey made for ${rpId}`, "Show", openPasswords);
	return {
		ok: true,
		credentialId: credentialId.buffer,
		clientDataJSON: clientData.buffer,
		attestationObject: attestation.buffer,
		authenticatorData: authData.buffer,
		publicKey: spki,
	};
}

async function usePasskey(tab, page, request) {
	const rpId = validRpId(request.rpId || page.hostname, page.hostname);
	if (!rpId) throw failure("That site name doesn't match the page's address.", "SecurityError");
	const allowed = new Set((request.allow || []).map(b64url));
	const candidates = readPasskeys().filter((k) => k.rpId === rpId && (!allowed.size || allowed.has(k.id)));
	if (!vault && !candidates.length && readList(PASSKEYS).length === 0 && localStorage.getItem(VAULT))
		throw failure("Unlock the app first.");
	if (!candidates.length) {
		await choose({ title: `No passkey for ${rpId} here`, note: "This app has no passkey this site accepts. Use another way to sign in." });
		throw failure("No passkey for this site.");
	}
	const picked = await choose({
		title: `Sign in to ${rpId} with a passkey?`,
		options: candidates.map((k) => ({ label: k.name || k.displayName || "(no name)", detail: `Made ${timeAgo(k.created)}`, value: k })),
	});
	if (!picked) throw failure("The sign-in was cancelled.");
	const clientData = encoder.encode(
		JSON.stringify({ type: "webauthn.get", challenge: b64url(request.challenge), origin: page.origin, crossOrigin: false })
	);
	const authData = concat(await sha256(encoder.encode(rpId)), new Uint8Array([FLAGS.up | FLAGS.uv, 0, 0, 0, 0]));
	const privateKey = await crypto.subtle.importKey("jwk", picked.key, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	const raw = new Uint8Array(
		await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, concat(authData, await sha256(clientData)))
	);
	return {
		ok: true,
		credentialId: fromB64url(picked.id).buffer,
		clientDataJSON: clientData.buffer,
		authenticatorData: authData.buffer,
		signature: derSignature(raw).buffer,
		userHandle: fromB64url(picked.user).buffer,
	};
}

// ------------------------------------------------------- passwords panel

function openPasswords() {
	sheet.hidden = true;
	renderPasswords();
	$("passwords").hidden = false;
}

function renderPasswords() {
	$("passwords-note").textContent = vault
		? "Kept on this device, encrypted with your passphrase."
		: "Kept on this device, encrypted with a key this browser keeps. Set a passphrase to lock them with one of your own; passkeys need it.";
	const logins = readLogins();
	$("logins-empty").hidden = logins.length > 0;
	$("logins-list").replaceChildren(
		...logins.map((login) => {
			const li = document.createElement("li");
			const text = document.createElement("span");
			text.className = "text link";
			const title = document.createElement("span");
			title.textContent = `${login.site} · ${login.username || "(no username)"}`;
			const small = document.createElement("small");
			small.className = "secret";
			small.textContent = "••••••••";
			text.append(title, small);
			const actions = document.createElement("span");
			actions.className = "row-actions";
			const show = document.createElement("button");
			show.type = "button";
			show.textContent = "Show";
			show.addEventListener("click", () => {
				const hidden = small.textContent === "••••••••";
				small.textContent = hidden ? login.password : "••••••••";
				show.textContent = hidden ? "Hide" : "Show";
			});
			const copy = document.createElement("button");
			copy.type = "button";
			copy.textContent = "Copy";
			copy.addEventListener("click", () =>
				navigator.clipboard?.writeText(login.password).then(
					() => toast("Password copied"),
					() => toast("Couldn't copy it")
				)
			);
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "Delete";
			remove.addEventListener("click", () => {
				if (!confirm(`Delete the password for ${login.username || login.site}?`)) return;
				saveEntries(LOGINS, readLogins().filter((l) => l.id !== login.id));
				renderPasswords();
				showKeyButton();
			});
			actions.append(show, copy, remove);
			li.append(text, actions);
			return li;
		})
	);
	const keys = readPasskeys();
	$("passkeys-empty").hidden = keys.length > 0;
	$("passkeys-list").replaceChildren(
		...keys.map((key) => {
			const li = document.createElement("li");
			const text = document.createElement("span");
			text.className = "text link";
			const title = document.createElement("span");
			title.textContent = `${key.rpId} · ${key.name || key.displayName || "(no name)"}`;
			const small = document.createElement("small");
			small.textContent = `Made ${timeAgo(key.created)}`;
			text.append(title, small);
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "text-btn";
			remove.textContent = "Delete";
			remove.addEventListener("click", () => {
				if (!confirm(`Delete the passkey for ${key.rpId}? You won't be able to sign in with it again.`)) return;
				saveEntries(PASSKEYS, readPasskeys().filter((k) => k.id !== key.id));
				renderPasswords();
			});
			li.append(text, remove);
			return li;
		})
	);
}

$("passwords-open").addEventListener("click", openPasswords);
$("passwords-close").addEventListener("click", () => ($("passwords").hidden = true));
$("passwords").addEventListener("click", (event) => {
	if (event.target === $("passwords")) $("passwords").hidden = true;
});

// ------------------------------------------------------------------- sync
// Two of the person's devices swap their bookmarks, history, passwords and
// passkeys once, and both merge (src/sync.js is the server's relay). The
// code one shows and the other types is 80 random bits; the key that seals
// what's sent and the relay's channel names both come from it (HKDF), so
// the server can't read what passes through, nor tell whose it is.

const SYNC_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let syncRun = 0;

function makeSyncCode() {
	const bytes = crypto.getRandomValues(new Uint8Array(10));
	let bits = 0;
	let value = 0;
	let code = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			code += SYNC_LETTERS[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	return code.match(/.{4}/g).join("-");
}

function syncSecret(code) {
	// (the code's letters leave out I, O, 0 and 1, which look alike)
	const letters = String(code).toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (letters.length !== 16 || [...letters].some((c) => !SYNC_LETTERS.includes(c))) return null;
	const out = new Uint8Array(10);
	let bits = 0;
	let value = 0;
	let at = 0;
	for (const c of letters) {
		value = (value << 5) | SYNC_LETTERS.indexOf(c);
		bits += 5;
		if (bits >= 8) {
			out[at++] = (value >>> (bits - 8)) & 255;
			bits -= 8;
		}
	}
	return out;
}

async function syncKeys(secret) {
	const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey", "deriveBits"]);
	const params = (info) => ({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("badger-sync-1"), info: encoder.encode(info) });
	const channel = async (info) =>
		[...new Uint8Array(await crypto.subtle.deriveBits(params(info), base, 128))].map((b) => b.toString(16).padStart(2, "0")).join("");
	return {
		key: await crypto.subtle.deriveKey(params("key"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
		shower: await channel("from the device showing the code"),
		typer: await channel("from the device the code was typed into"),
	};
}

function syncPayload() {
	return {
		v: 1,
		bookmarks: readEntries(BOOKMARKS),
		history: readEntries(HISTORY),
		logins: readLogins(),
		passkeys: readPasskeys(),
		never: readList(NEVER),
	};
}

async function sealSync(key, payload) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const box = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload))));
	return toBase64(concat(iv, box));
}

async function unsealSync(key, text) {
	const raw = fromBase64(text);
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
	return JSON.parse(new TextDecoder().decode(plain));
}

// What came from the other device joins what's here. Returns what was added.
function mergeSync(theirs) {
	const added = { bookmarks: 0, history: 0, logins: 0, passkeys: 0 };
	const list = (value) => (Array.isArray(value) ? value : []);
	const http = (e) => typeof e?.url === "string" && /^https?:/.test(e.url);

	const marks = readEntries(BOOKMARKS);
	const known = new Set(marks.map((b) => b.url));
	for (const b of list(theirs.bookmarks).filter(http))
		if (!known.has(b.url)) {
			known.add(b.url);
			marks.push({ url: b.url, title: String(b.title || "").slice(0, 200) });
			added.bookmarks++;
		}
	saveEntries(BOOKMARKS, marks);

	const visits = new Map(readEntries(HISTORY).map((h) => [`${h.at}\n${h.url}`, h]));
	for (const h of list(theirs.history).filter(http))
		if (!visits.has(`${h.at}\n${h.url}`)) {
			visits.set(`${h.at}\n${h.url}`, { url: h.url, title: String(h.title || "").slice(0, 200), at: Number(h.at) || 0 });
			added.history++;
		}
	saveEntries(HISTORY, [...visits.values()].sort((a, b) => b.at - a.at).slice(0, MAX_HISTORY));

	const logins = new Map(readLogins().map((l) => [`${l.site}\n${l.username}`, l]));
	for (const l of list(theirs.logins)) {
		if (typeof l?.site !== "string" || typeof l?.password !== "string") continue;
		const key = `${l.site}\n${l.username || ""}`;
		const mine = logins.get(key);
		const newer = (x) => Number(x?.used || x?.created) || 0;
		if (!mine) added.logins++;
		if (!mine || newer(l) > newer(mine)) logins.set(key, { ...l, id: mine?.id || l.id || crypto.randomUUID() });
	}
	saveEntries(LOGINS, [...logins.values()]);

	// passkeys only into a vault: they're never kept any other way here
	if (vault) {
		const keys = readPasskeys();
		const ids = new Set(keys.map((k) => k.id));
		for (const k of list(theirs.passkeys))
			if (typeof k?.id === "string" && typeof k?.rpId === "string" && k.key && !ids.has(k.id)) {
				ids.add(k.id);
				keys.push(k);
				added.passkeys++;
			}
		saveEntries(PASSKEYS, keys);
	}

	const never = new Set([...list(readList(NEVER)), ...list(theirs.never).filter((x) => typeof x === "string")]);
	saveEntries(NEVER, [...never].slice(-500));
	renderBookmarksBar();
	if (!active?.url) renderNewTab();
	return added;
}

function syncDone(added) {
	const parts = [
		[added.bookmarks, "bookmark"],
		[added.history, "page in history"],
		[added.logins, "password"],
		[added.passkeys, "passkey"],
	]
		.filter(([n]) => n)
		.map(([n, what]) => `${n} ${what}${n === 1 ? "" : what.endsWith("history") ? "" : "s"}`);
	$("sync-status").textContent = parts.length ? `Synced. Added here: ${parts.join(", ")}.` : "Synced. Nothing new on the other device.";
}

const syncFetch = (channel, init) => fetch("/api/sync/" + channel, { cache: "no-store", ...init });

async function syncShowing() {
	const run = ++syncRun;
	const code = makeSyncCode();
	const { key, shower, typer } = await syncKeys(syncSecret(code));
	$("sync-start").hidden = true;
	$("sync-code").textContent = code;
	$("sync-code").hidden = false;
	$("sync-status").textContent = "On the other device, choose Enter a code and type this. Waiting…";
	const res = await syncFetch(shower, { method: "PUT", body: await sealSync(key, syncPayload()) });
	if (!res.ok) return void ($("sync-status").textContent = `Couldn't start (${res.status}). Try again later.`);
	const until = Date.now() + 10 * 60_000;
	while (run === syncRun && Date.now() < until) {
		const answer = await syncFetch(typer).catch(() => null);
		if (answer?.ok) {
			try {
				return syncDone(mergeSync(await unsealSync(key, await answer.text())));
			} catch {
				return void ($("sync-status").textContent = "What came back couldn't be opened. Try again with a new code.");
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	if (run === syncRun) $("sync-status").textContent = "The code ran out. Start again for a new one.";
}

async function syncTyped(code) {
	const secret = syncSecret(code);
	if (!secret) return void ($("sync-status").textContent = "That isn't a code from the app: 16 letters and digits.");
	const run = ++syncRun;
	const { key, shower, typer } = await syncKeys(secret);
	$("sync-status").textContent = "Syncing…";
	for (let tries = 0; tries < 5 && run === syncRun; tries++) {
		const theirs = await syncFetch(shower).catch(() => null);
		if (theirs?.ok) {
			let added;
			try {
				added = mergeSync(await unsealSync(key, await theirs.text()));
			} catch {
				return void ($("sync-status").textContent = "That code doesn't match. Check it and try again.");
			}
			// ours goes back after theirs is merged, so the other device gets both
			await syncFetch(typer, { method: "PUT", body: await sealSync(key, syncPayload()) });
			$("sync-form").hidden = true;
			return syncDone(added);
		}
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
	if (run === syncRun) $("sync-status").textContent = "Nothing is waiting under that code. Check it, or start again on the other device.";
}

function openSyncPanel() {
	syncRun++;
	sheet.hidden = true;
	$("sync-start").hidden = false;
	$("sync-code").hidden = true;
	$("sync-form").hidden = true;
	$("sync-form").reset();
	$("sync-status").textContent = "";
	$("sync").hidden = false;
}

$("sync-open").addEventListener("click", openSyncPanel);
$("sync-close").addEventListener("click", () => {
	syncRun++;
	$("sync").hidden = true;
});
$("sync-show").addEventListener("click", () => syncShowing().catch((err) => ($("sync-status").textContent = err.message || String(err))));
$("sync-enter").addEventListener("click", () => {
	$("sync-start").hidden = true;
	$("sync-form").hidden = false;
	$("sync-input").focus();
});
$("sync-form").addEventListener("submit", (event) => {
	event.preventDefault();
	syncTyped($("sync-input").value).catch((err) => ($("sync-status").textContent = err.message || String(err)));
});

// ------------------------------------------------------------ certificate
// The site's certificate as the server sees it, and whether its authority
// has revoked it (src/certs.js).

async function openCert() {
	if (!active?.url?.startsWith("https:")) return;
	const url = new URL(active.url);
	sheet.hidden = true;
	$("cert-host").textContent = url.hostname;
	$("cert-status").textContent = "Checking…";
	$("cert-details").replaceChildren();
	$("cert").hidden = false;
	let cert;
	try {
		const res = await fetch("/api/cert", {
			cache: "no-store",
			headers: { "x-bios-host": url.hostname, "x-bios-port": url.port || "443" },
		});
		cert = await res.json();
		if (!res.ok) throw new Error(cert.error || `HTTP ${res.status}`);
	} catch (err) {
		$("cert-status").textContent = "Couldn't read the certificate: " + (err.message || err);
		return;
	}
	if ($("cert-host").textContent !== url.hostname) return;
	const when = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
	$("cert-status").textContent =
		cert.revoked === true
			? "Revoked: the authority that issued it says it must not be trusted."
			: !cert.trusted
				? `Not trusted: ${cert.problem || "it doesn't check out"}.`
				: cert.revoked === false
					? "Valid, and not on its authority's list of revoked certificates."
					: "Valid. Whether it was revoked couldn't be checked.";
	const rows = [
		["Issued to", [cert.commonName, cert.organization].filter(Boolean).join(", ") || cert.subject],
		["Names it covers", (cert.names || []).join(", ")],
		["Issued by", [cert.issuerName, cert.issuerOrganization].filter((v, i, all) => v && all.indexOf(v) === i).join(", ") || cert.issuer],
		["Valid", `${when(cert.validFrom)} to ${when(cert.validTo)}`],
		["Chain", (cert.chain || []).map((c) => c.commonName || c.subject).join(" → ")],
		["SHA-256 fingerprint", cert.fingerprint, true],
		["Serial number", cert.serial, true],
	];
	$("cert-details").replaceChildren(
		...rows
			.filter(([, value]) => value)
			.flatMap(([label, value, mono]) => {
				const dt = document.createElement("dt");
				dt.textContent = label;
				const dd = document.createElement("dd");
				dd.textContent = value;
				if (mono) dd.className = "mono";
				return [dt, dd];
			})
	);
}

$("cert-open").addEventListener("click", openCert);
$("cert-close").addEventListener("click", () => ($("cert").hidden = true));
$("cert").addEventListener("click", (event) => {
	if (event.target === $("cert")) $("cert").hidden = true;
});

// --------------------------------------------------------------- downloads
// Files sites send to be saved come here (see shield.js and page.js) rather
// than to the browser's own sheet, which leaves a home-screen app. Kept in the
// app's own storage on this device; with the passphrase lock, encrypted with
// its key like the history. The list of them is private data like the history.

const DOWNLOADS = "bios:downloads";
const DOWNLOAD_DB = "bios-downloads";
const MAX_DOWNLOAD = 200 * 1024 * 1024;

function downloadStore(mode, work) {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DOWNLOAD_DB, 1);
		req.onupgradeneeded = () => req.result.createObjectStore("files", { keyPath: "id" });
		req.onerror = () => reject(req.error);
		req.onsuccess = () => {
			const db = req.result;
			const tx = db.transaction("files", mode);
			const result = work(tx.objectStore("files"));
			tx.oncomplete = () => {
				db.close();
				resolve(result?.result);
			};
			tx.onerror = tx.onabort = () => {
				db.close();
				reject(tx.error);
			};
		};
	});
}

// Stored as bytes, not as a Blob: some browsers can't keep a Blob in
// IndexedDB (Safari's private windows among them).
async function sealBlob(blob) {
	const plain = await blob.arrayBuffer();
	if (!vault) return { plain };
	const iv = crypto.getRandomValues(new Uint8Array(12));
	return { iv, data: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, vault.key, plain) };
}

async function openBlob(record, type) {
	if (record.plain) return new Blob([record.plain], { type });
	if (!vault) throw new Error("Unlock the app to open this download.");
	return new Blob([await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, vault.key, record.data)], { type });
}

async function addDownload(tab, data) {
	if (!(data.blob instanceof Blob)) return;
	if (data.blob.size > MAX_DOWNLOAD) return toast("That download is larger than 200 MB, so it wasn't kept.");
	const name = String(data.name || "download").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "download";
	const type = typeof data.type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(data.type) ? data.type : "application/octet-stream";
	const id = crypto.randomUUID();
	const sealed = await sealBlob(data.blob);
	await downloadStore("readwrite", (store) => store.put({ id, ...sealed }));
	const list = readEntriesOf(DOWNLOADS);
	list.unshift({ id, name, type, size: data.blob.size, url: tab.url, at: Date.now() });
	for (const old of list.splice(100)) downloadStore("readwrite", (store) => store.delete(old.id)).catch(() => {});
	saveEntries(DOWNLOADS, list);
	if (!$("downloads").hidden) renderDownloads();
	toast(`Downloaded ${name}`, "Show", openDownloads);
}

// the download list's entries (they have no address of their own to check)
function readEntriesOf(name) {
	const list = readList(name);
	return Array.isArray(list) ? list.filter((e) => typeof e?.id === "string" && typeof e?.name === "string") : [];
}

const sizeText = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.ceil(n / 1024)) + " KB");

// Save or share: on a phone, the share sheet (Save to Files, AirDrop, another
// app); elsewhere, the browser's own download of the file.
async function saveDownload(entry) {
	const record = await downloadStore("readonly", (store) => store.get(entry.id));
	if (!record) throw new Error("This download is gone.");
	const blob = await openBlob(record, entry.type);
	const file = new File([blob], entry.name, { type: entry.type });
	if (MOBILE && navigator.canShare?.({ files: [file] })) {
		try {
			await navigator.share({ files: [file] });
			return;
		} catch (err) {
			if (err?.name === "AbortError") return;
		}
	}
	const link = document.createElement("a");
	link.href = URL.createObjectURL(file);
	link.download = entry.name;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

async function deleteDownload(id) {
	await downloadStore("readwrite", (store) => store.delete(id)).catch(() => {});
	saveEntries(
		DOWNLOADS,
		readEntriesOf(DOWNLOADS).filter((e) => e.id !== id)
	);
	renderDownloads();
}

async function deleteAllDownloads() {
	saveEntries(DOWNLOADS, []);
	await downloadStore("readwrite", (store) => store.clear()).catch(() => {});
	renderDownloads();
}

function renderDownloads() {
	const list = readEntriesOf(DOWNLOADS);
	$("downloads-empty").hidden = list.length > 0;
	$("downloads-clear").hidden = !list.length;
	$("downloads-list").replaceChildren(
		...list.map((entry) => {
			const li = document.createElement("li");
			const text = document.createElement("span");
			text.className = "text link";
			const title = document.createElement("span");
			title.textContent = entry.name;
			const small = document.createElement("small");
			small.textContent = `${sizeText(entry.size || 0)} · ${entry.url ? displayHost(entry.url) : ""} · ${timeAgo(entry.at || Date.now())}`;
			text.append(title, small);
			const actions = document.createElement("span");
			actions.className = "row-actions";
			const save = document.createElement("button");
			save.type = "button";
			save.textContent = MOBILE ? "Save or share" : "Save";
			save.addEventListener("click", () => saveDownload(entry).catch((err) => toast(err.message || String(err))));
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "Delete";
			remove.setAttribute("aria-label", `Delete ${entry.name}`);
			remove.addEventListener("click", () => deleteDownload(entry.id));
			actions.append(save, remove);
			li.append(text, actions);
			return li;
		})
	);
}

function openDownloads() {
	sheet.hidden = library.hidden = true;
	renderDownloads();
	$("downloads").hidden = false;
}

$("downloads-open").addEventListener("click", openDownloads);
$("downloads-close").addEventListener("click", () => ($("downloads").hidden = true));
$("downloads").addEventListener("click", (event) => {
	if (event.target === $("downloads")) $("downloads").hidden = true;
});
$("downloads-clear").addEventListener("click", () => {
	if (confirm("Delete every download kept in the app?")) deleteAllDownloads();
});

// A short note at the bottom of the screen, with one action.
let toastTimer = 0;
function toast(text, action = "", run = null) {
	$("toast-text").textContent = text;
	$("toast-action").textContent = action;
	$("toast-action").onclick = () => {
		$("toast").hidden = true;
		run?.();
	};
	$("toast").hidden = false;
	pulse($("toast"), RISE);
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
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
	const oldKey = vault?.key || null;
	vault = { key: await deriveKey(passphrase, salt), salt, data };
	await seal();
	for (const name of PRIVATE) localStorage.removeItem(name);
	// the passwords sealed with this device's key move into the vault
	sealedData = {};
	localStorage.removeItem(SEALED_KEY);
	await resealDownloads(oldKey, vault.key);
}

async function removePassphrase() {
	const { data, key } = vault;
	vault = null;
	await sealing;
	// a session unlocked with the passphrase never opened this device's key: the passwords need it now
	if (!deviceKey) await openOnDevice();
	for (const name of PRIVATE) saveEntries(name, data[name] ?? []);
	localStorage.removeItem(VAULT);
	await resealDownloads(key, null);
}

// The downloaded files follow the lock: encrypted with its new key, or
// stored plainly again when it's turned off.
async function resealDownloads(oldKey, newKey) {
	const records = await downloadStore("readonly", (store) => store.getAll()).catch(() => []);
	for (const record of records || []) {
		try {
			const plain = record.plain || (await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, oldKey, record.data));
			let next = { id: record.id, plain };
			if (newKey) {
				const iv = crypto.getRandomValues(new Uint8Array(12));
				next = { id: record.id, iv, data: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, newKey, plain) };
			}
			await downloadStore("readwrite", (store) => store.put(next));
		} catch {
			// one that can't be read with the old key is left as it was
		}
	}
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
	// encrypted with the forgotten passphrase: gone with it
	await deleteAllDownloads();
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

function recordVisit({ url, title, tor }) {
	if (tor || !/^https?:/.test(url)) return;
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
	if (!vault) await openOnDevice();
	showVaultButtons();
	const firstLaunch = !sessionStorage.getItem("bios:session");
	sessionStorage.setItem("bios:session", "1");
	const loaded = await loadSettings().catch(() => null);
	if (firstLaunch && loaded && loaded.wipe) await clearAllSiteData();
	if (isolated) {
		torAvailable = !!(await torState()).available;
		$("tor-tab").hidden = !torAvailable;
		if (firstLaunch) await forgetTor();
	}
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
		else if (!active) createTab();
	} else {
		if (!restoreTabs()) createTab();
		// warm up the service worker and transport so the first search is fast
		ensureReady().catch((err) => {
			error.textContent = err.message || String(err);
		});
	}
});

"use strict";

// Badger's browser UI for desktop. The pages are native views that the main
// process (main.js) owns; this window draws the tabs, toolbar, new tab page
// and panels around them and tells main.js what to show where.
/* global badger */

// Keys match SEARCH_ENGINES in rules.js.
const SEARCH = {
	brave: "https://search.brave.com/search?q=%s",
	duckduckgo: "https://duckduckgo.com/?q=%s",
	bing: "https://www.bing.com/search?q=%s",
	google: "https://www.google.com/search?q=%s",
};

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
const threatPanel = $("threat");
const suggestEl = $("suggest");

let platform = "win32";
let settings = { ads: true, threats: true, search: "brave", wipe: false, allow: [] };

/**
 * @param {string} input
 * @returns {string} Fully qualified URL
 */
function toUrl(input) {
	input = input.trim();
	try {
		const url = new URL(input);
		if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
	} catch {
		// not a full URL
	}
	try {
		const url = new URL(`https://${input}`);
		if (url.hostname.includes(".") && !input.includes(" ")) return url.toString();
	} catch {
		// not a hostname
	}
	return searchUrl(input);
}

function searchUrl(query) {
	return (SEARCH[settings.search] || SEARCH.brave).replace("%s", encodeURIComponent(query.trim()));
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
	img.src = "shared/icons/badger.png";
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

// Bookmarks, history, open tabs and stats live in a file that main.js
// writes within a moment of every change, so a crash or a forced quit loses
// almost nothing. (This window's own storage only reaches the disk now and
// then.) They're loaded once at startup and kept here in memory.
const store = new Map();

function readList(name) {
	return store.has(name) ? store.get(name) : [];
}

function saveEntries(name, value) {
	store.set(name, value);
	badger.saveStore(name, value);
}

function removeEntry(name) {
	store.delete(name);
	badger.saveStore(name, null);
}

// -------------------------------------------------------------------- tabs

/**
 * @typedef {{ id: number, url: string, title: string, loading: boolean,
 *   pending: boolean, canGoBack: boolean, canGoForward: boolean,
 *   threat: null | { url: string, host: string, kind: string } }} Tab
 * `pending`: a restored tab whose page loads the first time it's shown.
 */
/** @type {Tab[]} */
const tabs = [];
/** @type {Tab | null} */
let active = null;
let lastActive = null;
/** @type {[Tab, Tab] | null} two tabs side by side */
let split = null;
let nextTabId = 1;
const MAX_TABS = 50;
const closedTabs = []; // for Ctrl+Shift+T

function createTab(url = "", { after = null, lazy = false, title = "", select = true } = {}) {
	if (tabs.length >= MAX_TABS) return null;
	/** @type {Tab} */
	const tab = {
		id: nextTabId++,
		url: lazy ? url : "",
		title: lazy ? title : "",
		loading: false,
		pending: lazy,
		canGoBack: false,
		canGoForward: false,
		threat: null,
	};
	badger.createTab(tab.id);
	const at = after && tabs.includes(after) ? tabs.indexOf(after) + 1 : tabs.length;
	tabs.splice(at, 0, tab);
	if (select) selectTab(tab);
	else renderTabs();
	if (url && !lazy) go(url, tab);
	else if (!url && select) focusInput(homeInput);
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
	threatPanel.hidden = !tab.threat;
	if (tab.threat) showThreat(tab);
	layout();
	renderTabs();
	showAddress();
	if (tab.url) badger.command(tab.id, "focus");
}

function closeTab(tab) {
	const i = tabs.indexOf(tab);
	if (i === -1) return;
	if (split?.includes(tab)) split = null;
	if (tab.url) closedTabs.push({ url: tab.url, title: tab.title, index: i });
	if (closedTabs.length > 20) closedTabs.shift();
	tabs.splice(i, 1);
	badger.closeTab(tab.id);
	if (lastActive === tab) lastActive = null;
	if (!tabs.length) createTab();
	else if (tab === active) selectTab(tabs[Math.min(i, tabs.length - 1)]);
	else {
		layout();
		renderTabs();
	}
}

function reopenTab() {
	const last = closedTabs.pop();
	if (last) createTab(last.url, { after: tabs[last.index - 1] || null });
}

// The pages are native views on top of this window. They show only when no
// panel is open (a panel would be drawn underneath them); while suggestions
// are open, the page moves down below the list.
let suggestBottom = 0;
function layout() {
	if (!active) return;
	const overlay = !sheet.hidden || !library.hidden || !threatPanel.hidden;
	const panes = split || (active.url ? [active] : []);
	document.body.classList.toggle("browsing", !!active.url);
	document.body.classList.toggle("loading", active.loading);
	framesEl.classList.toggle("split", !!split);
	framesEl.replaceChildren(
		...(split || []).map((t) => {
			const pane = document.createElement("div");
			pane.className = "pane";
			pane.classList.toggle("focused", t === active);
			return pane;
		})
	);
	const top = Math.max(chrome.offsetHeight, suggestEl.hidden ? 0 : suggestBottom);
	badger.show(overlay ? [] : panes.filter((t) => t.url).map((t) => t.id), top);
	$("back").disabled = !active.canGoBack;
	$("forward").disabled = !active.canGoForward;
}

new ResizeObserver(() => {
	document.documentElement.style.setProperty("--chrome-h", chrome.offsetHeight + "px");
	layout();
}).observe(chrome);

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
			close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
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
	document.title = active?.url ? `${tabLabel(active)} - Badger` : "Badger";

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

// Open tabs are kept on this computer so they come back when Badger reopens.
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
		? saved.tabs.filter((t) => typeof t?.url === "string" && /^https?:/.test(t.url)).slice(0, MAX_TABS)
		: [];
	if (!list.length) return false;
	const made = list.map((t) =>
		createTab(t.url, { lazy: true, title: String(t.title || "").slice(0, 300), select: false })
	);
	selectTab(made[saved.active] || made[0]);
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
		const partner = [lastActive, ...tabs].find((t) => t && t !== active && t.url && tabs.includes(t));
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

// ------------------------------------------------------------- navigation

function go(input, tab = active) {
	if (!input.trim() || !tab) return;
	error.textContent = "";
	hideSuggest();
	let url;
	try {
		url = toUrl(input);
	} catch (err) {
		error.textContent = err.message || String(err);
		return;
	}
	tab.url = url;
	tab.title = "";
	tab.pending = false;
	tab.threat = null;
	tab.loading = true;
	if (tab === active) {
		threatPanel.hidden = true;
		layout();
		showAddress();
	}
	renderTabs();
	badger.load(tab.id, url);
}

function showAddress() {
	const url = active?.url || "";
	let state = "shield";
	if (url.startsWith("https:")) state = "lock";
	else if (url.startsWith("http:")) state = "warn";
	siteBtn.dataset.state = state;
	star.hidden = !url;
	const marked = isBookmarked(url);
	star.setAttribute("aria-pressed", String(marked));
	star.setAttribute("aria-label", marked ? "Remove bookmark" : "Bookmark this page");
	star.title = marked ? "Remove bookmark (Ctrl+D)" : "Bookmark this page (Ctrl+D)";
	if (document.activeElement === barInput) return;
	const shown = url ? displayHost(url) : "";
	if (barInput.value !== shown) barInput.value = shown;
}

const tabById = (id) => tabs.find((t) => t.id === id);

// What a tab's page reports: address, title, loading, history.
badger.on("tab", (state) => {
	const tab = tabById(state.id);
	if (!tab || tab.pending) return;
	const url = state.url && /^https?:/.test(state.url) ? state.url : tab.url;
	let title = String(state.title || "").slice(0, 300);
	// Chromium uses the address as the title until the page names itself
	if (title === url || title === url.replace(/^https?:\/\//, "")) title = "";
	const moved = url !== tab.url;
	const retitled = title !== tab.title;
	tab.url = url;
	tab.title = title;
	tab.loading = !!state.loading;
	tab.canGoBack = !!state.canGoBack;
	tab.canGoForward = !!state.canGoForward;
	if ((moved || retitled) && state.ok && !tab.threat) recordVisit(tab);
	if (tab === active || split?.includes(tab)) layout();
	renderTabs();
	if (tab === active) showAddress();
});

// A page asked for a new window (a link, window.open or "Open link in new
// tab"); main.js already checked it followed a real click.
badger.on("open", ({ opener, url, background }) => {
	const after = tabById(opener) || active;
	createTab(url, { after, select: !background });
});

// In split view, clicking into a pane makes it the active tab.
badger.on("focus", (id) => {
	const tab = tabById(id);
	if (tab && split?.includes(tab) && tab !== active) selectTab(tab);
});

badger.on("blocked", (count) => addBlocked(count));

// ------------------------------------------------------- dangerous sites

const THREAT_TEXT = {
	phishing: "is a known phishing site: it pretends to be a site you trust to steal passwords or payment details.",
	malware: "is known to spread malware that can harm your computer or steal your data.",
};

badger.on("threat", ({ id, url, host, kind }) => {
	const tab = tabById(id);
	if (!tab) return;
	tab.threat = { url, host, kind };
	tab.loading = false;
	if (tab === active) showThreat(tab);
	else renderTabs();
});

function showThreat(tab) {
	$("threat-text").textContent = `${tab.threat.host} ${THREAT_TEXT[tab.threat.kind] || THREAT_TEXT.malware}`;
	threatPanel.hidden = false;
	layout();
	$("threat-back").focus();
}

$("threat-back").addEventListener("click", () => {
	const tab = active;
	tab.threat = null;
	threatPanel.hidden = true;
	// Chromium left an empty page at the blocked address: go back past it,
	// or to the new tab page when there's nothing before it
	if (tab.canGoBack) badger.command(tab.id, "back");
	else {
		tab.url = "";
		tab.title = "";
		renderNewTab();
	}
	layout();
	renderTabs();
	showAddress();
});

$("threat-continue").addEventListener("click", () => {
	const tab = active;
	const url = tab.threat.url;
	tab.threat = null;
	threatPanel.hidden = true;
	tab.url = url;
	tab.loading = true;
	badger.proceed(tab.id, url);
	layout();
	renderTabs();
	showAddress();
});

// --------------------------------------------------------- toolbar, keys

function tabCommand(cmd, tab = active) {
	if (!tab?.url) return;
	if (cmd === "reload" && tab.loading) return badger.command(tab.id, "stop");
	badger.command(tab.id, cmd);
}

$("back").addEventListener("click", () => tabCommand("back"));
$("forward").addEventListener("click", () => tabCommand("forward"));
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

// The keyboard belongs to whichever view Chromium last focused: take it back
// for this window before focusing one of its fields.
async function focusInput(input) {
	await badger.focusUi();
	input.focus({ preventScroll: true });
}

function focusAddress() {
	focusInput(active?.url ? barInput : homeInput);
}

function cycleTab(step) {
	const i = tabs.indexOf(active);
	selectTab(tabs[(i + step + tabs.length) % tabs.length]);
}

// Shortcuts pressed while a page has focus arrive from main.js; the same
// keys pressed in this window are mapped here (rules.js shortcutFor).
const SHORTCUTS = {
	"new-tab": () => createTab(),
	"close-tab": () => closeTab(active),
	"reopen-tab": reopenTab,
	"focus-address": focusAddress,
	reload: () => tabCommand("reload"),
	back: () => tabCommand("back"),
	forward: () => tabCommand("forward"),
	"next-tab": () => cycleTab(1),
	"prev-tab": () => cycleTab(-1),
	bookmark: toggleBookmark,
	history: openHistory,
};
badger.on("shortcut", (name) => SHORTCUTS[name]?.());

function shortcutFor(event) {
	const mod = platform === "darwin" ? event.metaKey : event.ctrlKey;
	const key = event.key.toLowerCase();
	if (key === "f5") return "reload";
	if (event.altKey && !mod) return key === "arrowleft" ? "back" : key === "arrowright" ? "forward" : null;
	if (!mod) return null;
	if (key === "tab") return event.shiftKey ? "prev-tab" : "next-tab";
	if (event.shiftKey) return key === "t" ? "reopen-tab" : null;
	return { t: "new-tab", w: "close-tab", l: "focus-address", k: "focus-address", r: "reload", d: "bookmark", h: "history" }[key] || null;
}

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		sheet.hidden = library.hidden = true;
		hideSuggest();
		layout();
		return;
	}
	const name = shortcutFor(event);
	if (!name || !SHORTCUTS[name]) return;
	event.preventDefault();
	SHORTCUTS[name]();
});

// ---------------------------------------- address bar suggestions/commands

const COMMANDS = [
	{ name: "New tab", run: () => createTab() },
	{ name: "Close tab", run: () => closeTab(active) },
	{ name: "Reopen closed tab", when: () => closedTabs.length > 0, run: reopenTab },
	{ name: "History", run: openHistory },
	{ name: "Settings", run: openSheet },
	{ name: "Bookmark this page", when: () => !!active?.url && !isBookmarked(active.url), run: toggleBookmark },
	{ name: "Remove bookmark", when: () => isBookmarked(active?.url), run: toggleBookmark },
	{ name: "Split view", when: () => !split && canSplit(), run: toggleSplit },
	{ name: "Close split view", when: () => !!split, run: toggleSplit },
	{ name: "Reload page", when: () => !!active?.url, run: () => tabCommand("reload") },
	// opens Settings on the button rather than wiping from a typo
	{ name: "Clear history and site data", run: () => openSheet().then(() => $("wipe-now").focus()) },
];

const SEARCH_GLYPH = '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>';
const COMMAND_GLYPH = '<path d="M5 7l5 5-5 5M12 17h7"/>';

let suggestFor = null;
let suggestItems = [];
let suggestIndex = 0;

function suggestions(query) {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const items = [
		{
			glyph: SEARCH_GLYPH,
			label: query.trim(),
			detail: toUrl(query) === searchUrl(query) ? "Search" : "Go to address",
			run: () => go(query),
		},
	];
	if (q.length >= 2)
		for (const c of COMMANDS)
			if ((!c.when || c.when()) && c.name.toLowerCase().includes(q))
				items.push({ glyph: COMMAND_GLYPH, label: c.name, detail: "Command", run: c.run });
	const seen = new Set();
	const pages = [...readEntries(BOOKMARKS).map((e) => ({ ...e, bookmark: true })), ...readEntries(HISTORY)];
	for (const page of pages) {
		if (items.length >= 8) break;
		if (seen.has(page.url)) continue;
		if (!(page.title || "").toLowerCase().includes(q) && !page.url.toLowerCase().includes(q)) continue;
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
	suggestBottom = suggestEl.getBoundingClientRect().bottom + 8;
	layout();
}

function markSuggestion() {
	suggestEl.querySelectorAll("li").forEach((li, i) => li.setAttribute("aria-selected", String(i === suggestIndex)));
	suggestFor?.setAttribute("aria-activedescendant", `suggest-${suggestIndex}`);
}

function hideSuggest() {
	const wasOpen = !suggestEl.hidden;
	suggestEl.hidden = true;
	suggestItems = [];
	suggestFor?.setAttribute("aria-expanded", "false");
	suggestFor?.removeAttribute("aria-activedescendant");
	if (wasOpen) layout();
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

function timeAgo(ms) {
	const minutes = Math.round((Date.now() - ms) / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.round(hours / 24)} days ago`;
}

let currentSite = "";

function renderSheet() {
	const site = active?.url ? currentSite : "";
	$("sheet-site").textContent = site ? displayHost(active.url) : "Settings";
	const trust = $("sheet-trust");
	if (!site) trust.textContent = "";
	else if (active.url.startsWith("http:")) trust.textContent = "Not secure: this connection isn't encrypted.";
	else trust.textContent = "Encrypted connection.";
	$("site-row").hidden = !site;
	$("site-toggle").checked = !settings.allow.includes(site);
	for (const input of sheet.querySelectorAll("[data-setting]")) input.checked = !!settings[input.dataset.setting];
	$("search-engine").value = settings.search;
}

async function openSheet() {
	library.hidden = threatPanel.hidden = true;
	currentSite = active?.url ? await badger.siteOf(active.url) : "";
	sheet.hidden = false;
	layout();
	renderSheet();
	const status = await badger.status();
	$("filter-status").textContent = status.blockerUpdatedAt
		? `Block lists updated ${timeAgo(status.blockerUpdatedAt)}; ${status.threats.toLocaleString()} dangerous sites listed. Problems are logged to ${status.log}.`
		: "Block lists are still downloading. Ads aren't blocked until they finish.";
}

function closePanels() {
	sheet.hidden = library.hidden = true;
	layout();
}

siteBtn.addEventListener("click", openSheet);
$("menu-btn").addEventListener("click", openSheet);
$("sheet-close").addEventListener("click", closePanels);
for (const panel of [sheet, library])
	panel.addEventListener("click", (event) => {
		if (event.target === panel) closePanels();
	});

async function saveSettings(next) {
	settings = await badger.setSettings(next);
	renderSheet();
}

for (const input of sheet.querySelectorAll("[data-setting]")) {
	input.addEventListener("change", async () => {
		await saveSettings({ [input.dataset.setting]: input.checked });
		if (input.dataset.setting !== "wipe") tabCommand("reload");
	});
}

$("search-engine").addEventListener("change", (event) => saveSettings({ search: event.target.value }));

$("site-toggle").addEventListener("change", async (event) => {
	if (!currentSite) return;
	const allow = new Set(settings.allow);
	if (event.target.checked) allow.delete(currentSite);
	else allow.add(currentSite);
	await saveSettings({ allow: [...allow] });
	tabCommand("reload");
});

// Deletes every site's cookies, storage and logins, the history and the open
// tabs. Bookmarks stay.
async function clearAllSiteData() {
	removeEntry(HISTORY);
	split = null;
	for (const tab of [...tabs]) closeTab(tab);
	closedTabs.length = 0;
	removeEntry(TABS);
	await badger.clearSiteData();
	renderNewTab();
}

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
// Kept only in this window's storage on this computer.

const HISTORY = "bios:history";
const BOOKMARKS = "bios:bookmarks";
const MAX_HISTORY = 1000;

function readEntries(name) {
	const list = readList(name);
	return Array.isArray(list) ? list.filter((e) => typeof e?.url === "string" && /^https?:/.test(e.url)) : [];
}

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
	if (i === -1) list.unshift({ url, title: nameOf({ url, title: active.title }).slice(0, 200) });
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
	$("history-list").replaceChildren(...list.map((h) => linkRow(h, `${displayHost(h.url)} · ${timeAgo(h.at)}`)));
}

function openHistory() {
	sheet.hidden = threatPanel.hidden = true;
	renderHistory();
	library.hidden = false;
	layout();
}

$("history-open").addEventListener("click", openHistory);
$("library-close").addEventListener("click", closePanels);
$("history-clear").addEventListener("click", () => {
	removeEntry(HISTORY);
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

// Ads and trackers blocked, counted per day on this computer.
const BLOCKED = "bios:blocked";
// local calendar day, YYYY-MM-DD
const dayKey = (ms) => new Date(ms).toLocaleDateString("en-CA");
const lastWeek = () => new Set(Array.from({ length: 7 }, (_, i) => dayKey(Date.now() - i * 86_400_000)));

function blockedByDay() {
	const byDay = readList(BLOCKED);
	return byDay && typeof byDay === "object" && !Array.isArray(byDay) ? byDay : {};
}

function addBlocked(count) {
	count = Math.min(Math.max(0, Math.floor(Number(count) || 0)), 100_000);
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
	return Object.entries(blockedByDay()).reduce((sum, [day, n]) => sum + (week.has(day) ? Number(n) || 0 : 0), 0);
}

// ----------------------------------------------------------------- startup

(async () => {
	({ platform } = await badger.ready());
	for (const [name, value] of Object.entries(await badger.loadStore())) store.set(name, value);
	const kbd = platform === "darwin" ? "⌘K" : "Ctrl K";
	for (const el of document.querySelectorAll(".kbd")) el.textContent = kbd;
	settings = await badger.getSettings();
	// a fresh launch (sessionStorage starts empty) clears site data first
	// when that setting is on
	const firstLaunch = !sessionStorage.getItem("bios:session");
	sessionStorage.setItem("bios:session", "1");
	if (firstLaunch && settings.wipe) {
		removeEntry(HISTORY);
		removeEntry(TABS);
		await badger.clearSiteData();
	}
	renderBookmarksBar();
	if (!restoreTabs()) createTab();
})();

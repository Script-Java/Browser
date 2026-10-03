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
const star = $("star");
const error = $("error");
const sheet = $("sheet");
const library = $("library");

// The page area starts below the chrome, whose height changes with the
// bookmarks bar.
new ResizeObserver(() =>
	document.documentElement.style.setProperty("--chrome-h", chrome.offsetHeight + "px")
).observe(chrome);

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

	const engine = SEARCH[settings?.search] || SEARCH.brave;
	return engine.replace("%s", encodeURIComponent(input));
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

// ----------------------------------------------------------- site origins

function rememberOrigin(key) {
	const keys = new Set(readList("bios:origins"));
	if (keys.has(key)) return;
	keys.add(key);
	localStorage.setItem("bios:origins", JSON.stringify([...keys]));
}

function readList(name) {
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

/** @type {{ id: number, frame: HTMLIFrameElement, url: string, title: string, siteOrigin: string, loading: boolean }[]} */
const tabs = [];
let active = null;
let nextTabId = 1;

function createTab(url) {
	const id = nextTabId++;
	const frame = document.createElement("iframe");
	// unique per tab: page.js aims target=_blank links at its own tab's name
	frame.name = `uvframe-${id}`;
	frame.title = "Page";
	frame.allow =
		"autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write";
	frame.hidden = true;
	framesEl.appendChild(frame);

	const tab = { id, frame, url: "", title: "", siteOrigin: "", loading: false };
	frame.addEventListener("load", () => {
		if (!tab.url) return;
		setLoading(tab, false);
		syncAddress(tab);
		try {
			frame.contentWindow.addEventListener("pagehide", () => setLoading(tab, true));
		} catch {
			// cross-origin frame
		}
	});
	tabs.push(tab);
	selectTab(tab);
	if (url) go(url, tab);
	else homeInput.focus({ preventScroll: true });
	return tab;
}

function selectTab(tab) {
	active = tab;
	for (const t of tabs) t.frame.hidden = t !== tab || !t.url;
	document.body.classList.toggle("browsing", !!tab.url);
	document.body.classList.toggle("loading", tab.loading);
	error.textContent = "";
	homeInput.value = "";
	if (!tab.url) renderNewTab();
	renderTabs();
	showAddress();
}

function closeTab(tab) {
	const i = tabs.indexOf(tab);
	if (i === -1) return;
	tabs.splice(i, 1);
	tab.frame.remove();
	if (!tabs.length) createTab();
	else if (tab === active) selectTab(tabs[Math.min(i, tabs.length - 1)]);
	else renderTabs();
}

function setLoading(tab, loading) {
	tab.loading = loading;
	if (tab === active) document.body.classList.toggle("loading", loading);
}

function tabLabel(tab) {
	return tab.title || (tab.url ? displayHost(tab.url) : "New Tab");
}

function renderTabs() {
	$("tabs").replaceChildren(
		...tabs.map((tab) => {
			const el = document.createElement("div");
			el.className = "tab";
			el.setAttribute("role", "tab");
			el.setAttribute("aria-selected", String(tab === active));
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
			// middle click closes, like any browser
			el.addEventListener("auxclick", (event) => {
				if (event.button === 1) closeTab(tab);
			});
			return el;
		})
	);
	document.title = active?.url ? tabLabel(active) : "Badger";
}

// ------------------------------------------------------------- navigation

let startup = Promise.resolve();

async function go(input, tab = active) {
	if (!input.trim()) return;
	error.textContent = "";
	try {
		await startup;
		await ensureReady();
		const url = toUrl(input);
		// before touching the tab: throws for addresses that can't be opened
		const src = await frameUrlFor(url, tab);
		tab.url = url;
		tab.title = "";
		setLoading(tab, true);
		if (tab === active) selectTab(tab);
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
	star.setAttribute("aria-pressed", String(isBookmarked(url)));
	if (document.activeElement === barInput) return;
	const shown = url ? displayHost(url) : "";
	if (barInput.value !== shown) barInput.value = shown;
}

function updateTab(tab, url, title) {
	const changed = url !== tab.url || title !== tab.title;
	tab.url = url;
	tab.title = title;
	if (!changed) return;
	recordVisit(tab);
	renderTabs();
	if (tab === active) showAddress();
}

function syncAddress(tab) {
	const url = frameLocation(tab);
	if (url && url !== tab.url) updateTab(tab, url, tab.title);
}

const tabFor = (source) => tabs.find((t) => t.frame.contentWindow === source);

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

// catches pushState/SPA navigations
setInterval(() => active && syncAddress(active), 500);

// Back, forward and reload act on the tab's own page. In isolation mode the
// frame is cross-origin, so the page does it when the shell asks.
function tabCommand(cmd) {
	const tab = active;
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

$("back").addEventListener("click", () => tabCommand("back"));
$("forward").addEventListener("click", () => tabCommand("forward"));
$("reload").addEventListener("click", () => tabCommand("reload"));
$("new-tab").addEventListener("click", () => createTab());

homeForm.addEventListener("submit", (event) => {
	event.preventDefault();
	homeInput.blur();
	go(homeInput.value);
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
	if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
	const key = event.key.toLowerCase();
	if (key !== "k" && key !== "l") return;
	event.preventDefault();
	(active?.url ? barInput : homeInput).focus();
});

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
	sheet.hidden = false;
	renderSheet();
	try {
		await loadSettings();
		renderSheet();
	} catch (err) {
		$("filter-status").textContent = err.message;
	}
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
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") sheet.hidden = library.hidden = true;
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

// Deletes every site's cookies, storage and logins, and the history. Every
// tab closes first so no page holds its databases open.
async function clearAllSiteData() {
	localStorage.removeItem(HISTORY);
	for (const tab of [...tabs]) closeTab(tab);
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
	try {
		localStorage.setItem(name, JSON.stringify(list));
	} catch {
		// storage full or blocked: skip rather than break browsing
	}
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
			return button;
		})
	);
}

star.addEventListener("click", () => {
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
});

function renderHistory() {
	const list = readEntries(HISTORY).slice(0, 300);
	$("history-empty").hidden = list.length > 0;
	$("history-clear").hidden = !list.length;
	$("history-list").replaceChildren(
		...list.map((h) => linkRow(h, `${displayHost(h.url)} · ${timeAgo(h.at)}`))
	);
}

$("history-open").addEventListener("click", () => {
	sheet.hidden = true;
	renderHistory();
	library.hidden = false;
});
$("library-close").addEventListener("click", () => {
	library.hidden = true;
});
$("history-clear").addEventListener("click", () => {
	localStorage.removeItem(HISTORY);
	renderHistory();
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

function addBlocked(count) {
	count = Math.min(Math.max(0, Math.floor(Number(count) || 0)), 10_000);
	if (!count) return;
	const days = readList(BLOCKED);
	const byDay = days && typeof days === "object" && !Array.isArray(days) ? days : {};
	const today = dayKey(Date.now());
	byDay[today] = (byDay[today] || 0) + count;
	const week = new Set(Array.from({ length: 7 }, (_, i) => dayKey(Date.now() - i * 86_400_000)));
	for (const day of Object.keys(byDay)) if (!week.has(day)) delete byDay[day];
	saveEntries(BLOCKED, byDay);
	if (!active?.url) $("stat-blocked").textContent = blockedThisWeek().toLocaleString();
}

function blockedThisWeek() {
	const byDay = readList(BLOCKED);
	if (!byDay || typeof byDay !== "object" || Array.isArray(byDay)) return 0;
	const week = new Set(Array.from({ length: 7 }, (_, i) => dayKey(Date.now() - i * 86_400_000)));
	return Object.entries(byDay).reduce((sum, [day, n]) => sum + (week.has(day) ? Number(n) || 0 : 0), 0);
}

navigator.serviceWorker?.addEventListener("message", (event) => {
	if (event.data?.bios === "blocked") addBlocked(event.data.count);
});
navigator.serviceWorker?.startMessages();

// ----------------------------------------------------------------- startup

// A fresh launch (sessionStorage is empty after iOS closes the app) clears
// site data first when that setting is on.
startup = (async () => {
	const firstLaunch = !sessionStorage.getItem("bios:session");
	sessionStorage.setItem("bios:session", "1");
	const loaded = await loadSettings().catch(() => null);
	if (firstLaunch && loaded && loaded.wipe) await clearAllSiteData();
})().catch((err) => console.warn("startup:", err));

renderBookmarksBar();

// A proxied page that escaped to the top level redirects to /#<url>.
if (location.hash.length > 1) {
	const target = decodeURIComponent(location.hash.slice(1));
	history.replaceState(null, "", "/");
	createTab(target);
} else {
	createTab();
	// warm up the service worker and transport so the first search is fast
	startup.then(ensureReady).catch((err) => {
		error.textContent = err.message || String(err);
	});
}

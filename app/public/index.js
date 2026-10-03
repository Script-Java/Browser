"use strict";

// Marks this window as the shell so the no-popup layer in proxied pages
// (src/client/page.js) can find the tab frame and never navigate the shell.
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

const frame = document.getElementById("uv-frame");
const homeForm = document.getElementById("home-form");
const homeInput = document.getElementById("home-input");
const barForm = document.getElementById("bar-form");
const barInput = document.getElementById("bar-input");
const siteBtn = document.getElementById("site-btn");
const error = document.getElementById("error");
const sheet = document.getElementById("sheet");

// What the tab is showing. `url` only changes on messages the shell can
// trust (see onFrameMessage).
let current = { url: "", title: "" };

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
	const hash = target.hash.slice(1);
	target.hash = "";
	return (
		"/scramjet/" +
		encodeURIComponent(target.href) +
		(hash ? "#" + encodeURIComponent(hash) : "")
	);
}

async function frameUrlFor(url) {
	const path = proxyPath(url);
	if (!isolated) return path;
	const key = await BiosSiteKey.siteKey(new URL(url).hostname);
	rememberOrigin(key);
	const origin = originFor(key);
	tabSiteOrigin = origin;
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

	for (const [old, entry] of anchors) {
		if (anchors.size <= MAX_ANCHORS) break;
		if (old === origin || old === tabOrigin()) continue;
		entry.frame.remove();
		anchors.delete(old);
	}
	return ready;
}

// Site origin the tab is on (isolation mode).
let tabSiteOrigin = "";
const tabOrigin = () => tabSiteOrigin;

// ------------------------------------------------------------- navigation

let startup = Promise.resolve();

async function go(input) {
	if (!input.trim()) return;
	error.textContent = "";
	try {
		await startup;
		await ensureReady();
	} catch (err) {
		error.textContent = err.message || String(err);
		return;
	}
	const url = toUrl(input);
	document.body.classList.add("browsing", "loading");
	current = { url, title: "" };
	showAddress();
	frame.src = await frameUrlFor(url);
}

// Shared mode only: the frame is same-origin, so read its address directly.
function frameLocation() {
	if (isolated) return "";
	try {
		const client = frame.contentWindow[Symbol.for("scramjet client global")];
		return client ? client.url.href : "";
	} catch {
		return "";
	}
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

function showAddress() {
	const browsing = document.body.classList.contains("browsing");
	const url = browsing ? current.url : "";
	let state = "shield";
	if (url.startsWith("https:")) state = "lock";
	else if (url.startsWith("http:")) state = "warn";
	siteBtn.dataset.state = state;
	if (document.activeElement === barInput) return;
	const shown = url ? displayHost(url) : "";
	if (barInput.value !== shown) barInput.value = shown;
}

function syncAddress() {
	const url = frameLocation();
	if (url && url !== current.url) {
		current = { url, title: current.title };
		recordVisit(current);
	}
	showAddress();
}

async function onFrameMessage(event) {
	if (event.source !== frame.contentWindow) return;
	const data = event.data;

	// The tab landed on a site origin with no proxy connection yet.
	if (
		isolated &&
		data?.bios === "need-anchor" &&
		SITE_ORIGIN.test(event.origin)
	) {
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
		tabSiteOrigin = event.origin;
		ensureAnchor(event.origin);
	} else if (event.origin !== location.origin) {
		return;
	}

	current = { url: url.href, title: String(data.title || "") };
	recordVisit(current);
	showAddress();
}

function goHome() {
	document.body.classList.remove("browsing", "loading");
	frame.src = "about:blank";
	current = { url: "", title: "" };
	barInput.value = "";
	homeInput.value = "";
	showAddress();
	renderBookmarks();
}

window.addEventListener("message", onFrameMessage);

frame.addEventListener("load", () => {
	document.body.classList.remove("loading");
	syncAddress();
	try {
		frame.contentWindow.addEventListener("pagehide", () => {
			document.body.classList.add("loading");
		});
	} catch {
		// cross-origin frame
	}
});

// catches pushState/SPA navigations
setInterval(syncAddress, 500);

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
	if (current.url && document.body.classList.contains("browsing"))
		barInput.value = current.url;
	barInput.select();
});
barInput.addEventListener("blur", showAddress);

document.getElementById("back").addEventListener("click", () => {
	if (!document.body.classList.contains("browsing")) return;
	try {
		frame.contentWindow.history.back();
	} catch {
		history.back();
	}
});

document.getElementById("forward").addEventListener("click", () => {
	if (!document.body.classList.contains("browsing")) return;
	try {
		frame.contentWindow.history.forward();
	} catch {
		history.forward();
	}
});

document.getElementById("reload").addEventListener("click", () => {
	if (!document.body.classList.contains("browsing")) return;
	document.body.classList.add("loading");
	try {
		frame.contentWindow.location.reload();
	} catch {
		// cross-origin (isolation mode): ask the page to reload itself
		frame.contentWindow.postMessage({ bios: "cmd", cmd: "reload" }, "*");
	}
});

document.getElementById("home-btn").addEventListener("click", goHome);

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
	// the proxy's service worker keeps a copy for 30s; have it fetch these
	navigator.serviceWorker
		?.getRegistration("/scramjet/")
		.then((reg) => reg?.active?.postMessage({ bios: "settings" }))
		.catch(() => {});
	renderSheet();
}

function reloadTab() {
	if (document.body.classList.contains("browsing"))
		document.getElementById("reload").click();
}

function currentSite() {
	const host = current.url && displayHost(current.url);
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
	const site = document.body.classList.contains("browsing")
		? currentSite()
		: "";
	document.getElementById("sheet-site").textContent = site
		? displayHost(current.url)
		: "Protection";

	const trust = document.getElementById("sheet-trust");
	if (!site) trust.textContent = "";
	else if (current.url.startsWith("http:"))
		trust.textContent = "Not secure: this connection isn't encrypted.";
	else if (isolated)
		trust.textContent =
			"Address verified. This site runs walled off from other sites.";
	else trust.textContent = "Encrypted connection.";

	const siteRow = document.getElementById("site-row");
	siteRow.hidden = !site;
	document.getElementById("site-toggle").checked =
		!settings.allow.includes(site);

	const bookmarkBtn = document.getElementById("bookmark-btn");
	bookmarkBtn.hidden = !site;
	bookmarkBtn.textContent = isBookmarked(current.url) ? "Remove bookmark" : "Add bookmark";

	for (const input of sheet.querySelectorAll("[data-setting]"))
		input.checked = !!settings[input.dataset.setting];
	document.getElementById("search-engine").value = settings.search;

	document.getElementById("lock-form").hidden = !config.auth;

	const iso = document.getElementById("isolation-status");
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
		document.getElementById("filter-status").textContent = err.message;
	}
	fetch("/filters/status", { cache: "no-store" })
		.then((res) => res.json())
		.then((status) => {
			document.getElementById("filter-status").textContent = status.updatedAt
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
document.getElementById("sheet-close").addEventListener("click", () => {
	sheet.hidden = true;
});
sheet.addEventListener("click", (event) => {
	if (event.target === sheet) sheet.hidden = true;
});

for (const input of sheet.querySelectorAll("[data-setting]")) {
	input.addEventListener("change", async () => {
		try {
			await saveSettings({
				...settings,
				[input.dataset.setting]: input.checked,
			});
			if (input.dataset.setting !== "wipe") reloadTab();
		} catch (err) {
			input.checked = !input.checked;
			document.getElementById("filter-status").textContent = err.message;
		}
	});
}

const searchSelect = document.getElementById("search-engine");
searchSelect.addEventListener("change", async () => {
	try {
		await saveSettings({ ...settings, search: searchSelect.value });
	} catch (err) {
		searchSelect.value = settings.search;
		document.getElementById("filter-status").textContent = err.message;
	}
});

document
	.getElementById("site-toggle")
	.addEventListener("change", async (event) => {
		const site = currentSite();
		if (!site) return;
		const allow = new Set(settings.allow);
		if (event.target.checked) allow.delete(site);
		else allow.add(site);
		try {
			await saveSettings({ ...settings, allow: [...allow] });
			reloadTab();
		} catch (err) {
			event.target.checked = !event.target.checked;
			document.getElementById("filter-status").textContent = err.message;
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

// Deletes every site's cookies, storage and logins.
async function clearAllSiteData() {
	localStorage.removeItem(HISTORY);
	goHome();
	// let the tab's page close its databases first
	await new Promise((resolve) => setTimeout(resolve, 50));
	await clearStorageHere();
	if (config.isolation) {
		const keys = readList("bios:origins");
		await Promise.all(keys.map((key) => clearOrigin(originFor(key))));
		localStorage.setItem("bios:origins", "[]");
	}
}

document.getElementById("wipe-now").addEventListener("click", async (event) => {
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
const library = document.getElementById("library");

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

function linkRow(item, detail, onRemove) {
	const li = document.createElement("li");
	const open = document.createElement("button");
	open.type = "button";
	open.className = "link";
	const title = document.createElement("span");
	title.textContent = item.title || displayHost(item.url);
	const small = document.createElement("small");
	small.textContent = detail;
	open.append(title, small);
	open.addEventListener("click", () => {
		library.hidden = true;
		go(item.url);
	});
	li.append(open);
	if (onRemove) {
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "remove";
		remove.textContent = "×";
		remove.setAttribute("aria-label", `Remove ${title.textContent}`);
		remove.addEventListener("click", onRemove);
		li.append(remove);
	}
	return li;
}

function renderBookmarks() {
	const list = readEntries(BOOKMARKS);
	document.getElementById("bookmarks").hidden = !list.length;
	document.getElementById("bookmark-list").replaceChildren(
		...list.map((b) =>
			linkRow(b, displayHost(b.url), () => {
				saveEntries(
					BOOKMARKS,
					readEntries(BOOKMARKS).filter((x) => x.url !== b.url)
				);
				renderBookmarks();
			})
		)
	);
}

document.getElementById("bookmark-btn").addEventListener("click", () => {
	const list = readEntries(BOOKMARKS);
	const i = list.findIndex((b) => b.url === current.url);
	if (i === -1)
		list.unshift({
			url: current.url,
			title: (current.title || displayHost(current.url)).slice(0, 200),
		});
	else list.splice(i, 1);
	saveEntries(BOOKMARKS, list);
	renderSheet();
	renderBookmarks();
});

function renderHistory() {
	const list = readEntries(HISTORY).slice(0, 300);
	document.getElementById("history-empty").hidden = list.length > 0;
	document.getElementById("history-clear").hidden = !list.length;
	document
		.getElementById("history-list")
		.replaceChildren(
			...list.map((h) => linkRow(h, `${displayHost(h.url)} · ${timeAgo(h.at)}`))
		);
}

document.getElementById("history-btn").addEventListener("click", () => {
	renderHistory();
	library.hidden = false;
});
document.getElementById("library-close").addEventListener("click", () => {
	library.hidden = true;
});
library.addEventListener("click", (event) => {
	if (event.target === library) library.hidden = true;
});
document.getElementById("history-clear").addEventListener("click", () => {
	localStorage.removeItem(HISTORY);
	renderHistory();
});

renderBookmarks();

// ----------------------------------------------------------------- startup

// A fresh launch (sessionStorage is empty after iOS closes the app) clears
// site data first when that setting is on.
startup = (async () => {
	const firstLaunch = !sessionStorage.getItem("bios:session");
	sessionStorage.setItem("bios:session", "1");
	const loaded = await loadSettings().catch(() => null);
	if (firstLaunch && loaded && loaded.wipe) await clearAllSiteData();
})().catch((err) => console.warn("startup:", err));

showAddress();

// A proxied page that escaped to the top level redirects to /#<url>.
if (location.hash.length > 1) {
	const target = decodeURIComponent(location.hash.slice(1));
	history.replaceState(null, "", "/");
	go(target);
} else {
	// warm up the service worker and transport so the first search is fast
	startup.then(ensureReady).catch((err) => {
		error.textContent = err.message || String(err);
	});
}

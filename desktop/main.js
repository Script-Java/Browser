// Badger for desktop: Chromium (through Electron) with Badger's tabs,
// bookmarks and history around it, Ghostery's ad and tracker blocking,
// malware and phishing warnings, and pop-up blocking.
//
// Sites load directly in one WebContentsView per tab. There is no proxy
// server on this machine: on a desktop it couldn't hide the IP address
// anyway, and it was one more process that could crash and take the app down.

import {
	app,
	BrowserWindow,
	clipboard,
	crashReporter,
	ipcMain,
	Menu,
	net,
	protocol,
	session,
	WebContentsView,
} from "electron";
import updater from "electron-updater";
import { ElectronBlocker } from "@ghostery/adblocker-electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	cleanSettings,
	DEFAULT_SETTINGS,
	hostOf,
	parseHosts,
	SEARCH_ENGINES,
	shortcutFor,
	siteOf,
	THREAT_LISTS,
	threatFor,
} from "./rules.js";

const { autoUpdater } = updater;
const UI = join(import.meta.dirname, "ui");
const DAY = 86_400_000;

// The UI and the problem page load from badger://app/ rather than file://:
// file:// pages get extra powers in Electron, which a fuse turns off.
protocol.registerSchemesAsPrivileged([{ scheme: "badger", privileges: { standard: true, secure: true } }]);

/** Serves files under ui/ in a session; `allowed` picks which. */
function serveUi(ses, allowed) {
	ses.protocol.handle("badger", (request) => {
		const { host, pathname } = new URL(request.url);
		const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
		const file = join(UI, rel);
		if (host !== "app" || !file.startsWith(UI + sep) || !allowed(rel.replaceAll("\\", "/")))
			return new Response("Not found", { status: 404 });
		return net.fetch(pathToFileURL(file).href);
	});
}

// ------------------------------------------------------------ crash logging

// Crash dumps stay on this machine (userData/Crashpad); nothing is uploaded.
crashReporter.start({ uploadToServer: false });

const DATA = app.getPath("userData");
const LOG = join(DATA, "logs", "badger.log");
try {
	mkdirSync(join(DATA, "logs"), { recursive: true });
	if (existsSync(LOG) && statSync(LOG).size > 1_000_000) rmSync(LOG);
} catch {
	// logging is best effort
}

function log(...parts) {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} ${parts.join(" ")}\n`);
	} catch {
		// logging is best effort
	}
}

// A bug in one corner of the main process shouldn't close every tab: log it
// and keep going.
process.on("uncaughtException", (err) => log("uncaught exception:", err?.stack || err));
process.on("unhandledRejection", (err) => log("unhandled rejection:", err?.stack || err));
app.on("child-process-gone", (event, details) =>
	log("child process gone:", details.type, details.reason, details.exitCode)
);

// ----------------------------------------------------------------- settings

const SETTINGS = join(DATA, "settings.json");
let settings = { ...DEFAULT_SETTINGS };
try {
	settings = cleanSettings(JSON.parse(readFileSync(SETTINGS, "utf8")));
} catch {
	// first run, or unreadable: defaults
}

function saveSettings() {
	try {
		writeFileSync(SETTINGS, JSON.stringify(settings));
	} catch (err) {
		log("settings:", err.message);
	}
}

// ------------------------------------------------- bookmarks, history, tabs

// The UI's bookmarks, history, open tabs and stats, written to disk shortly
// after every change (a temp file renamed over the old one, so a crash
// mid-write can't leave half a file).
const STORE = join(DATA, "store.json");
const STORE_KEYS = new Set(["bios:history", "bios:bookmarks", "bios:tabs", "bios:blocked"]);
let store = {};
try {
	store = JSON.parse(readFileSync(STORE, "utf8"));
} catch {
	// first run, or unreadable: start empty
}
let storeTimer = null;

function flushStore() {
	clearTimeout(storeTimer);
	storeTimer = null;
	try {
		writeFileSync(STORE + ".tmp", JSON.stringify(store));
		renameSync(STORE + ".tmp", STORE);
	} catch (err) {
		log("store:", err.message);
	}
}

app.on("before-quit", () => storeTimer && flushStore());

const allowed = (pageUrl) => settings.allow.includes(siteOf(hostOf(pageUrl)));
// Whether ads and trackers are blocked on a page.
const blocking = (pageUrl) => settings.ads && !allowed(pageUrl);

// ----------------------------------------------- blocking and threat lists

let blocker = null;
let blockerUpdatedAt = 0;
const threats = new Map(); // host -> "phishing" | "malware"
let threatsUpdatedAt = 0;
const proceedAnyway = new Set(); // hosts the person chose to open anyway (this run)
const netFetch = (url, init) => net.fetch(url, init);

let blockedSoFar = 0;
let blockedTimer = null;
function countBlocked() {
	blockedSoFar++;
	blockedTimer ||= setTimeout(() => {
		send("blocked", blockedSoFar);
		blockedSoFar = 0;
		blockedTimer = null;
	}, 2000);
}

// Every request in the sites' session passes here (the blocker's own
// webRequest hook calls blocker.onBeforeRequest, which is this).
let blockerRequest = null;
function onRequest(details, callback) {
	if (details.resourceType === "mainFrame") {
		const host = hostOf(details.url);
		const kind = settings.threats && !proceedAnyway.has(host) ? threatFor(threats, host) : null;
		if (kind) {
			const entry = entryFor(details.webContents);
			if (entry) send("threat", { id: entry.id, url: details.url, host, kind });
			return callback({ cancel: true });
		}
		return callback({});
	}
	if (blockerRequest && blocking(details.webContents?.getURL() || "")) return blockerRequest(details, callback);
	callback({});
}

async function loadBlocker() {
	const cache = join(DATA, "adblock-engine.bin");
	try {
		if (existsSync(cache) && Date.now() - statSync(cache).mtimeMs > DAY) rmSync(cache);
	} catch {
		// keep the old engine
	}
	let fresh;
	try {
		fresh = await ElectronBlocker.fromPrebuiltAdsAndTracking(netFetch, {
			path: cache,
			read: readFile,
			write: writeFile,
		});
	} catch (err) {
		log("block lists:", err.message);
		return;
	}
	const ses = session.defaultSession;
	blocker?.disableBlockingInSession(ses);
	blockerRequest = fresh.onBeforeRequest;
	fresh.onBeforeRequest = onRequest;
	// page hiding rules and site fixes (scriptlets): not on sites the person allowed
	const inject = fresh.onInjectCosmeticFilters;
	fresh.onInjectCosmeticFilters = async (event, url, msg) => {
		if (blocking(url)) return inject(event, url, msg);
	};
	const headers = fresh.onHeadersReceived;
	fresh.onHeadersReceived = (details, callback) =>
		blocking(details.webContents?.getURL() || details.url) ? headers(details, callback) : callback({});
	fresh.on("request-blocked", countBlocked);
	fresh.on("request-redirected", countBlocked);
	fresh.enableBlockingInSession(ses);
	blocker = fresh;
	blockerUpdatedAt = Date.now();
}

async function loadThreats() {
	const cache = join(DATA, "threats.json");
	let data = null;
	try {
		if (Date.now() - statSync(cache).mtimeMs < DAY) data = JSON.parse(readFileSync(cache, "utf8"));
	} catch {
		// no fresh copy
	}
	if (!data) {
		const fresh = {};
		for (const [kind, ...urls] of THREAT_LISTS)
			for (const url of urls) {
				try {
					const res = await netFetch(url);
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					fresh[kind] = parseHosts(await res.text());
					break;
				} catch (err) {
					log("threat list:", url, err.message);
				}
			}
		if (Object.keys(fresh).length) {
			data = fresh;
			try {
				writeFileSync(cache, JSON.stringify(data));
			} catch (err) {
				log("threat list cache:", err.message);
			}
		} else {
			try {
				data = JSON.parse(readFileSync(cache, "utf8")); // stale beats none
			} catch {
				return;
			}
		}
	}
	threats.clear();
	for (const [kind, hosts] of Object.entries(data)) for (const host of hosts) threats.set(host, kind);
	threatsUpdatedAt = Date.now();
}

// ---------------------------------------------------------------- windows

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Map<number, { id: number, view: WebContentsView, lastInput: number, crashedAt: number, lastUrl: string, blockedUrl: string }>} */
const views = new Map();
let shown = { ids: [], top: 0 };
let fullscreenId = null;

const send = (channel, data) => {
	if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};
const entryFor = (contents) => [...views.values()].find((e) => e.view.webContents === contents);

function layout() {
	if (!win || win.isDestroyed()) return;
	const [width, height] = win.getContentSize();
	const ids = (fullscreenId ? [fullscreenId] : shown.ids).filter((id) => views.has(id));
	for (const entry of views.values()) {
		const visible = ids.includes(entry.id);
		entry.view.setVisible(visible);
		// a hidden page must not keep the keyboard: typing would go nowhere
		if (!visible && entry.view.webContents.isFocused()) win.webContents.focus();
	}
	if (fullscreenId && ids.length) {
		views.get(ids[0]).view.setBounds({ x: 0, y: 0, width, height });
		return;
	}
	const top = Math.round(shown.top);
	if (ids.length === 1) {
		views.get(ids[0]).view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
		return;
	}
	// split view: two panes with a gap, which the UI draws the focus ring in
	const gap = 6;
	const paneWidth = Math.floor((width - gap * (ids.length + 1)) / ids.length);
	ids.forEach((id, i) =>
		views.get(id).view.setBounds({
			x: gap + i * (paneWidth + gap),
			y: top + gap,
			width: paneWidth,
			height: Math.max(0, height - top - gap * 2),
		})
	);
}

function tabState(entry) {
	const wc = entry.view.webContents;
	const url = wc.getURL();
	const page = /^https?:/.test(url);
	if (page) entry.lastUrl = url;
	return {
		id: entry.id,
		// a local problem page (crash, no connection) keeps the site's address
		url: page ? url : entry.lastUrl,
		// a real page loaded (not a problem page, not a blocked dangerous site)
		ok: page && url !== entry.blockedUrl,
		title: page ? wc.getTitle() : "",
		loading: wc.isLoading(),
		canGoBack: wc.navigationHistory.canGoBack(),
		canGoForward: wc.navigationHistory.canGoForward(),
	};
}

function problemPage(entry, kind, detail = "") {
	const query = new URLSearchParams({ kind, url: entry.lastUrl, detail });
	entry.view.webContents.loadURL(`badger://app/problem.html?${query}`).catch(() => {});
}

function createView(id) {
	const view = new WebContentsView({
		webPreferences: {
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			// the spellchecker downloads dictionaries from Google
			spellcheck: false,
		},
	});
	const wc = view.webContents;
	const entry = { id, view, lastInput: 0, crashedAt: 0, lastUrl: "", blockedUrl: "" };
	views.set(id, entry);
	view.setVisible(false);
	view.setBackgroundColor("#ffffff");
	win.contentView.addChildView(view);

	// Sites see the public address anyway; this keeps WebRTC from also
	// showing them the addresses on the local network. Calls still work.
	wc.setWebRTCIPHandlingPolicy("default_public_interface_only");

	const update = () => send("tab", tabState(entry));
	for (const name of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"])
		wc.on(name, update);

	// Pop-ups: a new window opens as a tab, and only right after a real
	// click, tap or key press in this tab. Everything else is dropped.
	wc.on("input-event", (event, input) => {
		if (["mouseDown", "rawKeyDown", "keyDown", "gestureTap", "touchStart"].includes(input.type))
			entry.lastInput = Date.now();
	});
	wc.setWindowOpenHandler(({ url, disposition }) => {
		if (Date.now() - entry.lastInput < 1000 && /^https?:/.test(url))
			send("open", { opener: id, url, background: disposition === "background-tab" });
		return { action: "deny" };
	});

	// Only web pages: no file:// pages from the web, no handing off to other
	// apps (mailto:, tel:, custom schemes).
	wc.on("will-navigate", (event, url) => {
		if (!/^https?:/.test(url)) event.preventDefault();
	});
	wc.on("will-frame-navigate", (event) => {
		if (!event.isMainFrame && !/^(https?:|about:|data:|blob:)/.test(event.url)) event.preventDefault();
	});

	wc.on("before-input-event", (event, input) => {
		const name = shortcutFor(input);
		if (!name) return;
		event.preventDefault();
		runShortcut(entry, name);
	});
	wc.on("focus", () => send("focus", id));
	wc.on("context-menu", (event, params) => contextMenu(entry, params));
	wc.on("enter-html-full-screen", () => {
		fullscreenId = id;
		layout();
	});
	wc.on("leave-html-full-screen", () => {
		fullscreenId = null;
		layout();
	});

	wc.on("did-fail-load", (event, code, description, url, isMainFrame) => {
		// -3: aborted (a new navigation started); -20: blocked here (a threat,
		// which the UI explains; Chromium leaves an empty page at its address)
		if (isMainFrame && code === -20) entry.blockedUrl = url;
		if (!isMainFrame || code === -3 || code === -20 || !/^https?:/.test(url)) return;
		entry.lastUrl = url;
		problemPage(entry, "failed", description);
	});
	wc.on("render-process-gone", (event, details) => {
		log("tab crashed:", details.reason, details.exitCode, entry.lastUrl);
		if (details.reason === "clean-exit") return;
		// one automatic reload; a page that keeps crashing gets the problem page
		if (Date.now() - entry.crashedAt > 30_000 && entry.lastUrl) {
			entry.crashedAt = Date.now();
			wc.loadURL(entry.lastUrl).catch(() => {});
		} else problemPage(entry, "crashed");
		update();
	});
	return entry;
}

function destroyView(entry) {
	views.delete(entry.id);
	if (fullscreenId === entry.id) fullscreenId = null;
	if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view);
	if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
}

function runShortcut(entry, name) {
	const wc = entry?.view.webContents;
	if (name === "zoom-in" && wc) wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5));
	else if (name === "zoom-out" && wc) wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -5));
	else if (name === "zoom-reset" && wc) wc.setZoomLevel(0);
	else if (name === "reload-hard" && wc) wc.reloadIgnoringCache();
	else send("shortcut", name);
}

function searchUrl(text) {
	return (SEARCH_ENGINES[settings.search] || SEARCH_ENGINES.brave).replace("%s", encodeURIComponent(text));
}

function contextMenu(entry, p) {
	const wc = entry.view.webContents;
	const items = [];
	const add = (...more) => items.push(...more);
	const separate = () => items.length && items.at(-1).type !== "separator" && add({ type: "separator" });
	const openTab = (url, background = true) => send("open", { opener: entry.id, url, background });
	if (/^https?:/.test(p.linkURL)) {
		add(
			{ label: "Open link in new tab", click: () => openTab(p.linkURL) },
			{ label: "Copy link address", click: () => clipboard.writeText(p.linkURL) }
		);
		separate();
	}
	if (p.mediaType === "image" && /^https?:/.test(p.srcURL)) {
		add(
			{ label: "Open image in new tab", click: () => openTab(p.srcURL) },
			{ label: "Save image as…", click: () => wc.downloadURL(p.srcURL) },
			{ label: "Copy image", click: () => wc.copyImageAt(p.x, p.y) }
		);
		separate();
	}
	if (p.isEditable) {
		add({ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
		separate();
	} else if (p.selectionText.trim()) {
		const text = p.selectionText.trim().replace(/\s+/g, " ");
		add({ role: "copy" }, {
			label: `Search for “${text.length > 30 ? text.slice(0, 30) + "…" : text}”`,
			click: () => openTab(searchUrl(text), false),
		});
		separate();
	}
	add(
		{ label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
		{ label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
		{ label: "Reload", click: () => wc.reload() }
	);
	Menu.buildFromTemplate(items).popup({ window: win });
}

function openWindow() {
	win = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 480,
		minHeight: 360,
		title: "Badger",
		icon: join(UI, "shared", "icons", "icon-512.png"),
		backgroundColor: "#faf9f7",
		autoHideMenuBar: true,
		webPreferences: {
			preload: join(import.meta.dirname, "preload.cjs"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			spellcheck: false,
			// the UI's own storage (bookmarks, history, open tabs), kept apart
			// from the sites' so clearing site data leaves it alone
			partition: "persist:badger-ui",
		},
	});
	const ui = win.webContents;
	ui.on("will-navigate", (event) => event.preventDefault());
	ui.setWindowOpenHandler(() => ({ action: "deny" }));
	ui.on("render-process-gone", (event, details) => {
		log("ui crashed:", details.reason, details.exitCode);
		// the UI reopens the saved tabs when it loads
		if (details.reason !== "clean-exit") ui.reload();
	});
	for (const name of ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"])
		win.on(name, layout);
	win.on("closed", () => {
		win = null;
	});
	serveUi(ui.session, () => true);
	ui.loadURL("badger://app/index.html");
}

// ------------------------------------------------------------------- IPC

// Only the UI window may drive the browser; sites never get this API.
function handle(channel, fn) {
	ipcMain.handle(channel, (event, ...args) => {
		if (!win || event.sender !== win.webContents) throw new Error("not allowed");
		return fn(...args);
	});
}

const isId = (id) => Number.isSafeInteger(id) && id > 0;

function registerIpc() {
	handle("ui:ready", () => {
		// a reloaded UI starts over; drop the old tabs' pages
		for (const entry of [...views.values()]) destroyView(entry);
		shown = { ids: [], top: 0 };
		return { platform: process.platform };
	});
	handle("ui:focus", () => win.webContents.focus());
	handle("store:load", () => store);
	handle("store:save", (name, value) => {
		if (!STORE_KEYS.has(name)) return;
		if (value === null) delete store[name];
		else if (JSON.stringify(value).length < 5_000_000) store[name] = value;
		storeTimer ||= setTimeout(flushStore, 300);
	});
	handle("tab:create", (id) => {
		if (isId(id) && !views.has(id)) createView(id);
	});
	handle("tab:load", (id, url) => {
		const entry = views.get(id);
		if (!entry || typeof url !== "string" || !/^https?:/.test(url)) return;
		entry.lastUrl = url;
		entry.view.webContents.loadURL(url).catch(() => {});
	});
	handle("tab:close", (id) => {
		const entry = views.get(id);
		if (entry) destroyView(entry);
		layout();
	});
	handle("tab:cmd", (id, cmd) => {
		const entry = views.get(id);
		if (!entry) return;
		const wc = entry.view.webContents;
		if (cmd === "back") wc.navigationHistory.goBack();
		else if (cmd === "forward") wc.navigationHistory.goForward();
		else if (cmd === "reload") {
			// reloading a problem page means trying the site again
			if (/^https?:/.test(wc.getURL()) || !entry.lastUrl) wc.reload();
			else wc.loadURL(entry.lastUrl).catch(() => {});
		} else if (cmd === "stop") wc.stop();
		else if (cmd === "focus") wc.focus();
	});
	handle("tabs:show", (ids, top) => {
		shown = {
			ids: Array.isArray(ids) ? ids.filter(isId).slice(0, 2) : [],
			top: Number.isFinite(top) ? Math.max(0, top) : 0,
		};
		layout();
	});
	handle("settings:get", () => settings);
	handle("settings:set", (next) => {
		settings = cleanSettings({ ...settings, ...next });
		saveSettings();
		return settings;
	});
	handle("site:of", (url) => siteOf(hostOf(String(url))));
	handle("threat:proceed", (id, url) => {
		const entry = views.get(id);
		if (!entry || typeof url !== "string" || !/^https?:/.test(url)) return;
		proceedAnyway.add(hostOf(url));
		entry.view.webContents.loadURL(url).catch(() => {});
	});
	handle("data:clear", async () => {
		const ses = session.defaultSession;
		await ses.clearStorageData();
		await ses.clearCache();
		await ses.clearAuthCache();
		await ses.clearHostResolverCache();
		proceedAnyway.clear();
	});
	handle("status", () => ({
		blockerUpdatedAt,
		threats: threats.size,
		threatsUpdatedAt,
		version: app.getVersion(),
		log: LOG,
	}));
}

// ---------------------------------------------------------------- startup

function lockDown() {
	const ses = session.defaultSession;
	// sites' tabs may show the problem page, never the browser's own UI
	serveUi(ses, (rel) => /^problem\.(html|css|js)$/.test(rel) || rel.startsWith("shared/icons/"));
	// Before the blocker has loaded, the threat check still runs.
	ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, onRequest);
	// No prompt UI exists, so camera, microphone, location, notifications
	// and the rest are refused rather than silently granted.
	const ok = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);
	ses.setPermissionRequestHandler((contents, permission, callback) => callback(ok.has(permission)));
	ses.setPermissionCheckHandler((contents, permission) => ok.has(permission));
	app.on("web-contents-created", (event, contents) => {
		contents.on("will-attach-webview", (e) => e.preventDefault());
	});
}

// Chromium's security fixes reach people only through updates: check GitHub
// Releases at launch and every 6 hours; a downloaded update installs on quit.
// electron-updater uses its own session, so the request hooks don't touch it.
function keepUpdated() {
	if (!app.isPackaged) return;
	const check = () =>
		autoUpdater.checkForUpdatesAndNotify().catch((err) => log("update:", err.message));
	check();
	setInterval(check, 6 * 3_600_000);
}

if (!app.requestSingleInstanceLock()) app.exit(0);

// Sites see a plain Chrome; some (Google sign-in) refuse "Electron".
app.userAgentFallback = app.userAgentFallback.replace(/ (?!(Chrome|Safari|AppleWebKit)\/)\S+\/\S+/g, "");

app.on("second-instance", () => {
	if (!win) return;
	if (win.isMinimized()) win.restore();
	win.focus();
});
app.on("window-all-closed", () => app.quit());

app.whenReady().then(() => {
	// no default menu: its Reload would reload the browser's own UI, and
	// browser shortcuts are handled per tab
	Menu.setApplicationMenu(null);
	lockDown();
	registerIpc();
	openWindow();
	// blocking and threat lists load in the background; pages already work
	loadThreats().catch((err) => log("threats:", err.message));
	loadBlocker().catch((err) => log("blocker:", err.message));
	setInterval(() => {
		loadThreats().catch((err) => log("threats:", err.message));
		loadBlocker().catch((err) => log("blocker:", err.message));
	}, DAY);
	keepUpdated();
});

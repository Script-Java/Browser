// Badger for desktop: opens your Badger server (the Railway deploy) in a
// locked-down window. Every request the window makes goes to that server;
// nothing reaches a site directly, so sites see the server's address.

import { app, BrowserWindow, dialog, session } from "electron";
import updater from "electron-updater";

const { autoUpdater } = updater;

// The address the shell runs on: ISOLATION_DOMAIN if the deploy has one,
// otherwise its *.up.railway.app address.
const SERVER_URL = "https://badgerbrowser.com";
const SERVER = new URL(SERVER_URL);

// Only the server and its per-site subdomains, over https or the wisp WebSocket.
function ours(url) {
	try {
		const u = new URL(url);
		return (
			(u.protocol === "https:" || u.protocol === "wss:") &&
			u.port === SERVER.port &&
			(u.hostname === SERVER.hostname || u.hostname.endsWith("." + SERVER.hostname))
		);
	} catch {
		return false;
	}
}

// What a page may use without asking. The camera, the microphone and the
// location are asked about (askFor); notifications and the rest are refused.
const ALLOWED_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

// The app's own prompt named the site before the page asked; this is the
// browser's, which a page that gets around the app's can't skip.
async function askFor(contents, permission, details) {
	const kinds =
		permission === "geolocation"
			? ["your location"]
			: (details.mediaTypes || []).map((type) => (type === "video" ? "the camera" : "the microphone"));
	const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(contents), {
		type: "question",
		message: `Let this tab use ${kinds.join(" and ") || "the camera or microphone"}?`,
		detail: "Badger asked you about the site in the tab first. Video calls don't work through Badger; photos, scanning and recording do.",
		buttons: ["Don't allow", "Allow"],
		defaultId: 0,
		cancelId: 0,
	});
	return response === 1;
}

async function lockDown() {
	const ses = session.defaultSession;
	// Whatever isn't the server goes to a proxy that isn't there. The request
	// filter below can't see WebRTC's connections; this makes its TCP ones
	// fail too (its UDP is turned off further down).
	await ses.setProxy({
		proxyRules: "http://127.0.0.1:9",
		proxyBypassRules: `${SERVER.hostname},.${SERVER.hostname}`,
	});
	// The lock: a page that slips past the proxy still can't reach the network.
	ses.webRequest.onBeforeRequest((details, callback) => {
		callback({ cancel: /^(https?|wss?):/.test(details.url) && !ours(details.url) });
	});
	ses.setPermissionRequestHandler((contents, permission, callback, details) => {
		if (ALLOWED_PERMISSIONS.has(permission)) return callback(true);
		if ((permission !== "media" && permission !== "geolocation") || !ours(details.requestingUrl)) return callback(false);
		askFor(contents, permission, details).then(callback, () => callback(false));
	});
	ses.setPermissionCheckHandler((contents, permission) => ALLOWED_PERMISSIONS.has(permission));

	app.on("web-contents-created", (event, contents) => {
		// WebRTC's UDP goes around the network lock above and would show
		// sites the real IP address. The proxy above carries no UDP, so this
		// turns it off.
		contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
		// Tabs live inside the shell; nothing opens a raw window or the system browser.
		contents.setWindowOpenHandler(() => ({ action: "deny" }));
		contents.on("will-navigate", (event, url) => {
			if (!ours(url)) event.preventDefault();
		});
		contents.on("will-attach-webview", (event) => event.preventDefault());
	});
}

function openWindow() {
	const win = new BrowserWindow({
		width: 1280,
		height: 860,
		title: "Badger",
		backgroundColor: "#faf9f7",
		autoHideMenuBar: true,
		webPreferences: {
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			// the spellchecker downloads dictionaries from Google
			spellcheck: false,
		},
	});
	// Offline, or the server is down: say so instead of showing a blank window.
	win.webContents.on("did-fail-load", async (event, code, description, url, isMainFrame) => {
		if (!isMainFrame || code === -3) return; // -3: replaced by a newer navigation
		const { response } = await dialog.showMessageBox(win, {
			type: "warning",
			message: "Can't reach the Badger server",
			detail: `${SERVER.host} didn't answer (${description}). Check your internet connection.`,
			buttons: ["Try again", "Quit"],
		});
		if (response === 0) win.loadURL(SERVER_URL);
		else app.quit();
	});
	win.loadURL(SERVER_URL);
}

// Chromium's security fixes reach people only through updates: check GitHub
// Releases at launch and every 6 hours; a downloaded update installs on quit.
// electron-updater uses its own session, so the network lock doesn't block it.
function keepUpdated() {
	if (!app.isPackaged) return;
	const check = () =>
		autoUpdater.checkForUpdatesAndNotify().catch((err) => console.warn("update:", err.message));
	check();
	setInterval(check, 6 * 3_600_000);
}

if (!app.requestSingleInstanceLock()) app.exit(0);

// Sites see a plain Chrome; some (Google sign-in) refuse "Electron".
app.userAgentFallback = app.userAgentFallback.replace(/ (?!(Chrome|Safari|AppleWebKit)\/)\S+\/\S+/g, "");

app.on("second-instance", () => {
	const [win] = BrowserWindow.getAllWindows();
	if (win) {
		if (win.isMinimized()) win.restore();
		win.focus();
	}
});
app.on("window-all-closed", () => app.quit());

app.whenReady().then(async () => {
	if (SERVER.hostname === "your-app.up.railway.app") {
		dialog.showErrorBox(
			"Badger isn't set up yet",
			"Put your server's address in SERVER_URL in desktop/main.js, then rebuild with pnpm desktop:dist."
		);
		return app.quit();
	}
	await lockDown();
	openWindow();
	keepUpdated();
});

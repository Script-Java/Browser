import { resolve } from "node:path";
import { tmpdir, hostname } from "node:os";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import express from "express";
import { routeRequest } from "./wisp.js";
import { build } from "esbuild";

import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";

import { CHALLENGE_BITS, createAuth, parseCookies, seal, unseal } from "./auth.js";
import { Filters } from "./filters.js";
import { serveMedia } from "./media.js";
import { canonicalNames, lookupable } from "./cname.js";
import { certificateOf } from "./certs.js";
import * as sync from "./sync.js";
import { startTor, torAgent, torSocket, torStatus } from "./tor.js";
import { WebRisk } from "./webrisk.js";
import { clientKey, createLimits } from "./limits.js";
import { DEFAULT_SETTINGS, cleanSettings } from "./settings.js";

const publicPath = resolve(import.meta.dirname, "..", "public");

// ---------------------------------------------------------------- settings

// Optional: makes the instance private. Without it, anyone can use the app
// after their browser passes a small proof-of-work check (see auth.js).
const PASSWORD = process.env.APP_PASSWORD || "";
const SECRET = process.env.AUTH_SECRET || "";
// Shown on /terms for abuse and takedown reports.
const CONTACT = (process.env.CONTACT_EMAIL || "").trim();

// e.g. "browse.example.com": the shell runs there and every site gets its own
// <key>.browse.example.com origin. Needs a wildcard DNS record and certificate.
const ISOLATION = (process.env.ISOLATION_DOMAIN || "")
	.trim()
	.toLowerCase()
	.replace(/^\*\./, "")
	.replace(/\.$/, "");

// Refuse to start rather than run an unsafe public deploy.
if (process.env.NODE_ENV === "production") {
	const missing = [];
	if (SECRET.length < 32)
		missing.push(
			'AUTH_SECRET (32+ random characters; it signs every cookie):\n    npx @railway/cli variable set "AUTH_SECRET=$(openssl rand -hex 32)"'
		);
	// Public mode: strangers sign in to sites through it, and without
	// isolation one malicious site could read every other site's logins.
	if (!PASSWORD && !ISOLATION)
		missing.push("ISOLATION_DOMAIN (a domain you own; see README), or APP_PASSWORD to keep the app private");
	if (!PASSWORD && !CONTACT)
		missing.push('CONTACT_EMAIL (where abuse and takedown reports go; shown on /terms):\n    npx @railway/cli variable set "CONTACT_EMAIL=abuse@example.com"');
	if (missing.length) {
		console.error("Can't start in production. Set:\n  - " + missing.join("\n  - "));
		process.exit(1);
	}
}

const limits = createLimits({
	// ponytail: per address, so a household behind one IP shares these.
	maxSockets: 16,
	dailyBytes: Number(process.env.DAILY_GB_PER_CLIENT || 2) * 1024 ** 3,
	// Hard cap for the whole server, so the bandwidth bill can't run away.
	totalDailyBytes: Number(process.env.DAILY_GB_TOTAL || 50) * 1024 ** 3,
});

// Optional: Google Web Risk, checked privately (webrisk.js), for threats
// fresher than the free lists' half-hourly updates.
const webRisk = process.env.WEB_RISK_API_KEY ? new WebRisk({ key: process.env.WEB_RISK_API_KEY }) : null;

const filters = new Filters({
	cacheDir: process.env.FILTER_CACHE_DIR || resolve(tmpdir(), "browser-ios-filters"),
	refreshHours: Number(process.env.FILTER_REFRESH_HOURS) || 24,
	threatMinutes: Number(process.env.THREAT_REFRESH_MINUTES) || 30,
});

// ----------------------------------------------------------------- helpers

function hostOf(req) {
	return String(req.headers.host || "")
		.toLowerCase()
		.replace(/:\d+$/, "");
}

// A site origin's label: "s<key>" for a site, "t<key>" for a site in a Tor
// tab, "f<key>" for a frame from another site inside a page, "g<key>" for one
// in a Tor tab (src/client/sitekey.js).
const SITE_LABEL = /^[stfg][a-z2-7]{25}$/;
const viaTor = (label) => /^[tg]/.test(label);

// "shell": the app itself. "site": an isolated site origin. "stray": any other
// name under ISOLATION_DOMAIN (www, typos), which only redirects to the app.
// In shared mode (no ISOLATION_DOMAIN, or reached through another address)
// everything is "shell".
function hostKind(req) {
	if (!ISOLATION) return "shell";
	const host = hostOf(req);
	if (!host.endsWith("." + ISOLATION)) return "shell";
	return SITE_LABEL.test(host.slice(0, -ISOLATION.length - 1)) ? "site" : "stray";
}

// The label of a site origin request's host, or "".
const labelOf = (req) => (hostKind(req) === "site" ? hostOf(req).slice(0, -ISOLATION.length - 1) : "");

function cookieDomain(req) {
	const host = hostOf(req);
	if (ISOLATION && (host === ISOLATION || host.endsWith("." + ISOLATION)))
		return ISOLATION;
	return null;
}

const auth = createAuth({ password: PASSWORD, secret: SECRET, cookieDomain });

// Settings live in an encrypted cookie on the shell's address alone; site
// origins' service workers ask the shell for them (siteCors below). Over
// https its name starts with __Host-, which browsers refuse to set for a
// whole domain: a proxied page on a site subdomain can't plant a copy with
// protections switched off. Sealed, so someone holding the device can't read
// the allowed-sites list.
const LEGACY_SETTINGS_COOKIE = "bios_settings"; // was shared with every subdomain
const settingsCookie = (req) => (req.secure ? "__Host-" : "") + LEGACY_SETTINGS_COOKIE;
const settingsKey = createHmac("sha256", SECRET + "\0" + PASSWORD).update("bios-settings-aes").digest();

/** The stored settings, or null when there's no cookie it can open. */
function storedSettings(req, name = settingsCookie(req)) {
	const raw = parseCookies(req.headers.cookie)[name];
	const stored = raw ? unseal(settingsKey, raw) : null;
	return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : null;
}

function readSettings(req) {
	return { ...DEFAULT_SETTINGS, ...storedSettings(req) };
}

function writeSettings(req, res, settings) {
	const parts = [
		`${settingsCookie(req)}=${seal(settingsKey, settings)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${5 * 365 * 86_400}`,
	];
	if (req.secure) parts.push("Secure");
	res.append("Set-Cookie", parts.join("; "));
}

// Only the shell may change settings: requests must come from the shell's
// own origin, not from a proxied page on a site origin.
function fromShell(req) {
	if (hostKind(req) !== "shell") return false;
	const origin = req.headers.origin;
	return !origin || origin === `${req.protocol}://${req.headers.host}`;
}

// ------------------------------------------------------------------ bundles

// `auth`: whether the shield menu offers Lock (only useful with a password).
const clientConfig = JSON.stringify({ isolation: ISOLATION || null, auth: auth.mode === "password" });

async function bundle(entry, globalName, define) {
	const result = await build({
		entryPoints: [resolve(import.meta.dirname, entry)],
		bundle: true,
		format: "iife",
		globalName,
		minify: true,
		write: false,
		target: ["safari15"],
		// keeps the notices the open-source libraries bundled here ask for
		legalComments: "inline",
		define,
	});
	return result.outputFiles[0].text;
}

// consent.js runs in a proxied page without Scramjet rewriting it: its
// library's `location`, `top` and `parent` are the page's, not the proxy's
// (see consent.js).
const PAGE_VIEW = {
	location: "self.__biosLocation",
	"window.location": "self.__biosLocation",
	"globalThis.location": "self.__biosLocation",
	"document.location": "self.__biosLocation",
	"window.top": "self.__biosTop",
	"window.parent": "self.__biosParent",
};

const bundles = Promise.all([
	bundle("sw/shield.js", "BiosShield"),
	bundle("client/sitekey.js", "BiosSiteKey"),
	bundle("client/page.js"),
	bundle("client/consent.js", undefined, PAGE_VIEW),
	bundle("client/reader.js", "BiosReader"),
	bundle("client/worker.js", undefined, { __BIOS_LEVEL__: '"standard"' }),
	bundle("client/worker.js", undefined, { __BIOS_LEVEL__: '"safer"' }),
]).then(([shield, sitekey, page, consent, reader, worker, workerSafer]) => {
	// the service worker's and the page's carry the server's settings
	const withConfig = (text) => `self.__biosConfig = ${clientConfig};\n${text}`;
	const texts = { shield: withConfig(shield), page: withConfig(page), sitekey, consent, reader, worker, workerSafer };
	// with a gzipped copy of each: the bigger ones carry whole libraries
	return Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, { text, gzip: gzipSync(text) }]));
});

function sendBundle(name) {
	return async (req, res) => {
		res.type("text/javascript").setHeader("Cache-Control", "no-cache");
		res.vary("Accept-Encoding");
		const { text, gzip } = (await bundles)[name];
		if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
			res.setHeader("Content-Encoding", "gzip");
			return res.end(gzip);
		}
		res.send(text);
	};
}


// -------------------------------------------------------------------- app

// iOS home-screen apps cache aggressively; always revalidate.
const staticOptions = {
	setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
};

// ------------------------------------------------- CSP for the app's pages

// The inline <script>s in the app's own pages, allowed by hash, so no other
// inline script (an injected one) can run. Browsers hash a script after
// turning CRLF line ends into LF, and a Windows checkout has CRLF.
const scriptHashes = [];
for (const name of (await readdir(publicPath)).filter((n) => n.endsWith(".html"))) {
	const html = (await readFile(resolve(publicPath, name), "utf8")).replace(/\r\n?/g, "\n");
	for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g))
		scriptHashes.push(`'sha256-${createHash("sha256").update(code).digest("base64")}'`);
}

const portOf = (req) => String(req.headers.host || "").match(/:\d+$/)?.[0] || "";
// The app frames its own pages; a frame's own origin (f…, g…, see
// shield.js inFrame) is framed by the site origins of the pages it's in,
// all of them inside the app (the rule holds for every window above).
const framing = (req) =>
	/^[fg]/.test(labelOf(req))
		? `frame-ancestors ${req.protocol}://${ISOLATION}${portOf(req)} ${req.protocol}://*.${ISOLATION}${portOf(req)}`
		: "frame-ancestors 'self'" + (ISOLATION ? ` ${req.protocol}://${ISOLATION}${portOf(req)}` : "");

function pageCsp(req) {
	// isolation: the shell frames every site's own subdomain
	const sites = ISOLATION ? ` ${req.protocol}://*.${ISOLATION}${portOf(req)}` : "";
	return [
		"default-src 'self'",
		`script-src 'self' ${scriptHashes.join(" ")}`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		`frame-src 'self'${sites}`,
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		framing(req),
	].join("; ");
}

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

// For the host's health check (railway.json); before the site and password rules.
// With ?nonce=, it answers HMAC(AUTH_SECRET, nonce): only this server could,
// so a check can tell it apart from a look-alike or a stale instance.
app.get("/healthz", (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	const nonce = String(req.query.nonce || "");
	if (!/^[\w-]{1,64}$/.test(nonce)) return res.type("text/plain").send("ok");
	res.type("text/plain").send(createHmac("sha256", SECRET).update("healthz:" + nonce).digest("hex"));
});

app.use((req, res, next) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	// lets the shell frame pages from the site subdomains
	res.setHeader("Cross-Origin-Resource-Policy", "same-site");
	res.setHeader("Referrer-Policy", "same-origin");
	res.setHeader("X-Content-Type-Options", "nosniff");
	// No page, the app's or a site's inside it, gets these. page.js refuses
	// them too, but this is the browser's own rule. Location, camera and
	// microphone go to a tab only through the app's own prompt (page.js asks
	// it); the app hands them to its tab frames (index.js, frame.allow).
	res.setHeader(
		"Permissions-Policy",
		"camera=*, microphone=*, geolocation=*, payment=(), usb=(), display-capture=(), serial=(), hid=()"
	);
	// keeps the proxy out of search results
	res.setHeader("X-Robots-Tag", "noindex, nofollow");
	// Only the app frames its own pages (tabs, anchors, wipers), so another
	// site can't wrap it to trick taps. The app's own pages also get a strict
	// policy: only its own scripts run. Workers keep just the framing rule
	// (Scramjet and the transport compile WebAssembly in them), and proxied
	// pages come from the service worker, so neither gets the strict one.
	// Without Sec-Fetch-Dest (iOS before 16.4) fail closed: only a .js file
	// can be a worker, and on other non-pages the policy does nothing anyway.
	const dest = req.headers["sec-fetch-dest"];
	const page = dest ? dest === "document" || dest === "iframe" || dest === "frame" : !req.path.endsWith(".js");
	res.setHeader("Content-Security-Policy", page ? pageCsp(req) : framing(req));
	if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
	next();
});

// Site origins only serve what the proxy needs, never the shell: if the shell
// ran on a site origin, that site could reach into it.
const SITE_PATHS = /^\/(scramjet\/|scram\/|bios\/(shield|page|consent|worker|worker-safer)\.js$|baremux\/|epoxy\/|filters\/|scramjet-sw\.js$|register-sw\.js$|wipe\.html$|anchor\.html$)/;
app.use((req, res, next) => {
	const kind = hostKind(req);
	if (kind === "stray" || (kind === "site" && !SITE_PATHS.test(req.path))) {
		if ((kind === "stray" || req.path === "/") && req.method === "GET")
			return res.redirect(`${req.protocol}://${ISOLATION}${req.headers.host.match(/:\d+$/)?.[0] || ""}/`);
		return res.status(404).type("text/plain").send("Not found");
	}
	next();
});

app.get("/login", (req, res) => {
	if (!auth.enabled || auth.isAuthed(req)) return res.redirect("/");
	res.setHeader("Cache-Control", "no-store");
	res.sendFile(resolve(publicPath, auth.mode === "password" ? "login.html" : "challenge.html"));
});
app.get("/api/challenge", (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	res.json({ challenge: auth.newChallenge(), bits: CHALLENGE_BITS });
});

const escapeHtml = (text) =>
	text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const terms = readFile(resolve(import.meta.dirname, "terms.html"), "utf8").then((html) =>
	html.replaceAll(
		"{{CONTACT}}",
		CONTACT
			? `<a href="mailto:${escapeHtml(CONTACT)}">${escapeHtml(CONTACT)}</a>`
			: "the person running this server"
	)
);
app.get("/terms", async (req, res) => {
	res.setHeader("Cache-Control", "no-cache");
	res.type("html").send(await terms);
});
app.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), auth.login);
// another site can't sign people out
app.post("/logout", (req, res, next) => (fromShell(req) ? auth.logout(req, res, next) : res.status(403).end()));

// Isolation mode: site origins' service workers read the block list and the
// settings from the shell, with the person's cookies. Before the gate,
// because a preflight carries no cookies.
function siteCors(req, res, next) {
	res.vary("Origin");
	let label = "";
	try {
		const { hostname } = new URL(req.headers.origin);
		if (ISOLATION && hostname.endsWith("." + ISOLATION)) label = hostname.slice(0, -ISOLATION.length - 1);
	} catch {
		// no Origin, or a malformed one
	}
	if (SITE_LABEL.test(label)) {
		res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
		res.setHeader("Access-Control-Allow-Credentials", "true");
		if (req.method === "OPTIONS") {
			res.setHeader("Access-Control-Allow-Headers", "x-bios-host, x-bios-port, if-none-match");
			res.setHeader("Access-Control-Max-Age", "86400");
			return res.status(204).end();
		}
	}
	next();
}
app.use(["/filters/engine.bin", "/filters/notices.bin", "/filters/privacy.json", "/api/nav", "/api/settings", "/api/cname", "/api/cert"], siteCors);

app.use(auth.gate);

// Server settings for the shell, the service worker and every proxied page.
app.get("/bios/config.js", (req, res) => {
	res.type("text/javascript").setHeader("Cache-Control", "no-cache");
	res.send(`self.__biosConfig = ${clientConfig};\n`);
});
app.get("/bios/shield.js", sendBundle("shield"));
app.get("/bios/page.js", sendBundle("page"));
app.get("/bios/consent.js", sendBundle("consent"));
app.get("/bios/reader.js", sendBundle("reader"));
app.get("/bios/worker.js", sendBundle("worker"));
app.get("/bios/worker-safer.js", sendBundle("workerSafer"));
app.get("/sitekey.js", sendBundle("sitekey"));

const serveEngine = (pick, type = "application/octet-stream") => (req, res) => {
	res.vary("Accept-Encoding");
	const engine = pick();
	if (!engine) return res.status(503).setHeader("Retry-After", "60").end();
	res.setHeader("ETag", engine.etag);
	res.setHeader("Cache-Control", "no-cache");
	if (req.headers["if-none-match"] === engine.etag) return res.status(304).end();
	res.type(type);
	if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
		res.setHeader("Content-Encoding", "gzip");
		return res.end(engine.gzip);
	}
	res.end(engine.raw);
};
app.get("/filters/engine.bin", serveEngine(() => filters.engine));
// the cookie-notice lists, for service workers of people who switched them on
app.get("/filters/notices.bin", serveEngine(() => filters.notices));
// Brave's navigation-tracking rules (privacyrules.js)
app.get("/filters/privacy.json", serveEngine(() => filters.privacy, "application/json"));

app.get("/filters/status", (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	res.json({ ...filters.status(), webRiskAt: webRisk?.updatedAt || null });
});

app.get("/api/settings", (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	let settings = readSettings(req);
	// The shell asks at every start. With no cookie it can open, store one
	// (the settings from the old shared cookie, once), so there is always a
	// cookie only the shell could have set, and drop the old one.
	if (!storedSettings(req) && fromShell(req)) {
		const legacy = req.secure && storedSettings(req, LEGACY_SETTINGS_COOKIE);
		if (legacy) settings = cleanSettings(legacy);
		writeSettings(req, res, settings);
		if (req.secure && ISOLATION)
			res.append("Set-Cookie", `${LEGACY_SETTINGS_COOKIE}=; Path=/; Domain=${ISOLATION}; Max-Age=0; Secure`);
	}
	res.json(settings);
});

app.post("/api/settings", express.json({ limit: "16kb" }), (req, res) => {
	if (!fromShell(req)) return res.status(403).json({ error: "forbidden" });
	const settings = cleanSettings(req.body);
	writeSettings(req, res, settings);
	res.setHeader("Cache-Control", "no-store");
	res.json(settings);
});

// The service worker calls this once per page load. The site's hostname comes
// in a header, not the URL, so it never shows up in the host's request logs.
app.get("/api/nav", async (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	const host = String(req.headers["x-bios-host"] || "");
	let threat = host ? filters.threat(host) : null;
	if (host && !threat && webRisk) threat = await webRisk.check(host).catch(() => null);
	res.json({ settings: readSettings(req), threat });
});

// What a site's subdomain is an alias of (CNAME uncloaking, see cname.js).
// The name comes in a header, like /api/nav's, so it stays out of request logs.
// Whether Tor tabs can be opened here (tor.js): Tor running, and site
// isolation for their origins.
app.get("/api/tor", (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	const status = torStatus();
	res.json({ ...status, available: status.available && !!ISOLATION });
});

app.get("/api/cname", async (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	const host = String(req.headers["x-bios-host"] || "").toLowerCase();
	res.json({ names: lookupable(host) ? await canonicalNames(host) : [] });
});

// A site's certificate as the server sees it, and whether it's revoked
// (certs.js): for the service worker's check and the app's certificate viewer.
app.get("/api/cert", async (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	const host = String(req.headers["x-bios-host"] || "").toLowerCase();
	const port = Number(req.headers["x-bios-port"] || 443);
	if (!lookupable(host)) return res.status(400).json({ error: "not a site name" });
	try {
		res.json(await certificateOf(host, port));
	} catch (err) {
		res.status(502).json({ error: String(err.message || err) });
	}
});

// Sync between two of the person's devices (sync.js): a relay in memory for
// two sealed boxes, under names only the two devices can work out. Only the
// app itself may use it.
app.put("/api/sync/:channel", express.text({ limit: "5mb", type: "*/*" }), (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	if (!fromShell(req)) return res.status(403).json({ error: "forbidden" });
	const error = sync.put(req.params.channel, req.body, clientKey(req));
	if (error) return res.status(error === "bad box" || error === "bad channel" ? 400 : 429).json({ error });
	res.status(204).end();
});
app.get("/api/sync/:channel", (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	if (!fromShell(req)) return res.status(403).json({ error: "forbidden" });
	const box = sync.take(req.params.channel);
	if (!box) return res.status(404).end();
	res.type("text/plain").send(box);
});

app.use(express.static(publicPath, staticOptions));
app.use("/scram/", express.static(scramjetPath, staticOptions));
app.use("/epoxy/", express.static(epoxyPath, staticOptions));
app.use("/baremux/", express.static(baremuxPath, staticOptions));

// A proxied URL reached the server, so the service worker isn't controlling
// the page (iOS evicts it sometimes, and every isolated site origin starts
// without one). Register it, connect the proxy and reload once.
app.all("/scramjet/{*rest}", async (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	// iOS plays video with its own media engine, which skips the service
	// worker and asks the server for the proxied URL directly.
	const dest = req.headers["sec-fetch-dest"];
	const isPage =
		dest === "document" ||
		dest === "iframe" ||
		dest === "frame" ||
		(!dest &&
			!req.headers.range &&
			(req.headers.accept || "").includes("text/html"));
	if (!isPage) {
		const key = clientKey(req);
		if (limits.overQuota(key))
			return res.status(429).type("text/plain").send("Daily traffic limit reached.");
		try {
			// a stream that began under the limit stops when it crosses it
			const count = (n) => {
				limits.addBytes(key, n);
				if (limits.overQuota(key)) res.destroy();
			};
			// a Tor tab's video goes through Tor too, or not at all
			const label = labelOf(req);
			const agent = viaTor(label) ? torAgent(label) : undefined;
			if (viaTor(label) && !agent) return res.status(503).type("text/plain").send("Tor isn't ready.");
			if (await serveMedia(req, res, count, agent)) return;
		} catch (err) {
			console.warn("media:", err.message);
			if (!res.headersSent) return res.status(502).end();
			return;
		}
		console.warn(
			`proxied request reached the server: dest=${dest || "?"} range=${req.headers.range || "-"} ua=${String(req.headers["user-agent"] || "").slice(0, 60)}`
		);
	}
	res.sendFile(resolve(publicPath, "recover.html"));
});

// Everything else goes back to the app.
app.use((req, res) => {
	res.redirect("/");
});

const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
	const path = new URL(req.url, "http://x").pathname;
	const label = labelOf(req);
	// A Tor tab's site connects through Tor, and only through it; every
	// other origin, never.
	const tor = path === "/torwisp/";
	if ((path !== "/wisp/" && !tor) || !auth.isAuthed(req) || hostKind(req) === "stray" || tor !== viaTor(label)) {
		socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
		return;
	}
	if (tor && !torStatus().ready) {
		socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
		return;
	}
	if (!limits.trackSocket(clientKey(req), socket)) {
		socket.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
		return;
	}
	if (tor) routeRequest(req, socket, head, { TCPSocket: torSocket(label) });
	else routeRequest(req, socket, head);
});

let port = parseInt(process.env.PORT || "");

if (isNaN(port)) port = 8787;

server.on("listening", () => {
	const address = server.address();

	// by default we are listening on 0.0.0.0 (every interface)
	// we just need to list a few
	console.log("Listening on:");
	console.log(`\thttp://localhost:${address.port}`);
	console.log(`\thttp://${hostname()}:${address.port}`);
	console.log(
		`\thttp://${
			address.family === "IPv6" ? `[${address.address}]` : address.address
		}:${address.port}`
	);
	console.log(
		`Access: ${{ password: "private (APP_PASSWORD)", challenge: "public, with a browser check", off: "open (local development)" }[auth.mode]}`
	);
	console.log(`Site isolation: ${ISOLATION ? `on (${ISOLATION})` : "off (set ISOLATION_DOMAIN)"}`);
});

// https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Stop taking connections and let open requests finish, so a deploy doesn't
// cut page loads off halfway. railway.json gives us 15s before the kill.
function shutdown(signal) {
	console.log(`${signal} received: finishing open requests`);
	server.close(() => process.exit(0));
	server.closeIdleConnections();
	// ponytail: proxy WebSockets and video streams never end on their own;
	// they're cut after 10s and the app reconnects to the new deploy.
	setTimeout(() => process.exit(0), 10_000).unref();
}

filters.start();
webRisk?.start();
if (ISOLATION) startTor().catch((err) => console.warn("tor:", err.message));
server.listen({
	port,
});

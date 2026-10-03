import { resolve } from "node:path";
import { tmpdir, hostname } from "node:os";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import express from "express";
import { routeRequest } from "./wisp.js";
import { build } from "esbuild";

import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";

import { CHALLENGE_BITS, createAuth, parseCookies, seal, unseal } from "./auth.js";
import { Filters } from "./filters.js";
import { serveMedia } from "./media.js";
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

const filters = new Filters({
	cacheDir: process.env.FILTER_CACHE_DIR || resolve(tmpdir(), "browser-ios-filters"),
	refreshHours: Number(process.env.FILTER_REFRESH_HOURS) || 24,
});

// ----------------------------------------------------------------- helpers

function hostOf(req) {
	return String(req.headers.host || "")
		.toLowerCase()
		.replace(/:\d+$/, "");
}

// "shell": the app itself. "site": an isolated site origin. "stray": any other
// name under ISOLATION_DOMAIN (www, typos), which only redirects to the app.
// In shared mode (no ISOLATION_DOMAIN, or reached through another address)
// everything is "shell".
function hostKind(req) {
	if (!ISOLATION) return "shell";
	const host = hostOf(req);
	if (!host.endsWith("." + ISOLATION)) return "shell";
	return /^s[a-z2-7]{25}$/.test(host.slice(0, -ISOLATION.length - 1)) ? "site" : "stray";
}

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

async function bundle(entry, globalName) {
	const result = await build({
		entryPoints: [resolve(import.meta.dirname, entry)],
		bundle: true,
		format: "iife",
		globalName,
		minify: true,
		write: false,
		target: ["safari15"],
		legalComments: "none",
	});
	return result.outputFiles[0].text;
}

const bundles = Promise.all([
	bundle("sw/shield.js", "BiosShield"),
	bundle("client/sitekey.js", "BiosSiteKey"),
	bundle("client/page.js"),
]).then(([shield, sitekey, page]) => ({ shield, sitekey, page }));

// `auth`: whether the shield menu offers Lock (only useful with a password).
const clientConfig = JSON.stringify({ isolation: ISOLATION || null, auth: auth.mode === "password" });

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
const framing = (req) =>
	"frame-ancestors 'self'" + (ISOLATION ? ` ${req.protocol}://${ISOLATION}${portOf(req)}` : "");

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
	// them too, but this is the browser's own rule.
	res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()");
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
const SITE_PATHS = /^\/(scramjet\/|scram\/|bios\/(shield|page)\.js$|baremux\/|epoxy\/|filters\/|scramjet-sw\.js$|register-sw\.js$|wipe\.html$|anchor\.html$)/;
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
	if (/^s[a-z2-7]{25}$/.test(label)) {
		res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
		res.setHeader("Access-Control-Allow-Credentials", "true");
		if (req.method === "OPTIONS") {
			res.setHeader("Access-Control-Allow-Headers", "x-bios-host, if-none-match");
			res.setHeader("Access-Control-Max-Age", "86400");
			return res.status(204).end();
		}
	}
	next();
}
app.use(["/filters/engine.bin", "/api/nav", "/api/settings"], siteCors);

app.use(auth.gate);

// Server settings for the shell, the service worker and every proxied page.
const withConfig = (source) => `self.__biosConfig = ${clientConfig};\n${source}`;
app.get("/bios/config.js", (req, res) => {
	res.type("text/javascript").setHeader("Cache-Control", "no-cache");
	res.send(withConfig(""));
});
app.get("/bios/shield.js", async (req, res) => {
	res.type("text/javascript").setHeader("Cache-Control", "no-cache");
	res.send(withConfig((await bundles).shield));
});
app.get("/bios/page.js", async (req, res) => {
	res.type("text/javascript").setHeader("Cache-Control", "no-cache");
	res.send(withConfig((await bundles).page));
});
app.get("/sitekey.js", async (req, res) => {
	res.type("text/javascript").setHeader("Cache-Control", "no-cache");
	res.send((await bundles).sitekey);
});

app.get("/filters/engine.bin", (req, res) => {
	res.vary("Accept-Encoding");
	const engine = filters.engine;
	if (!engine) return res.status(503).setHeader("Retry-After", "60").end();
	res.setHeader("ETag", engine.etag);
	res.setHeader("Cache-Control", "no-cache");
	if (req.headers["if-none-match"] === engine.etag) return res.status(304).end();
	res.type("application/octet-stream");
	if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
		res.setHeader("Content-Encoding", "gzip");
		return res.end(engine.gzip);
	}
	res.end(engine.raw);
});

app.get("/filters/status", (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	res.json(filters.status());
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
app.get("/api/nav", (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	const host = String(req.headers["x-bios-host"] || "");
	res.json({ settings: readSettings(req), threat: host ? filters.threat(host) : null });
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
			if (await serveMedia(req, res, count)) return;
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
	if (!req.url.endsWith("/wisp/") || !auth.isAuthed(req) || hostKind(req) === "stray") {
		socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
		return;
	}
	if (!limits.trackSocket(clientKey(req), socket)) {
		socket.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
		return;
	}
	routeRequest(req, socket, head);
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
server.listen({
	port,
});

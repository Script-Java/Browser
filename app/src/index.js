import { resolve } from "node:path";
import { tmpdir, hostname } from "node:os";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import express from "express";
import wisp from "wisp-server-node";
import { build } from "esbuild";

import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

import { createAuth, parseCookies } from "./auth.js";
import { Filters } from "./filters.js";
import { serveMedia } from "./media.js";
import { clientKey, createLimits } from "./limits.js";
import { DEFAULT_SETTINGS } from "./settings.js";

// Ultraviolet is built from ../Ultraviolet (patched to support config.construct).
const uvPath = resolve(import.meta.dirname, "..", "..", "Ultraviolet", "dist");
const publicPath = resolve(import.meta.dirname, "..", "public");

// ---------------------------------------------------------------- settings

const PASSWORD = process.env.APP_PASSWORD || "";
const SECRET = process.env.AUTH_SECRET || "";

// A public deploy without these is an open proxy (or one whose password can
// be brute-forced offline from a single cookie), so refuse to start.
if (process.env.NODE_ENV === "production" && (!PASSWORD || SECRET.length < 32)) {
	console.error(
		"APP_PASSWORD and AUTH_SECRET (32+ random characters) must be set in production.\n" +
			'  npx @railway/cli variable set "APP_PASSWORD=pick-a-long-password"\n' +
			'  npx @railway/cli variable set "AUTH_SECRET=$(openssl rand -hex 32)"'
	);
	process.exit(1);
}

// e.g. "browse.example.com": the shell runs there and every site gets its own
// <key>.browse.example.com origin. Needs a wildcard DNS record and certificate.
const ISOLATION = (process.env.ISOLATION_DOMAIN || "")
	.trim()
	.toLowerCase()
	.replace(/^\*\./, "")
	.replace(/\.$/, "");

const limits = createLimits({
	// ponytail: per address, so a household behind one IP shares these.
	maxSockets: 16,
	dailyBytes: Number(process.env.DAILY_GB_PER_CLIENT || 10) * 1024 ** 3,
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

// "shell": the app itself. "site": an isolated site origin. In shared mode
// (no ISOLATION_DOMAIN, or reached through another address) everything is "shell".
function hostKind(req) {
	if (!ISOLATION) return "shell";
	const host = hostOf(req);
	if (host.endsWith("." + ISOLATION) && /^s[a-z2-7]{25}$/.test(host.slice(0, -ISOLATION.length - 1)))
		return "site";
	return "shell";
}

function cookieDomain(req) {
	const host = hostOf(req);
	if (ISOLATION && (host === ISOLATION || host.endsWith("." + ISOLATION)))
		return ISOLATION;
	return null;
}

const auth = createAuth({ password: PASSWORD, secret: SECRET, cookieDomain });

// Settings live in a signed cookie shared by the shell and every site origin,
// so a proxied page can't switch protections off by writing its own cookie.
const SETTINGS_COOKIE = "bios_settings";
const settingsKey = createHmac("sha256", "bios-settings").update(SECRET + "\0" + PASSWORD).digest();

function readSettings(req) {
	const raw = parseCookies(req.headers.cookie)[SETTINGS_COOKIE];
	if (raw) {
		const [data, mac] = raw.split(".");
		const expected = createHmac("sha256", settingsKey).update(data).digest("base64url");
		if (mac === expected) {
			try {
				return { ...DEFAULT_SETTINGS, ...JSON.parse(Buffer.from(data, "base64url").toString()) };
			} catch {
				// fall through to defaults
			}
		}
	}
	return { ...DEFAULT_SETTINGS };
}

function cleanSettings(input) {
	const out = {};
	for (const key of ["ads", "cosmetic", "videoAds", "threats", "wipe"])
		out[key] = typeof input?.[key] === "boolean" ? input[key] : DEFAULT_SETTINGS[key];
	out.allow = Array.isArray(input?.allow)
		? [...new Set(input.allow.filter((s) => typeof s === "string" && /^[a-z0-9.-]{1,253}$/.test(s)))].slice(0, 200)
		: [];
	return out;
}

function writeSettings(req, res, settings) {
	const data = Buffer.from(JSON.stringify(settings)).toString("base64url");
	const mac = createHmac("sha256", settingsKey).update(data).digest("base64url");
	const parts = [
		`${SETTINGS_COOKIE}=${data}.${mac}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${5 * 365 * 86_400}`,
	];
	const domain = cookieDomain(req);
	if (domain) parts.push(`Domain=${domain}`);
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
]).then(([shield, sitekey]) => ({ shield, sitekey }));

const clientConfig = JSON.stringify({ isolation: ISOLATION || null, auth: auth.enabled });

// -------------------------------------------------------------------- app

// iOS home-screen apps cache aggressively; always revalidate.
const staticOptions = {
	setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
};

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

// For the host's health check (railway.json); before the site and password rules.
app.get("/healthz", (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	res.type("text/plain").send("ok");
});

app.use((req, res, next) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	// lets the shell frame pages from the site subdomains
	res.setHeader("Cross-Origin-Resource-Policy", "same-site");
	res.setHeader("Referrer-Policy", "same-origin");
	res.setHeader("X-Content-Type-Options", "nosniff");
	next();
});

// Site origins only serve what the proxy needs, never the shell: if the shell
// ran on a site origin, that site could reach into it.
const SITE_PATHS = /^\/(uv\/|baremux\/|epoxy\/|filters\/|api\/(nav|settings)$|register-sw\.js$|wipe\.html$|anchor\.html$)/;
app.use((req, res, next) => {
	if (hostKind(req) === "site" && !SITE_PATHS.test(req.path)) {
		if (req.path === "/" && req.method === "GET")
			return res.redirect(`${req.protocol}://${ISOLATION}${req.headers.host.match(/:\d+$/)?.[0] || ""}/`);
		return res.status(404).type("text/plain").send("Not found");
	}
	next();
});

app.get("/login", (req, res) => {
	if (!auth.enabled || auth.isAuthed(req)) return res.redirect("/");
	res.setHeader("Cache-Control", "no-store");
	res.sendFile(resolve(publicPath, "login.html"));
});
app.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), auth.login);
app.post("/logout", auth.logout);

app.use(auth.gate);

app.get("/uv/uv.config.js", async (req, res) => {
	res.type("text/javascript").setHeader("Cache-Control", "no-cache");
	const source = await readFile(resolve(publicPath, "uv", "uv.config.js"), "utf8");
	res.send(`self.__biosConfig = ${clientConfig};\n${source}`);
});
app.get("/uv/shield.js", async (req, res) => {
	res.type("text/javascript").setHeader("Cache-Control", "no-cache");
	res.send((await bundles).shield);
});
app.get("/sitekey.js", async (req, res) => {
	res.type("text/javascript").setHeader("Cache-Control", "no-cache");
	res.send((await bundles).sitekey);
});

app.get("/filters/engine.bin", (req, res) => {
	// isolation mode: site origins' service workers load the shell's copy
	const origin = req.headers.origin;
	if (origin && ISOLATION) {
		try {
			const { hostname } = new URL(origin);
			if (hostname.endsWith("." + ISOLATION)) {
				res.setHeader("Access-Control-Allow-Origin", origin);
				res.setHeader("Access-Control-Allow-Credentials", "true");
			}
		} catch {
			// ignore malformed Origin
		}
	}
	res.setHeader("Vary", "Origin, Accept-Encoding");
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
	res.json(readSettings(req));
});

app.post("/api/settings", express.json({ limit: "16kb" }), (req, res) => {
	if (!fromShell(req)) return res.status(403).json({ error: "forbidden" });
	const settings = cleanSettings(req.body);
	writeSettings(req, res, settings);
	res.setHeader("Cache-Control", "no-store");
	res.json(settings);
});

// The service worker calls this once per page load.
app.get("/api/nav", (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	const host = String(req.query.host || "");
	res.json({ settings: readSettings(req), threat: host ? filters.threat(host) : null });
});

// Load our publicPath first and prioritize it over UV.
app.use(express.static(publicPath, staticOptions));
// Load vendor files last.
// The vendor's uv.config.js won't conflict with our uv.config.js inside the publicPath directory.
app.use("/uv/", express.static(uvPath, staticOptions));
app.use("/epoxy/", express.static(epoxyPath, staticOptions));
app.use("/baremux/", express.static(baremuxPath, staticOptions));

// A proxied URL reached the server, so the service worker isn't controlling
// the page (iOS evicts it sometimes, and every isolated site origin starts
// without one). Register it, connect the proxy and reload once.
app.all("/uv/service/{*rest}", async (req, res) => {
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
			if (await serveMedia(req, res, (n) => limits.addBytes(key, n))) return;
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
	if (!req.url.endsWith("/wisp/") || !auth.isAuthed(req)) {
		socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
		return;
	}
	if (!limits.trackSocket(clientKey(req), socket)) {
		socket.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
		return;
	}
	wisp.routeRequest(req, socket, head);
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
	console.log(`Password: ${auth.enabled ? "on" : "off (set APP_PASSWORD)"}`);
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

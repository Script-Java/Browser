// Password gate. When APP_PASSWORD is set, every request (pages, the proxy
// service worker's files, the wisp WebSocket) needs a signed session cookie,
// which /login hands out.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { clientKey } from "./limits.js";

const COOKIE = "bios_auth";
const SESSION_DAYS = 180;
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

// Reachable without signing in: the login page itself and what iOS fetches
// when adding the app to the home screen.
const PUBLIC_PATHS = new Set([
	"/login",
	"/login.html",
	"/login.css",
	"/index.css",
	"/manifest.webmanifest",
	"/favicon.ico",
	"/uv.png",
]);

const sha256 = (text) => createHash("sha256").update(text).digest();

export function parseCookies(header = "") {
	const cookies = {};
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const name = part.slice(0, eq).trim();
		if (!(name in cookies))
			cookies[name] = decodeURIComponent(part.slice(eq + 1).trim());
	}
	return cookies;
}

/**
 * @param {{ password?: string, secret?: string, cookieDomain: (req: import("node:http").IncomingMessage) => string | null }} options
 */
export function createAuth({ password, secret, cookieDomain }) {
	const enabled = !!password;
	// Changing the password signs every device out.
	const key = sha256(`bios-auth:${secret || ""}:${password || ""}`);
	const passwordHash = sha256(password || "");
	const attempts = new Map(); // ip -> { count, since }

	function sign(expires) {
		return createHmac("sha256", key)
			.update(String(expires))
			.digest("base64url");
	}

	function isAuthed(req) {
		if (!enabled) return true;
		const token = parseCookies(req.headers.cookie)[COOKIE];
		if (!token) return false;
		const [expires, mac] = token.split(".");
		if (!mac || Number(expires) < Date.now()) return false;
		const expected = Buffer.from(sign(expires));
		const given = Buffer.from(mac);
		return expected.length === given.length && timingSafeEqual(expected, given);
	}

	function cookie(req, value, maxAge) {
		const parts = [
			`${COOKIE}=${value}`,
			"Path=/",
			"HttpOnly",
			"SameSite=Lax",
			`Max-Age=${maxAge}`,
		];
		const domain = cookieDomain(req);
		if (domain) parts.push(`Domain=${domain}`);
		if (req.secure) parts.push("Secure");
		return parts.join("; ");
	}

	function tooManyAttempts(ip) {
		const now = Date.now();
		const entry = attempts.get(ip);
		if (!entry || now - entry.since > ATTEMPT_WINDOW_MS) return false;
		return entry.count >= MAX_ATTEMPTS;
	}

	function recordFailure(ip) {
		const now = Date.now();
		const entry = attempts.get(ip);
		if (!entry || now - entry.since > ATTEMPT_WINDOW_MS)
			attempts.set(ip, { count: 1, since: now });
		else entry.count++;
		// Drop expired entries only: clearing everything would let a flood of
		// addresses reset an attacker's own counter.
		if (attempts.size > 10_000)
			for (const [key, e] of attempts)
				if (now - e.since > ATTEMPT_WINDOW_MS) attempts.delete(key);
	}

	/** Express middleware: blocks everything except PUBLIC_PATHS until signed in. */
	function gate(req, res, next) {
		if (
			!enabled ||
			PUBLIC_PATHS.has(req.path) ||
			req.path.startsWith("/icons/")
		)
			return next();
		if (isAuthed(req)) return next();

		const wantsPage =
			req.method === "GET" && (req.headers.accept || "").includes("text/html");
		if (wantsPage && (req.path === "/" || req.path === "/index.html"))
			return res.redirect("/login");
		if (req.path.startsWith("/uv/service/"))
			console.warn(
				`signed-out proxied request: dest=${req.headers["sec-fetch-dest"] || "?"} range=${req.headers.range || "-"} ua=${String(req.headers["user-agent"] || "").slice(0, 60)}`
			);
		res.status(401).type("text/plain").send("Sign in first.");
	}

	/** POST /login */
	function login(req, res) {
		const ip = clientKey(req);
		if (!enabled) return res.redirect("/");
		if (tooManyAttempts(ip))
			return res.redirect(
				"/login?error=" +
					encodeURIComponent("Too many attempts. Try again in 15 minutes.")
			);

		const given = sha256(String(req.body?.password || ""));
		if (!timingSafeEqual(given, passwordHash)) {
			recordFailure(ip);
			return res.redirect(
				"/login?error=" + encodeURIComponent("Wrong password.")
			);
		}
		attempts.delete(ip);
		const expires = Date.now() + SESSION_DAYS * 86_400_000;
		res.setHeader(
			"Set-Cookie",
			cookie(req, `${expires}.${sign(expires)}`, SESSION_DAYS * 86_400)
		);
		res.redirect("/");
	}

	/** POST /logout */
	function logout(req, res) {
		res.setHeader("Set-Cookie", cookie(req, "", 0));
		res.redirect(enabled ? "/login" : "/");
	}

	return { enabled, isAuthed, gate, login, logout };
}

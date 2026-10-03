// Access gate. Every request (pages, the proxy service worker's files, the
// wisp WebSocket) needs a signed session cookie, which /login hands out:
// - "password" (APP_PASSWORD set): for a private instance.
// - "challenge" (only AUTH_SECRET set): open to anyone whose browser solves a
//   small proof-of-work puzzle, which keeps casual bots and scanners out
//   without accounts, a database or a third-party captcha.
// - "off" (neither set): local development only; production refuses to start.

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { clientKey } from "./limits.js";

/**
 * A value -> an opaque cookie-safe token (AES-256-GCM): without the 32-byte
 * key it can be neither read nor changed.
 * @param {Buffer} key
 * @param {unknown} value
 */
export function seal(key, value) {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
	return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/**
 * The value back, or null if the token wasn't sealed with this key.
 * @param {Buffer} key
 * @param {string} token
 */
export function unseal(key, token) {
	try {
		const raw = Buffer.from(String(token), "base64url");
		// a fixed tag length: GCM otherwise accepts short, forgeable tags
		const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12), {
			authTagLength: 16,
		});
		decipher.setAuthTag(raw.subarray(-16));
		return JSON.parse(
			Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString()
		);
	} catch {
		return null;
	}
}

const COOKIE = "bios_auth";
const SESSION_DAYS = { password: 180, challenge: 30 };
// ~65k hashes on average: about a second on a phone, once a month.
// ponytail: a determined attacker solves this cheaply on a server; the
// per-client and daily traffic limits are what actually cap abuse.
export const CHALLENGE_BITS = 16;
const CHALLENGE_MS = 10 * 60_000;
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
	"/logo.png",
	"/terms",
	"/api/challenge",
]);

const sha256 = (text) => createHash("sha256").update(text).digest();

export function parseCookies(header = "") {
	const cookies = {};
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const name = part.slice(0, eq).trim();
		if (name in cookies) continue;
		// A bad %-escape must not throw: this runs in the WebSocket upgrade
		// handler too, where an exception kills the server.
		try {
			cookies[name] = decodeURIComponent(part.slice(eq + 1).trim());
		} catch {
			cookies[name] = part.slice(eq + 1).trim();
		}
	}
	return cookies;
}

/**
 * Every value a cookie name has in the header. A site on a subdomain can set
 * a cookie of the same name for the whole domain, and which copy comes first
 * is up to the browser, so callers look for a good one among them all.
 */
export function cookieValues(header = "", name) {
	return header
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(name + "="))
		.map((part) => part.slice(name.length + 1));
}

function leadingZeroBits(bytes) {
	let bits = 0;
	for (const byte of bytes) {
		if (byte) return bits + Math.clz32(byte) - 24;
		bits += 8;
	}
	return bits;
}

/**
 * @param {{ password?: string, secret?: string, cookieDomain: (req: import("node:http").IncomingMessage) => string | null }} options
 */
export function createAuth({ password, secret, cookieDomain }) {
	const mode = password ? "password" : secret ? "challenge" : "off";
	const enabled = mode !== "off";
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
		// any good copy counts, so a planted bad one can't sign people out
		return cookieValues(req.headers.cookie, COOKIE).some((token) => {
			const [expires, mac] = token.split(".");
			if (!mac || Number(expires) < Date.now()) return false;
			const expected = Buffer.from(sign(expires));
			const given = Buffer.from(mac);
			return expected.length === given.length && timingSafeEqual(expected, given);
		});
	}

	/** A fresh puzzle: a signed timestamp and nonce, so the server keeps nothing. */
	function newChallenge() {
		const body = `${Date.now()}.${randomBytes(12).toString("base64url")}`;
		const mac = createHmac("sha256", key).update("challenge:" + body).digest("base64url");
		return `${body}.${mac}`;
	}

	/** True when `solution` solves a challenge this server issued in the last 10 minutes. */
	function solves(challenge, solution) {
		const [issued, nonce, mac] = String(challenge).split(".");
		if (!mac || !/^\d{1,12}$/.test(String(solution))) return false;
		const age = Date.now() - Number(issued);
		if (!(age >= 0 && age < CHALLENGE_MS)) return false;
		const expected = Buffer.from(
			createHmac("sha256", key).update(`challenge:${issued}.${nonce}`).digest("base64url")
		);
		const given = Buffer.from(mac);
		if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
		return leadingZeroBits(sha256(`${challenge}:${solution}`)) >= CHALLENGE_BITS;
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
		if (req.path.startsWith("/scramjet/"))
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

		const ok =
			mode === "password"
				? timingSafeEqual(sha256(String(req.body?.password || "")), passwordHash)
				: solves(req.body?.challenge, req.body?.solution);
		if (!ok) {
			recordFailure(ip);
			return res.redirect(
				"/login?error=" +
					encodeURIComponent(mode === "password" ? "Wrong password." : "Check failed. Try again.")
			);
		}
		attempts.delete(ip);
		const days = SESSION_DAYS[mode];
		const expires = Date.now() + days * 86_400_000;
		res.setHeader("Set-Cookie", cookie(req, `${expires}.${sign(expires)}`, days * 86_400));
		res.redirect("/");
	}

	/** POST /logout */
	function logout(req, res) {
		res.setHeader("Set-Cookie", cookie(req, "", 0));
		res.redirect(enabled ? "/login" : "/");
	}

	return { mode, enabled, isAuthed, gate, login, logout, newChallenge, solves };
}

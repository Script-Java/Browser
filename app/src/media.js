// Media fallback for requests that reach the server with a proxied URL.
//
// Normally the service worker handles every /scramjet/ request on the
// phone. iOS plays video with its own media engine (HLS always, plain video
// files sometimes), and that engine does not go through service workers: it
// asks the server for the proxied URL directly. Without this, it got the
// recovery page and the player spun forever.
//
// This decodes the proxied URL, fetches the media from the site, and streams
// it back. HLS playlists are rewritten so every segment, key and sub-playlist
// in them is a proxied URL too, because the media engine fetches those on
// its own as well.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { pipeline } from "node:stream";
import { PREFIX, decodeUrl, encodeUrl } from "./codec.js";
import { lookupAll } from "./dns.js";
import { WEB_PORTS, isBlockedAddress } from "./wisp.js";

const MAX_REDIRECTS = 5;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

// Same rules as the wisp server: never connect to the server's own network,
// and look names up over DoH (dns.js).
function safeLookup(hostname, options, callback) {
	lookupAll(hostname).then((addresses) => {
		const allowed = addresses.filter((a) => !isBlockedAddress(a.address));
		if (!allowed.length) {
			const error = new Error(`Blocked connection to a private address (${hostname})`);
			error.code = "EACCES";
			return callback(error);
		}
		if (options && options.all) return callback(null, allowed);
		callback(null, allowed[0].address, allowed[0].family);
	}, callback);
}

// ---------------------------------------------------------- HLS rewriting

const PLAYLIST_TYPES = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl)|audio\/(x-)?mpegurl)/i;
const URI_TAGS = /^#EXT-X-(KEY|SESSION-KEY|MAP|MEDIA|I-FRAME-STREAM-INF|PART|PRELOAD-HINT|RENDITION-REPORT)/i;

function isPlaylist(url, contentType) {
	if (PLAYLIST_TYPES.test(contentType || "")) return true;
	return /\.m3u8?(\?|$)/i.test(url.pathname) && !/^(video|audio|image)\//i.test(contentType || "");
}

// The addresses in a playlist the server rewrote (every segment of a video)
// are sealed, AES-GCM with a key only this server has: the player asks for
// each one by its address, and the host's request logs record them. Sealed,
// the logs show nothing of what's played but the playlist's own address.
// ponytail: that first address is the page's (Scramjet makes it); hiding it
// too needs a codec of our own in Scramjet
const SEALED = PREFIX + "__m/";
const MEDIA_KEY = createHmac("sha256", process.env.AUTH_SECRET || randomBytes(32)).update("bios-media-url").digest();

/** "/scramjet/__m/…": a site URL only this server can read back. */
export function sealUrl(url) {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", MEDIA_KEY, iv);
	const box = Buffer.concat([cipher.update(String(url), "utf8"), cipher.final()]);
	return SEALED + Buffer.concat([iv, box, cipher.getAuthTag()]).toString("base64url");
}

/** The http(s) URL a sealed address (absolute, or a path) holds, or null. */
export function unsealUrl(proxied) {
	try {
		const { pathname } = new URL(proxied, "http://x");
		if (!pathname.startsWith(SEALED)) return null;
		const raw = Buffer.from(pathname.slice(SEALED.length), "base64url");
		const decipher = createDecipheriv("aes-256-gcm", MEDIA_KEY, raw.subarray(0, 12));
		decipher.setAuthTag(raw.subarray(raw.length - 16));
		const url = new URL(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8"));
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

function proxied(base, ref, encode) {
	try {
		return encode(new URL(ref, base));
	} catch {
		return ref;
	}
}

/** Rewrites every URL in an HLS playlist to a proxied one (relative to this server). */
export function rewritePlaylist(text, baseUrl, encode = encodeUrl) {
	return text
		.split(/\r?\n/)
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed) return line;
			if (trimmed.startsWith("#")) {
				if (!URI_TAGS.test(trimmed)) return line;
				return line.replace(/URI="([^"]*)"/g, (m, ref) => `URI="${proxied(baseUrl, ref, encode)}"`);
			}
			return proxied(baseUrl, trimmed, encode);
		})
		.join("\n");
}

// -------------------------------------------------------------- the fetch

// The site's headers a player needs. Every other one stays behind: sent from
// this origin, a site's Clear-Site-Data would sign the person out, and its
// reporting headers (NEL, Report-To) would have the browser call the site
// directly, around the proxy.
const PASS_HEADERS = ["content-type", "content-range", "accept-ranges", "etag", "last-modified"];

// What a media engine asks for. A script or worker fetched through here
// would run on this origin without the proxy's hooks.
const MEDIA_DESTS = new Set(["video", "audio", "track", "empty"]);

// `agent`: for a Tor tab's site, its connections through Tor (tor.js)
function upstreamRequest(url, headers, method, redirects = 0, agent = undefined) {
	return new Promise((resolve, reject) => {
		// an IP in the URL skips DNS, and so the lookup check
		const literal = url.hostname.replace(/^\[|\]$/g, "");
		if (net.isIP(literal) && isBlockedAddress(literal))
			return reject(new Error(`Blocked connection to a private address (${literal})`));
		// same ports as wisp, so this can't be used for port scans either; checked per redirect hop
		if (url.port && !WEB_PORTS.includes(Number(url.port)))
			return reject(new Error(`Blocked port ${url.port}`));
		const lib = url.protocol === "https:" ? https : http;
		const req = lib.request(
			url,
			// through Tor the exit looks the name up, never the server
			agent ? { method, headers, agent, timeout: 60_000 } : { method, headers, lookup: safeLookup, timeout: 30_000 },
			(res) => {
				const status = res.statusCode || 0;
				const location = res.headers.location;
				if ([301, 302, 303, 307, 308].includes(status) && location && redirects < MAX_REDIRECTS) {
					res.resume();
					let next;
					try {
						next = new URL(location, url);
					} catch {
						return resolve({ res, url });
					}
					if (next.protocol !== "http:" && next.protocol !== "https:")
						return resolve({ res, url });
					return resolve(upstreamRequest(next, headers, method, redirects + 1, agent));
				}
				resolve({ res, url });
			}
		);
		req.on("timeout", () => req.destroy(new Error("upstream timeout")));
		req.on("error", reject);
		req.end();
	});
}

function readAll(stream, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		stream.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				stream.destroy();
				reject(new Error("playlist too large"));
				return;
			}
			chunks.push(chunk);
		});
		stream.on("end", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
	});
}

/**
 * Express handler for a proxied URL that reached the server from a media
 * engine. Returns false (and sends nothing) when the request isn't one.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {(bytes: number) => void} [countBytes] told about every chunk streamed
 */
export async function serveMedia(req, res, countBytes = () => {}, agent = undefined) {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	// absent before iOS 16.4, and from the system's HLS player
	const dest = req.headers["sec-fetch-dest"];
	if (dest && !MEDIA_DESTS.has(dest)) return false;
	const target = unsealUrl(req.originalUrl) || decodeUrl(req.originalUrl);
	if (!target) return false;

	const headers = {
		"user-agent": req.headers["user-agent"] || "Mozilla/5.0",
		accept: req.headers.accept || "*/*",
		"accept-language": req.headers["accept-language"] || "en-US,en;q=0.9",
		"accept-encoding": "identity",
	};
	if (req.headers.range) headers.range = req.headers.range;
	// The page the player is on, decoded from the proxied referrer, so sites
	// that only serve video to their own pages still work.
	const page = req.headers.referer && decodeUrl(req.headers.referer);
	headers.referer = page ? page.href : target.origin + "/";
	if (page) headers.origin = page.origin;

	let upstream;
	try {
		upstream = await upstreamRequest(target, headers, req.method, 0, agent);
	} catch (err) {
		// no hostname: the server doesn't keep a record of where people browse
		console.warn(`media: ${err.message.replace(target.hostname, "<site>")}`);
		res.status(502).type("text/plain").send("Couldn't reach the media server.");
		return true;
	}
	const { res: up, url: finalUrl } = upstream;
	const contentType = up.headers["content-type"] || "";

	res.status(up.statusCode || 502);
	for (const name of PASS_HEADERS)
		if (up.headers[name] !== undefined) res.setHeader(name, up.headers[name]);
	// for requests without Sec-Fetch-Dest: never hand back something a browser would run
	if (/script/i.test(contentType)) res.setHeader("Content-Type", "text/plain");
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Cross-Origin-Resource-Policy", "same-site");
	// never let a fetched file run as a page on this origin
	res.setHeader("Content-Security-Policy", "sandbox");

	if (req.method === "HEAD" || up.statusCode === 304 || up.statusCode === 204) {
		up.resume();
		res.end();
		return true;
	}

	if (up.statusCode === 200 && isPlaylist(finalUrl, contentType)) {
		let body;
		try {
			body = await readAll(up, MAX_PLAYLIST_BYTES);
		} catch (err) {
			res.status(502).type("text/plain").send(err.message);
			return true;
		}
		countBytes(body.length);
		const text = body.toString("utf8");
		if (!text.trimStart().startsWith("#EXTM3U")) {
			res.type(contentType || "application/octet-stream").send(body);
			return true;
		}
		const rewritten = rewritePlaylist(text, finalUrl, sealUrl);
		res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
		res.setHeader("Content-Length", Buffer.byteLength(rewritten));
		res.end(rewritten);
		return true;
	}

	if (up.headers["content-length"] !== undefined)
		res.setHeader("Content-Length", up.headers["content-length"]);
	up.on("data", (chunk) => countBytes(chunk.length));
	pipeline(up, res, (err) => {
		if (err && !res.headersSent) res.status(502).end();
	});
	return true;
}

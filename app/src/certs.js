// A site's certificate as the server sees it, for the app's certificate
// viewer, and whether whoever issued it has revoked it. The TLS inside the
// app (epoxy, rustls) checks a certificate's dates, name and signatures, but
// not revocation, and can't show the certificate it got. So the server opens
// a connection of its own to the site, reads the certificate there, and looks
// it up in the issuer's revocation list (its CRL), checking the list's
// signature against the issuer's key.

import { X509Certificate, verify as verifySignature } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { WEB_PORTS, isBlockedAddress } from "./wisp.js";

// ------------------------------------------------------------------- DER

/** The element at `at` in DER `buf`: tag, where its content starts and ends, where it ends. */
function element(buf, at) {
	if (at + 2 > buf.length) throw new Error("DER: truncated");
	const tag = buf[at];
	let length = buf[at + 1];
	let start = at + 2;
	if (length & 0x80) {
		const bytes = length & 0x7f;
		if (!bytes || bytes > 4 || start + bytes > buf.length) throw new Error("DER: bad length");
		length = 0;
		for (let i = 0; i < bytes; i++) length = length * 256 + buf[start + i];
		start += bytes;
	}
	const end = start + length;
	if (end > buf.length) throw new Error("DER: truncated");
	return { tag, at, start, end };
}

/** The elements inside a constructed one. */
function children(buf, parent) {
	const out = [];
	for (let at = parent.start; at < parent.end; ) {
		const child = element(buf, at);
		out.push(child);
		at = child.end;
	}
	return out;
}

function oid(buf, el) {
	const bytes = buf.subarray(el.start, el.end);
	const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
	let value = 0;
	for (const byte of bytes.subarray(1)) {
		value = value * 128 + (byte & 0x7f);
		if (!(byte & 0x80)) {
			parts.push(value);
			value = 0;
		}
	}
	return parts.join(".");
}

function time(buf, el) {
	const text = buf.toString("latin1", el.start, el.end);
	const parts = /^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
	if (!parts) return null;
	let year = Number(parts[1]);
	if (parts[1].length === 2) year += year < 50 ? 2000 : 1900;
	return new Date(Date.UTC(year, parts[2] - 1, parts[3], parts[4], parts[5], parts[6]));
}

// A serial number as Node writes one (X509Certificate.serialNumber): hex, upper case, no leading zeros.
const serialOf = (bytes) => Buffer.from(bytes).toString("hex").toUpperCase().replace(/^0+(?=.)/, "");

// ------------------------------------------------------------ the parts

/** The addresses of the revocation lists a certificate (DER) names: its CRL distribution points. */
export function crlUrls(der) {
	const cert = element(der, 0);
	const [tbs] = children(der, cert);
	const extensions = children(der, tbs).find((el) => el.tag === 0xa3);
	if (!extensions) return [];
	const [list] = children(der, extensions);
	for (const ext of children(der, list)) {
		const parts = children(der, ext);
		if (oid(der, parts[0]) !== "2.5.29.31") continue;
		const value = parts[parts.length - 1];
		// every uniformResourceIdentifier ([6]) in it
		const urls = [];
		const walk = (el) => {
			if (el.tag === 0x86) urls.push(der.toString("latin1", el.start, el.end));
			else if (el.tag & 0x20) for (const child of children(der, el)) walk(child);
		};
		walk(element(der, value.start));
		return urls.filter((url) => /^https?:\/\//i.test(url));
	}
	return [];
}

const ALGORITHMS = {
	"1.2.840.113549.1.1.11": "sha256",
	"1.2.840.113549.1.1.12": "sha384",
	"1.2.840.113549.1.1.13": "sha512",
	"1.2.840.10045.4.3.2": "sha256",
	"1.2.840.10045.4.3.3": "sha384",
	"1.2.840.10045.4.3.4": "sha512",
};

/**
 * A revocation list (DER): the serial numbers it revokes, when the next one
 * is due, and what it takes to check its signature.
 */
export function parseCrl(der) {
	const list = element(der, 0);
	const [tbs, algorithm, signature] = children(der, list);
	const parts = children(der, tbs);
	let i = 0;
	if (parts[i]?.tag === 0x02) i++; // version
	i += 2; // signature algorithm, issuer
	const thisUpdate = parts[i] && time(der, parts[i]);
	i++;
	let nextUpdate = null;
	if (parts[i] && (parts[i].tag === 0x17 || parts[i].tag === 0x18)) nextUpdate = time(der, parts[i++]);
	const serials = new Set();
	if (parts[i]?.tag === 0x30)
		for (const entry of children(der, parts[i])) {
			const [serial] = children(der, entry);
			serials.add(serialOf(der.subarray(serial.start, serial.end)));
		}
	return {
		serials,
		thisUpdate,
		nextUpdate,
		signed: der.subarray(tbs.at, tbs.end),
		hash: ALGORITHMS[oid(der, children(der, algorithm)[0])] || null,
		// a BIT STRING's first byte counts its unused bits
		signature: der.subarray(signature.start + 1, signature.end),
	};
}

/** Whether `crl` (parseCrl's) was signed by the holder of `issuerKey` (a KeyObject). */
export function signedBy(crl, issuerKey) {
	if (!crl.hash) return false;
	try {
		return verifySignature(crl.hash, crl.signed, issuerKey, crl.signature);
	} catch {
		return false;
	}
}

// ----------------------------------------------------------- the network

// Public addresses only, as for the proxy itself (wisp.js).
function publicLookup(hostname, options, callback) {
	dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
		if (err) return callback(err);
		const allowed = addresses.filter((a) => !isBlockedAddress(a.address));
		if (!allowed.length) return callback(Object.assign(new Error("private address"), { code: "EACCES" }));
		if (options?.all) return callback(null, allowed);
		callback(null, allowed[0].address, allowed[0].family);
	});
}

const MAX_CRL_BYTES = 20 * 1024 ** 2;

function download(url) {
	return new Promise((resolve, reject) => {
		const at = new URL(url);
		if (at.port && at.port !== "80" && at.port !== "443") return reject(new Error("not a web port"));
		const lib = at.protocol === "https:" ? https : http;
		const req = lib.get(at, { lookup: publicLookup, timeout: 10_000 }, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				return reject(new Error(`HTTP ${res.statusCode}`));
			}
			const chunks = [];
			let size = 0;
			res.on("data", (chunk) => {
				size += chunk.length;
				if (size > MAX_CRL_BYTES) req.destroy(new Error("list too large"));
				else chunks.push(chunk);
			});
			res.on("end", () => resolve(Buffer.concat(chunks)));
			res.on("error", reject);
		});
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("error", reject);
	});
}

// The site's certificates, from a connection of the server's own.
function handshake(host, port) {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({
			host,
			port,
			servername: /^[\d.]+$|:/.test(host) ? undefined : host,
			lookup: publicLookup,
			// (told apart below: a certificate that fails is still shown)
			rejectUnauthorized: false,
			timeout: 8000,
		});
		socket.once("secureConnect", () => {
			const peer = socket.getPeerCertificate(true);
			resolve({
				leaf: socket.getPeerX509Certificate(),
				issuer: peer?.issuerCertificate && peer.issuerCertificate !== peer ? new X509Certificate(peer.issuerCertificate.raw) : null,
				trusted: socket.authorized,
				problem: socket.authorizationError ? String(socket.authorizationError) : null,
			});
			socket.end();
		});
		socket.once("timeout", () => socket.destroy(new Error("timed out")));
		socket.once("error", reject);
	});
}

// "CN=example.com\nO=Example" as { CN, O }
function names(text) {
	const out = {};
	for (const line of String(text || "").split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
	}
	return out;
}

/**
 * @param {{ connect?: typeof handshake, fetchCrl?: typeof download, ttlMs?: number }} [options]
 * stand-ins for the network in tests
 */
export function createCerts({ connect = handshake, fetchCrl = download, ttlMs = 6 * 3_600_000 } = {}) {
	const sites = new Map(); // "host:port" -> { about: Promise, at }
	const crls = new Map(); // url -> { list: Promise, until }

	function crlAt(url) {
		const hit = crls.get(url);
		if (hit && Date.now() < hit.until) return hit.list;
		if (crls.size > 500) crls.clear();
		const list = fetchCrl(url).then(parseCrl);
		// a list lasts until its next one is due (at most half a day); a failure, five minutes
		const entry = { list, until: Date.now() + 300_000 };
		crls.set(url, entry);
		list.then(
			(crl) => (entry.until = Math.min(crl.nextUpdate?.getTime() || 0, Date.now() + 12 * 3_600_000) || Date.now() + 3_600_000),
			() => {}
		);
		return list;
	}

	/** true, false, or null when there's no telling (no list, or none that can be checked). */
	async function revoked(leaf, issuer) {
		if (!issuer) return null;
		for (const url of crlUrls(leaf.raw)) {
			try {
				const crl = await crlAt(url);
				if (!signedBy(crl, issuer.publicKey)) continue;
				return crl.serials.has(leaf.serialNumber.toUpperCase().replace(/^0+(?=.)/, ""));
			} catch {
				// try the next list
			}
		}
		return null;
	}

	async function look(host, port) {
		const { leaf, issuer, trusted, problem } = await connect(host, port);
		const subject = names(leaf.subject);
		const by = names(leaf.issuer);
		return {
			host,
			subject: subject.CN || subject.O || "",
			organization: subject.O || "",
			issuer: by.O ? `${by.O}${by.CN ? ` (${by.CN})` : ""}` : by.CN || "",
			names: String(leaf.subjectAltName || "")
				.split(/,\s*/)
				.filter((name) => name.startsWith("DNS:"))
				.map((name) => name.slice(4))
				.slice(0, 50),
			validFrom: new Date(leaf.validFrom).toISOString(),
			validTo: new Date(leaf.validTo).toISOString(),
			fingerprint: leaf.fingerprint256,
			serial: leaf.serialNumber,
			trusted,
			problem,
			revoked: trusted ? await revoked(leaf, issuer) : null,
		};
	}

	/** What `host`'s certificate says, or null when it can't be had. */
	function about(host, port = 443) {
		host = String(host).toLowerCase();
		port = Number(port);
		if (!/^[a-z0-9.-]{1,253}$/.test(host) || !WEB_PORTS.includes(port)) return Promise.resolve(null);
		const key = `${host}:${port}`;
		const hit = sites.get(key);
		if (hit && Date.now() - hit.at < ttlMs) return hit.about;
		if (sites.size > 2000) sites.clear();
		const entry = { about: look(host, port).catch(() => null), at: Date.now() };
		sites.set(key, entry);
		// (no answer: asked again next time)
		entry.about.then((answer) => answer || sites.delete(key));
		return entry.about;
	}
	return { about };
}

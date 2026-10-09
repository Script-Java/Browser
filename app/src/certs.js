// Certificates, as the server sees them: who a site's certificate belongs to
// (the app's certificate viewer) and whether its authority has revoked it.
//
// The app's TLS runs on the device (epoxy, rustls), which checks the chain
// and the name but can't check revocation. So the server opens a TLS
// connection of its own to the site, reads the certificate and checks it
// against its authority's revocation list (CRL), as Chrome's CRLSets and
// Firefox's CRLite do from lists of their own. The server already learns the
// site's name from every connection it relays; this tells it nothing more.
// Certificate and CRL parsing: @peculiar/x509 (MIT).

// @peculiar/x509 needs this loaded before it (its dependency injection)
import "reflect-metadata";
import { X509Certificate as NodeCertificate, verify as cryptoVerify, webcrypto } from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import tls from "node:tls";
import { X509Certificate, CRLDistributionPointsExtension, SubjectAlternativeNameExtension, cryptoProvider } from "@peculiar/x509";
import { WEB_PORTS, isBlockedAddress } from "./wisp.js";

cryptoProvider.set(webcrypto);

const CERT_TTL_MS = 30 * 60_000;
const CRL_MAX_TTL_MS = 6 * 3_600_000;
const MAX_CRL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 2000;

const certCache = new Map(); // "host:port" -> { at, result: Promise }
const crlCache = new Map(); // url -> { until, crl: Promise, size }

async function publicAddress(host) {
	const found = (await dns.lookup(host, { all: true })).filter((a) => !isBlockedAddress(a.address));
	if (!found.length) throw new Error("private address");
	return found[0].address;
}

// The site's certificate chain, leaf first, as DER.
async function fetchChain(host, port) {
	const address = await publicAddress(host);
	return new Promise((resolve, reject) => {
		const socket = tls.connect({
			host: address,
			port,
			servername: host,
			// the viewer shows a bad certificate too; the device decides whether to trust it
			rejectUnauthorized: false,
			ALPNProtocols: ["http/1.1"],
			timeout: 8000,
		});
		const fail = (err) => {
			socket.destroy();
			reject(err);
		};
		socket.once("timeout", () => fail(new Error("timed out")));
		socket.once("error", fail);
		socket.once("secureConnect", () => {
			const chain = [];
			const seen = new Set();
			for (let cert = socket.getPeerCertificate(true); cert?.raw && !seen.has(cert.fingerprint256); cert = cert.issuerCertificate) {
				seen.add(cert.fingerprint256);
				chain.push(cert.raw);
				if (chain.length > 8) break;
			}
			const verified = socket.authorized;
			socket.end();
			resolve({ chain, verified, why: verified ? null : String(socket.authorizationError || "") });
		});
	});
}

function download(url, redirects = 0) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		if (target.protocol !== "http:") return reject(new Error("CRLs are fetched over http"));
		const req = http.get(
			target,
			{
				timeout: 15_000,
				lookup: (hostname, options, callback) =>
					publicAddress(hostname).then(
						(address) => (options?.all ? callback(null, [{ address, family: address.includes(":") ? 6 : 4 }]) : callback(null, address, address.includes(":") ? 6 : 4)),
						callback
					),
			},
			(res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
					res.resume();
					return resolve(download(new URL(res.headers.location, url).href, redirects + 1));
				}
				if (res.statusCode !== 200) {
					res.resume();
					return reject(new Error(`CRL HTTP ${res.statusCode}`));
				}
				const chunks = [];
				let size = 0;
				res.on("data", (chunk) => {
					size += chunk.length;
					if (size > MAX_CRL_BYTES) req.destroy(new Error("CRL too large"));
					else chunks.push(chunk);
				});
				res.on("end", () => resolve(Buffer.concat(chunks)));
				res.on("error", reject);
			}
		);
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("error", reject);
	});
}

// A CRL can be tens of megabytes (one of Cloudflare's is 40), listing a
// million certificates: too many to keep as a set. It's kept as it came, its
// signature checked once against the issuer, and searched for the one
// certificate asked about. A small reader of DER (the encoding CRLs use) is
// all that takes.
function tlv(buf, pos) {
	const tag = buf[pos];
	let length = buf[pos + 1];
	let header = 2;
	if (length & 0x80) {
		const bytes = length & 0x7f;
		if (bytes > 4) throw new Error("bad DER length");
		length = 0;
		for (let i = 0; i < bytes; i++) length = length * 256 + buf[pos + 2 + i];
		header += bytes;
	}
	const end = pos + header + length;
	if (end > buf.length) throw new Error("truncated DER");
	return { tag, start: pos, value: pos + header, end };
}

// signature algorithm OIDs (DER, hex) -> the hash they sign with
const SIGNATURE_HASHES = {
	"2a864886f70d01010b": "sha256", // sha256WithRSAEncryption
	"2a864886f70d01010c": "sha384",
	"2a864886f70d01010d": "sha512",
	"2a8648ce3d040302": "sha256", // ecdsa-with-SHA256
	"2a8648ce3d040303": "sha384",
	"2a8648ce3d040304": "sha512",
};

function parseTime(buf, field) {
	const text = buf.subarray(field.value, field.end).toString("latin1");
	const m = field.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
	if (!m) return null;
	let year = Number(m[1]);
	if (field.tag === 0x17) year += year < 50 ? 2000 : 1900;
	return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/**
 * A CRL, checked: { nextUpdate, revoked: [start, end) of its list of entries, raw }.
 * @param {Buffer} raw
 * @param {import("node:crypto").X509Certificate} issuer
 */
function openCrl(raw, issuer) {
	const outer = tlv(raw, 0);
	const tbs = tlv(raw, outer.value);
	const algorithm = tlv(raw, tbs.end);
	const signature = tlv(raw, algorithm.end);
	const oid = tlv(raw, algorithm.value);
	const hash = SIGNATURE_HASHES[raw.subarray(oid.value, oid.end).toString("hex")];
	if (!hash || signature.tag !== 0x03) throw new Error("the CRL is signed in a way this can't check");
	// a BIT STRING's first byte counts its unused bits
	const ok = cryptoVerify(hash, raw.subarray(tbs.start, tbs.end), issuer.publicKey, raw.subarray(signature.value + 1, signature.end));
	if (!ok) throw new Error("the CRL's signature doesn't match its issuer");
	// TBSCertList: [version] signature issuer thisUpdate [nextUpdate] [revokedCertificates] [extensions]
	let pos = tbs.value;
	let field = tlv(raw, pos);
	if (field.tag === 0x02) field = tlv(raw, (pos = field.end));
	field = tlv(raw, (pos = field.end)); // issuer
	field = tlv(raw, (pos = field.end)); // thisUpdate
	pos = field.end;
	let nextUpdate = null;
	let revoked = [0, 0];
	while (pos < tbs.end) {
		field = tlv(raw, pos);
		if (field.tag === 0x17 || field.tag === 0x18) nextUpdate = parseTime(raw, field);
		else if (field.tag === 0x30) revoked = [field.value, field.end];
		pos = field.end;
	}
	return { raw, nextUpdate, revoked };
}

// Whether `serialHex` is among a checked CRL's entries: the serial's DER
// INTEGER, followed by the entry's revocation date.
function lists(crl, serialHex) {
	let hex = serialHex.toLowerCase().replace(/^0+/, "") || "0";
	if (hex.length % 2) hex = "0" + hex;
	let bytes = Buffer.from(hex, "hex");
	if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
	const needle = Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
	const [start, end] = crl.revoked;
	for (let at = crl.raw.indexOf(needle, start); at !== -1 && at < end; at = crl.raw.indexOf(needle, at + 1)) {
		const next = crl.raw[at + needle.length];
		if (next === 0x17 || next === 0x18) return true;
	}
	return false;
}

const MAX_CACHED_CRL_BYTES = 160 * 1024 * 1024;

// The checked CRL at `url`, cached until its next update (at most six hours),
// with the biggest ones dropped first once they add up to too much.
function crlAt(url, issuer) {
	const now = Date.now();
	const hit = crlCache.get(url);
	if (hit && now < hit.until) return hit.crl;
	// past its next update: answered from the old copy (for up to a day)
	// while a new one comes down, so nobody waits for a big list
	if (hit?.size && now < hit.until + 24 * 3_600_000) {
		if (!hit.refreshing) {
			hit.refreshing = true;
			fetchCrl(url, issuer, now).catch(() => (hit.refreshing = false));
		}
		return hit.crl;
	}
	return fetchCrl(url, issuer, now);
}

function fetchCrl(url, issuer, now) {
	const crl = download(url).then((raw) => {
		const opened = openCrl(raw, issuer);
		const until = Math.min(opened.nextUpdate || now + CRL_MAX_TTL_MS, now + CRL_MAX_TTL_MS);
		crlCache.set(url, { until, crl, size: raw.length });
		let total = 0;
		for (const entry of crlCache.values()) total += entry.size || 0;
		for (const [key, entry] of [...crlCache].sort((a, b) => (b[1].size || 0) - (a[1].size || 0))) {
			if (total <= MAX_CACHED_CRL_BYTES) break;
			if (key === url) continue;
			total -= entry.size || 0;
			crlCache.delete(key);
		}
		return opened;
	});
	if (!crlCache.get(url)?.size) {
		crlCache.set(url, { until: now + 60_000, crl, size: 0 });
		crl.catch(() => crlCache.delete(url));
	}
	return crl;
}

const names = (cert) =>
	(cert.getExtension(SubjectAlternativeNameExtension)?.names.items || [])
		.filter((name) => name.type === "dns" || name.type === "ip")
		.map((name) => name.value)
		.slice(0, 50);

const field = (dn, key) => (new RegExp(`(?:^|, )${key}=([^,]+)`).exec(dn) || [])[1] || "";

function describe(cert) {
	return {
		subject: cert.subject,
		commonName: field(cert.subject, "CN"),
		organization: field(cert.subject, "O"),
		issuer: cert.issuer,
		issuerName: field(cert.issuer, "CN") || field(cert.issuer, "O"),
		issuerOrganization: field(cert.issuer, "O"),
		validFrom: cert.notBefore.toISOString(),
		validTo: cert.notAfter.toISOString(),
		serial: cert.serialNumber.toLowerCase(),
	};
}

async function check(host, port) {
	const { chain, verified, why } = await fetchChain(host, port);
	if (!chain.length) throw new Error("no certificate");
	const leaf = new X509Certificate(chain[0]);
	const issuer = chain[1] ? new NodeCertificate(chain[1]) : null;
	const result = {
		host,
		...describe(leaf),
		names: names(leaf),
		fingerprint: Buffer.from(await leaf.getThumbprint("SHA-256"))
			.toString("hex")
			.toUpperCase()
			.match(/../g)
			.join(":"),
		chain: chain.slice(1).map((raw) => describe(new X509Certificate(raw))),
		// as the server's own trust store sees it
		trusted: verified,
		problem: why,
		revoked: null, // true, false, or null: not checked
		revocationChecked: null, // the CRL it was checked against
	};
	const points = leaf.getExtension(CRLDistributionPointsExtension)?.distributionPoints || [];
	const urls = points
		.flatMap((point) => point.distributionPoint?.fullName || [])
		.map((name) => name.uniformResourceIdentifier)
		.filter((url) => typeof url === "string" && /^http:\/\//i.test(url));
	if (issuer && urls.length) {
		for (const url of urls.slice(0, 2)) {
			try {
				result.revoked = lists(await crlAt(url, issuer), result.serial);
				result.revocationChecked = url;
				break;
			} catch (err) {
				result.revocationError = String(err.message || err);
			}
		}
	}
	return result;
}

/**
 * The certificate `host` presents, and whether it's revoked.
 * @param {string} host
 * @param {number} port
 */
export function certificateOf(host, port = 443) {
	host = String(host).toLowerCase().replace(/\.$/, "");
	port = Number(port) || 443;
	if (!WEB_PORTS.includes(port) || port === 80) return Promise.reject(new Error("not a TLS port"));
	const key = `${host}:${port}`;
	const now = Date.now();
	const hit = certCache.get(key);
	if (hit && now - hit.at < CERT_TTL_MS) return hit.result;
	if (certCache.size >= MAX_ENTRIES) certCache.clear();
	const result = check(host, port);
	certCache.set(key, { at: now, result });
	result.catch(() => certCache.delete(key));
	return result;
}

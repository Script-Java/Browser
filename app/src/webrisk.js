// Google Web Risk (the commercial form of Safe Browsing), optional: with
// WEB_RISK_API_KEY set, every page's site is also checked against Google's
// malware, phishing and unwanted-software lists, which change by the minute
// (the free lists in filters.js come down every half hour).
//
// Privately, the way browsers use Safe Browsing: the server keeps Google's
// lists of hash prefixes (4 bytes of a SHA-256) and updates them every few
// minutes. A site is hashed here and checked against them; only when a
// prefix matches (rarely) does the server ask Google for the full hashes
// under that prefix, which tells Google nothing about which site it was.
// Docs: https://cloud.google.com/web-risk/docs/update-api

import { createHash } from "node:crypto";
import { get } from "node:https";

const API = "https://webrisk.googleapis.com/v1";
const TYPES = { MALWARE: "malware", SOCIAL_ENGINEERING: "phishing", UNWANTED_SOFTWARE: "malware" };
const MIN_WAIT_MS = 5 * 60_000;
const MAX_LIST_BYTES = 64 * 1024 * 1024;

function getJson(url) {
	return new Promise((resolve, reject) => {
		const req = get(url, { timeout: 30_000, headers: { accept: "application/json" } }, (res) => {
			const chunks = [];
			let size = 0;
			res.on("data", (chunk) => {
				size += chunk.length;
				if (size > MAX_LIST_BYTES) req.destroy(new Error("answer too large"));
				else chunks.push(chunk);
			});
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				if (res.statusCode !== 200) return reject(new Error(`Web Risk HTTP ${res.statusCode}`));
				try {
					resolve(JSON.parse(text));
				} catch (err) {
					reject(err);
				}
			});
			res.on("error", reject);
		});
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("error", reject);
	});
}

/**
 * The expressions Safe Browsing looks a site up by, for a host alone: the
 * host, and up to four of the domains it's under (never the bare suffix).
 * @param {string} host
 */
export function hostExpressions(host) {
	host = String(host).toLowerCase().replace(/\.+$/, "").replace(/^\.+/, "");
	if (!host) return [];
	const out = [host + "/"];
	const parts = host.split(".");
	if (/^\d+(\.\d+){3}$/.test(host) || host.includes(":")) return out;
	// the last five parts, then one fewer each time, down to (not including) the suffix alone
	const tail = parts.slice(-5);
	for (let i = 0; i < tail.length - 1 && out.length < 5; i++) {
		const name = tail.slice(i).join(".");
		if (name !== host) out.push(name + "/");
	}
	return [...new Set(out)];
}

const sha256 = (text) => createHash("sha256").update(text).digest();

/**
 * One threat list's prefixes, kept sorted (that's how Web Risk's removals
 * and checksum count them) and as a set by length, for lookups.
 */
class PrefixList {
	constructor() {
		this.version = "";
		this.sorted = []; // Buffers, sorted
		this.byLength = new Map(); // length -> Set of hex
	}

	reset() {
		this.version = "";
		this.sorted = [];
		this.byLength = new Map();
	}

	apply(diff) {
		if (diff.responseType === "RESET") this.reset();
		const removals = diff.removals?.rawIndices?.indices || [];
		if (removals.length) {
			const drop = new Set(removals.map(Number));
			this.sorted = this.sorted.filter((_, i) => !drop.has(i));
		}
		for (const raw of [].concat(diff.additions?.rawHashes || [])) {
			const size = Number(raw.prefixSize);
			const bytes = Buffer.from(String(raw.rawHashes || ""), "base64");
			if (!(size >= 4 && size <= 32) || bytes.length % size) throw new Error("bad prefixes");
			for (let at = 0; at < bytes.length; at += size) this.sorted.push(bytes.subarray(at, at + size));
		}
		this.sorted.sort(Buffer.compare);
		const expected = diff.checksum?.sha256 ? Buffer.from(diff.checksum.sha256, "base64") : null;
		const actual = createHash("sha256").update(Buffer.concat(this.sorted)).digest();
		if (expected && !expected.equals(actual)) {
			this.reset();
			throw new Error("checksum mismatch: the list starts over");
		}
		this.byLength = new Map();
		for (const prefix of this.sorted) {
			const set = this.byLength.get(prefix.length) || new Set();
			set.add(prefix.toString("hex"));
			this.byLength.set(prefix.length, set);
		}
		this.version = diff.newVersionToken || "";
	}

	matches(hash) {
		const hex = hash.toString("hex");
		for (const [length, set] of this.byLength) if (set.has(hex.slice(0, length * 2))) return hex.slice(0, length * 2);
		return null;
	}
}

export class WebRisk {
	/** @param {{ key: string, fetchJson?: (url: string) => Promise<any> }} options */
	constructor({ key, fetchJson = getJson }) {
		this.key = key;
		this.fetchJson = fetchJson;
		this.lists = Object.fromEntries(Object.keys(TYPES).map((type) => [type, new PrefixList()]));
		this.fullHashes = new Map(); // prefix hex -> { until, hashes: Map<hash hex, kind> }
		this.timer = null;
		this.updatedAt = 0;
	}

	start() {
		const run = () =>
			this.update()
				.catch((err) => console.warn("web risk:", err.message))
				.then((wait) => {
					this.timer = setTimeout(run, Math.max(MIN_WAIT_MS, wait || 0));
					this.timer.unref?.();
				});
		run();
	}

	/** Brings every list up to date; returns how long Web Risk asks to wait. */
	async update() {
		let wait = MIN_WAIT_MS;
		for (const [type, list] of Object.entries(this.lists)) {
			const params = new URLSearchParams({
				threatType: type,
				"constraints.supportedCompressions": "RAW",
				key: this.key,
			});
			if (list.version) params.set("versionToken", list.version);
			const diff = await this.fetchJson(`${API}/threatLists:computeDiff?${params}`);
			list.apply(diff);
			// when Web Risk would like the next update (a time)
			const at = Date.parse(diff.recommendedNextDiff || "");
			if (Number.isFinite(at)) wait = Math.max(wait, at - Date.now());
		}
		this.updatedAt = Date.now();
		return wait;
	}

	/**
	 * "phishing", "malware" or null for a site's host.
	 * @param {string} host
	 */
	async check(host) {
		for (const expression of hostExpressions(host)) {
			const hash = sha256(expression);
			for (const list of Object.values(this.lists)) {
				const prefix = list.matches(hash);
				if (!prefix) continue;
				const kind = (await this.fullHashesFor(prefix)).get(hash.toString("hex"));
				if (kind) return kind;
			}
		}
		return null;
	}

	// The full hashes under a prefix, from Web Risk, kept as long as it says.
	async fullHashesFor(prefix) {
		const now = Date.now();
		const hit = this.fullHashes.get(prefix);
		if (hit && now < hit.until) return hit.hashes;
		const params = new URLSearchParams({ hashPrefix: Buffer.from(prefix, "hex").toString("base64"), key: this.key });
		for (const type of Object.keys(TYPES)) params.append("threatTypes", type);
		const answer = await this.fetchJson(`${API}/hashes:search?${params}`);
		const hashes = new Map();
		let until = now + 5 * 60_000;
		for (const threat of answer.threats || []) {
			const kind = (threat.threatTypes || []).map((t) => TYPES[t]).find(Boolean);
			if (!kind || !threat.hash) continue;
			hashes.set(Buffer.from(threat.hash, "base64").toString("hex"), kind);
			const expires = Date.parse(threat.expireTime);
			if (Number.isFinite(expires)) until = Math.min(until, expires);
		}
		if (!hashes.size && answer.negativeExpireTime) {
			const expires = Date.parse(answer.negativeExpireTime);
			if (Number.isFinite(expires)) until = expires;
		}
		if (this.fullHashes.size > 10_000) this.fullHashes.clear();
		this.fullHashes.set(prefix, { until, hashes });
		return hashes;
	}
}

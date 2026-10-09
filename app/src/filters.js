// Filter lists: the ad/tracker engine (shipped to the service worker), Brave's
// navigation-tracking rules (privacyrules.js, shipped to the worker too) and
// the malware/phishing host lists (checked by the server on every page load).
// The ad lists are rebuilt from upstream every REFRESH_HOURS, the threat lists
// every THREAT_REFRESH_MINUTES (they change by the hour), and everything is
// cached on disk so a restart doesn't have to download it all again.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { get } from "node:https";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { FiltersEngine } from "@ghostery/adblocker";
import { compileRules } from "./privacyrules.js";

// Ghostery mirrors the same lists; used when an upstream host is down.
const MIRROR =
	"https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets";
const UASSETS = "https://ublockorigin.github.io/uAssets/filters";
const BRAVE = "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists";
const ADGUARD_CNAME = "https://raw.githubusercontent.com/AdguardTeam/cname-trackers/master/data";

const AD_LISTS = [
	[
		"https://easylist.to/easylist/easylist.txt",
		`${MIRROR}/easylist/easylist.txt`,
	],
	[
		"https://easylist.to/easylist/easyprivacy.txt",
		`${MIRROR}/easylist/easyprivacy.txt`,
	],
	[
		"https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext",
		`${MIRROR}/peter-lowe/serverlist.txt`,
	],
	[`${UASSETS}/filters.txt`, `${MIRROR}/ublock-origin/filters.txt`],
	[`${UASSETS}/filters-2020.txt`, `${MIRROR}/ublock-origin/filters-2020.txt`],
	[`${UASSETS}/filters-2021.txt`, `${MIRROR}/ublock-origin/filters-2021.txt`],
	[`${UASSETS}/filters-2022.txt`, `${MIRROR}/ublock-origin/filters-2022.txt`],
	[`${UASSETS}/filters-2023.txt`, `${MIRROR}/ublock-origin/filters-2023.txt`],
	[`${UASSETS}/filters-2024.txt`, `${MIRROR}/ublock-origin/filters-2024.txt`],
	[`${UASSETS}/filters-2025.txt`],
	[`${UASSETS}/filters-2026.txt`],
	[`${UASSETS}/badware.txt`, `${MIRROR}/ublock-origin/badware.txt`],
	[`${UASSETS}/privacy.txt`, `${MIRROR}/ublock-origin/privacy.txt`],
	[`${UASSETS}/quick-fixes.txt`, `${MIRROR}/ublock-origin/quick-fixes.txt`],
	[`${UASSETS}/unbreak.txt`, `${MIRROR}/ublock-origin/unbreak.txt`],
	[
		`${UASSETS}/resource-abuse.txt`,
		`${MIRROR}/ublock-origin/resource-abuse.txt`,
	],
	// Trackers disguised as a site's own subdomain (a CNAME pointing at the
	// tracker), as Brave lists them for its iOS app, which can't look the
	// names up either.
	[`${BRAVE}/brave-firstparty-cname.txt`],
	// The trackers those subdomains point at, for the live check (cname.js):
	// the server looks the name up and the worker matches what it points to.
	[`${ADGUARD_CNAME}/combined_original_trackers.txt`],
];

// Brave's navigation-tracking rules (privacyrules.js).
const DEBOUNCE_RULES = [`${BRAVE}/debounce.json`];
const QUERY_RULES = [`${BRAVE}/query-filter.json`];

// "Hide cookie notices": an engine of their own, so only people who switch
// it on carry these lists in every site's service worker.
const NOTICE_LISTS = [
	[
		"https://secure.fanboy.co.nz/fanboy-cookiemonster.txt",
		`${MIRROR}/easylist/easylist-cookie.txt`,
	],
	[
		`${UASSETS}/annoyances-cookies.txt`,
		`${MIRROR}/ublock-origin/annoyances-cookies.txt`,
	],
];

const ENGINE_OPTIONS = {
	loadCosmeticFilters: true,
	loadNetworkFilters: true,
	enableHtmlFiltering: false,
	loadCSPFilters: false,
};

// An engine as the server hands it out.
const pack = (raw) => ({
	raw,
	gzip: gzipSync(raw),
	etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 24)}"`,
});

// Scriptlets (+js(...) rules) in the format the Ghostery engine expects.
const RESOURCES = [`${MIRROR}/ublock-origin/resources.json`];

const THREAT_LISTS = [
	[
		"phishing",
		"https://malware-filter.gitlab.io/malware-filter/phishing-filter-hosts.txt",
		"https://curbengh.github.io/phishing-filter/phishing-filter-hosts.txt",
	],
	[
		"malware",
		"https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts-online.txt",
		"https://curbengh.github.io/urlhaus-filter/urlhaus-filter-hosts-online.txt",
	],
];

const MAX_LIST_BYTES = 64 * 1024 ** 2;

// node:https rather than fetch(): Node 22's built-in fetch (undici) can crash
// the whole process with an internal assert, not a catchable error, when a
// download's connection ends mid-body. These run while people are browsing.
// With `since` (an ETag or Last-Modified from before), an unchanged list
// answers null instead of coming down again.
export function fetchText(url, since = null, redirects = 0) {
	return new Promise((resolve, reject) => {
		if (!url.startsWith("https://")) return reject(new Error("not https"));
		const headers = {};
		if (since?.etag) headers["if-none-match"] = since.etag;
		else if (since?.modified) headers["if-modified-since"] = since.modified;
		const req = get(url, { timeout: 60_000, headers }, (res) => {
			const { statusCode, headers } = res;
			if (statusCode >= 300 && statusCode < 400 && headers.location && statusCode !== 304) {
				res.resume();
				if (redirects >= 5) return reject(new Error("too many redirects"));
				return resolve(fetchText(new URL(headers.location, url).href, since, redirects + 1));
			}
			if (statusCode === 304 && since) {
				res.resume();
				return resolve(null);
			}
			if (statusCode !== 200) {
				res.resume();
				return reject(new Error(`HTTP ${statusCode}`));
			}
			const chunks = [];
			let size = 0;
			res.on("data", (chunk) => {
				size += chunk.length;
				if (size > MAX_LIST_BYTES) req.destroy(new Error("list too large"));
				else chunks.push(chunk);
			});
			res.on("end", () =>
				resolve({
					text: Buffer.concat(chunks).toString("utf8"),
					// for the next conditional request
					etag: headers.etag || null,
					modified: headers["last-modified"] || null,
				})
			);
			res.on("error", reject);
		});
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("error", reject);
	});
}

// The first of `urls` that answers: { text, etag, modified }, or null when
// the first one says it hasn't changed since `since`.
async function fetchFirst(urls, since = null) {
	let lastError;
	for (const url of urls) {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return await fetchText(url, url === urls[0] ? since : null);
			} catch (err) {
				lastError = new Error(`${url}: ${err.message}`);
			}
		}
	}
	throw lastError;
}

const download = async (urls) => (await fetchFirst(urls)).text;

function parseHosts(text) {
	const hosts = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const host = trimmed.split(/\s+/).pop().toLowerCase();
		if (host && host !== "0.0.0.0" && host !== "localhost") hosts.push(host);
	}
	return hosts;
}

export class Filters {
	/**
	 * @param {{ cacheDir: string, refreshHours: number, threatMinutes?: number }} options
	 */
	constructor({ cacheDir, refreshHours, threatMinutes = 30 }) {
		this.cacheDir = cacheDir;
		this.refreshMs = refreshHours * 3_600_000;
		this.threatMs = threatMinutes * 60_000;
		this.engine = null; // { raw, gzip, etag }
		this.notices = null; // the cookie-notice engine, the same way
		this.privacy = null; // Brave's navigation-tracking rules, as JSON the same way
		this.threats = new Map(); // host -> "phishing" | "malware"
		// per threat list: { etag, modified, hosts } from its last download
		this.threatSources = {};
		this.updatedAt = 0;
		this.threatsAt = 0;
		this.stats = {};
		this.building = null;
		this.checkingThreats = null;
	}

	async start() {
		await this.loadCache().catch(() => {});
		this.refresh();
		this.refreshThreats();
		// Checks hourly; build() only downloads once the lists are stale.
		setInterval(() => this.refresh(), 3_600_000).unref();
		setInterval(() => this.refreshThreats(), this.threatMs).unref();
	}

	refresh() {
		this.building ||= this.build()
			.catch((err) => console.error("filters: update failed:", err.message))
			.finally(() => {
				this.building = null;
			});
		return this.building;
	}

	refreshThreats() {
		this.checkingThreats ||= this.buildThreats()
			.catch((err) => console.error("filters: threat lists failed:", err.message))
			.finally(() => {
				this.checkingThreats = null;
			});
		return this.checkingThreats;
	}

	async build() {
		// (a cache from before the cookie-notice lists or the privacy rules
		// has none: fetch them once)
		const fresh = Date.now() - this.updatedAt < this.refreshMs;
		if (fresh && (this.notices || this.noticesTried) && (this.privacy || this.privacyTried)) return;
		this.noticesTried = this.privacyTried = true;
		console.log("filters: downloading lists");
		const started = Date.now();
		const optional = (urls) =>
			download(urls).catch((err) => {
				console.warn("filters: skipping list:", err.message);
				return "";
			});

		const [lists, noticeLists, resources, debounceText, queryText] = await Promise.all([
			Promise.all(AD_LISTS.map(optional)),
			Promise.all(NOTICE_LISTS.map(optional)),
			download(RESOURCES),
			optional(DEBOUNCE_RULES),
			optional(QUERY_RULES),
		]);

		const loaded = lists.filter(Boolean);
		if (loaded.length < AD_LISTS.length / 2)
			throw new Error("too many ad lists failed to download");

		const engine = FiltersEngine.parse(loaded.join("\n"), ENGINE_OPTIONS);
		engine.updateResources(resources, String(resources.length));
		const raw = Buffer.from(engine.serialize());

		// keeps the previous copy when neither list came down
		const noticeText = noticeLists.filter(Boolean).join("\n");
		let noticeFilters = this.stats.noticeFilters || 0;
		if (noticeText) {
			const notices = FiltersEngine.parse(noticeText, ENGINE_OPTIONS);
			notices.updateResources(resources, String(resources.length));
			this.notices = pack(Buffer.from(notices.serialize()));
			const found = notices.getFilters();
			noticeFilters = found.networkFilters.length + found.cosmeticFilters.length;
		}

		// the same: a rule list that didn't come down keeps its last copy
		let { debounceRules = 0, paramRules = 0 } = this.stats;
		if (debounceText || queryText) {
			try {
				const before = this.privacy ? JSON.parse(this.privacy.raw) : { debounce: [], params: [] };
				const rules = compileRules(debounceText, queryText);
				if (!debounceText) rules.debounce = before.debounce;
				if (!queryText) rules.params = before.params;
				this.privacy = pack(Buffer.from(JSON.stringify(rules)));
				debounceRules = rules.debounce.length;
				paramRules = rules.params.length;
			} catch (err) {
				console.warn("filters: skipping Brave's rules:", err.message);
			}
		}

		this.setEngine(raw);
		this.updatedAt = Date.now();
		const found = engine.getFilters();
		this.stats = {
			...this.stats,
			lists: loaded.length,
			networkFilters: found.networkFilters.length,
			cosmeticFilters: found.cosmeticFilters.length,
			noticeFilters,
			debounceRules,
			paramRules,
		};
		console.log(
			`filters: ready in ${((Date.now() - started) / 1000).toFixed(1)}s`,
			this.stats
		);
		await this.saveCache().catch((err) =>
			console.warn("filters: could not write cache:", err.message)
		);
	}

	// The malware and phishing lists, asked again every THREAT_REFRESH_MINUTES:
	// one that hasn't changed answers "not modified" and costs next to nothing.
	async buildThreats() {
		let changed = false;
		await Promise.all(
			THREAT_LISTS.map(async ([kind, ...urls]) => {
				const before = this.threatSources[kind];
				try {
					const got = await fetchFirst(urls, before?.hosts ? before : null);
					if (!got) return;
					this.threatSources[kind] = { etag: got.etag, modified: got.modified, hosts: parseHosts(got.text) };
					changed = true;
				} catch (err) {
					// keep the previous copy of a list that failed to download
					console.warn("filters: skipping threat list:", err.message);
				}
			})
		);
		this.threatsAt = Date.now();
		if (!changed) return;
		const threats = new Map();
		const counts = {};
		for (const [kind] of THREAT_LISTS) {
			// (a list never downloaded since the old cache format: that cache's copy)
			const hosts =
				this.threatSources[kind]?.hosts || [...this.threats].filter(([, k]) => k === kind).map(([h]) => h);
			for (const host of hosts) threats.set(host, kind);
			counts[kind] = hosts.length;
		}
		this.threats = threats;
		this.stats = { ...this.stats, ...counts };
		await this.saveCache().catch((err) =>
			console.warn("filters: could not write cache:", err.message)
		);
	}

	setEngine(raw) {
		this.engine = pack(raw);
	}

	async saveCache() {
		await mkdir(this.cacheDir, { recursive: true });
		const meta = {
			updatedAt: this.updatedAt,
			threatsAt: this.threatsAt,
			stats: this.stats,
			threatSources: this.threatSources,
		};
		const write = async (name, data) => {
			const path = join(this.cacheDir, name);
			await writeFile(path + ".tmp", data);
			await rename(path + ".tmp", path);
		};
		if (this.engine) await write("engine.bin", this.engine.raw);
		if (this.notices) await write("notices.bin", this.notices.raw);
		if (this.privacy) await write("privacy.json", this.privacy.raw);
		await write("meta.json", JSON.stringify(meta));
	}

	async loadCache() {
		const meta = JSON.parse(
			await readFile(join(this.cacheDir, "meta.json"), "utf8")
		);
		const raw = await readFile(join(this.cacheDir, "engine.bin"));
		// Fails if the cache was written by a different engine version.
		FiltersEngine.deserialize(new Uint8Array(raw));
		this.setEngine(raw);
		try {
			const notices = await readFile(join(this.cacheDir, "notices.bin"));
			FiltersEngine.deserialize(new Uint8Array(notices));
			this.notices = pack(notices);
		} catch {
			// none cached yet: build() fetches the lists
		}
		try {
			const privacy = await readFile(join(this.cacheDir, "privacy.json"));
			JSON.parse(privacy);
			this.privacy = pack(privacy);
		} catch {
			// none cached yet: build() fetches the rules
		}
		// (a cache from before the threat lists had their own refresh kept a plain list)
		this.threatSources = meta.threatSources || {};
		const threats = new Map(meta.threats || []);
		for (const [kind] of THREAT_LISTS)
			for (const host of this.threatSources[kind]?.hosts || []) threats.set(host, kind);
		this.threats = threats;
		this.stats = meta.stats;
		this.updatedAt = meta.updatedAt;
		this.threatsAt = meta.threatsAt || 0;
		console.log("filters: loaded cached lists from", new Date(this.updatedAt));
	}

	/**
	 * @param {string} hostname
	 * @returns {"phishing" | "malware" | null}
	 */
	threat(hostname) {
		let host = hostname.toLowerCase().replace(/\.$/, "");
		while (host) {
			const kind = this.threats.get(host);
			if (kind) return kind;
			const dot = host.indexOf(".");
			if (dot === -1) break;
			host = host.slice(dot + 1);
		}
		return null;
	}

	status() {
		return { updatedAt: this.updatedAt, threatsAt: this.threatsAt, ...this.stats };
	}
}

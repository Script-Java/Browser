// Filter lists: the ad/tracker engine (shipped to the service worker) and the
// malware/phishing host lists (checked by the server on every page load).
// Everything is rebuilt from the upstream lists every REFRESH_HOURS and cached
// on disk so a restart doesn't have to download it all again.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { get } from "node:https";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { FiltersEngine } from "@ghostery/adblocker";

// Ghostery mirrors the same lists; used when an upstream host is down.
const MIRROR =
	"https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets";
const UASSETS = "https://ublockorigin.github.io/uAssets/filters";

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
	// the trackers that sites' own subdomains turn out to stand for (CNAME
	// cloaking: see cname.js)
	["https://raw.githubusercontent.com/AdguardTeam/cname-trackers/master/data/combined_original_trackers.txt"],
];

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

// Addresses that only bounce a click on to the real one (sw/debounce.js has
// the format, and the app's own rules for the big sites' link wrappers).
const DEBOUNCE_LIST = ["https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/debounce.json"];

/** Brave's debounce rules, only the fields the worker reads. */
export function parseDebounce(text) {
	const rules = JSON.parse(text);
	if (!Array.isArray(rules)) throw new Error("not a list of rules");
	return rules
		.filter((r) => r && Array.isArray(r.include) && typeof r.action === "string" && typeof r.param === "string")
		.slice(0, 2000)
		.map(({ include, exclude, action, param, prepend_scheme, redirect_url_template }) => ({
			include: include.filter((p) => typeof p === "string"),
			exclude: Array.isArray(exclude) ? exclude.filter((p) => typeof p === "string") : [],
			action,
			param,
			prepend_scheme: typeof prepend_scheme === "string" ? prepend_scheme : undefined,
			redirect_url_template: typeof redirect_url_template === "string" ? redirect_url_template : undefined,
		}));
}

// An engine as the server hands it out.
const pack = (raw) => ({
	raw,
	gzip: gzipSync(raw),
	etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 24)}"`,
});

// Scriptlets (+js(...) rules) in the format the Ghostery engine expects.
const RESOURCES = [`${MIRROR}/ublock-origin/resources.json`];

// Malware and phishing hosts, each list with its mirrors. Checked far more
// often than the ad lists (see refreshThreats), and fetched again only when
// changed: a phishing site lives for hours.
const THREAT_LISTS = [
	[
		"phishing",
		"https://malware-filter.gitlab.io/malware-filter/phishing-filter-hosts.txt",
		"https://curbengh.github.io/phishing-filter/phishing-filter-hosts.txt",
	],
	// rebuilt every few hours, from PhishTank, OpenPhish, CERT.pl and others
	["phishing", "https://phishing.army/download/phishing_army_blocklist.txt"],
	[
		"malware",
		"https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts-online.txt",
		"https://curbengh.github.io/urlhaus-filter/urlhaus-filter-hosts-online.txt",
	],
	// URLhaus itself: rebuilt every five minutes
	["malware", "https://urlhaus.abuse.ch/downloads/hostfile/"],
];
const THREAT_REFRESH_MS = (Number(process.env.THREAT_REFRESH_MINUTES) || 15) * 60_000;
// Hosts the person running the server wants warned about besides the lists,
// as phishing (PHISHING_HOSTS, comma-separated): a scam going round today.
const OWN_THREATS = String(process.env.PHISHING_HOSTS || "")
	.split(",")
	.map((host) => host.trim().toLowerCase())
	.filter((host) => /^[a-z0-9.-]{1,253}$/.test(host));

const MAX_LIST_BYTES = 64 * 1024 ** 2;

/**
 * A list over https. `since`: the validators of the copy already here, and
 * then `unchanged` comes back when it still is.
 * node:https rather than fetch(): Node 22's built-in fetch (undici) can crash
 * the whole process with an internal assert, not a catchable error, when a
 * download's connection ends mid-body. These run while people are browsing.
 * @returns {Promise<{ text?: string, etag?: string, modified?: string, unchanged?: boolean }>}
 */
export function fetchList(url, since = null, redirects = 0) {
	return new Promise((resolve, reject) => {
		if (!url.startsWith("https://")) return reject(new Error("not https"));
		const conditions = {};
		if (since?.etag) conditions["if-none-match"] = since.etag;
		if (since?.modified) conditions["if-modified-since"] = since.modified;
		const req = get(url, { timeout: 60_000, headers: conditions }, (res) => {
			const { statusCode, headers } = res;
			if (statusCode === 304 && since) {
				res.resume();
				return resolve({ unchanged: true });
			}
			if (statusCode >= 300 && statusCode < 400 && headers.location) {
				res.resume();
				if (redirects >= 5) return reject(new Error("too many redirects"));
				return resolve(fetchList(new URL(headers.location, url).href, since, redirects + 1));
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
				resolve({ text: Buffer.concat(chunks).toString("utf8"), etag: headers.etag, modified: headers["last-modified"] })
			);
			res.on("error", reject);
		});
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("error", reject);
	});
}

export const fetchText = async (url) => (await fetchList(url)).text;

async function download(urls) {
	let lastError;
	for (const url of urls) {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return await fetchText(url);
			} catch (err) {
				lastError = new Error(`${url}: ${err.message}`);
			}
		}
	}
	throw lastError;
}

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
	 * @param {{ cacheDir: string, refreshHours: number, fetch?: typeof fetchList }} options
	 * `fetch` for the threat lists (a stand-in in tests)
	 */
	constructor({ cacheDir, refreshHours, fetch = fetchList, ownThreats = OWN_THREATS }) {
		this.cacheDir = cacheDir;
		this.refreshMs = refreshHours * 3_600_000;
		this.fetch = fetch;
		this.ownThreats = ownThreats;
		this.engine = null; // { raw, gzip, etag }
		this.notices = null; // the cookie-notice engine, the same way
		this.debounce = null; // Brave's bounce-tracking rules, as JSON, the same way
		this.threats = new Map(); // host -> "phishing" | "malware"
		// one for each of THREAT_LISTS once it came down: { hosts, from, etag, modified }
		this.threatLists = THREAT_LISTS.map(() => null);
		this.threatsCheckedAt = 0;
		this.updatedAt = 0;
		this.stats = {};
		this.building = null;
		this.checking = null;
		// the server's own, before any list has come down
		this.setThreats();
	}

	async start() {
		await this.loadThreats().catch(() => {});
		await this.loadCache().catch(() => {});
		this.refresh();
		this.refreshThreats();
		// Checks hourly; build() only downloads once the lists are stale.
		setInterval(() => this.refresh(), 3_600_000).unref();
		setInterval(() => this.refreshThreats(), THREAT_REFRESH_MS).unref();
	}

	/**
	 * The malware and phishing lists again, each only if it changed since the
	 * copy here (one that fails to come down keeps its copy).
	 */
	refreshThreats() {
		this.checking ||= (async () => {
			const lists = await Promise.all(
				THREAT_LISTS.map(async ([, ...urls], i) => {
					const had = this.threatLists[i];
					for (const url of urls) {
						try {
							const got = await this.fetch(url, had?.from === url ? had : null);
							if (got.unchanged) return had;
							return { hosts: parseHosts(got.text), from: url, etag: got.etag, modified: got.modified };
						} catch (err) {
							console.warn(`filters: threat list ${url}: ${err.message}`);
						}
					}
					return had;
				})
			);
			const changed = lists.some((list, i) => list !== this.threatLists[i]);
			this.threatLists = lists;
			this.threatsCheckedAt = Date.now();
			if (!changed) return;
			this.setThreats();
			await this.saveThreats().catch((err) => console.warn("filters: could not write the threat lists:", err.message));
		})().finally(() => (this.checking = null));
		return this.checking;
	}

	// The lists as one table; the first list naming a host says what it is.
	setThreats() {
		const threats = new Map(this.ownThreats.map((host) => [host, "phishing"]));
		THREAT_LISTS.forEach(([kind], i) => {
			for (const host of this.threatLists[i]?.hosts || []) if (!threats.has(host)) threats.set(host, kind);
		});
		this.threats = threats;
		const counts = { phishing: 0, malware: 0 };
		for (const kind of threats.values()) counts[kind]++;
		Object.assign(this.stats, counts);
	}

	refresh() {
		this.building ||= this.build()
			.catch((err) => console.error("filters: update failed:", err.message))
			.finally(() => {
				this.building = null;
			});
		return this.building;
	}

	async build() {
		// (a cache from before the cookie-notice or bounce lists has none: fetch them once)
		const fresh = Date.now() - this.updatedAt < this.refreshMs;
		if (fresh && ((this.notices && this.debounce) || this.tried)) return;
		this.tried = true;
		console.log("filters: downloading lists");
		const started = Date.now();
		const optional = (urls) =>
			download(urls).catch((err) => {
				console.warn("filters: skipping list:", err.message);
				return "";
			});

		const [lists, noticeLists, resources, debounceText] = await Promise.all([
			Promise.all(
				AD_LISTS.map((urls) =>
					download(urls).catch((err) => {
						console.warn("filters: skipping list:", err.message);
						return "";
					})
				)
			),
			Promise.all(NOTICE_LISTS.map(optional)),
			download(RESOURCES),
			optional(DEBOUNCE_LIST),
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

		// keeps the previous copy when it didn't come down, or came down wrong
		let debounceRules = this.stats.debounceRules || 0;
		try {
			if (debounceText) {
				const rules = parseDebounce(debounceText);
				this.debounce = pack(Buffer.from(JSON.stringify(rules)));
				debounceRules = rules.length;
			}
		} catch (err) {
			console.warn("filters: skipping the bounce list:", err.message);
		}

		this.setEngine(raw);
		this.updatedAt = Date.now();
		this.stats = {
			lists: loaded.length,
			networkFilters: engine.getFilters().networkFilters.length,
			cosmeticFilters: engine.getFilters().cosmeticFilters.length,
			noticeFilters,
			debounceRules,
			// (refreshThreats keeps these)
			phishing: this.stats.phishing || 0,
			malware: this.stats.malware || 0,
		};
		console.log(
			`filters: ready in ${((Date.now() - started) / 1000).toFixed(1)}s`,
			this.stats
		);
		await this.saveCache(raw).catch((err) =>
			console.warn("filters: could not write cache:", err.message)
		);
	}

	setEngine(raw) {
		this.engine = pack(raw);
	}

	async write(name, data) {
		await mkdir(this.cacheDir, { recursive: true });
		const path = join(this.cacheDir, name);
		await writeFile(path + ".tmp", data);
		await rename(path + ".tmp", path);
	}

	async saveCache(raw) {
		await this.write("engine.bin", raw);
		if (this.notices) await this.write("notices.bin", this.notices.raw);
		if (this.debounce) await this.write("debounce.json", this.debounce.raw);
		await this.write("meta.json", JSON.stringify({ updatedAt: this.updatedAt, stats: this.stats }));
	}

	// with what it takes to ask for them again only if changed
	saveThreats() {
		return this.write("threats.json", JSON.stringify(this.threatLists));
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
			const debounce = await readFile(join(this.cacheDir, "debounce.json"));
			parseDebounce(debounce.toString("utf8"));
			this.debounce = pack(debounce);
		} catch {
			// the same
		}
		this.stats = { ...meta.stats, ...this.stats };
		this.updatedAt = meta.updatedAt;
		// (a cache from before threats.json has them in one table)
		if (this.threatLists.every((list) => !list) && Array.isArray(meta.threats))
			this.threats = new Map([...meta.threats, ...this.ownThreats.map((host) => [host, "phishing"])]);
		console.log("filters: loaded cached lists from", new Date(this.updatedAt));
	}

	async loadThreats() {
		const lists = JSON.parse(await readFile(join(this.cacheDir, "threats.json"), "utf8"));
		if (!Array.isArray(lists) || lists.length !== THREAT_LISTS.length) return;
		this.threatLists = lists.map((list) => (list && Array.isArray(list.hosts) ? list : null));
		this.setThreats();
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
		return { updatedAt: this.updatedAt, threatsCheckedAt: this.threatsCheckedAt, ...this.stats };
	}
}

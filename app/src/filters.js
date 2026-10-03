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
];

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
export function fetchText(url, redirects = 0) {
	return new Promise((resolve, reject) => {
		if (!url.startsWith("https://")) return reject(new Error("not https"));
		const req = get(url, { timeout: 60_000 }, (res) => {
			const { statusCode, headers } = res;
			if (statusCode >= 300 && statusCode < 400 && headers.location) {
				res.resume();
				if (redirects >= 5) return reject(new Error("too many redirects"));
				return resolve(fetchText(new URL(headers.location, url).href, redirects + 1));
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
			res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			res.on("error", reject);
		});
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("error", reject);
	});
}

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
	 * @param {{ cacheDir: string, refreshHours: number }} options
	 */
	constructor({ cacheDir, refreshHours }) {
		this.cacheDir = cacheDir;
		this.refreshMs = refreshHours * 3_600_000;
		this.engine = null; // { raw, gzip, etag }
		this.threats = new Map(); // host -> "phishing" | "malware"
		this.updatedAt = 0;
		this.stats = {};
		this.building = null;
	}

	async start() {
		await this.loadCache().catch(() => {});
		this.refresh();
		// Checks hourly; build() only downloads once the lists are stale.
		setInterval(() => this.refresh(), 3_600_000).unref();
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
		if (Date.now() - this.updatedAt < this.refreshMs) return;
		console.log("filters: downloading lists");
		const started = Date.now();

		const [lists, resources, threatTexts] = await Promise.all([
			Promise.all(
				AD_LISTS.map((urls) =>
					download(urls).catch((err) => {
						console.warn("filters: skipping list:", err.message);
						return "";
					})
				)
			),
			download(RESOURCES),
			Promise.all(
				THREAT_LISTS.map(([kind, ...urls]) =>
					download(urls).then(
						(text) => [kind, parseHosts(text)],
						(err) => {
							console.warn("filters: skipping threat list:", err.message);
							return [kind, null];
						}
					)
				)
			),
		]);

		const loaded = lists.filter(Boolean);
		if (loaded.length < AD_LISTS.length / 2)
			throw new Error("too many ad lists failed to download");

		const engine = FiltersEngine.parse(loaded.join("\n"), {
			loadCosmeticFilters: true,
			loadNetworkFilters: true,
			enableHtmlFiltering: false,
			loadCSPFilters: false,
		});
		engine.updateResources(resources, String(resources.length));
		const raw = Buffer.from(engine.serialize());

		const threats = new Map();
		const threatStats = {};
		for (const [kind, hosts] of threatTexts) {
			// keep the previous copy of a list that failed to download
			const list =
				hosts ||
				[...this.threats].filter(([, k]) => k === kind).map(([h]) => h);
			for (const host of list) threats.set(host, kind);
			threatStats[kind] = list.length;
		}

		this.setEngine(raw);
		this.threats = threats;
		this.updatedAt = Date.now();
		this.stats = {
			lists: loaded.length,
			networkFilters: engine.getFilters().networkFilters.length,
			cosmeticFilters: engine.getFilters().cosmeticFilters.length,
			...threatStats,
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
		this.engine = {
			raw,
			gzip: gzipSync(raw),
			etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 24)}"`,
		};
	}

	async saveCache(raw) {
		await mkdir(this.cacheDir, { recursive: true });
		const meta = {
			updatedAt: this.updatedAt,
			stats: this.stats,
			threats: [...this.threats],
		};
		const write = async (name, data) => {
			const path = join(this.cacheDir, name);
			await writeFile(path + ".tmp", data);
			await rename(path + ".tmp", path);
		};
		await write("engine.bin", raw);
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
		this.threats = new Map(meta.threats);
		this.stats = meta.stats;
		this.updatedAt = meta.updatedAt;
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
		return { updatedAt: this.updatedAt, ...this.stats };
	}
}

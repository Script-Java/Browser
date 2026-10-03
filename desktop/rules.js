// Pure rules shared by the main process and its tests: settings, the
// malware/phishing host lists and keyboard shortcuts.

import { getDomain } from "tldts";

export const SEARCH_ENGINES = {
	brave: "https://search.brave.com/search?q=%s",
	duckduckgo: "https://duckduckgo.com/?q=%s",
	bing: "https://www.bing.com/search?q=%s",
	google: "https://www.google.com/search?q=%s",
};

export const DEFAULT_SETTINGS = {
	ads: true,
	threats: true,
	search: "brave",
	wipe: false,
	allow: [],
};

/** Input from the UI -> valid settings. */
export function cleanSettings(input) {
	const out = {};
	for (const key of ["ads", "threats", "wipe"])
		out[key] = typeof input?.[key] === "boolean" ? input[key] : DEFAULT_SETTINGS[key];
	out.search = Object.hasOwn(SEARCH_ENGINES, input?.search) ? input.search : DEFAULT_SETTINGS.search;
	out.allow = Array.isArray(input?.allow)
		? [...new Set(input.allow.filter((s) => typeof s === "string" && /^[a-z0-9.-]{1,253}$/.test(s)))].slice(-500)
		: [];
	return out;
}

/** The site a host belongs to: mail.google.com -> google.com. */
export function siteOf(hostname) {
	hostname = String(hostname || "").toLowerCase().replace(/\.$/, "");
	return getDomain(hostname, { allowPrivateDomains: true }) || hostname;
}

export function hostOf(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

// Same lists as the server (app/src/filters.js): [kind, url, mirror].
export const THREAT_LISTS = [
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

/** A hosts file ("0.0.0.0 bad.example") -> its hostnames. */
export function parseHosts(text) {
	const hosts = [];
	for (const line of String(text).split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const host = trimmed.split(/\s+/).pop().toLowerCase();
		if (host && host !== "0.0.0.0" && host !== "localhost") hosts.push(host);
	}
	return hosts;
}

/** "phishing" | "malware" when the host or a parent domain is listed. */
export function threatFor(threats, hostname) {
	let host = String(hostname || "").toLowerCase().replace(/\.$/, "");
	while (host) {
		const kind = threats.get(host);
		if (kind) return kind;
		const dot = host.indexOf(".");
		if (dot === -1) break;
		host = host.slice(dot + 1);
	}
	return null;
}

/**
 * Browser shortcuts, from an Electron input event (before-input-event). The
 * UI window maps its own key presses with the same table.
 * @param {{ type: string, key: string, control?: boolean, meta?: boolean, alt?: boolean, shift?: boolean }} input
 * @param {string} platform process.platform
 */
export function shortcutFor(input, platform = process.platform) {
	if (input.type !== "keyDown" && input.type !== "rawKeyDown") return null;
	const mod = platform === "darwin" ? input.meta : input.control;
	const key = String(input.key || "").toLowerCase();
	if (key === "f5") return input.control ? "reload-hard" : "reload";
	if (input.alt && !mod) {
		if (key === "arrowleft") return "back";
		if (key === "arrowright") return "forward";
		return null;
	}
	if (!mod) return null;
	if (key === "tab") return input.shift ? "prev-tab" : "next-tab";
	if (input.shift) return key === "t" ? "reopen-tab" : null;
	return (
		{
			t: "new-tab",
			w: "close-tab",
			l: "focus-address",
			k: "focus-address",
			r: "reload",
			d: "bookmark",
			h: "history",
			"=": "zoom-in",
			"+": "zoom-in",
			"-": "zoom-out",
			0: "zoom-reset",
		}[key] || null
	);
}

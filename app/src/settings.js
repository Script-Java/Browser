// Defaults for the user's protection settings (shared by the server and the
// service worker bundle).
export const DEFAULT_SETTINGS = {
	ads: true,
	cosmetic: true,
	videoAds: true,
	// Two more block lists (see filters.js); they cost memory on every site.
	notices: false,
	// Cookie notices answered "reject" (DuckDuckGo's autoconsent, client/consent.js).
	consent: true,
	threats: true,
	// http:// pages pass through the server unencrypted: try https first.
	httpsOnly: true,
	// "safer": no WebGL or web fonts anywhere, no scripts on http:// pages.
	// "safest": that, and no site's own scripts on any page.
	level: "standard",
	// On so a lost or shared device doesn't keep the last session's logins.
	wipe: true,
	// Google shows proxied searches a captcha, even from home connections.
	search: "brave",
	// Sites with blocking switched off.
	allow: [],
	// Sites whose own scripts are switched off.
	noScripts: [],
	// Sites that stay signed in when the rest is cleared.
	keep: [],
	// The person's own rules, in uBlock Origin's syntax (a cookie of their own: cleanRules).
	rules: "",
};

// Rules ride in their own signed cookie, under the same ~4 KB.
const MAX_RULES = 2800;

/** User input -> rules, one a line, that fit in their cookie. */
export function cleanRules(text) {
	if (typeof text !== "string") return "";
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && line.length <= 500 && !/[\u0000-\u001f\u007f]/.test(line));
	let out = [...new Set(lines)].join("\n");
	// the last rules added go first when they don't fit
	while (JSON.stringify(out).length > MAX_RULES) out = out.slice(0, Math.max(0, out.lastIndexOf("\n")));
	return out;
}

const SITE_LISTS = ["allow", "noScripts", "keep"];

// The shell's address bar maps these to search URLs (public/index.js).
export const SEARCH_ENGINES = ["google", "duckduckgo", "bing", "brave"];

export const LEVELS = ["standard", "safer", "safest"];

// The settings ride in one signed cookie, and browsers drop cookies over
// ~4 KB. Base64 grows the JSON by a third, so this keeps the cookie under it.
const MAX_JSON = 2800;

/** User input -> valid settings that fit in the cookie. */
export function cleanSettings(input) {
	const out = {};
	for (const key of ["ads", "cosmetic", "videoAds", "notices", "consent", "threats", "httpsOnly", "wipe"])
		out[key] =
			typeof input?.[key] === "boolean" ? input[key] : DEFAULT_SETTINGS[key];
	out.search = SEARCH_ENGINES.includes(input?.search)
		? input.search
		: DEFAULT_SETTINGS.search;
	out.level = LEVELS.includes(input?.level) ? input.level : DEFAULT_SETTINGS.level;
	for (const list of SITE_LISTS)
		out[list] = Array.isArray(input?.[list])
			? [
					...new Set(
						input[list].filter(
							(s) => typeof s === "string" && /^[a-z0-9.-]{1,253}$/.test(s)
						)
					),
				]
			: [];
	// The shell adds new sites at the end, so the oldest go first, from the
	// longest list.
	while (JSON.stringify(out).length > MAX_JSON)
		SITE_LISTS.map((list) => out[list])
			.sort((a, b) => b.length - a.length)[0]
			.shift();
	return out;
}

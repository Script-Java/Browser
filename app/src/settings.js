// Defaults for the user's protection settings (shared by the server and the
// service worker bundle).
export const DEFAULT_SETTINGS = {
	ads: true,
	cosmetic: true,
	videoAds: true,
	// Two more block lists (see filters.js); they cost memory on every site.
	notices: false,
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
	allow: [],
};

// The shell's address bar maps these to search URLs (public/index.js).
export const SEARCH_ENGINES = ["google", "duckduckgo", "bing", "brave"];

export const LEVELS = ["standard", "safer", "safest"];

// The settings ride in one signed cookie, and browsers drop cookies over
// ~4 KB. Base64 grows the JSON by a third, so this keeps the cookie under it.
const MAX_JSON = 2800;

/** User input -> valid settings that fit in the cookie. */
export function cleanSettings(input) {
	const out = {};
	for (const key of ["ads", "cosmetic", "videoAds", "notices", "threats", "httpsOnly", "wipe"])
		out[key] =
			typeof input?.[key] === "boolean" ? input[key] : DEFAULT_SETTINGS[key];
	out.search = SEARCH_ENGINES.includes(input?.search)
		? input.search
		: DEFAULT_SETTINGS.search;
	out.level = LEVELS.includes(input?.level) ? input.level : DEFAULT_SETTINGS.level;
	out.allow = Array.isArray(input?.allow)
		? [
				...new Set(
					input.allow.filter(
						(s) => typeof s === "string" && /^[a-z0-9.-]{1,253}$/.test(s)
					)
				),
			]
		: [];
	// The shell adds new sites at the end, so the oldest go first.
	while (JSON.stringify(out).length > MAX_JSON) out.allow.shift();
	return out;
}

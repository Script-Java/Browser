// Defaults for the user's protection settings (shared by the server and the
// service worker bundle).
export const DEFAULT_SETTINGS = {
	ads: true,
	cosmetic: true,
	videoAds: true,
	threats: true,
	// Off so people stay signed in to sites, like in any other browser.
	wipe: false,
	// Google shows proxied searches a captcha, even from home connections.
	search: "brave",
	allow: [],
};

// The shell's address bar maps these to search URLs (public/index.js).
export const SEARCH_ENGINES = ["google", "duckduckgo", "bing", "brave"];

// The settings ride in one signed cookie, and browsers drop cookies over
// ~4 KB. Base64 grows the JSON by a third, so this keeps the cookie under it.
const MAX_JSON = 2800;

/** User input -> valid settings that fit in the cookie. */
export function cleanSettings(input) {
	const out = {};
	for (const key of ["ads", "cosmetic", "videoAds", "threats", "wipe"])
		out[key] =
			typeof input?.[key] === "boolean" ? input[key] : DEFAULT_SETTINGS[key];
	out.search = SEARCH_ENGINES.includes(input?.search)
		? input.search
		: DEFAULT_SETTINGS.search;
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

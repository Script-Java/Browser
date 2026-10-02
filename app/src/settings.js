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

// Proxied URLs: /scramjet/<encodeURIComponent(site URL)>, Scramjet's default
// codec. Shared by the server (media.js) and the service worker (shield.js).

export const PREFIX = "/scramjet/";

// Query parameters Scramjet adds for itself; anything else after the encoded
// URL was appended by the browser (a GET form submission).
const OWN_PARAMS = new Set(["type", "dest", "topFrame", "parentFrame"]);

/** "/scramjet/…" for a site URL. Same as ScramjetController.encodeUrl. */
export function encodeUrl(url) {
	url = new URL(url);
	const hash = url.hash.slice(1);
	url.hash = "";
	return PREFIX + encodeURIComponent(url.href) + (hash ? "#" + encodeURIComponent(hash) : "");
}

/**
 * The http(s) site URL a proxied URL (absolute, or a path) points at, or null.
 * Mirrors Scramjet's service worker, so both agree on which page a request is for.
 */
export function decodeUrl(proxied) {
	try {
		const at = new URL(proxied, "http://x");
		if (!at.pathname.startsWith(PREFIX)) return null;
		const url = new URL(decodeURIComponent(at.pathname.slice(PREFIX.length)));
		for (const [name, value] of at.searchParams)
			if (!OWN_PARAMS.has(name)) url.searchParams.set(name, value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url;
	} catch {
		return null;
	}
}

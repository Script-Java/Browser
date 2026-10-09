// Maps a hostname to its "site" (registrable domain, e.g. mail.google.com ->
// google.com) and to the subdomain label that site gets in isolation mode.
// Bundled for the shell (window.BiosSiteKey) and the service worker.

import { getDomain } from "tldts";

// for the shell, which reads a tab's address back out of its proxied one
export { decodeUrl } from "../codec.js";

/**
 * @param {string} hostname
 * @returns {string}
 */
export function siteOf(hostname) {
	hostname = String(hostname).toLowerCase().replace(/\.$/, "");
	return getDomain(hostname, { allowPrivateDomains: true }) || hostname;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * A stable DNS label for a site: "s" + 25 base32 chars of SHA-256(site).
 * @param {string} hostname
 * @returns {Promise<string>}
 */
export function siteKey(hostname) {
	return label("s", siteOf(hostname));
}

/**
 * The same site's label in a Tor tab: "t" + 25 base32 chars of
 * SHA-256("tor " + site), an origin of its own, walled off from the site's
 * ordinary one (its cookies and storage, and its connections, which go
 * through Tor: see src/tor.js).
 * @param {string} hostname
 * @returns {Promise<string>}
 */
export function torKey(hostname) {
	return label("t", "tor " + siteOf(hostname));
}

/**
 * The label of a frame from `frameHost`'s site inside a page of `topSite`:
 * "f" + 25 base32 chars of SHA-256("frame <top site> <frame's site>"), or "g"
 * in a Tor tab. An origin of its own, so the browser keeps the frame and the
 * page around it apart (src/sw/shield.js), and one per site that embeds it,
 * as browsers partition what an embedded site keeps.
 * @param {string} topSite the site of the tab's page
 * @param {string} frameHost
 * @param {boolean} tor
 * @returns {Promise<string>}
 */
export function frameKey(topSite, frameHost, tor = false) {
	return label(tor ? "g" : "f", `frame ${siteOf(topSite)} ${siteOf(frameHost)}`);
}

/** The label `key` belongs to a site in a Tor tab (or a frame in one). */
export const isTorKey = (key) => /^[tg][a-z2-7]{25}$/.test(String(key));

/** The label `key` belongs to a frame inside a page (see frameKey). */
export const isFrameKey = (key) => /^[fg][a-z2-7]{25}$/.test(String(key));

/** The label of `hostname`'s site as a tab, of the kind `key` is (a Tor tab's, or not). */
export const keyLike = (key, hostname) => (isTorKey(key) ? torKey(hostname) : siteKey(hostname));

async function label(prefix, name) {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)));
	let out = prefix;
	let bits = 0;
	let value = 0;
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5 && out.length < 26) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	return out;
}

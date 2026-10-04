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
export async function siteKey(hostname) {
	const bytes = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(siteOf(hostname))
		)
	);
	let out = "s";
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

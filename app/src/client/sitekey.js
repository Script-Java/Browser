// Maps a hostname to its "site" (registrable domain, e.g. mail.google.com ->
// google.com) and to the subdomain label that site gets in isolation mode.
// Bundled for the shell (window.BiosSiteKey) and the service worker.

import { getDomain } from "tldts";
import { named } from "./label.js";

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

/** "s" + 25 base32 chars of SHA-256(text): a DNS label that gives nothing of the text away. */
async function label(text) {
	return named(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/**
 * A stable DNS label for a site, where its own pages run.
 * @param {string} hostname
 * @returns {Promise<string>}
 */
export function siteKey(hostname) {
	return label(siteOf(hostname));
}

/**
 * The label for a site's pages shown in a frame inside another origin's
 * page: one for each pair of that origin (by its label) and the framed site,
 * so the same site framed elsewhere is kept apart. No site's name has a space
 * in it, so no frame's label can be a site's own.
 * @param {string} holder The label of the origin whose page holds the frame.
 * @param {string} hostname
 * @returns {Promise<string>}
 */
export function frameKey(holder, hostname) {
	return label(holder + " " + siteOf(hostname));
}

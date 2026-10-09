// CNAME uncloaking: a tracker can hide behind a site's own subdomain
// (metrics.example.com -> example.tracker.net), where block lists keyed on
// the tracker's name never see it. Browsers on the device can't look the
// name up; the server does the DNS for every connection anyway, so it
// answers the service worker's question "what does this name point to?",
// and the worker checks those names against the block lists (shield.js).

import { Resolver } from "node:dns/promises";
import net from "node:net";

const resolver = new Resolver({ timeout: 2000, tries: 2 });
const TTL_MS = 10 * 60_000;
const MAX_HOPS = 5;
const MAX_ENTRIES = 5000;
const cache = new Map(); // host -> { at, names: Promise<string[]> }

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** True for a DNS name this will look up (not an IP address, not a single label). */
export const lookupable = (host) => HOSTNAME.test(host) && !net.isIP(host);

async function chase(host) {
	const names = [];
	let name = host;
	for (let hop = 0; hop < MAX_HOPS; hop++) {
		let next;
		try {
			[next] = await resolver.resolveCname(name);
		} catch {
			// no CNAME here (ENODATA), or the name doesn't exist
			break;
		}
		next = String(next || "").toLowerCase().replace(/\.$/, "");
		if (!next || names.includes(next) || next === host) break;
		names.push(next);
		name = next;
	}
	return names;
}

/**
 * The names `host` points to, in order (empty when it's no alias).
 * @param {string} host
 * @returns {Promise<string[]>}
 */
export function canonicalNames(host) {
	host = String(host).toLowerCase().replace(/\.$/, "");
	if (!lookupable(host)) return Promise.resolve([]);
	const now = Date.now();
	const hit = cache.get(host);
	if (hit && now - hit.at < TTL_MS) return hit.names;
	if (cache.size >= MAX_ENTRIES)
		for (const [key, entry] of cache) if (now - entry.at >= TTL_MS || cache.size >= MAX_ENTRIES) cache.delete(key);
	const names = chase(host);
	cache.set(host, { at: now, names });
	return names;
}

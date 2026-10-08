// CNAME uncloaking: a site's own subdomain can be another name for a
// tracker's server (metrics.example.com -> example.eulerian.net), which the
// block lists know only by the tracker's name. The service worker can't look
// names up; the server can, since it does the proxy's DNS anyway.

import { promises as dns } from "node:dns";

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/**
 * @param {{ resolve?: (host: string) => Promise<string[]>, ttlMs?: number, max?: number, timeoutMs?: number }} [options]
 */
export function createCnames({ resolve = (host) => dns.resolveCname(host), ttlMs = 600_000, max = 5000, timeoutMs = 2000 } = {}) {
	const cache = new Map(); // host -> { names: Promise<string[]>, at }
	const lookup = (name) =>
		Promise.race([
			resolve(name),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs).unref?.()),
		]);

	async function follow(host) {
		const names = [];
		for (let name = host; names.length < 6; ) {
			let next;
			try {
				[next] = await lookup(name);
			} catch {
				break; // no CNAME (or no answer): the chain ends here
			}
			next = String(next || "").toLowerCase().replace(/\.$/, "");
			if (!HOSTNAME.test(next) || next === host || names.includes(next)) break;
			names.push(next);
			name = next;
		}
		return names;
	}

	/** The names `host` stands for, nearest first; [] for none. */
	function chain(host) {
		host = String(host).toLowerCase().replace(/\.$/, "");
		if (!HOSTNAME.test(host)) return Promise.resolve([]);
		const hit = cache.get(host);
		if (hit && Date.now() - hit.at < ttlMs) return hit.names;
		// ponytail: forgets everything when full; a busy server just looks names up again
		if (cache.size >= max) cache.clear();
		const names = follow(host);
		cache.set(host, { names, at: Date.now() });
		return names;
	}
	return { chain };
}

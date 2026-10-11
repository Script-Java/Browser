// The server's DNS, over HTTPS (DoH). Every site people open is looked up
// here; through the host's resolver in plain text, the hosting provider and
// every network on the way could read the list. DoH sends it encrypted to
// one resolver (Cloudflare's by default, which keeps no logs of it: DOH_URL
// names another, "off" uses the system's). Answers are cached for their TTL.

import { Resolver, lookup as systemLookup } from "node:dns/promises";
import { Agent, get } from "node:https";
import net from "node:net";

const DOH_URL = process.env.DOH_URL ?? "https://1.1.1.1/dns-query";
const TYPES = { A: 1, AAAA: 28, CNAME: 5 };
const MIN_TTL_S = 30;
const MAX_TTL_S = 300;
const MAX_ENTRIES = 5000;

const agent = new Agent({ keepAlive: true, maxSockets: 16 });
const cache = new Map(); // "name type" -> { until, answers: Promise<string[]> }

/**
 * The answers of one DoH query (JSON form): the records of `type`, and how
 * long they may be kept (seconds). A name that doesn't exist answers none.
 * @param {(url: string) => Promise<any>} fetchJson
 */
export async function query(name, type, fetchJson = dohJson) {
	if (!/^[a-z0-9._-]{1,253}$/i.test(name) || !(type in TYPES)) throw Object.assign(new Error("not a DNS name"), { code: "EINVAL" });
	const answer = await fetchJson(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`);
	// 3: no such name
	if (answer.Status === 3) return { records: [], ttl: MIN_TTL_S };
	if (answer.Status !== 0) throw Object.assign(new Error(`DNS answered ${answer.Status}`), { code: "ESERVFAIL" });
	const records = (answer.Answer || []).filter((r) => r.type === TYPES[type]);
	const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, ...records.map((r) => Number(r.TTL) || 0)));
	return { records: records.map((r) => String(r.data).toLowerCase().replace(/\.$/, "")), ttl };
}

function dohJson(url) {
	return new Promise((resolve, reject) => {
		const req = get(url, { agent, timeout: 3000, headers: { accept: "application/dns-json" } }, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				return reject(new Error(`DoH HTTP ${res.statusCode}`));
			}
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				body += chunk;
				if (body.length > 65_536) req.destroy(new Error("DoH answer too large"));
			});
			res.on("end", () => {
				try {
					resolve(JSON.parse(body));
				} catch (err) {
					reject(err);
				}
			});
		});
		req.on("timeout", () => req.destroy(new Error("DoH timed out")));
		req.on("error", reject);
	});
}

// ponytail: if the resolver can't be reached, the system's answers instead
// (so the app keeps working, in plain text for that while); logged at most
// once a minute, without the name
let warnedAt = 0;
function cached(name, type) {
	const key = `${name} ${type}`;
	const hit = cache.get(key);
	if (hit && hit.until > Date.now()) return hit.answers;
	if (cache.size > MAX_ENTRIES) cache.clear();
	const answers = query(name, type).then(({ records, ttl }) => {
		cache.set(key, { until: Date.now() + ttl * 1000, answers: Promise.resolve(records) });
		return records;
	});
	// errors aren't kept: the next lookup asks again
	cache.set(key, { until: Date.now() + 5000, answers });
	answers.catch(() => cache.delete(key));
	return answers;
}

/**
 * Every address `hostname` has, IPv4 first: [{ address, family }].
 * @param {string} hostname
 */
export async function lookupAll(hostname) {
	const family = net.isIP(hostname);
	if (family) return [{ address: hostname, family }];
	if (DOH_URL === "off") return systemLookup(hostname, { all: true });
	let a, aaaa;
	try {
		[a, aaaa] = await Promise.all([cached(hostname, "A"), cached(hostname, "AAAA").catch(() => [])]);
	} catch {
		if (Date.now() - warnedAt > 60_000) {
			warnedAt = Date.now();
			console.warn("dns: the DoH resolver didn't answer; using the system's");
		}
		return systemLookup(hostname, { all: true });
	}
	const found = [
		...a.filter((ip) => net.isIP(ip) === 4).map((address) => ({ address, family: 4 })),
		...aaaa.filter((ip) => net.isIP(ip) === 6).map((address) => ({ address, family: 6 })),
	];
	if (!found.length) throw Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND" });
	return found;
}

/**
 * What `name` is an alias of (its CNAME), or none.
 * @param {string} name
 */
export async function resolveCname(name) {
	if (DOH_URL === "off") return systemResolver.resolveCname(name);
	return cached(name, "CNAME");
}
const systemResolver = new Resolver({ timeout: 2000, tries: 2 });

// Runs inside the proxy's service worker (bundled to /bios/shield.js).
//
// Before Scramjet fetches anything it decides whether the request is
// allowed: known ad/tracker requests are dropped, known malware/phishing pages
// get a warning page, and (in isolation mode) a page that belongs to another
// site is moved to that site's own subdomain. After Scramjet rewrites an
// HTML page, it adds our page script, the page's element-hiding CSS and
// anti-ad scriptlets.

import { FiltersEngine, Request as FilterRequest } from "@ghostery/adblocker";
import { parse } from "tldts";
import { siteOf, siteKey, frameKey } from "../client/sitekey.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { PREFIX, decodeUrl, encodeUrl } from "../codec.js";
import { expiresFromMaxAge } from "./cookies.js";
import { OWN_RULES, compile, debounce } from "./debounce.js";

const FILTER_CACHE = "bios-filters";
const ENGINE_RECHECK_MS = 6 * 3_600_000;
const ENGINE_WAIT_MS = 4000;
const SETTINGS_TTL_MS = 30_000;
const API = PREFIX + "__bios/";

// Scramjet's config. The service worker stores it itself (Scramjet normally
// expects a page to), so every origin's worker works on its first request.
const SCRAMJET_CONFIG = {
	prefix: PREFIX,
	files: {
		wasm: "/scram/scramjet.wasm.wasm",
		all: "/scram/scramjet.all.js",
		sync: "/scram/scramjet.sync.js",
	},
	flags: {
		// On, every rewritten script carries its source map as a giant array
		// literal the page has to parse; YouTube's froze the tab. It only
		// serves Function.prototype.toString showing the original code.
		sourcemaps: false,
	},
};

const REQUEST_TYPES = {
	iframe: "sub_frame",
	frame: "sub_frame",
	document: "main_frame",
	script: "script",
	worker: "script",
	sharedworker: "script",
	serviceworker: "script",
	style: "stylesheet",
	image: "image",
	font: "font",
	audio: "media",
	video: "media",
	track: "media",
	object: "object",
	embed: "object",
	manifest: "other",
	report: "ping",
	"": "xmlhttprequest",
};

const json = (value) =>
	new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
	});

const htmlEscape = (text) =>
	String(text).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			]
	);
// JSON that is safe inside an inline <script>.
const scriptJson = (value) =>
	JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");

/**
 * Saves Scramjet's config to its database. Call before creating the
 * ScramjetServiceWorker: it opens that database without creating its tables,
 * and the first open of a new database is the one that gets to create them.
 */
export function storeConfig() {
	const { ScramjetController } = self.$scramjetLoadController();
	const save = () => new ScramjetController(SCRAMJET_CONFIG).openIDB();
	return save().catch(async (err) => {
		// a database left without tables: start it over
		console.warn("bios: rebuilding Scramjet's database:", err);
		await new Promise((resolve) => {
			const req = indexedDB.deleteDatabase("$scramjet");
			req.onsuccess = req.onerror = req.onblocked = resolve;
		});
		return save();
	});
}

/**
 * @param {any} scramjet ScramjetServiceWorker instance
 * @param {Promise<unknown>} configStored from storeConfig()
 */
export function createShield(scramjet, configStored) {
	const prefix = location.origin + PREFIX;
	// Server settings, prepended to this script by the server.
	const bios = self.__biosConfig || {};
	const isolationDomain = bios.isolation || null;
	const isolated =
		!!isolationDomain && location.hostname.endsWith("." + isolationDomain);
	const ownLabel = isolated
		? location.hostname.slice(0, -(isolationDomain.length + 1))
		: null;
	const port = location.port ? ":" + location.port : "";
	const shellOrigin = isolated
		? `${location.protocol}//${isolationDomain}${port}`
		: location.origin;
	const originFor = (label) =>
		`${location.protocol}//${label}.${isolationDomain}${port}`;

	// In isolation mode every site origin has its own service worker. They
	// all load the block list from the shell's origin so the browser keeps a
	// single cached copy instead of one per site.
	const ENGINE_URL = isolated
		? shellOrigin + "/filters/engine.bin"
		: "/filters/engine.bin";

	// Only pages this worker made (a warning's button, a trampoline) know the
	// token, so a link from elsewhere can't click "Continue anyway" for someone.
	const goToken = crypto.randomUUID();
	const goUrl = (action, to) =>
		`${location.origin}${API}go?do=${action}&t=${goToken}&u=${encodeURIComponent(to)}`;

	// The settings live with the shell (see index.js).
	const shellFetch = (path, init = {}) =>
		isolated ? fetch(shellOrigin + path, { ...init, credentials: "include" }) : fetch(path, init);

	let configLoad = null;
	function ensureConfig() {
		if (scramjet.config) return;
		configLoad ||= configStored
			.then(() => scramjet.loadConfig())
			.finally(() => (configLoad = null));
		return configLoad;
	}

	// The transport's connection to the server died (a deploy, a network
	// change) and epoxy doesn't reopen it. Ask one open page of this origin
	// to connect again, then retry the request once.
	const DEAD_TRANSPORT = /MuxTaskEnded|WebSocket (is )?closed|wisp.*clos/i;
	let reconnecting = null;
	function reconnect() {
		reconnecting ||= (async () => {
			const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			// the shell or a site's anchor frame: pages that load register-sw.js
			const page = pages.find((client) => !client.url.startsWith(prefix));
			if (!page) return;
			const channel = new MessageChannel();
			const answered = new Promise((resolve) => (channel.port1.onmessage = resolve));
			page.postMessage({ bios: "reconnect" }, [channel.port2]);
			await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, 5000))]);
		})().finally(() => (reconnecting = null));
		return reconnecting;
	}
	// Why the last request for a site address failed (handle() shows a page
	// that couldn't be fetched what went wrong).
	const failures = new Map();
	const transportFetch = scramjet.client.fetch.bind(scramjet.client);
	scramjet.client.fetch = async (url, init) => {
		try {
			try {
				return await transportFetch(url, init);
			} catch (err) {
				if (!DEAD_TRANSPORT.test(String(err?.message || err))) throw err;
				await reconnect();
				return await transportFetch(url, init);
			}
		} catch (err) {
			// ponytail: forgets everything at 50; a page that failed just then gets Scramjet's own error page
			if (failures.size > 50) failures.clear();
			failures.set(String(url), String(err?.message || err));
			throw err;
		}
	};

	// ------------------------------------------------------------- cookies

	// Scramjet keeps the sites' cookies in its database, but its worker
	// never reads them back (they come out as an object, and its load() only
	// takes text), and saves only the ones a page's script sets. So every
	// time the browser stopped this worker (Chrome does after half a minute
	// without requests), the cookies sites had sent were gone: signed out.
	// This worker reads them back when it starts, and saves them after
	// every change. (Scramjet's database, as storeConfig made it.)
	function cookieJar(mode, use) {
		return new Promise((resolve, reject) => {
			const open = indexedDB.open("$scramjet");
			// not made here: storeConfig makes it, with all its tables
			open.onupgradeneeded = () => open.transaction.abort();
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const db = open.result;
				try {
					const tx = db.transaction("cookies", mode);
					const req = use(tx.objectStore("cookies"));
					tx.oncomplete = () => {
						db.close();
						resolve(req.result);
					};
					tx.onerror = tx.onabort = () => {
						db.close();
						reject(tx.error);
					};
				} catch (err) {
					db.close();
					reject(err);
				}
			};
		});
	}
	const savedCookies = configStored
		.then(() => cookieJar("readonly", (store) => store.get("cookies")))
		.then((saved) => {
			if (typeof saved === "string") saved = JSON.parse(saved);
			if (!saved || typeof saved !== "object") return;
			// what this worker has heard since it started is newer
			scramjet.cookieStore.load(JSON.stringify({ ...saved, ...JSON.parse(scramjet.cookieStore.dump()) }));
		})
		.catch((err) => console.warn("bios: couldn't read the saved cookies:", err));
	// one write at a time, each with the jar as it is then
	let cookieWrites = Promise.resolve();
	let cookiesChanged = false;
	function saveCookies() {
		cookiesChanged = false;
		cookieWrites = cookieWrites
			.then(() => savedCookies)
			.then(() => cookieJar("readwrite", (store) => store.put(JSON.parse(scramjet.cookieStore.dump()), "cookies")))
			.catch((err) => console.warn("bios: couldn't save the cookies:", err));
		return cookieWrites;
	}

	// Messages from this origin's own pages (scramjet-sw.js drops the rest).
	self.addEventListener("message", (event) => {
		if (event.origin !== location.origin) return;
		if (event.data?.bios === "wipe") wipe(event);
		else if (event.data?.bios === "typed" || event.data?.bios === "own") vouch(event);
	});

	// "Clear all site data" deleted Scramjet's cookie database; forget the
	// copy this worker keeps in memory too.
	function wipe(event) {
		scramjet.cookieStore.load("{}");
		// (and a write of the old jar still on its way lands before this one)
		event.waitUntil(saveCookies());
		// New Identity: forget the warnings the person clicked through too
		for (const set of [bypassed, plainHttp, allowOnce]) set.clear();
		// (the page that clears this origin's data deleted what was written down)
		home = null;
	}

	// Isolation: what this origin is for. A site's own origin (its label is
	// the site's key) needs nothing written down. An origin made for a
	// site's pages shown in frames inside another origin's page can't tell
	// from its label, which is a hash: it is told on the way in (the "enter"
	// call in api()), checks the claim against its label, and remembers.
	// { site, above: the labels of the origins it is framed in, nearest first }
	let home = null;
	const HOME_CACHE = "bios-origin";
	const LABEL = /^s[a-z2-7]{25}$/;
	const homeLoaded = isolated
		? caches
				.open(HOME_CACHE)
				.then((cache) => cache.match("/home"))
				.then((saved) => saved && saved.json())
				.then(
					(saved) => {
						if (typeof saved?.site === "string" && Array.isArray(saved.above)) home = saved;
					},
					() => {}
				)
		: Promise.resolve();
	async function setHome(next) {
		home = next;
		const cache = await caches.open(HOME_CACHE);
		await cache.put("/home", new Response(JSON.stringify(next)));
	}

	let engine = null;
	let engineLoad = null;
	let settings = null;
	let settingsAt = 0;
	let settingsLoad = null;
	const bypassed = new Set(); // hosts the user chose to open despite a warning
	const plainHttp = new Set(); // sites (example.com) the user chose to open over http
	const httpsWorks = new Set(); // hosts that answered over https
	const allowOnce = new Set(); // proxied URLs to load once without ad blocking
	const pages = new Map(); // site URL -> page info for the response hook
	const framed = new Map(); // proxied URL of a page shown in a frame inside a page -> its tab's page (a site URL)

	// ---------------------------------------------------------------- engine

	async function fetchEngine(cache, cached) {
		const headers = {};
		const etag = cached && cached.headers.get("etag");
		if (etag) headers["if-none-match"] = etag;
		const res = await fetch(ENGINE_URL, { headers, cache: "no-store" });
		const stamp = { "x-bios-checked": String(Date.now()) };
		if (res.status === 304 && cached) {
			const body = await cached.arrayBuffer();
			await cache.put(
				ENGINE_URL,
				new Response(body, { headers: { etag, ...stamp } })
			);
			return null;
		}
		if (!res.ok) throw new Error(`engine HTTP ${res.status}`);
		const body = await res.arrayBuffer();
		const next = FiltersEngine.deserialize(new Uint8Array(body));
		await cache.put(
			ENGINE_URL,
			new Response(body, {
				headers: { etag: res.headers.get("etag") || "", ...stamp },
			})
		);
		return next;
	}

	async function fetchSharedEngine() {
		const res = await fetch(ENGINE_URL, {
			credentials: "include",
			cache: "no-cache",
		});
		if (!res.ok) throw new Error(`engine HTTP ${res.status}`);
		engine = FiltersEngine.deserialize(new Uint8Array(await res.arrayBuffer()));
		setTimeout(() => (engineLoad = null), ENGINE_RECHECK_MS);
	}

	function loadEngine() {
		if (isolated) {
			engineLoad ||= fetchSharedEngine().catch((err) => {
				console.warn("bios: filters unavailable:", err);
				setTimeout(() => (engineLoad = null), 30_000);
			});
			return engineLoad;
		}
		engineLoad ||= (async () => {
			const cache = await caches.open(FILTER_CACHE);
			const cached = await cache.match(ENGINE_URL);
			if (cached) {
				try {
					engine = FiltersEngine.deserialize(
						new Uint8Array(await cached.clone().arrayBuffer())
					);
				} catch {
					// written by another engine version; fetch a fresh one
				}
			}
			const checked = cached ? Number(cached.headers.get("x-bios-checked")) : 0;
			if (!engine || Date.now() - checked > ENGINE_RECHECK_MS) {
				const update = fetchEngine(cache, engine ? cached : null).then(
					(next) => {
						if (next) engine = next;
					}
				);
				if (!engine) await update;
				else update.catch(() => {});
			}
		})().catch((err) => {
			console.warn("bios: filters unavailable:", err);
			// try again on a later request
			setTimeout(() => (engineLoad = null), 30_000);
		});
		return engineLoad;
	}

	function waitForEngine() {
		if (engine) return;
		return Promise.race([
			loadEngine(),
			new Promise((resolve) => setTimeout(resolve, ENGINE_WAIT_MS)),
		]);
	}

	// "Hide cookie notices": two more lists in an engine of their own, loaded
	// only for people who switch it on (every site's worker holds a copy).
	const NOTICES_URL = ENGINE_URL.replace("engine.bin", "notices.bin");
	let notices = null;
	let noticesLoad = null;
	function loadNotices() {
		noticesLoad ||= fetch(NOTICES_URL, { credentials: "include", cache: "no-cache" })
			.then(async (res) => {
				if (!res.ok) throw new Error(`notices HTTP ${res.status}`);
				notices = FiltersEngine.deserialize(new Uint8Array(await res.arrayBuffer()));
				setTimeout(() => (noticesLoad = null), ENGINE_RECHECK_MS);
			})
			.catch((err) => {
				console.warn("bios: cookie-notice lists unavailable:", err);
				setTimeout(() => (noticesLoad = null), 30_000);
			});
		return noticesLoad;
	}

	// Switched on a moment ago, or this worker just started: the first page waits for them.
	function waitForNotices() {
		if (!settings?.notices || notices) return;
		return Promise.race([
			loadNotices(),
			new Promise((resolve) => setTimeout(resolve, ENGINE_WAIT_MS)),
		]);
	}

	// Addresses that only bounce a click on (debounce.js): the app's own rules
	// at once, and Brave's list from the server once it's here.
	const DEBOUNCE_URL = ENGINE_URL.replace("engine.bin", "debounce.json");
	let bounces = compile(OWN_RULES);
	let bouncesLoad = null;
	function loadBounces() {
		bouncesLoad ||= fetch(DEBOUNCE_URL, { credentials: "include", cache: "no-cache" })
			.then(async (res) => {
				if (!res.ok) throw new Error(`bounce list HTTP ${res.status}`);
				bounces = compile([...OWN_RULES, ...(await res.json())]);
				setTimeout(() => (bouncesLoad = null), ENGINE_RECHECK_MS);
			})
			.catch((err) => {
				console.warn("bios: bounce list unavailable:", err);
				setTimeout(() => (bouncesLoad = null), 30_000);
			});
		return bouncesLoad;
	}

	// What the block lists say about a request for `target` from the page `source`.
	function listed(target, source, type) {
		const request = FilterRequest.fromRawDetails({
			url: target.href,
			sourceUrl: (source || target).href,
			type,
		});
		let answer = { match: false };
		for (const list of [engine, settings.notices && notices]) {
			if (!list) continue;
			answer = list.match(request);
			if (answer.match || answer.redirect) break;
		}
		return answer;
	}

	// CNAME uncloaking (cname.js): a site's own subdomain can be another name
	// for a tracker's server, which the lists know only by the tracker's own
	// name. The server says what a name stands for; a request the lists would
	// block under one of those names is blocked here too. Asked only for the
	// subdomains of the page's own site: that's where trackers hide.
	const cnames = new Map(); // host -> Promise<string[]>
	function namesFor(host) {
		if (!cnames.has(host)) {
			// ponytail: forgets everything at 500
			if (cnames.size > 500) cnames.clear();
			cnames.set(
				host,
				shellFetch("/api/cname", { cache: "no-store", headers: { "x-bios-host": host } })
					.then((res) => (res.ok ? res.json() : { names: [] }))
					.then(
						({ names }) => (Array.isArray(names) ? names.filter((name) => typeof name === "string").slice(0, 6) : []),
						() => []
					)
			);
		}
		return cnames.get(host);
	}
	/** The tracker's name `target` stands for, when the lists block that one. */
	async function cloaked(target, page, type) {
		const site = siteOf(target.hostname);
		if (!page || page.hostname === target.hostname || siteOf(page.hostname) !== site) return null;
		// (a slow answer lets the request go: the next one is checked)
		const names = await Promise.race([namesFor(target.hostname), new Promise((resolve) => setTimeout(resolve, 800, []))]);
		// a name of the site's own is still the site's; only its host is asked about, as uBlock does
		return names.find((name) => siteOf(name) !== site && listed(new URL(`${target.protocol}//${name}/`), page, type).match) || null;
	}

	// The rules that hide parts of a page, and its scriptlets, from each of `lists`.
	function hiding(lists, options) {
		let styles = "";
		const scripts = [];
		for (const list of lists.filter(Boolean)) {
			const found = list.getCosmeticsFilters(options);
			styles += found.styles || "";
			scripts.push(...(found.scripts || []));
		}
		return { styles, scripts };
	}

	// -------------------------------------------------------------- settings

	function applySettings(next) {
		settings = { ...DEFAULT_SETTINGS, ...(next || {}) };
		settingsAt = Date.now();
		if (settings.notices) loadNotices();
		// This origin is one site's, or a frame's inside a site's page
		// (isolation): which sites' tabs have scripts switched off?
		if (isolated)
			Promise.all(settings.noScripts.map((site) => siteKey(site))).then((keys) => (scriptsOffIn = keys));
	}

	async function getSettings() {
		if (!settings || Date.now() - settingsAt > SETTINGS_TTL_MS) {
			settingsLoad ||= shellFetch("/api/settings", { cache: "no-store" })
				.then((res) => (res.ok ? res.json() : null))
				.then(applySettings, () => settings || applySettings(null))
				.finally(() => (settingsLoad = null));
			await settingsLoad;
		}
		return settings;
	}

	// One round trip per page load: fresh settings plus the threat verdict,
	// so a switch flipped in the shield menu applies to the very next page
	// (on every site origin in isolation mode, too).
	// And for an https page, whether its certificate was revoked (the server
	// looks: certs.js). { threat, revoked }
	async function checkNavigation(target) {
		try {
			const headers = { "x-bios-host": target.hostname };
			if (target.protocol === "https:") headers["x-bios-https"] = target.port || "443";
			const res = await shellFetch("/api/nav", { cache: "no-store", headers });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			applySettings(data.settings);
			return { threat: data.threat, revoked: data.revoked === true };
		} catch {
			await getSettings();
			return { threat: null, revoked: false };
		}
	}

	const isAllowed = (hostname) =>
		!!hostname && settings.allow.includes(siteOf(hostname));

	// ----------------------------------------------------------------- pages

	function headers(type = "text/html") {
		const h = {
			"content-type": `${type}; charset=utf-8`,
			"cache-control": "no-store",
			"cross-origin-resource-policy": "same-site",
		};
		if (self.crossOriginIsolated)
			h["cross-origin-embedder-policy"] = "require-corp";
		return h;
	}

	// A 307, which keeps a form POST intact. Not Response.redirect(): Safari
	// refuses a redirect into the app's frame unless it carries these headers.
	const redirect = (to) => new Response(null, { status: 307, headers: { ...headers(), location: to } });

	// Runs in a page we generate. Works out where it is: "top" (escaped the
	// app), "tab" (the app's page frame: the app is the window above, and the
	// top one) or "sub" (a frame inside a page).
	const WHERE = `function where(){if(parent===self)return"top";return parent===top?"tab":"sub"}`;

	const WARNINGS = {
		phishing: {
			danger: true,
			title: "Deceptive site ahead",
			text: "This site is on a list of known phishing sites. It may try to trick you into entering a password, card number or other personal details.",
			go: "Continue anyway (unsafe)",
			action: "bypass",
		},
		malware: {
			danger: true,
			title: "Dangerous site ahead",
			text: "This site is on a list of sites known to spread malware.",
			go: "Continue anyway (unsafe)",
			action: "bypass",
		},
		ads: {
			title: "Page blocked",
			text: "This address belongs to a known ad or tracking network, so it was blocked.",
			go: "Open anyway",
			action: "allow",
		},
		// The app's own TLS (epoxy, on the device) refused the site's
		// certificate. No way past it: nothing can make epoxy accept one, and
		// whoever sits in between could read and change everything.
		cert: {
			danger: true,
			title: "This connection isn't private",
			text: "Someone may be pretending to be this site, so it wasn't opened.",
		},
		unreachable: {
			title: "Couldn't open this page",
			text: "The site didn't answer. It may be down, the address may be wrong, or the connection dropped.",
			go: "Try again",
			action: "retry",
		},
		http: {
			title: "This site isn't secure",
			text: "It doesn't offer a secure (https) connection. What you see and send there passes through the app's server and the internet unencrypted, so others along the way could read or change it. Don't enter passwords or personal details.",
			go: "Continue (not secure)",
			action: "http",
		},
	};

	const CERT_PROBLEMS = [
		// rustls's own names for them, nothing looser: a site's name may say "expired" too
		[/InvalidCertificate\(Expired/, "Its security certificate has expired."],
		[/InvalidCertificate\(NotValidYet/, "Its security certificate isn't valid yet."],
		[/InvalidCertificate\(NotValidForName/, "Its security certificate belongs to a different address."],
		[/InvalidCertificate\((UnknownIssuer|BadSignature)/, "Its security certificate isn't signed by an authority this app trusts."],
		// (the server's word: certs.js)
		[/^Revoked$/, "Its security certificate was revoked by whoever issued it."],
		[/./, "Its security certificate isn't valid."],
	];

	// `why`: what the transport said when the page couldn't be fetched.
	function interstitial({ kind, host, url, why }) {
		const { danger, title, go, action } = WARNINGS[kind];
		let { text } = WARNINGS[kind];
		if (kind === "cert") text = CERT_PROBLEMS.find(([problem]) => problem.test(why))[1] + " " + text;
		const proceed = action === "retry" ? url : action ? goUrl(action, url) : "";
		return new Response(
			`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title>
<style>
html{background:${danger ? "#7f1d1d" : "#1b1b24"};color:#fff;font:16px/1.45 -apple-system,system-ui,sans-serif}
body{margin:0;padding:48px 24px;max-width:560px}
h1{font-size:24px;margin:0 0 12px}p{margin:0 0 16px;opacity:.9}
code{word-break:break-all;background:rgba(0,0,0,.25);padding:2px 6px;border-radius:6px}
button{font:inherit;padding:10px 16px;border-radius:10px;border:0;margin:8px 8px 0 0}
#back{background:#fff;color:#111}#go{background:transparent;color:#fff;text-decoration:underline;padding-left:0}
body.sub{display:none}
</style></head><body>
<h1>${htmlEscape(title)}</h1>
<p>${htmlEscape(text)}</p>
<p><code>${htmlEscape(host)}</code></p>
<button id="back" type="button">Go back</button>
${proceed ? `<button id="go" type="button">${htmlEscape(go)}</button>` : ""}
<script>
${WHERE}
if (where() === "sub") document.body.className = "sub";
document.getElementById("back").onclick = function () { history.length > 1 ? history.back() : location.replace("about:blank"); };
var go = document.getElementById("go");
if (go) go.onclick = function () { location.replace(${scriptJson(proceed)}); };
</script></body></html>`,
			{ status: 200, headers: headers() }
		);
	}

	// Re-issues a navigation from a tiny page we serve (GET or form POST).
	// `plan` decides the destination once the page knows where it is.
	//
	// The page may get hooked by Scramjet (a parent page touching the frame
	// does that), which reroutes fetch() through the proxy. So it only uses
	// location.replace() and forms written in the markup, which go to the
	// browser's own Location and form handling.
	async function trampoline(request, plan) {
		let fields = null;
		if (request.method === "POST") {
			const type = request.headers.get("content-type") || "";
			if (
				!/^(application\/x-www-form-urlencoded|multipart\/form-data)/i.test(
					type
				)
			)
				return null;
			try {
				const form = await request.clone().formData();
				fields = [];
				for (const [name, value] of form)
					if (typeof value === "string") fields.push([name, value]);
			} catch {
				return null;
			}
		} else if (request.method !== "GET") {
			return null;
		}

		const targets = {
			shell: plan.shell || null,
			tab: plan.tab || null,
			child: plan.child || null,
			sibling: plan.sibling || null,
			sub: plan.url || null,
		};
		const inputs = (fields || [])
			.map(
				([name, value]) =>
					`<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`
			)
			.join("");
		const forms = fields
			? Object.entries(targets)
					.filter(([key, action]) => action && key !== "shell")
					.map(
						([key, action]) =>
							`<form id="f-${key}" method="post" action="${htmlEscape(action)}">${inputs}</form>`
					)
					.join("")
			: "";
		const boot = plan.boot
			? `<script src="/baremux/index.js"></script><script src="/register-sw.js"></script>`
			: "";
		// (its address is no site's, so it isn't given as a referrer)
		const quiet = plan.quiet ? `<meta name="referrer" content="no-referrer">` : "";
		return new Response(
			`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${quiet}<style>html{background:#fff}</style>${boot}</head><body>${forms}<script>
${WHERE}
var targets = ${scriptJson(targets)};
// The app (the top window) opens an origin's anchor frame, which keeps its
// proxy connection alive: this origin's, or the one a frame is about to go to.
function needAnchor(origin, fallback) {
	return new Promise(function (resolve) {
		var timer = setTimeout(function () { fallback().then(resolve, resolve); }, 8000);
		addEventListener("message", function (e) {
			if (e.source !== top || !e.data || e.data.bios !== "anchor-ready") return;
			clearTimeout(timer);
			resolve();
		});
		top.postMessage({ bios: "need-anchor", origin: origin }, "*");
	});
}
function go(key) {
	var form = document.getElementById("f-" + key);
	if (form) HTMLFormElement.prototype.submit.call(form);
	else location.replace(targets[key]);
}
(async function () {
	var at = where();
	if (${plan.boot ? "true" : "false"}) {
		try {
			// outside the app there is nobody to ask: connect here
			if (at === "top") await setupTransport();
			else await needAnchor(location.origin, setupTransport);
		} catch (e) { document.body.textContent = String(e && e.message || e); return; }
	}
	if (targets.sub) return go("sub");
	if (at === "top") return targets.shell && location.replace(targets.shell);
	// The tab, on to another site's own origin: that origin's proxy
	// connection first. A site not opened yet would otherwise answer from
	// the server, whose page starts it and reloads, and a form's fields
	// don't survive that.
	if (at === "tab") {
		if (targets.tab) await needAnchor(new URL(targets.tab).origin, function () { return Promise.resolve(); });
		return go("tab");
	}
	// A frame inside a page, bound for another site: to the origin kept for
	// that site in this frame's place. A frame of this origin's own page is
	// its child; one whose parent is another origin's page is moving on from
	// the site it showed.
	var own = false;
	try { parent.location.href; own = true; } catch (e) {}
	var key = own ? "child" : "sibling";
	if (!targets[key]) return;
	await needAnchor(new URL(targets[key]).origin, function () { return Promise.resolve(); });
	go(key);
})();
</script></body></html>`,
			// The site origin the tab goes on to learns from the referrer that
			// another site sent it (see whoAsks). Safari sends none unless told to.
			{ status: 200, headers: { ...headers(), "referrer-policy": "origin" } }
		);
	}

	// True when a page of this origin is open to hand bare-mux a connection.
	async function hasProxyClient() {
		const list = await self.clients.matchAll({
			type: "window",
			includeUncontrolled: true,
		});
		return list.some(
			(client) =>
				client.url.startsWith(prefix) ||
				client.url === location.origin + "/anchor.html"
		);
	}

	// ------------------------------------------------------------ internal API

	async function api(request, path) {
		// /scramjet/__bios/go?do=<allow|bypass|http>&t=<token>&u=<proxied URL>:
		// remember the choice, then continue to the page (307 keeps a form POST
		// intact). Without the token (a made-up link, or this worker restarted
		// since the page was made) nothing is remembered, and the page's
		// warning comes up again.
		if (path === "go") {
			const params = new URL(request.url).searchParams;
			const to = params.get("u") || "";
			const target = decode(to);
			if (!target) return new Response(null, { status: 400 });
			const action = params.get("t") === goToken ? params.get("do") : null;
			if (action === "allow") allowOnce.add(to);
			else if (action === "bypass") bypassed.add(target.hostname.toLowerCase());
			else if (action === "http") plainHttp.add(siteOf(target.hostname.toLowerCase()));
			return redirect(to);
		}
		// /scramjet/__bios/enter?u=<proxied path>&a=<labels>[&from=<site>]: a
		// frame arriving from the page that holds it, or (with `from`) moving
		// on from the origin kept for another site in the same place. The
		// browser says which origin sent it (the referrer, which a page can
		// hide but not forge), and labels are hashes: the claim fits this
		// origin's own label or it doesn't. Only then does this origin serve
		// that site's pages, so nothing can be shown here but the one site
		// this origin was made for, under the one origin it was made for.
		// `a` is the labels of the origins above, nearest first.
		if (path === "enter") {
			const params = new URL(request.url).searchParams;
			const to = location.origin + (params.get("u") || "");
			const target = decode(to);
			const above = (params.get("a") || "").split(",");
			const from = params.get("from");
			let sender = "";
			try {
				const { hostname } = new URL(request.referrer);
				if (hostname.endsWith("." + isolationDomain))
					sender = hostname.slice(0, -(isolationDomain.length + 1));
			} catch {
				// no referrer
			}
			const fits =
				isolated &&
				!!target &&
				!!sender &&
				sender !== ownLabel &&
				above.length <= 6 &&
				above.every((label) => LABEL.test(label)) &&
				(from ? (await frameKey(above[0], from)) === sender : above[0] === sender) &&
				(await frameKey(above[0], target.hostname)) === ownLabel;
			if (!fits) return new Response(null, { status: 403, headers: headers() });
			await homeLoaded;
			await setHome({ site: siteOf(target.hostname), above });
			// Safari drops a POST's fields when this worker redirects it, so a
			// form is posted on from here, as asked by whoever sent it here.
			if (request.method === "POST") {
				const who = await whoAsks({ request }, to, target, true);
				const page = await trampoline(request, { url: to, quiet: true });
				if (page) {
					keep(hops, pageKey(to), { who, redirect: true, at: Date.now() });
					return page;
				}
			}
			return redirect(to);
		}
		// /scramjet/__bios/cross?u=<proxied path>: a page asked the app for
		// this navigation (a link that opens a new tab, or a frame's link or
		// form aimed at the whole tab) and the app loads it for the page. To
		// this worker that looked like an address typed into the bar, or,
		// when the tab's own page posts the frame's form, like the site's own
		// request, with all its cookies. So it comes marked as another
		// site's. Anyone may mark a navigation so: it only takes away.
		if (path === "cross") {
			const to = location.origin + (new URL(request.url).searchParams.get("u") || "");
			if (!decode(to)) return new Response(null, { status: 400 });
			keep(hops, pageKey(to), { who: OUTSIDER, redirect: true, at: Date.now() });
			return redirect(to);
		}
		// Where a message for the site at `o` may be delivered: the origin
		// kept for that site in a frame under `under` (a label), or its own
		// origin when there's no `under`. For page.js, which has no hashing
		// of site names; nothing here is secret.
		if (path === "origin") {
			const params = new URL(request.url).searchParams;
			const under = params.get("under") || "";
			let kept = "";
			try {
				const { hostname } = new URL(params.get("o"));
				if (isolated && (!under || LABEL.test(under)))
					kept = originFor(under ? await frameKey(under, hostname) : await siteKey(hostname));
			} catch {
				// not an origin
			}
			return json({ origin: kept });
		}
		// A page in a frame inside another page (an embedded player) says so:
		// see where a blocked page is answered with nothing, in handle().
		if (path === "framed") {
			// ponytail: forgets everything at 500; a frame loaded before that shows the blank warning again
			if (framed.size > 500) framed.clear();
			// the tab's page, for the list of what was blocked on it
			let top = "";
			try {
				top = new URL(new URL(request.url).searchParams.get("top")).href.slice(0, 2000);
			} catch {
				// not said
			}
			if (decode(request.referrer)) framed.set(pageKey(request.referrer), top);
			return new Response(null, { status: 204 });
		}
		// Would the ad blocker stop this page? Asked before a page's pop-up
		// becomes a tab, so an ad's pop-up never does.
		if (path === "ad") {
			let target = null;
			try {
				target = new URL(new URL(request.url).searchParams.get("u"));
			} catch {
				// not an address
			}
			const source = decode(request.referrer);
			await getSettings();
			await waitForEngine();
			await waitForNotices();
			const blocked =
				!!target &&
				settings.ads &&
				!isAllowed(target.hostname) &&
				listed(target, source, "main_frame").match;
			if (blocked) countBlocked(pageFor(request.referrer, source), target.hostname);
			return json({ blocked });
		}
		if (request.method === "POST" && path === "cosmetic") {
			const { url, classes, ids, hrefs } = await request.json();
			await getSettings();
			const host = parse(url);
			if (!host.hostname || isAllowed(host.hostname)) return json({ styles: "" });
			await waitForNotices();
			const result = hiding([settings.cosmetic && engine, settings.notices && notices], {
				url,
				hostname: host.hostname,
				domain: host.domain || host.hostname,
				classes: classes || [],
				ids: ids || [],
				hrefs: hrefs || [],
				getBaseRules: false,
				getInjectionRules: false,
				getExtendedRules: false,
				getRulesFromHostname: false,
				getRulesFromDOM: true,
			});
			return json({ styles: result.styles });
		}
		return new Response(null, { status: 404 });
	}

	// ----------------------------------------------------------- the request

	function decode(url) {
		if (!url || !url.startsWith(prefix)) return null;
		return decodeUrl(url);
	}

	// ------------------------------------------------- what sites are told

	// A site is told where each request comes from (Sec-Fetch-Site, Referer,
	// Origin) and refuses forged requests by it; its SameSite cookies depend
	// on the same answer. Scramjet works it out from the browser's referrer
	// for the proxied address, which goes wrong three ways here: our own
	// in-between pages (trampolines) make a navigation look like the site's
	// own, a page that sends no referrer looks like nobody's, and every
	// request to another site carries the page's whole address.
	const RANK = { none: 0, "same-origin": 1, "same-site": 2, "cross-site": 3 };
	const stricter = (a, b) => (RANK[b] > RANK[a] ? b : a);
	const safe = (method) => method === "GET" || method === "HEAD";

	function relation(from, to) {
		if (from.origin === to.origin) return "same-origin";
		return from.protocol === to.protocol && siteOf(from.hostname) === siteOf(to.hostname)
			? "same-site"
			: "cross-site";
	}

	// In isolation mode a tab reaches another site through that site's own
	// origin. All its worker sees is that the page before was another site's.
	function fromAnotherSite(referrer) {
		if (!isolated || !referrer) return false;
		try {
			const at = new URL(referrer);
			return at.origin !== location.origin && at.hostname.endsWith("." + isolationDomain);
		} catch {
			return false;
		}
	}

	// ponytail: both forget everything when full; a request caught by that
	// is described by Scramjet alone, as all were before
	const hops = new Map(); // proxied page URL -> who began the navigation a trampoline or a redirect carries on
	const asked = new Map(); // site URL -> who is asking, for the request Scramjet sends next
	function keep(map, key, value) {
		if (map.size > 200) map.clear();
		map.set(key, value);
	}
	// A navigation another site began, which won't be named (see "cross" in api()).
	const OUTSIDER = {
		site: "cross-site",
		from: null,
		quiet: true,
		brief: false,
		nav: true,
		framed: false,
		mode: "navigate",
		method: "GET",
	};

	// Navigations with no referrer at all (see whoAsks), and what was said
	// about them before they came: the app's word that it is loading an
	// address itself (typed, a bookmark, reload, back), which comes through
	// this origin's anchor frame; and the word of this origin's own pages
	// that they are going somewhere (page.js), for pages that hide their
	// referrer. No page of another origin can speak to this worker.
	// ponytail: the last 50 of each, for 30 seconds
	const typedNext = new Map(); // proxied page URL -> when the app said so
	let ownNext = []; // { kind: "url" | "path" | "history", url, from, at }
	const TYPED = Symbol("typed");
	// (a message from a page of this origin)
	function vouch({ data, source, ports }) {
		if (data.bios === "typed" && typeof data.path === "string" && source?.url === location.origin + "/anchor.html") {
			if (typedNext.size > 50) typedNext.clear();
			typedNext.set(pageKey(location.origin + data.path), Date.now());
			ports[0]?.postMessage("noted");
		} else if (data.bios === "own" && ["url", "path", "history"].includes(data.kind)) {
			// the page's address as the browser has it, not its word for it
			const from = decode(source?.url);
			let url = null;
			try {
				if (data.kind !== "history") url = new URL(String(data.url));
			} catch {
				return;
			}
			if (from) ownNext = [...ownNext.slice(-49), { kind: data.kind, url, from, at: Date.now() }];
		}
	}
	async function vouched(url, target, request) {
		// the browser's own back, forward or reload (Chromium says which): the person's
		if (!home && (request.isHistoryNavigation || request.isReloadNavigation)) return TYPED;
		const find = () => {
			const now = Date.now();
			const typed = typedNext.get(pageKey(url));
			typedNext.delete(pageKey(url));
			if (typed && now - typed < 30_000) return TYPED;
			const at = ownNext.findIndex(
				({ kind, url: to, at }) =>
					now - at < 30_000 &&
					(kind === "history" ||
						(kind === "path"
							? to.origin + to.pathname === target.origin + target.pathname
							: pageKey(to.href) === pageKey(target.href)))
			);
			return at === -1 ? null : ownNext.splice(at, 1)[0].from;
		};
		// a page's word comes as it goes, and may arrive just after its navigation
		return find() || (await new Promise((resolve) => setTimeout(resolve, 50)), find());
	}

	/**
	 * Who is asking for `target`: { site, from, quiet, brief, nav, framed,
	 * carried, mode, method }, or null when there's no telling (Scramjet's
	 * own answer stands). `from`: the asking page's site URL, when known.
	 * `quiet`: the page sends no referrer; `brief`: its origin only.
	 */
	async function whoAsks(event, url, target, isPage) {
		const { request } = event;
		const ref = decode(request.referrer);
		const who = {
			site: "none",
			from: ref,
			quiet: !request.referrer,
			brief: !!request.referrer && !ref,
			nav: isPage,
			// every page of an origin kept for frames is in a frame
			framed: isPage && !!home,
			mode: request.mode,
			method: request.method,
		};
		if (!isPage) {
			// a page that hides its referrer is still the one asking
			if (!ref && event.clientId) who.from = decode((await self.clients.get(event.clientId))?.url);
			if (!who.from) return null;
			who.site = relation(who.from, target);
			return who;
		}
		const hop = hops.get(pageKey(url));
		// One of our trampolines carrying a navigation on (it asks for its own
		// address again), or a redirect: whoever began it is asking. One step
		// through another site makes the whole chain another site's.
		if (
			hop &&
			Date.now() - hop.at < 60_000 &&
			(hop.redirect || (ref && pageKey(request.referrer) === pageKey(url)))
		) {
			hops.delete(pageKey(url));
			const began = hop.who;
			return {
				...began,
				method: request.method,
				carried: true,
				site: began.from ? stricter(began.site, relation(began.from, target)) : began.site,
			};
		}
		if (ref) who.site = relation(ref, target);
		else if (fromAnotherSite(request.referrer)) who.site = "cross-site";
		else if (isolated && !request.referrer) {
			// No referrer at all. In a browser that's the person's own request
			// (an address typed), and so it was here, with all their cookies.
			// But a page that gets around the proxy's hooks can send its tab
			// here without a referrer too, and its forged request would come
			// as theirs: SameSite cookies and all. So it's another site's,
			// unless someone who can tell vouched for it (see `typedNext`).
			const said = await vouched(url, target, request);
			if (said === TYPED) who.site = "none";
			else if (said) {
				who.from = said;
				who.site = relation(said, target);
			} else who.site = "cross-site";
		}
		return who;
	}

	// One answer for everyone, as in Tor Browser: the device's own list of
	// languages helps tell its owner apart. (Scramjet sent none, and some
	// sites then guessed a language from where the server is.)
	const LANGUAGE = "en-US,en;q=0.9";

	scramjet.addEventListener("request", (event) => {
		const headers = event.requestHeaders;
		headers["accept-language"] = LANGUAGE;
		// Global Privacy Control: "don't sell or share my data", binding under some laws
		headers["sec-gpc"] = "1";
		const who = asked.get(event.url.href);
		if (!who) return;
		asked.delete(event.url.href);
		const to = event.url;
		const { from } = who;

		// Scramjet follows a background request's redirects, so its answer
		// counts when it's the stricter one. After a trampoline its answer is
		// about our own page, and ours stands alone.
		const theirs = headers["sec-fetch-site"];
		const site = who.carried || !(theirs in RANK) ? who.site : stricter(who.site, theirs);
		headers["sec-fetch-site"] = site;

		// Referer: the whole address for the page's own origin; for others the
		// origin only, and nothing from an https page to an http one (what
		// browsers do by default). Never more than the page itself would send.
		if (who.quiet || !from || (from.protocol === "https:" && to.protocol === "http:"))
			delete headers.referer;
		else
			headers.referer =
				from.origin === to.origin && !who.brief ? from.href.split("#")[0] : from.origin + "/";

		if (who.nav) {
			// A frame inside a page, when we know it is one. (Scramjet says
			// "iframe" for every address typed into the bar: the tab is a frame.)
			headers["sec-fetch-dest"] = who.framed ? "iframe" : "document";
			// A posted form names the origin it was posted from, and sites
			// tell their own forms from forged ones by it; "null" when the
			// page won't say or it came from another origin of this app.
			if (!safe(who.method)) {
				if (from && !who.quiet) headers.origin = from.origin;
				else if (who.quiet || site === "cross-site") headers.origin = "null";
			}
		} else if (who.quiet && who.mode === "no-cors" && safe(who.method)) {
			// Scramjet names the page's origin on every request; a browser
			// doesn't on these, and the page asked not to be named
			delete headers.origin;
		}

		// SameSite cookies: Strict ones never go with another site's request,
		// Lax ones only when a link or the address bar takes the tab there.
		if (site === "cross-site" && headers.cookie) {
			const laxToo = who.nav && !who.framed && safe(who.method);
			const jar = Object.create(scramjet.cookieStore);
			jar.cookies = Object.fromEntries(
				Object.entries(scramjet.cookieStore.cookies).filter(([, cookie]) => {
					const rule = String(cookie.sameSite).toLowerCase();
					return rule !== "strict" && (rule !== "lax" || laxToo);
				})
			);
			const cookie = jar.getCookies(to, false);
			if (cookie) headers.cookie = cookie;
			else delete headers.cookie;
		}
	});

	// A cookie that doesn't say goes everywhere, as in Safari. (Scramjet's
	// jar files it under Lax, which would keep it home with the ones that
	// asked to stay; Chrome does that, with exceptions sign-ins depend on.)
	// And its Max-Age counts (see cookies.js).
	const setCookies = scramjet.cookieStore.setCookies.bind(scramjet.cookieStore);
	scramjet.cookieStore.setCookies = (cookies, url) => {
		cookiesChanged = true;
		return setCookies(
			cookies.map((cookie) =>
				expiresFromMaxAge(/;\s*samesite\s*=/i.test(cookie) ? cookie : cookie + "; SameSite=None")
			),
			url
		);
	};

	// Query parameters that only exist to follow a person from one site to
	// the next: click ids and campaign tags (Brave's and DuckDuckGo's lists).
	const TRACKING_PARAMS = new Set(
		(
			"fbclid gclid gclsrc dclid gbraid wbraid msclkid twclid ttclid yclid ymclid ysclid igshid " +
			"srsltid li_fat_id irclickid rb_clickid unicorn_click_id wickedid s_cid mc_eid mkt_tok " +
			"_hsenc _hsmi __hssc __hstc __hsfp hsctatracking _openstat __s _gl _kx _bhlid " +
			"oly_anon_id oly_enc_id vero_id vero_conv ml_subscriber ml_subscriber_hash " +
			"fb_action_ids fb_comment_id guce_referrer guce_referrer_sig bsft_clkid bsft_uid " +
			"sc_customer sc_eh sc_uid ss_email_id et_rid vgo_ee mtm_cid pk_cid " +
			"_branch_match_id _branch_referrer at_recipient_id at_recipient_list"
		).split(" ")
	);

	// `target` without them, or null when it has none. The rest of the query
	// is left exactly as written (some sites sign theirs).
	function withoutTracking(target) {
		const parts = target.search.slice(1).split("&");
		const kept = parts.filter((part) => {
			let name = part.split("=")[0];
			try {
				name = decodeURIComponent(name.replace(/\+/g, " "));
			} catch {
				// not valid percent-encoding: compare it as written
			}
			name = name.toLowerCase();
			return !TRACKING_PARAMS.has(name) && !name.startsWith("utm_");
		});
		if (kept.length === parts.length) return null;
		const clean = new URL(target.href);
		clean.search = kept.join("&");
		return clean;
	}

	/**
	 * A site's rule about which pages may show it in a frame: X-Frame-Options,
	 * or frame-ancestors in a Content-Security-Policy, which wins when both
	 * are there. Scramjet drops both headers. Returns null, or one list of
	 * allowed sources per policy for page.js to hold the page's frame to.
	 */
	function framingRule(rawHeaders) {
		let options = "";
		const policies = [];
		for (const [name, value] of Object.entries(rawHeaders || {})) {
			const header = name.toLowerCase();
			// a header sent twice arrives as a list; a comma also separates policies
			const text = [].concat(value).join(",");
			if (header === "x-frame-options") options = text.toLowerCase();
			else if (header === "content-security-policy")
				for (const policy of text.split(",")) {
					const rule = policy
						.split(";")
						.map((directive) => directive.trim().split(/\s+/))
						.find(([directive]) => directive.toLowerCase() === "frame-ancestors");
					if (rule) policies.push(rule.slice(1));
				}
		}
		if (policies.length) return policies;
		if (/\bdeny\b/.test(options)) return [[]];
		if (/\bsameorigin\b/.test(options)) return [["'self'"]];
		return null;
	}

	// Counts blocked requests for the new tab's "trackers blocked" stat and
	// tells the app's own pages every few seconds: the shell (shared mode) or
	// this site's anchor frame (isolation mode), never the proxied pages.
	// With the page and the host when known, for the shield menu's list of
	// what was blocked on the page.
	let blockedCount = 0;
	let blockedTimer = null;
	let blockedHosts = [];
	function countBlocked(page, host) {
		blockedCount++;
		// ponytail: the first 200 in three seconds; the count stays right
		if (page && host && blockedHosts.length < 200) blockedHosts.push([page, host]);
		blockedTimer ||= setTimeout(async () => {
			const count = blockedCount;
			const hosts = blockedHosts;
			blockedCount = 0;
			blockedHosts = [];
			blockedTimer = null;
			const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const page of pages)
				if (!page.url.startsWith(prefix)) page.postMessage({ bios: "blocked", count, hosts });
		}, 3000);
	}

	// A page load that is a file to save (sent as an attachment, or of a kind
	// browsers don't show), for the app's list of downloads: the browser saves
	// it as usual, and the app's pages are told, as they are of what's blocked.
	const SHOWN = new Set(["application/json", "application/pdf", "application/xml", "application/javascript"]);
	async function noteDownload(event) {
		const disposition = String(event.responseHeaders["content-disposition"] || "");
		const type = String(event.responseHeaders["content-type"] || "").split(";")[0].trim().toLowerCase();
		const attachment = /^\s*attachment/i.test(disposition);
		const shown = !type || SHOWN.has(type) || /^(text|image|video|audio|font)\//.test(type);
		if (!attachment && (shown || /^\s*inline/i.test(disposition))) return;
		let name = /filename\*?=(?:utf-8'')?["']?([^"';]+)/i.exec(disposition)?.[1] || event.url.pathname.split("/").pop();
		try {
			name = decodeURIComponent(name);
		} catch {
			// as it was written
		}
		const download = {
			name: String(name || event.url.hostname).slice(0, 200),
			type: type.slice(0, 100),
			size: Number(event.responseHeaders["content-length"]) || 0,
			url: event.url.href.slice(0, 2000),
		};
		const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		for (const page of pages) if (!page.url.startsWith(prefix)) page.postMessage({ bios: "download", download });
	}

	// The tab's page a request belongs to: a frame inside a page answers for
	// the page around it.
	const pageFor = (referrer, source) => framed.get(pageKey(referrer || "")) || source?.href;

	// Whether the block lists refuse `target` as a frame in the page `holder`.
	async function refusedFrame(target, holder) {
		await getSettings();
		if (!settings.ads || isAllowed(target.hostname) || isAllowed(holder.hostname)) return false;
		await waitForEngine();
		await waitForNotices();
		return !!engine && !!listed(target, holder, "sub_frame").match;
	}

	function blocked(destination) {
		if (SCRIPTED.has(destination))
			return new Response("", { headers: headers("text/javascript") });
		if (destination === "style")
			return new Response("", { headers: headers("text/css") });
		return Response.error();
	}

	// Scramjet rewrites an empty src="" (and poster) into the page's own
	// address, so the browser fetched the whole page as an image (a broken
	// image icon) or a script. An empty attribute loads nothing; so answer a
	// page asking for itself as one of those with nothing too.
	// ponytail: frames are left alone: the app's tab is itself a frame, and a
	// reload or a link to the same page looks just like an empty frame src.
	const EMPTY = {
		image: () =>
			new Response(Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0)), {
				headers: headers("image/gif"),
			}),
		script: () => new Response("", { headers: headers("text/javascript") }),
		video: () => Response.error(),
		audio: () => Response.error(),
		track: () => Response.error(),
	};
	async function emptyAttribute(event, target, destination) {
		if (!EMPTY[destination] || !event.clientId) return null;
		const client = await self.clients.get(event.clientId);
		const page = client && decode(client.url);
		return page && page.href === target.href ? EMPTY[destination]() : null;
	}

	// ------------------------------------------------------------ HTTPS-Only

	// Whether a host answers over https at all: one quick request. A yes is
	// remembered while this worker runs; a no is asked again next time, in
	// case it was the connection failing rather than the site.
	async function speaksHttps(host) {
		if (httpsWorks.has(host)) return true;
		const probe = scramjet.client
			.fetch(`https://${host}/`, { method: "HEAD", redirect: "manual" })
			.then(
				() => true,
				() => false
			);
		const timeout = new Promise((resolve) => setTimeout(resolve, 6000, false));
		const ok = await Promise.race([probe, timeout]);
		if (ok) httpsWorks.add(host);
		return ok;
	}

	// http:// requests: the https address instead (307 keeps a form POST), or
	// for a page with no https, a warning. Subresources are just upgraded,
	// unless their page is one the person chose to open over http.
	async function httpsOnly(request, target, isPage, url, who) {
		if (target.protocol !== "http:") return null;
		const host = target.hostname.toLowerCase();
		if (plainHttp.has(siteOf(host))) return null;
		// a page load gets fresh settings, so the switch applies at once
		if (isPage) settingsAt = 0;
		await getSettings();
		if (!settings.httpsOnly) return null;
		if (!isPage) {
			const page = decode(request.referrer);
			if (page && plainHttp.has(siteOf(page.hostname.toLowerCase()))) return null;
		}
		// (on a port of its own, it's that port that would have to speak https)
		if (isPage && !(await speaksHttps(target.host.toLowerCase())))
			return interstitial({ kind: "http", host: target.host, url });
		const secure = new URL(target.href);
		secure.protocol = "https:";
		const to = location.origin + encodeUrl(secure.href);
		// whoever began the navigation is still the one asking
		if (isPage && who) keep(hops, pageKey(to), { who, redirect: true, at: Date.now() });
		return redirect(to);
	}

	// "Safer" level: no web fonts (a fingerprinting and font-parser attack
	// surface), and no scripts from pages that came over plain http.
	// "Safest": the same, and no site's scripts on any page.
	// Also for one site at a time, from the shield menu: that site's pages,
	// and with isolation everything in its tabs (the frames of other sites
	// inside its pages too: see tabScriptsOff).
	const hardened = () => settings.level === "safer" || settings.level === "safest";
	// The labels of the sites with scripts switched off. A frame on an origin
	// of its own is in such a site's tab when one of the origins above it is
	// that site's: the browser shows a page only inside the origins it names
	// (framers), so the tab's own can't be left out of `home.above`.
	let scriptsOffIn = [];
	const tabScriptsOff = () =>
		scriptsOffIn.includes(ownLabel) || !!home?.above.some((label) => scriptsOffIn.includes(label));
	const noSiteScripts = (url) =>
		settings.level === "safest" ||
		(settings.level === "safer" && url?.protocol === "http:") ||
		tabScriptsOff() ||
		(!!url && settings.noScripts.includes(siteOf(url.hostname)));

	const SCRIPTED = new Set(["script", "worker", "sharedworker", "serviceworker"]);
	// what loads as a document of its own: pages, and what <object> and <embed> show
	const DOCUMENTS = new Set(["document", "iframe", "frame", "object", "embed"]);
	const WORKERS = new Set(["worker", "sharedworker"]);

	// A worker's code (as Scramjet rewrote it) with worker.js at its top, so it
	// gives the same answers about the device as the page that started it.
	// Ahead of Scramjet's own lines, with the browser's own importScripts.
	function workerPrelude(code, page) {
		if (typeof code !== "string") return code;
		const flags = `safer=${hardened() ? 1 : 0}&fingerprint=${settings.ads && !isAllowed(page?.hostname) ? 1 : 0}`;
		const url = `${location.origin}/bios/worker.js?${flags}`;
		return (code.startsWith("import ") ? `import "${url}";\n` : `importScripts("${url}");\n`) + code;
	}

	function saferBlock(destination, source) {
		if (hardened() && destination === "font") return blocked(destination);
		if (SCRIPTED.has(destination) && noSiteScripts(source)) return blocked(destination);
		return null;
	}

	// A data: or blob: URL carries the page's own code, so it gets the same
	// rules as the page that used it. Scramjet answers these without its
	// handleResponse event, so the policy and our page script go on here.
	async function inline(event, destination, isPage) {
		await getSettings();
		const holder = decode(event.request.referrer);
		const noScripts = noSiteScripts(holder);
		if (noScripts && SCRIPTED.has(destination)) return blocked(destination);
		const res = await scramjet.fetch(event);
		const page = isPage && {
			cosmetic: false,
			videoAds: false,
			safer: hardened(),
			fingerprint: settings.ads && !isAllowed(holder?.hostname),
			noScripts,
		};
		const resHeaders = new Headers(res.headers);
		const html = /^text\/html/i.test(resHeaders.get("content-type") || "");
		resHeaders.set("content-security-policy", policyFor(page, (isPage || DOCUMENTS.has(destination)) && !html));
		let body = res.body;
		if (page && html) body = injectHtml(await res.text(), page);
		else if (WORKERS.has(destination)) body = workerPrelude(await res.text(), holder);
		return new Response(body, {
			status: res.status,
			statusText: res.statusText,
			headers: resHeaders,
		});
	}

	// Without the #fragment: the response hook doesn't always see it, and a page
	// it can't match goes out uninjected and without the header that lets the
	// app frame it (Safari then refuses to show it).
	const pageKey = (href) => href.split("#")[0];

	function rememberPage(page) {
		// ponytail: entries for pages that never answer stay until this clears
		if (pages.size > 200) pages.clear();
		pages.set(pageKey(page.url), page);
	}

	async function handle(event) {
		const { request } = event;
		const url = request.url;

		if (url.startsWith(location.origin + API))
			return api(
				request,
				url.slice((location.origin + API).length).split("?")[0]
			);
		await ensureConfig();
		await homeLoaded;
		if (!scramjet.route(event)) {
			// A proxied page asking for a real address directly (a preload or
			// an API Scramjet doesn't cover) would reach the site from the
			// phone, with its own IP address. Only the app's own files go out.
			if (new URL(url).origin !== location.origin) return Response.error();
			return fetch(request);
		}

		const destination = request.destination;
		const isPage =
			request.mode === "navigate" ||
			destination === "document" ||
			destination === "iframe" ||
			destination === "frame";

		// decodeUrl only returns http(s) pages; Scramjet's own files go
		// straight to Scramjet
		const target = decode(url);
		if (!target) {
			if (!/^(data|blob):/i.test(url.slice(prefix.length))) return scramjet.fetch(event);
			return inline(event, destination, isPage);
		}

		const empty = await emptyAttribute(event, target, destination);
		if (empty) return empty;

		const who = await whoAsks(event, url, target, isPage);

		const upgraded = await httpsOnly(request, target, isPage, url, who);
		if (upgraded) return upgraded;

		// A tracker's address on the way to the real one (bounce tracking):
		// straight on to the real one, so the tracker never hears of it. Off
		// with the rest of the blocking, for one site too.
		if (isPage && safe(request.method)) {
			// (Brave's list for the next page, if it isn't here yet)
			if (!bouncesLoad) loadBounces();
			const real = debounce(bounces, target);
			if (real) settingsAt = 0;
			if (real && (await getSettings()).ads && !isAllowed(target.hostname)) {
				countBlocked(pageFor(request.referrer, decode(request.referrer)), target.hostname);
				const to = location.origin + encodeUrl(real.href);
				if (who) keep(hops, pageKey(to), { who, redirect: true, at: Date.now() });
				return redirect(to);
			}
		}

		// An address typed or pasted, or a link from another site, loses the
		// parameters that follow people between sites; a site's own links
		// keep theirs. Off with the rest of the blocking, for one site too.
		if (isPage && safe(request.method) && who?.site !== "same-origin" && who?.site !== "same-site") {
			const clean = withoutTracking(target);
			// fresh settings, so the switch applies to the very next page
			if (clean) settingsAt = 0;
			if (clean && (await getSettings()).ads && !isAllowed(target.hostname)) {
				countBlocked();
				const to = location.origin + encodeUrl(clean.href);
				// the same navigation, by whoever began it
				if (who) keep(hops, pageKey(to), { who, redirect: true, at: Date.now() });
				return redirect(to);
			}
		}

		const enginePromise = waitForEngine();

		if (isPage) {
			// Isolation: every site runs on its own subdomain, and so does
			// each site shown in a frame inside another origin's page, so
			// the browser itself keeps a page and the frames in it apart. A
			// page that belongs elsewhere goes there; the in-between page
			// works out whether it is a tab or a frame, and which.
			if (isolated) {
				const mine = home
					? home.site === siteOf(target.hostname)
					: (await siteKey(target.hostname)) === ownLabel;
				if (!mine) {
					// A frame is held to the block lists here, where the page
					// it sits in is known (the origin it goes to only sees that
					// another origin sent it). One the lists refuse gets no
					// origin; and when a player's own script sent its frame to
					// an ad, the frame stays as it is (see `framed` below).
					const holder = decode(request.referrer);
					const refused = !!holder && (await refusedFrame(target, holder));
					if (refused && framed.has(pageKey(request.referrer))) {
						countBlocked(pageFor(request.referrer, holder), target.hostname);
						return new Response(null, { status: 204 });
					}
					const path = url.slice(location.origin.length);
					const enter = (label, above, from) =>
						`${originFor(label)}${API}enter?u=${encodeURIComponent(path)}&a=${above.join(",")}` +
						(from ? `&from=${encodeURIComponent(from)}` : "");
					const page = await trampoline(request, {
						tab: originFor(await siteKey(target.hostname)) + path,
						// a frame of this origin's page
						child:
							!refused && enter(await frameKey(ownLabel, target.hostname), [ownLabel, ...(home?.above || [])]),
						// this origin's own frame, moving on to another site
						sibling:
							!refused &&
							home &&
							enter(await frameKey(home.above[0], target.hostname), home.above, home.site),
						shell: shellOrigin + "/#" + encodeURIComponent(target.href),
					});
					if (page) return page;
					// What can't be sent on (a form that isn't one of the usual
					// kinds) isn't loaded here either: this origin is one site's.
					return new Response("This page belongs to another site and couldn't be sent there.", {
						status: 403,
						headers: headers("text/plain"),
					});
				} else if (!(await hasProxyClient())) {
					// First page of this site since the app opened: start the
					// proxy connection for this origin, then load the page.
					const page = await trampoline(request, { boot: true, url });
					if (page && who) keep(hops, pageKey(url), { who, at: Date.now() });
					if (page) return page;
				}
			}

			const { threat, revoked } = await checkNavigation(target);
			if (
				threat &&
				settings.threats &&
				!bypassed.has(target.hostname.toLowerCase())
			)
				return interstitial({ kind: threat, host: target.hostname, url });
			// Its issuer took its certificate back: as with any other bad
			// certificate, no way past (whoever holds the key may not be the site).
			if (revoked) return interstitial({ kind: "cert", host: target.hostname, url, why: "Revoked" });
		} else {
			await getSettings();
		}

		const source = isPage
			? decode(request.referrer)
			: decode(request.referrer) || target;
		const pageHost = isPage ? target.hostname : source && source.hostname;
		const blocking = settings.ads && !isAllowed(pageHost);

		const safer = !isPage && saferBlock(destination, source);
		if (safer) return safer;

		if (blocking && !allowOnce.delete(url)) {
			await enginePromise;
			await waitForNotices();
			if (engine) {
				const { match, redirect } = listed(target, source, REQUEST_TYPES[destination] || "other");
				if (redirect && !isPage) {
					countBlocked(pageFor(request.referrer, source), target.hostname);
					return new Response(
						redirect.contentType.includes("base64")
							? Uint8Array.from(atob(redirect.body), (c) => c.charCodeAt(0))
							: redirect.body,
						{ headers: { ...headers(redirect.contentType.split(";")[0]) } }
					);
				}
				if (match) {
					// An embedded player whose ad script sends its own frame to
					// an ad: answer with nothing, and the frame stays as it is.
					if (isPage && framed.has(pageKey(request.referrer))) {
						countBlocked(pageFor(request.referrer, source), target.hostname);
						return new Response(null, { status: 204 });
					}
					if (isPage)
						return interstitial({ kind: "ads", host: target.hostname, url });
					countBlocked(pageFor(request.referrer, source), target.hostname);
					return blocked(destination);
				}
				// not on the lists by its own name, but by the tracker's it stands for
				if (!isPage && (await cloaked(target, who?.from || source, REQUEST_TYPES[destination] || "other"))) {
					countBlocked(pageFor(request.referrer, source), target.hostname);
					return blocked(destination);
				}
			}
		}

		const page = isPage && {
			url: target.href,
			hostname: target.hostname,
			cosmetic: blocking && settings.cosmetic,
			notices: blocking && settings.notices,
			videoAds: settings.videoAds && !isAllowed(target.hostname),
			safer: hardened(),
			// noise in what a canvas and the like read back (unique.js), with the blocking
			fingerprint: blocking,
			// "Safest", or "Safer" on a plain http page: none of the page's own scripts run
			noScripts: noSiteScripts(target),
		};
		if (page) rememberPage(page);
		failures.delete(target.href);
		if (who) keep(asked, target.href, who);
		// A form one of this worker's own pages posts on (see "enter") has that
		// page for its client, whose address Scramjet would take for a site's.
		const client = isPage && event.clientId ? await self.clients.get(event.clientId) : null;
		const ours = !!client && client.url.startsWith(prefix + "__bios/");
		await savedCookies;
		const response = await scramjet.fetch(ours ? { request: event.request, clientId: "" } : event);
		// the site set a cookie: write it down before this worker can be stopped
		if (cookiesChanged) event.waitUntil(saveCookies());
		// The site's own rule about who may frame it (the response hook read
		// it into `page`), for a page on an origin kept for frames: the pages
		// above it are other origins', which the page script can't see into.
		if (page && page.ancestors && home && !(await framersFit(page.ancestors, target)))
			return new Response("", { headers: headers() });
		if (isPage && who && response.status >= 300 && response.status < 400) {
			const to = response.headers.get("location");
			if (to) keep(hops, pageKey(new URL(to, url).href), { who, redirect: true, at: Date.now() });
		}
		// Scramjet answers a page it couldn't fetch with an error page of its
		// own, which the app's frame can't show (it lacks the header that
		// allows it): the tab stayed blank. Say what went wrong instead.
		const why = isPage && response.status === 500 ? failures.get(target.href) : undefined;
		if (why === undefined) return response;
		failures.delete(target.href);
		return interstitial({
			kind: /InvalidCertificate/.test(why) ? "cert" : "unreachable",
			host: target.hostname,
			url,
			why,
		});
	}

	// -------------------------------------------- after Scramjet rewrites HTML

	function injectHtml(html, page) {
		const { styles, scripts } = hiding([page.cosmetic && engine, page.notices && notices], {
			url: page.url,
			hostname: page.hostname,
			domain: parse(page.url).domain || page.hostname,
			getBaseRules: true,
			getInjectionRules: true,
			getExtendedRules: false,
			getRulesFromHostname: true,
			getRulesFromDOM: false,
		});

		const flags = {
			// the page script asks for the rules that match what's on the page
			cosmetic: page.cosmetic || page.notices,
			videoAds: page.videoAds,
			safer: page.safer,
			fingerprint: page.fingerprint,
			// left out when the site has no framing rule
			ancestors: page.ancestors || undefined,
			// What this origin is for, which a window of another origin can
			// check a message against (page.js, hearWindows): the site, and
			// for a frame's origin the label of the origin it sits in.
			site: page.hostname ? siteOf(page.hostname) : undefined,
			under: home?.above[0],
		};
		// On a no-scripts page (see policyFor), only scripts with the nonce run.
		const nonce = page.nonce ? ` nonce="${page.nonce}"` : "";
		let after =
			`<script${nonce}>self.__biosPage=${scriptJson(flags)};document.currentScript.remove();</script>` +
			`<script src="${location.origin}/bios/page.js"></script>`;
		if (styles)
			after += `<style>${styles.replace(/<\/style/gi, "<\\/style")}</style>`;
		if (scripts.length)
			after +=
				`<script${nonce}>` +
				scripts
					.map(
						(s) =>
							`try{(function(){${s.replace(/<\/script/gi, "<\\/script")}\n})()}catch(e){}`
					)
					.join("\n") +
				";document.currentScript&&document.currentScript.remove();</script>";

		// Right after Scramjet's own scripts at the top of <head>, the last of
		// which starts Scramjet in the page.
		const boot = html.indexOf('<script src="data:application/javascript;base64,');
		const bootEnd = boot === -1 ? -1 : html.indexOf("</script>", boot);
		if (bootEnd === -1) return html;
		const end = bootEnd + "</script>".length;
		return html.slice(0, boot) + `<script${nonce}` + html.slice(boot + "<script".length, end) + after + html.slice(end);
	}

	// Every proxied page and worker may only talk to this origin, which is
	// the proxy. Scramjet's hooks already send a page's requests there, but a
	// page can reach around them (a fresh frame has the browser's own fetch,
	// WebSocket and WebRTC). This rule is the browser's, so it holds there
	// too, and frames a page writes itself inherit it.
	// ponytail: no browser has a rule like this for WebRTC; page.js is the only block.
	// Frames may also be on the proxy's other origins: each site shown in a
	// frame has one of its own (isolation). Those origins say themselves who
	// may frame them (`framers`).
	const socket = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
	const siteOrigins = isolated ? ` ${location.protocol}//*.${isolationDomain}${port}` : "";
	const NETWORK_LOCK = `default-src 'self' ${socket} data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; frame-src 'self'${siteOrigins}`;

	// Isolation: who may show this origin's pages in a frame. The app, this
	// origin's own pages, and the origins it was made to sit in. So a page
	// elsewhere can't put a site's own origin, with the person's sign-in, in
	// a frame of its own. The browser enforces this one.
	const framers = () =>
		isolated
			? `frame-ancestors 'self' ${shellOrigin}${(home?.above || []).map((label) => " " + originFor(label)).join("")}; `
			: "";

	/**
	 * A site's own framing rule (framingRule's lists) against the origins
	 * above this one, by their labels: the origin kept for a site in a place
	 * is a hash of the site and the origin above, so a label either is the
	 * one for a site the rule names or isn't.
	 * ponytail: by site, as origins here go: a rule that names one subdomain
	 * lets its sister subdomains frame the page too.
	 */
	async function framersFit(policies, target) {
		const { above } = home;
		for (let i = 0; i < above.length; i++) {
			const keptFor = (hostname) =>
				i === above.length - 1 ? siteKey(hostname) : frameKey(above[i + 1], hostname);
			for (const sources of policies) {
				let fits = false;
				for (const source of sources) {
					const lower = source.toLowerCase();
					if (lower === "*" || /^[a-z][a-z0-9+.-]*:$/.test(lower)) fits = true;
					else if (lower === "'self'") fits = (await keptFor(target.hostname)) === above[i];
					else {
						const host = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\*\.)?([a-z0-9.-]+)/.exec(lower)?.[1];
						fits = !!host && (await keptFor(host)) === above[i];
					}
					if (fits) break;
				}
				if (!fits) return false;
			}
		}
		return true;
	}

	// The policy for a proxied response; `page` is set for the pages we inject.
	// `inert`: a document that isn't HTML (an SVG, XML). The browser runs the
	// scripts in it too, but our page script never goes in, and Scramjet
	// doesn't rewrite them: they'd run with nothing of the proxy's around
	// them (WebRTC, the browser's own location). None of its own start; eval
	// stays, which only a page reaching in can call, and Scramjet hooks such
	// a document with it.
	function policyFor(page, inert = false) {
		// "Safer": no web fonts. handle() refuses them too, but a font the
		// browser kept from an earlier visit never gets there to be refused.
		const lock = (page ? framers() : "") + (page?.safer ? `font-src 'none'; ${NETWORK_LOCK}` : NETWORK_LOCK);
		if (inert) return `script-src 'unsafe-eval' 'wasm-unsafe-eval'; ${lock}`;
		if (!page?.noScripts) return lock;
		// Its inline scripts and handlers don't run; Scramjet's own scripts
		// (its folder, and its data: one, which injectHtml gives the nonce)
		// and ours (our folder, the nonce) still do. Not 'self': the page's
		// own scripts are this origin's as well, and handle() refusing them
		// isn't enough, since one the browser kept from an earlier visit is
		// never asked for. Scramjet builds functions from strings and runs
		// WebAssembly as it starts, hence the evals; with none of the page's
		// code running, nothing else can call them.
		page.nonce = crypto.randomUUID().replace(/-/g, "");
		return `script-src ${location.origin}/scram/ ${location.origin}/bios/ 'nonce-${page.nonce}' 'unsafe-eval' 'wasm-unsafe-eval'; object-src 'none'; ${lock}`;
	}

	scramjet.addEventListener("handleResponse", (event) => {
		// Link headers ask the browser to preload or preconnect to the site's
		// servers itself, around the proxy (and Scramjet garbles their URLs).
		delete event.responseHeaders.link;
		const page = pages.get(pageKey(event.url.href));
		const html = typeof event.responseBody === "string" && /^text\/html/i.test(event.responseHeaders["content-type"] || "");
		const document = !!page || DOCUMENTS.has(event.destination);
		event.responseHeaders["content-security-policy"] = policyFor(page, document && !html);
		if (WORKERS.has(event.destination)) event.responseBody = workerPrelude(event.responseBody, decode(event.client?.url));
		// The site's length is of what it sent, and a body Scramjet and this
		// worker rewrote is longer: Safari cut a worker's code off at it.
		if (typeof event.responseBody === "string") delete event.responseHeaders["content-length"];
		if (!page) return;
		if (!html && event.status >= 200 && event.status < 300) noteDownload(event).catch(() => {});
		pages.delete(pageKey(event.url.href));
		// A page carries its protection with it (the policy above, the page
		// script's settings, its cookies). Safari shows one its site said it
		// may keep again as it was, without asking: switched to Safest, the
		// page still ran its scripts. So the browser always asks.
		event.responseHeaders["cache-control"] = "no-cache";
		delete event.responseHeaders.expires;
		// lets the page load in the app's frame across subdomains
		event.responseHeaders["cross-origin-resource-policy"] = "same-site";
		if (html) {
			page.ancestors = framingRule(event.rawResponse?.rawHeaders);
			event.responseBody = injectHtml(event.responseBody, page);
		}
	});

	loadEngine();

	return {
		/**
		 * A page's script set a cookie (document.cookie). Scramjet would save
		 * its jar for it, and right after this worker started that is a jar
		 * without the cookies saved before: scramjet-sw.js hands these here.
		 * @param {ExtendableMessageEvent} event
		 */
		pageCookie(event) {
			const { cookie, url } = event.data;
			event.waitUntil(
				savedCookies.then(() => {
					try {
						scramjet.cookieStore.setCookies([String(cookie)], new URL(url));
					} catch {
						return;
					}
					return saveCookies();
				})
			);
		},
		handle(event) {
			// A check that broke must not wave the request through unchecked.
			return handle(event).catch((err) => {
				console.error("bios:", err);
				return event.request.mode === "navigate"
					? new Response("Badger couldn't check this page, so it wasn't loaded. Try reloading.", {
							status: 500,
							headers: headers("text/plain"),
						})
					: Response.error();
			});
		},
	};
}

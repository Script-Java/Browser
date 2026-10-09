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
import { frameKey, siteOf, siteKey, torKey } from "../client/sitekey.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { PREFIX, decodeUrl, encodeUrl } from "../codec.js";

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
	// A Tor tab's site (src/tor.js): its connections go through Tor, the
	// sites it leads to open in Tor too, and the server never connects to a
	// site for it (no certificate or CNAME lookups, which a site could see).
	const viaTor = isolated && /^[tg]/.test(ownLabel);
	const keyOf = (hostname) => (viaTor ? torKey(hostname) : siteKey(hostname));
	// A frame from another site inside a page runs on an origin of its own
	// (f<key>, g<key> in a Tor tab; see sitekey.js frameKey), so the browser
	// itself keeps it and the page around it apart. This origin's worker
	// learns which site's page the frame is in from the address that opens
	// it, checked against the origin's own label, and keeps it.
	const inFrame = isolated && /^[fg]/.test(ownLabel);
	const TOP_KEY = location.origin + API + "top";
	let topSite = null;
	const topLoaded = inFrame
		? caches
				.open("bios-frame")
				.then((cache) => cache.match(TOP_KEY))
				.then((res) => res?.text())
				.then((text) => (topSite ||= /^[a-z0-9.-]{1,253}$/.test(text || "") ? text : null))
				.catch(() => {})
		: null;
	function keepTop(site) {
		topSite = site;
		caches
			.open("bios-frame")
			.then((cache) => cache.put(TOP_KEY, new Response(site)))
			.catch(() => {});
	}
	// The site this origin's tabs show, once a page of it was served (or
	// from the page asking): the page a frame of another site is in.
	let ownSite = null;
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

	// Who may show this origin's pages in a frame (every window above must
	// be one). A tab's site: its own pages and the app (no other site may
	// frame it, signed in, to trick taps). A frame's own origin: the site
	// origins of the pages it's in, inside the app.
	const siteOrigins = isolated ? `${location.protocol}//*.${isolationDomain}${port}` : "";
	const FRAMED_BY = !isolated
		? "frame-ancestors 'self'"
		: inFrame
			? `frame-ancestors ${shellOrigin} ${siteOrigins}`
			: `frame-ancestors 'self' ${shellOrigin}`;

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
	const rawFetch = scramjet.client.fetch.bind(scramjet.client);
	// The first request on a fresh connection goes alone: the transport sets
	// itself up on it, and a second one arriving meanwhile (two frames of a
	// site starting together) could be lost. The rest wait for it, at most
	// ten seconds.
	let warmedUp = false;
	let warming = null;
	async function transportFetch(url, init) {
		if (warmedUp) return rawFetch(url, init);
		if (warming) {
			await Promise.race([warming.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 10_000))]);
			return rawFetch(url, init);
		}
		warming = rawFetch(url, init);
		try {
			return await warming;
		} finally {
			warmedUp = true;
		}
	}
	scramjet.client.fetch = async (url, init) => {
		try {
			try {
				return await transportFetch(url, init);
			} catch (err) {
				if (!DEAD_TRANSPORT.test(String(err?.message || err))) throw err;
				await reconnect();
				// a new connection: set up afresh, one request first
				warmedUp = false;
				warming = null;
				return await transportFetch(url, init);
			}
		} catch (err) {
			// ponytail: forgets everything at 50; a page that failed just then gets Scramjet's own error page
			if (failures.size > 50) failures.clear();
			failures.set(String(url), String(err?.message || err));
			throw err;
		}
	};

	// Navigations the app itself starts in this origin (an address typed, a
	// bookmark, back, reload, or a tab a page opened), announced by the
	// shell through this site's anchor frame just before: proxied URL ->
	// { from: the page that opened the tab, or null for the person }. Any
	// other navigation without a referrer is taken to be another site's.
	const announced = new Map();
	self.addEventListener("message", (event) => {
		if (event.origin !== location.origin || event.data?.bios !== "typed") return;
		if (announced.size > 100) announced.clear();
		let from = null;
		try {
			if (event.data.from) from = new URL(event.data.from);
		} catch {
			// the person, then
		}
		if (from && from.protocol !== "http:" && from.protocol !== "https:") from = null;
		announced.set(pageKey(String(event.data.url || "")), { from, at: Date.now() });
		event.ports[0]?.postMessage("ok");
	});

	// "Clear all site data" deleted Scramjet's cookie database; forget the
	// copy this worker keeps in memory too.
	self.addEventListener("message", (event) => {
		if (event.origin !== location.origin) return;
		if (event.data?.bios !== "wipe") return;
		scramjet.cookieStore.load("{}");
		// New Identity: forget the warnings the person clicked through too
		for (const set of [bypassed, plainHttp, allowOnce, inlineOnce]) set.clear();
	});

	let engine = null;
	let engineLoad = null;
	let settings = null;
	let settingsAt = 0;
	let settingsLoad = null;
	const bypassed = new Set(); // hosts the user chose to open despite a warning
	const plainHttp = new Set(); // sites (example.com) the user chose to open over http
	const httpsWorks = new Set(); // hosts that answered over https
	const allowOnce = new Set(); // proxied URLs to load once without ad blocking
	const inlineOnce = new Set(); // proxied URLs to load in this origin once
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

	// Brave's navigation-tracking rules (src/privacyrules.js): addresses that
	// only bounce a visitor through a tracker, and query parameters that follow
	// a person between sites. Patterns arrive as regular expressions.
	const PRIVACY_URL = ENGINE_URL.replace("engine.bin", "privacy.json");
	let privacyRules = { debounce: [], params: [] };
	let privacyLoad = null;
	const compile = (list) => (list || []).map((source) => new RegExp(source, "i"));
	function loadPrivacyRules() {
		privacyLoad ||= fetch(PRIVACY_URL, { credentials: "include", cache: "no-cache" })
			.then(async (res) => {
				if (!res.ok) throw new Error(`privacy rules HTTP ${res.status}`);
				const rules = await res.json();
				privacyRules = {
					debounce: (rules.debounce || []).map((rule) => ({
						...rule,
						match: compile(rule.match),
						exclude: compile(rule.exclude),
					})),
					params: (rules.params || []).map((rule) => ({
						match: rule.match && compile(rule.match),
						exclude: compile(rule.exclude),
						params: new Set(rule.params),
					})),
				};
				setTimeout(() => (privacyLoad = null), ENGINE_RECHECK_MS);
			})
			.catch((err) => {
				console.warn("bios: navigation-tracking rules unavailable:", err);
				setTimeout(() => (privacyLoad = null), 30_000);
			});
		return privacyLoad;
	}

	function waitForPrivacyRules() {
		if (privacyRules.debounce.length || privacyRules.params.length) return;
		return Promise.race([loadPrivacyRules(), new Promise((resolve) => setTimeout(resolve, ENGINE_WAIT_MS))]);
	}

	// Switched on a moment ago, or this worker just started: the first page waits for them.
	function waitForNotices() {
		if (!settings?.notices || notices) return;
		return Promise.race([
			loadNotices(),
			new Promise((resolve) => setTimeout(resolve, ENGINE_WAIT_MS)),
		]);
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

	// Scramjet rewrites a page's addresses (href, src, ...) to the proxy's and
	// keeps each original in a scramjet-attr-<name> attribute. A hiding rule
	// that matches by address ("a[href*=doubleclick]") looks there instead.
	const PROXIED_ATTRIBUTE = /\[\s*(href|src|action|data|poster|formaction)(\s*[~|^$*]?=)/gi;
	const realAttributes = (css) => css.replace(PROXIED_ATTRIBUTE, "[scramjet-attr-$1$2");

	// The rules that hide parts of a page, and its scriptlets, from each of `lists`.
	function hiding(lists, options) {
		let styles = "";
		const scripts = [];
		for (const list of lists.filter(Boolean)) {
			const found = list.getCosmeticsFilters(options);
			styles += found.styles || "";
			scripts.push(...(found.scripts || []));
		}
		return { styles: realAttributes(styles), scripts };
	}

	// -------------------------------------------------------------- settings

	function applySettings(next) {
		settings = { ...DEFAULT_SETTINGS, ...(next || {}) };
		settingsAt = Date.now();
		if (settings.notices) loadNotices();
		// This origin is one site's (isolation): is it one with scripts switched off?
		// a frame's: the page it's in, whose tab it belongs to
		if (inFrame) tabScriptsOff = !!topSite && settings.noScripts.includes(siteOf(topSite));
		else if (isolated)
			Promise.all(settings.noScripts.map((site) => keyOf(site))).then(
				(keys) => (tabScriptsOff = keys.includes(ownLabel))
			);
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
	async function checkNavigation(hostname) {
		try {
			const res = await shellFetch("/api/nav", {
				cache: "no-store",
				headers: { "x-bios-host": hostname },
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			applySettings(data.settings);
			return data.threat;
		} catch {
			await getSettings();
			return null;
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
			"content-security-policy": FRAMED_BY,
		};
		if (self.crossOriginIsolated)
			h["cross-origin-embedder-policy"] = "require-corp";
		return h;
	}

	// A 307, which keeps a form POST intact. Not Response.redirect(): Safari
	// refuses a redirect into the app's frame unless it carries these headers.
	const redirect = (to) => new Response(null, { status: 307, headers: { ...headers(), location: to } });

	// Runs in a page we generate. Works out where it is: "top" (escaped the
	// app), "tab" (the app's page frame) or "sub" (a frame inside a page).
	// (A frame's own origin is never a tab's: there, a cross-origin parent is
	// the page around the frame.)
	const WHERE = inFrame
		? `function where(){return parent===self?"top":"sub"}`
		: `function where(){try{if(parent===self)return"top";if(parent.__biosShell)return"tab";parent.location.href;return"sub"}catch(e){return"tab"}}`;

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
		onion: {
			title: "This is an onion site",
			text: "Onion sites can only be reached through Tor. Open it in a Tor tab: its connections go through Tor, and nothing from this tab comes along.",
			go: "Open in a Tor tab",
			action: "tor",
		},
		// The site's certificate authority has revoked its certificate (the
		// server checked its list, certs.js): whoever presents it may have
		// stolen it. No way past, as in browsers.
		revoked: {
			danger: true,
			title: "This connection isn't private",
			text: "The authority that issued this site's security certificate has revoked it, so someone may be using a stolen certificate to pretend to be the site. It wasn't opened.",
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
		[/./, "Its security certificate isn't valid."],
	];

	// `why`: what the transport said when the page couldn't be fetched.
	function interstitial({ kind, host, url, why }) {
		const { danger, title, go, action } = WARNINGS[kind];
		let { text } = WARNINGS[kind];
		if (kind === "cert") text = CERT_PROBLEMS.find(([problem]) => problem.test(why))[1] + " " + text;
		const proceed = action === "retry" || action === "tor" ? url : action ? goUrl(action, url) : "";
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
if (go) go.onclick = ${kind === "onion" ? `function () { top.postMessage({ bios: "open-tor", url: ${scriptJson(url)} }, "*"); }` : `function () { location.replace(${scriptJson(proceed)}); }`};
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
			sub: plan.sub || (plan.inline ? goUrl("inline", plan.inline) : plan.url),
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
		return new Response(
			`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{background:#fff}</style>${boot}</head><body>${forms}<script>
${WHERE}
var targets = ${scriptJson(targets)};
// the shell opens the anchor of this origin, or of another site's origin a
// form is about to be posted to (without its service worker there yet, the
// server would get the post, and its fields would be lost)
// (the shell is the top: the tab's parent, or above the page a frame is in)
function needAnchor(origin) {
	return new Promise(function (resolve) {
		var timer = setTimeout(function () { origin ? resolve() : setupTransport().then(resolve, resolve); }, 8000);
		addEventListener("message", function (e) {
			if (e.source !== top || !e.data || e.data.bios !== "anchor-ready") return;
			clearTimeout(timer);
			resolve();
		});
		top.postMessage({ bios: "need-anchor", origin: origin || undefined }, "*");
	});
}
function go(key) {
	var form = document.getElementById("f-" + key);
	if (form) form.submit();
	else location.replace(targets[key]);
}
(async function () {
	var at = where();
	if (${plan.boot ? "true" : "false"}) {
		try {
			// In the app's frame, have the shell open this site's anchor
			// (it keeps the proxy connection alive); otherwise connect here.
			if (at === "tab") await needAnchor();
			else await setupTransport();
		} catch (e) { document.body.textContent = String(e && e.message || e); return; }
	}
	if (at === "top" && targets.shell) return location.replace(targets.shell);
	if (at !== "sub" && targets.tab) {
		if (at === "tab" && document.getElementById("f-tab")) await needAnchor(new URL(targets.tab).origin);
		return go("tab");
	}
	// a frame of another site goes to an origin of its own: its anchor first
	if (at === "sub" && targets.sub && new URL(targets.sub, location.href).origin !== location.origin && top !== self)
		await needAnchor(new URL(targets.sub, location.href).origin);
	go("sub");
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

	// --------------------------------------------------------------- downloads

	// A file the site sends to be saved (an attachment, or a type no page can
	// show) goes to the app's download list instead of the browser's own
	// handling, which in a home-screen app is a sheet that leaves the app. The
	// file streams into this origin's cache while a small page in the tab
	// shows how far along it is; that page then hands it to the app.
	const DOWNLOAD_CACHE = "bios-downloads";
	const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
	const downloads = new Map(); // id -> { name, type, total, received, done, error }
	const SHOWABLE =
		/^(text\/|image\/|video\/|audio\/|font\/|application\/(json|xml|javascript|pdf|xhtml\+xml|ld\+json|manifest\+json|x-javascript|ecmascript|rss\+xml|atom\+xml)\b)/i;

	function headerOf(raw, name) {
		for (const [key, value] of Object.entries(raw || {})) if (key.toLowerCase() === name) return [].concat(value).join(", ");
		return "";
	}

	// What the file is to be called: the site's name for it, else the address's last part.
	function fileName(disposition, url) {
		let name = "";
		const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?'[^']*'([^;]+)/i.exec(disposition);
		const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(disposition);
		try {
			if (star) name = decodeURIComponent(star[1].trim());
		} catch {
			// a name that isn't valid percent-encoding: try the plain one
		}
		if (!name && plain) name = (plain[2] ?? plain[1]).trim();
		if (!name) name = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "") || url.hostname;
		// no paths, nothing a file system would refuse
		return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").slice(0, 200) || "download";
	}

	function downloadOf(event) {
		if (event.destination !== "document" && event.destination !== "iframe") return null;
		if (event.status < 200 || event.status >= 300 || !(event.responseBody instanceof ReadableStream)) return null;
		const raw = event.rawResponse?.rawHeaders;
		const disposition = headerOf(raw, "content-disposition");
		const type = (headerOf(raw, "content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
		const attachment = /^\s*attachment/i.test(disposition);
		if (!attachment && (SHOWABLE.test(type) || /html/.test(type))) return null;
		return {
			name: fileName(disposition, event.url),
			type: type || "application/octet-stream",
			total: Number(headerOf(raw, "content-length")) || 0,
		};
	}

	function startDownload(event, info) {
		// before the caller puts the progress page in its place
		const body = event.responseBody;
		const id = crypto.randomUUID();
		const entry = { ...info, received: 0, done: false, error: null };
		if (downloads.size > 50) for (const [key, old] of downloads) if (old.done || old.error) downloads.delete(key);
		downloads.set(id, entry);
		const counting = new TransformStream({
			transform(chunk, controller) {
				entry.received += chunk.byteLength;
				if (entry.received > MAX_DOWNLOAD_BYTES) controller.error(new Error("The file is larger than 200 MB."));
				else controller.enqueue(chunk);
			},
		});
		caches
			.open(DOWNLOAD_CACHE)
			.then((cache) =>
				cache.put(
					location.origin + API + "file?id=" + id,
					new Response(body.pipeThrough(counting), { headers: { "content-type": entry.type } })
				)
			)
			.then(
				() => (entry.done = true),
				(err) => (entry.error = String(err?.message || err))
			);
		return id;
	}

	// The tab's page while a file comes down. It polls this worker (which keeps
	// it running), then sends the file up to the app, and goes back.
	function downloadPage(id, info) {
		return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(info.name)}</title>
<style>
html{background:#faf9f7;color:#1f1e1d;font:16px/1.45 -apple-system,system-ui,sans-serif}
body{margin:0;padding:48px 24px;max-width:560px}h1{font-size:20px;margin:0 0 8px;word-break:break-all}
p{margin:0 0 14px;color:#6f6c68}progress{width:100%;height:8px}
button{font:inherit;padding:10px 16px;border-radius:10px;border:1px solid #e2e0dc;background:#fff;margin-top:8px}
</style></head><body>
<h1 id="name">${htmlEscape(info.name)}</h1>
<p id="status">Downloading…</p>
<progress id="bar"></progress>
<p><button id="back" type="button">Back to the page</button></p>
<script>
var fetchNow = window.fetch.bind(window), id = ${scriptJson(id)}, api = ${scriptJson(location.origin + API)};
var shown = function (n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB"; };
document.getElementById("back").onclick = function () { history.length > 1 ? history.back() : location.replace("about:blank"); };
function fail(why) { document.getElementById("status").textContent = "The download failed. " + (why || ""); document.getElementById("bar").remove(); }
function poll() {
	fetchNow(api + "download?id=" + id).then(function (r) { return r.json(); }).then(function (s) {
		var bar = document.getElementById("bar");
		if (s.total) { bar.max = s.total; bar.value = s.received; }
		document.getElementById("status").textContent = "Downloading… " + shown(s.received) + (s.total ? " of " + shown(s.total) : "");
		if (s.error) return fail(s.error);
		if (!s.done) return setTimeout(poll, 400);
		fetchNow(api + "file?id=" + id).then(function (r) { return r.blob(); }).then(function (blob) {
			top.postMessage({ bios: "download", name: s.name, type: s.type, blob: blob }, "*");
			fetchNow(api + "download-done?id=" + id);
			document.getElementById("status").textContent = "Saved to Downloads (" + shown(blob.size) + ").";
			bar.remove();
			if (history.length > 1) setTimeout(function () { history.back(); }, 600);
		}, function () { fail(); });
	}, function () { setTimeout(poll, 1000); });
}
poll();
</script></body></html>`;
	}

	// ------------------------------------------------------------ internal API

	async function api(request, path) {
		// /scramjet/__bios/go?do=<inline|allow|bypass|http>&t=<token>&u=<proxied URL>:
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
			if (action === "inline") inlineOnce.add(to);
			else if (action === "allow") allowOnce.add(to);
			else if (action === "bypass") bypassed.add(target.hostname.toLowerCase());
			else if (action === "http") plainHttp.add(siteOf(target.hostname.toLowerCase()));
			return redirect(to);
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
		// The way into a frame's own origin (see inFrame): which site's page
		// it's in comes along, and must be the one this origin was made for.
		if (path === "frame") {
			const params = new URL(request.url).searchParams;
			const top = String(params.get("top") || "").toLowerCase();
			const to = location.origin + String(params.get("u") || "");
			const target = decode(to);
			if (!inFrame || !target || !/^[a-z0-9.-]{1,253}$/.test(top)) return new Response(null, { status: 400 });
			if ((await frameKey(top, target.hostname, viaTor)) !== ownLabel) return new Response(null, { status: 403 });
			keepTop(top);
			if (request.method !== "GET") return redirect(to);
			// A frame's origin has no anchor frame to hold its proxy connection
			// (a tab's site has one): this page connects it, then goes on,
			// without a referrer: this address isn't a site's, and Scramjet
			// would read it as one. (A frame's request is another site's anyway.)
			return new Response(
				`<!doctype html><meta charset="utf-8"><script src="/baremux/index.js"></script><script src="/register-sw.js"></script>` +
					// (at most a few seconds: two frames of one origin setting up at
					// once can leave one waiting, and the connection is the origin's)
					`<script>Promise.race([setupTransport(), new Promise(function (r) { setTimeout(r, 4000); })]).catch(function () {}).then(function () { location.replace(${scriptJson(to)}); });</script>`,
				{ headers: { ...headers(), "referrer-policy": "no-referrer" } }
			);
		}
		// A download's progress, its file, and its end (see startDownload).
		if (path === "download" || path === "file" || path === "download-done") {
			const id = new URL(request.url).searchParams.get("id") || "";
			const entry = downloads.get(id);
			if (path === "download")
				return entry
					? json({ name: entry.name, type: entry.type, total: entry.total, received: entry.received, done: entry.done, error: entry.error })
					: json({ error: "This download is no longer here." });
			const cache = await caches.open(DOWNLOAD_CACHE);
			const key = location.origin + API + "file?id=" + id;
			if (path === "file") return (entry?.done && (await cache.match(key))) || new Response(null, { status: 404 });
			await cache.delete(key);
			downloads.delete(id);
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
	const workerLevels = new Map(); // site URL of a worker's script -> its fingerprinting protection
	function keep(map, key, value) {
		if (map.size > 200) map.clear();
		map.set(key, value);
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
		// the app's own navigation: the person, or the page that opened the tab
		const mine = announced.get(pageKey(url));
		if (mine && !ref) {
			announced.delete(pageKey(url));
			if (Date.now() - mine.at < 30_000) {
				if (!mine.from) return who;
				return { ...who, from: mine.from, quiet: false, brief: true, site: relation(mine.from, target) };
			}
		}
		// a frame's own origin only ever holds frames
		if (inFrame) who.framed = true;
		if (ref) who.site = relation(ref, target);
		else if (fromAnotherSite(request.referrer)) who.site = "cross-site";
		// Isolation: a page that got around the proxy's hooks can send the tab
		// to this origin without a referrer. Unless the app said it was its
		// own, nobody we know asked: another site's request.
		else if (isolated && !request.referrer) who.site = "cross-site";
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
	const setCookies = scramjet.cookieStore.setCookies.bind(scramjet.cookieStore);
	scramjet.cookieStore.setCookies = (cookies, url) =>
		setCookies(
			cookies.map((cookie) => (/;\s*samesite\s*=/i.test(cookie) ? cookie : cookie + "; SameSite=None")),
			url
		);

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

	// Brave's rules that apply to `target`: every address's, and its site's.
	const appliesTo = (rule, href) =>
		(!rule.match || rule.match.some((re) => re.test(href))) && !rule.exclude.some((re) => re.test(href));

	// `target` without them, or null when it has none. The rest of the query
	// is left exactly as written (some sites sign theirs).
	function withoutTracking(target) {
		if (!target.search) return null;
		const extra = privacyRules.params.filter((rule) => appliesTo(rule, target.href));
		const parts = target.search.slice(1).split("&");
		const kept = parts.filter((part) => {
			let name = part.split("=")[0];
			try {
				name = decodeURIComponent(name.replace(/\+/g, " "));
			} catch {
				// not valid percent-encoding: compare it as written
			}
			name = name.toLowerCase();
			return !TRACKING_PARAMS.has(name) && !name.startsWith("utm_") && !extra.some((rule) => rule.params.has(name));
		});
		if (kept.length === parts.length) return null;
		const clean = new URL(target.href);
		clean.search = kept.join("&");
		return clean;
	}

	// Where a bounce-tracking address leads (Brave's debounce rules), or null.
	// Only to another site: a hop within one site may be its own sign-in.
	function bounceTarget(target) {
		let at = target;
		for (let hops = 0; hops < 5; hops++) {
			const next = privacyRules.debounce
				.filter((rule) => appliesTo(rule, at.href))
				.map((rule) => leadsTo(rule, at))
				.find((url) => url && siteOf(url.hostname) !== siteOf(at.hostname));
			if (!next) break;
			at = next;
		}
		return at === target ? null : at;
	}

	function leadsTo(rule, from) {
		let value = null;
		try {
			if (rule.action === "redirect" || rule.action === "base64,redirect") {
				value = from.searchParams.get(rule.param);
				if (value && rule.action === "base64,redirect")
					value = atob(value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, ""));
			} else {
				const found = new RegExp(rule.param).exec(from.pathname);
				if (!found) return null;
				const groups = found.slice(1).map((part) => decodeURIComponent(part || ""));
				value =
					rule.action === "regex-path-template"
						? rule.template.replace(/\$(\d)/g, (_, n) => groups[n - 1] || "")
						: groups.join("");
			}
			if (!value) return null;
			value = value.trim();
			if (rule.scheme && !/^https?:\/\//i.test(value)) value = `${rule.scheme}://${value.replace(/^\/+/, "")}`;
			const url = new URL(value);
			return url.protocol === "http:" || url.protocol === "https:" ? url : null;
		} catch {
			return null;
		}
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

	// Whether a site's framing rule (framingRule) lets a page of `site` frame
	// it. A frame's own origin is always another site's than the page's, so
	// 'self' never matches; a source matches by its site.
	function framingAllows(policies, site) {
		if (!site) return false;
		return policies.every((sources) =>
			sources.some((source) => {
				source = source.toLowerCase();
				if (source === "*" || /^https?:$/.test(source)) return true;
				if (source.startsWith("'")) return false;
				const host = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\*\.)?([a-z0-9.-]+)/.exec(source)?.[1];
				return !!host && siteOf(host) === siteOf(site);
			})
		);
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

	// Revocation: the server checks the site's certificate against its
	// authority's list (src/certs.js), once per host every half hour here.
	const certChecks = new Map(); // host[:port] -> Promise<certificate | null>
	function revocation(target) {
		if (target.protocol !== "https:" || viaTor) return null;
		let check = certChecks.get(target.host);
		if (!check) {
			if (certChecks.size > 300) certChecks.clear();
			check = shellFetch("/api/cert", {
				cache: "no-store",
				headers: { "x-bios-host": target.hostname, "x-bios-port": target.port || "443" },
			})
				.then((res) => (res.ok ? res.json() : null))
				.catch(() => null);
			certChecks.set(target.host, check);
			setTimeout(() => certChecks.delete(target.host), 30 * 60_000);
		}
		return check;
	}

	// CNAME uncloaking (src/cname.js): what one of the page's site's own
	// subdomains points to, asked once per name while this worker runs.
	// Only those: a name of another site is checked against the lists as it is.
	const cnames = new Map(); // host -> Promise<string[]>
	function canonical(host) {
		let names = cnames.get(host);
		if (!names) {
			if (cnames.size > 500) cnames.clear();
			names = shellFetch("/api/cname", { cache: "no-store", headers: { "x-bios-host": host } })
				.then((res) => (res.ok ? res.json() : { names: [] }))
				.then((answer) => (Array.isArray(answer.names) ? answer.names : []))
				.catch(() => []);
			cnames.set(host, names);
		}
		// a slow answer lets the request through rather than stall the page
		return Promise.race([names, new Promise((resolve) => setTimeout(resolve, 1500, []))]);
	}

	async function cloakedTracker(target, source, destination) {
		if (viaTor || !source || target.hostname === source.hostname) return false;
		if (siteOf(target.hostname) !== siteOf(source.hostname)) return false;
		for (const name of await canonical(target.hostname)) {
			const uncloaked = new URL(target.href);
			uncloaked.hostname = name;
			if (listed(uncloaked, source, REQUEST_TYPES[destination] || "other").match) return true;
		}
		return false;
	}

	// The tab's page a request belongs to: a frame inside a page answers for
	// the page around it.
	const pageFor = (referrer, source) => framed.get(pageKey(referrer || "")) || source?.href;

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
	async function httpsOnly(request, target, isPage, url) {
		if (target.protocol !== "http:") return null;
		const host = target.hostname.toLowerCase();
		// an onion site's connection is encrypted end to end by Tor itself
		if (viaTor && host.endsWith(".onion")) return null;
		if (plainHttp.has(siteOf(host))) return null;
		// a page load gets fresh settings, so the switch applies at once
		if (isPage) settingsAt = 0;
		await getSettings();
		if (!settings.httpsOnly) return null;
		if (!isPage) {
			const page = decode(request.referrer);
			if (page && plainHttp.has(siteOf(page.hostname.toLowerCase()))) return null;
		}
		if (isPage && !(await speaksHttps(host)))
			return interstitial({ kind: "http", host: target.hostname, url });
		const secure = new URL(target.href);
		secure.protocol = "https:";
		return redirect(location.origin + encodeUrl(secure.href));
	}

	// "Safer" level: no web fonts (a fingerprinting and font-parser attack
	// surface), and no scripts from pages that came over plain http.
	// "Safest": the same, and no site's scripts on any page.
	// Also for one site at a time, from the shield menu: that site's pages,
	// and with isolation everything in its tabs (the frames of other sites
	// inside its pages run in its origin, so this worker serves them too).
	const hardened = () => settings.level === "safer" || settings.level === "safest";
	let tabScriptsOff = false;
	const noSiteScripts = (url) =>
		settings.level === "safest" ||
		(settings.level === "safer" && url?.protocol === "http:") ||
		tabScriptsOff ||
		(!!url && settings.noScripts.includes(siteOf(url.hostname)));

	const SCRIPTED = new Set(["script", "worker", "sharedworker", "serviceworker"]);

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
		const noScripts = noSiteScripts(decode(event.request.referrer));
		if (noScripts && SCRIPTED.has(destination)) return blocked(destination);
		const res = await scramjet.fetch(event);
		const page = isPage && { cosmetic: false, videoAds: false, safer: hardened(), farble: true, noScripts };
		const resHeaders = new Headers(res.headers);
		resHeaders.set("content-security-policy", policyFor(page));
		const html = page && /^text\/html/i.test(resHeaders.get("content-type") || "");
		// a worker made from a blob: (a favourite of fingerprinting scripts) gets
		// the protection a worker from an address gets
		if (destination === "worker" || destination === "sharedworker") {
			const shim = `${location.origin}/bios/worker${hardened() ? "-safer" : ""}.js`;
			const body = await res.text();
			return new Response((body.startsWith("import ") ? `import "${shim}";\n` : `importScripts("${shim}");\n`) + body, {
				status: res.status,
				statusText: res.statusText,
				headers: resHeaders,
			});
		}
		return new Response(html ? injectHtml(await res.text(), page) : res.body, {
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

		// an onion site only exists inside Tor: offer to open it in a Tor tab
		if (!viaTor && target.hostname.toLowerCase().endsWith(".onion")) {
			if (isPage) return interstitial({ kind: "onion", host: target.hostname, url: target.href });
			return Response.error();
		}

		const upgraded = await httpsOnly(request, target, isPage, url);
		if (upgraded) return upgraded;

		const who = await whoAsks(event, url, target, isPage);

		// A bounce-tracking address (an affiliate or mail-click link, an AMP
		// cache) goes straight to where it leads, skipping the tracker.
		if (isPage && safe(request.method)) {
			await waitForPrivacyRules();
			const leads = bounceTarget(target);
			// fresh settings, so the switch applies to the very next page
			if (leads) settingsAt = 0;
			if (leads && (await getSettings()).ads && !isAllowed(target.hostname) && !isAllowed(leads.hostname)) {
				countBlocked();
				return redirect(location.origin + encodeUrl(leads.href));
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
				return redirect(location.origin + encodeUrl(clean.href));
			}
		}

		const enginePromise = waitForEngine();

		if (isPage) {
			// Isolation: every site runs on its own subdomain. A page that
			// belongs to another site goes there, unless it's a frame inside
			// a page (those stay with the page, like Safari's partitioning).
			if (isolated && !inlineOnce.delete(url)) {
				if (inFrame) await topLoaded;
				const key = await keyOf(target.hostname);
				// the page this frame is in: this origin's own site, or the
				// one a frame's origin was opened for
				const embedder = inFrame ? topSite : ownSite || (decode(request.referrer) && siteOf(decode(request.referrer).hostname));
				const frameLabel = embedder ? await frameKey(embedder, target.hostname, viaTor) : null;
				const here = inFrame ? frameLabel === ownLabel : key === ownLabel;
				if (!inFrame && here) ownSite = siteOf(target.hostname);
				if (!here) {
					// A frame inside a page goes to an origin of its own (see
					// inFrame); one whose page can't be told stays here, as before.
					const sub =
						frameLabel && (!inFrame || topSite)
							? `${originFor(frameLabel)}${API}frame?top=${encodeURIComponent(embedder)}&u=${encodeURIComponent(url.slice(location.origin.length))}`
							: null;
					const page = await trampoline(request, {
						tab: originFor(key) + url.slice(location.origin.length),
						sub,
						inline: url,
						shell: shellOrigin + "/#" + encodeURIComponent(target.href),
					});
					// A frame inside a page carries on with the page as its
					// asker. Its site isn't the page's, so unless a page of that
					// site asked, the request is another site's.
					if (page && who)
						keep(hops, pageKey(url), {
							who: { ...who, framed: true, site: who.from ? who.site : "cross-site" },
							at: Date.now(),
						});
					if (page) return page;
				} else if (!(await hasProxyClient())) {
					// First page of this site since the app opened: start the
					// proxy connection for this origin, then load the page.
					const page = await trampoline(request, { boot: true, url });
					if (page && who) keep(hops, pageKey(url), { who, at: Date.now() });
					if (page) return page;
				}
			}

			const certificate = revocation(target);
			const threat = await checkNavigation(target.hostname);
			if (
				threat &&
				settings.threats &&
				!bypassed.has(target.hostname.toLowerCase())
			)
				return interstitial({ kind: threat, host: target.hostname, url });
			// a slow answer (a big list the server is still fetching) lets the
			// page load; the verdict is kept for the next one
			const cert = await Promise.race([certificate, new Promise((resolve) => setTimeout(resolve, 2500, null))]);
			if (cert?.revoked === true) return interstitial({ kind: "revoked", host: target.hostname, url });
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
				// A tracker hiding behind one of the site's own subdomains
				// (a CNAME): the server says what the name points to.
				if (!match && !isPage && (await cloakedTracker(target, source, destination))) {
					countBlocked(pageFor(request.referrer, source), target.hostname);
					return blocked(destination);
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
			}
		}

		if (isPage) {
			rememberPage({
				url: target.href,
				hostname: target.hostname,
				cosmetic: blocking && settings.cosmetic,
				notices: blocking && settings.notices,
				consent: blocking && settings.consent,
				// fingerprinting protection, off with the rest for a site the person switched it off for
				farble: !isAllowed(target.hostname),
				videoAds: settings.videoAds && !isAllowed(target.hostname),
				safer: hardened(),
				// "Safest", or "Safer" on a plain http page: none of the page's own scripts run
				noScripts: noSiteScripts(target),
			});
		}
		failures.delete(target.href);
		if (who) keep(asked, target.href, who);
		// a worker gets its page's fingerprinting protection (client/worker.js)
		if (destination === "worker" || destination === "sharedworker")
			keep(workerLevels, target.href, hardened() ? "safer" : isAllowed(source?.hostname) ? null : "standard");
		// A navigation gets no page that started it: Scramjet would read that
		// page's address as a site's, and one of ours (a frame's way in,
		// __bios/frame) isn't one. What sites are told is worked out above.
		const response = await scramjet.fetch(isPage ? { request, clientId: "no page" } : event);
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
			farble: page.farble,
			// left out when the site has no framing rule
			ancestors: page.ancestors || undefined,
		};
		// On a no-scripts page (see policyFor), only scripts with the nonce run.
		const nonce = page.nonce ? ` nonce="${page.nonce}"` : "";
		let after =
			`<script${nonce}>self.__biosPage=${scriptJson(flags)};document.currentScript.remove();</script>` +
			`<script src="${location.origin}/bios/page.js"></script>`;
		// cookie notices answered "reject" (client/consent.js), on the site's own pages
		if (page.consent) after += `<script src="${location.origin}/bios/consent.js"></script>`;
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
	const socket = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
	// (Frames: this origin, or another site origin of the app: a frame from
	// another site gets one of its own, see inFrame.)
	const NETWORK_LOCK = `default-src 'self' ${socket} data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; frame-src 'self' ${siteOrigins}; ${FRAMED_BY}`;

	// The policy for a proxied response; `page` is set for the pages we inject.
	function policyFor(page) {
		// "Safer": no web fonts. handle() refuses them too, but a font the
		// browser kept from an earlier visit never gets there to be refused.
		const lock = page?.safer ? `font-src 'none'; ${NETWORK_LOCK}` : NETWORK_LOCK;
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
		// A worker's script: our protection loads first, before Scramjet's
		// own code (which the rewritten script starts with).
		const level = workerLevels.get(event.url.href);
		if (level !== undefined && typeof event.responseBody === "string") {
			workerLevels.delete(event.url.href);
			const shim = `${location.origin}/bios/worker${level === "safer" ? "-safer" : ""}.js`;
			if (level)
				event.responseBody = (event.responseBody.startsWith("import ") ? `import "${shim}";\n` : `importScripts("${shim}");\n`) + event.responseBody;
		}
		const page = pages.get(pageKey(event.url.href));
		// a file to save: the download list, not the browser's sheet
		const file = page && downloadOf(event);
		if (file) {
			pages.delete(pageKey(event.url.href));
			event.responseBody = downloadPage(startDownload(event, file), file);
			event.responseHeaders = { ...headers(), "content-security-policy": NETWORK_LOCK };
			return;
		}
		event.responseHeaders["content-security-policy"] = policyFor(page);
		if (!page) return;
		pages.delete(pageKey(event.url.href));
		// A page carries its protection with it (the policy above, the page
		// script's settings, its cookies). Safari shows one its site said it
		// may keep again as it was, without asking: switched to Safest, the
		// page still ran its scripts. So the browser always asks.
		event.responseHeaders["cache-control"] = "no-cache";
		delete event.responseHeaders.expires;
		// lets the page load in the app's frame across subdomains
		event.responseHeaders["cross-origin-resource-policy"] = "same-site";
		const type = event.responseHeaders["content-type"] || "";
		if (typeof event.responseBody === "string" && /^text\/html/i.test(type)) {
			page.ancestors = framingRule(event.rawResponse?.rawHeaders);
			// A frame's own origin knows the site of the page it's in, so the
			// site's rule against being framed holds here, in the worker,
			// even for a frame whose scripts the page switched off.
			if (inFrame && page.ancestors && !framingAllows(page.ancestors, topSite)) {
				event.responseBody = "<!doctype html><title></title>";
				return;
			}
			event.responseBody = injectHtml(event.responseBody, page);
		}
	});

	loadEngine();
	loadPrivacyRules();

	return {
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

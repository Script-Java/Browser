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
import { siteOf, siteKey } from "../client/sitekey.js";
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
	const transportFetch = scramjet.client.fetch.bind(scramjet.client);
	scramjet.client.fetch = async (url, init) => {
		try {
			return await transportFetch(url, init);
		} catch (err) {
			if (!DEAD_TRANSPORT.test(String(err?.message || err))) throw err;
			await reconnect();
			return transportFetch(url, init);
		}
	};

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
	const framed = new Set(); // proxied URLs of pages shown in a frame inside a page

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

	// -------------------------------------------------------------- settings

	function applySettings(next) {
		settings = { ...DEFAULT_SETTINGS, ...(next || {}) };
		settingsAt = Date.now();
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
	const WHERE = `function where(){try{if(parent===self)return"top";if(parent.__biosShell)return"tab";parent.location.href;return"sub"}catch(e){return"tab"}}`;

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
		http: {
			title: "This site isn't secure",
			text: "It doesn't offer a secure (https) connection. What you see and send there passes through the app's server and the internet unencrypted, so others along the way could read or change it. Don't enter passwords or personal details.",
			go: "Continue (not secure)",
			action: "http",
		},
	};

	function interstitial({ kind, host, url }) {
		const { danger, title, text, go, action } = WARNINGS[kind];
		const proceed = goUrl(action, url);
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
<button id="go" type="button">${htmlEscape(go)}</button>
<script>
${WHERE}
if (where() === "sub") document.body.className = "sub";
document.getElementById("back").onclick = function () { history.length > 1 ? history.back() : location.replace("about:blank"); };
document.getElementById("go").onclick = function () { location.replace(${scriptJson(proceed)}); };
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
			sub: plan.inline ? goUrl("inline", plan.inline) : plan.url,
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
function needAnchor() {
	return new Promise(function (resolve) {
		var timer = setTimeout(function () { setupTransport().then(resolve, resolve); }, 8000);
		addEventListener("message", function (e) {
			if (e.source !== parent || !e.data || e.data.bios !== "anchor-ready") return;
			clearTimeout(timer);
			resolve();
		});
		parent.postMessage({ bios: "need-anchor" }, "*");
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
	if (at !== "sub" && targets.tab) return go("tab");
	go("sub");
})();
</script></body></html>`,
			{ status: 200, headers: headers() }
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
			if (decode(request.referrer)) framed.add(pageKey(request.referrer));
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
			const blocked =
				!!target &&
				!!engine &&
				settings.ads &&
				!isAllowed(target.hostname) &&
				engine.match(
					FilterRequest.fromRawDetails({
						url: target.href,
						sourceUrl: (source || target).href,
						type: "main_frame",
					})
				).match;
			if (blocked) countBlocked();
			return json({ blocked });
		}
		if (request.method === "POST" && path === "cosmetic") {
			const { url, classes, ids, hrefs } = await request.json();
			await getSettings();
			const host = parse(url);
			if (
				!engine ||
				!settings.cosmetic ||
				!host.hostname ||
				isAllowed(host.hostname)
			)
				return json({ styles: "" });
			const result = engine.getCosmeticsFilters({
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
			return json({ styles: result.styles || "" });
		}
		return new Response(null, { status: 404 });
	}

	// ----------------------------------------------------------- the request

	function decode(url) {
		if (!url || !url.startsWith(prefix)) return null;
		return decodeUrl(url);
	}

	// Counts blocked requests for the new tab's "trackers blocked" stat and
	// tells the app's own pages every few seconds: the shell (shared mode) or
	// this site's anchor frame (isolation mode), never the proxied pages.
	let blockedCount = 0;
	let blockedTimer = null;
	function countBlocked() {
		blockedCount++;
		blockedTimer ||= setTimeout(async () => {
			const count = blockedCount;
			blockedCount = 0;
			blockedTimer = null;
			const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const page of pages)
				if (!page.url.startsWith(prefix)) page.postMessage({ bios: "blocked", count });
		}, 3000);
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
	async function httpsOnly(request, target, isPage, url) {
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
		if (isPage && !(await speaksHttps(host)))
			return interstitial({ kind: "http", host: target.hostname, url });
		const secure = new URL(target.href);
		secure.protocol = "https:";
		return redirect(location.origin + encodeUrl(secure.href));
	}

	// "Safer" level: no web fonts (a fingerprinting and font-parser attack
	// surface), and no scripts from pages that came over plain http.
	// "Safest": the same, and no site's scripts on any page.
	const hardened = () => settings.level === "safer" || settings.level === "safest";
	const noSiteScripts = (url) =>
		settings.level === "safest" || (settings.level === "safer" && url?.protocol === "http:");

	const SCRIPTED = new Set(["script", "worker", "sharedworker", "serviceworker"]);

	function saferBlock(destination, source) {
		if (!hardened()) return null;
		if (destination === "font") return blocked(destination);
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
		const page = isPage && { cosmetic: false, videoAds: false, safer: hardened(), noScripts };
		const resHeaders = new Headers(res.headers);
		resHeaders.set("content-security-policy", policyFor(page));
		const html = page && /^text\/html/i.test(resHeaders.get("content-type") || "");
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

		const upgraded = await httpsOnly(request, target, isPage, url);
		if (upgraded) return upgraded;

		const enginePromise = waitForEngine();

		if (isPage) {
			// Isolation: every site runs on its own subdomain. A page that
			// belongs to another site goes there, unless it's a frame inside
			// a page (those stay with the page, like Safari's partitioning).
			if (isolated && !inlineOnce.delete(url)) {
				const key = await siteKey(target.hostname);
				if (key !== ownLabel) {
					const page = await trampoline(request, {
						tab: originFor(key) + url.slice(location.origin.length),
						inline: url,
						shell: shellOrigin + "/#" + encodeURIComponent(target.href),
					});
					if (page) return page;
				} else if (!(await hasProxyClient())) {
					// First page of this site since the app opened: start the
					// proxy connection for this origin, then load the page.
					const page = await trampoline(request, { boot: true, url });
					if (page) return page;
				}
			}

			const threat = await checkNavigation(target.hostname);
			if (
				threat &&
				settings.threats &&
				!bypassed.has(target.hostname.toLowerCase())
			)
				return interstitial({ kind: threat, host: target.hostname, url });
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
			if (engine) {
				const { match, redirect } = engine.match(
					FilterRequest.fromRawDetails({
						url: target.href,
						sourceUrl: source ? source.href : target.href,
						type: REQUEST_TYPES[destination] || "other",
					})
				);
				if (redirect && !isPage) {
					countBlocked();
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
						countBlocked();
						return new Response(null, { status: 204 });
					}
					if (isPage)
						return interstitial({ kind: "ads", host: target.hostname, url });
					countBlocked();
					return blocked(destination);
				}
			}
		}

		if (isPage) {
			rememberPage({
				url: target.href,
				hostname: target.hostname,
				cosmetic: blocking && settings.cosmetic,
				videoAds: settings.videoAds && !isAllowed(target.hostname),
				safer: hardened(),
				// "Safest", or "Safer" on a plain http page: none of the page's own scripts run
				noScripts: noSiteScripts(target),
			});
		}
		return scramjet.fetch(event);
	}

	// -------------------------------------------- after Scramjet rewrites HTML

	function injectHtml(html, page) {
		let styles = "";
		let scripts = [];
		if (engine && page.cosmetic) {
			const host = parse(page.url);
			const result = engine.getCosmeticsFilters({
				url: page.url,
				hostname: page.hostname,
				domain: host.domain || page.hostname,
				getBaseRules: true,
				getInjectionRules: true,
				getExtendedRules: false,
				getRulesFromHostname: true,
				getRulesFromDOM: false,
			});
			styles = result.styles || "";
			scripts = result.scripts || [];
		}

		const flags = { cosmetic: page.cosmetic, videoAds: page.videoAds, safer: page.safer };
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
	const socket = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
	const NETWORK_LOCK = `default-src 'self' ${socket} data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; frame-src 'self'`;

	// The policy for a proxied response; `page` is set for the pages we inject.
	function policyFor(page) {
		if (!page?.noScripts) return NETWORK_LOCK;
		// Its inline scripts and handlers don't run; Scramjet's own scripts
		// (this origin, and its data: one, which injectHtml gives the nonce)
		// and ours (the nonce) still do. The page's external, data: and blob:
		// scripts are refused in handle(). Scramjet builds functions from
		// strings and runs WebAssembly as it starts, hence the evals; with
		// none of the page's code running, nothing else can call them.
		page.nonce = crypto.randomUUID().replace(/-/g, "");
		return `script-src 'self' 'nonce-${page.nonce}' 'unsafe-eval' 'wasm-unsafe-eval'; object-src 'none'; ${NETWORK_LOCK}`;
	}

	scramjet.addEventListener("handleResponse", (event) => {
		// Link headers ask the browser to preload or preconnect to the site's
		// servers itself, around the proxy (and Scramjet garbles their URLs).
		delete event.responseHeaders.link;
		const page = pages.get(pageKey(event.url.href));
		event.responseHeaders["content-security-policy"] = policyFor(page);
		if (!page) return;
		pages.delete(pageKey(event.url.href));
		// lets the page load in the app's frame across subdomains
		event.responseHeaders["cross-origin-resource-policy"] = "same-site";
		const type = event.responseHeaders["content-type"] || "";
		if (typeof event.responseBody === "string" && /^text\/html/i.test(type))
			event.responseBody = injectHtml(event.responseBody, page);
	});

	loadEngine();

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

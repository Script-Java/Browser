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
import { PREFIX, decodeUrl } from "../codec.js";

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

	const goUrl = (action, to) =>
		`${location.origin}${API}go?do=${action}&u=${encodeURIComponent(to)}`;

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
		if (event.data?.bios === "wipe") scramjet.cookieStore.load("{}");
	});

	let engine = null;
	let engineLoad = null;
	let settings = null;
	let settingsAt = 0;
	let settingsLoad = null;
	const bypassed = new Set(); // hosts the user chose to open despite a warning
	const allowOnce = new Set(); // proxied URLs to load once without ad blocking
	const inlineOnce = new Set(); // proxied URLs to load in this origin once
	const pages = new Map(); // site URL -> page info for the response hook

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
			settingsLoad ||= fetch("/api/settings", { cache: "no-store" })
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
			const res = await fetch("/api/nav", {
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

	// Runs in a page we generate. Works out where it is: "top" (escaped the
	// app), "tab" (the app's page frame) or "sub" (a frame inside a page).
	const WHERE = `function where(){try{if(parent===self)return"top";if(parent.__biosShell)return"tab";parent.location.href;return"sub"}catch(e){return"tab"}}`;

	function interstitial({ kind, host, url }) {
		const danger = kind === "phishing" || kind === "malware";
		const title = danger
			? kind === "phishing"
				? "Deceptive site ahead"
				: "Dangerous site ahead"
			: "Page blocked";
		const text = danger
			? kind === "phishing"
				? "This site is on a list of known phishing sites. It may try to trick you into entering a password, card number or other personal details."
				: "This site is on a list of sites known to spread malware."
			: "This address belongs to a known ad or tracking network, so it was blocked.";
		const proceed = goUrl(danger ? "bypass" : "allow", url);
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
<button id="go" type="button">${danger ? "Continue anyway (unsafe)" : "Open anyway"}</button>
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
		// /scramjet/__bios/go?do=<inline|allow|bypass>&u=<proxied URL>: remember the
		// choice, then continue to the page (307 keeps a form POST intact).
		if (path === "go") {
			const params = new URL(request.url).searchParams;
			const to = params.get("u") || "";
			const target = decode(to);
			if (!target) return new Response(null, { status: 400 });
			const action = params.get("do");
			if (action === "inline") inlineOnce.add(to);
			else if (action === "allow") allowOnce.add(to);
			else if (action === "bypass") bypassed.add(target.hostname.toLowerCase());
			return Response.redirect(to, 307);
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

	function blocked(destination) {
		if (destination === "script" || destination === "worker")
			return new Response("", { headers: headers("text/javascript") });
		if (destination === "style")
			return new Response("", { headers: headers("text/css") });
		return Response.error();
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
		if (!scramjet.route(event)) return fetch(request);

		// decodeUrl only returns http(s) pages; data:, blob: and Scramjet's
		// own files go straight to Scramjet
		const target = decode(url);
		if (!target) return scramjet.fetch(event);

		const destination = request.destination;
		const isPage =
			request.mode === "navigate" ||
			destination === "document" ||
			destination === "iframe" ||
			destination === "frame";
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
					return new Response(
						redirect.contentType.includes("base64")
							? Uint8Array.from(atob(redirect.body), (c) => c.charCodeAt(0))
							: redirect.body,
						{ headers: { ...headers(redirect.contentType.split(";")[0]) } }
					);
				}
				if (match) {
					if (isPage)
						return interstitial({ kind: "ads", host: target.hostname, url });
					return blocked(destination);
				}
			}
		}

		if (isPage) {
			// ponytail: entries for pages that never answer stay until this clears
			if (pages.size > 200) pages.clear();
			pages.set(target.href, {
				url: target.href,
				hostname: target.hostname,
				cosmetic: blocking && settings.cosmetic,
				videoAds: settings.videoAds && !isAllowed(target.hostname),
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

		const flags = { cosmetic: page.cosmetic, videoAds: page.videoAds };
		let after =
			`<script>self.__biosPage=${scriptJson(flags)};document.currentScript.remove();</script>` +
			`<script src="${location.origin}/bios/page.js"></script>`;
		if (styles)
			after += `<style>${styles.replace(/<\/style/gi, "<\\/style")}</style>`;
		if (scripts.length)
			after +=
				"<script>" +
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
		return html.slice(0, end) + after + html.slice(end);
	}

	scramjet.addEventListener("handleResponse", (event) => {
		const page = pages.get(event.url.href);
		if (!page) return;
		pages.delete(event.url.href);
		// lets the page load in the app's frame across subdomains
		event.responseHeaders["cross-origin-resource-policy"] = "same-site";
		const type = event.responseHeaders["content-type"] || "";
		if (typeof event.responseBody === "string" && /^text\/html/i.test(type))
			event.responseBody = injectHtml(event.responseBody, page);
	});

	loadEngine();

	return {
		handle(event) {
			return handle(event).catch((err) => {
				console.error("bios:", err);
				return scramjet.fetch(event);
			});
		},
	};
}

// What a site is told about a request (where it comes from), and whether the
// site's own protections hold through the proxy: its rule against being
// framed, and its cookies that must not travel with other sites' requests.
// The browser never sees the real requests, so the proxy has to get these right.

import { expect, test } from "./fixtures.js";
import { ECHO, bodyText, follow, open, received, tabFrame, testPage } from "./fixtures.js";
import { ISOLATED_URL } from "./env.js";

async function openIsolated(page) {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
}

// A site signs someone in: one cookie of each SameSite kind.
const SIGNED_IN = ["strict=1; SameSite=Strict", "lax=1; SameSite=Lax", "plain=1"];
const signIn = (page, site = ECHO) =>
	open(page, `${site}/response-headers?${SIGNED_IN.map((c) => "Set-Cookie=" + encodeURIComponent(c)).join("&")}`);
/** The names in a Cookie header, sorted. */
const names = (cookie = "") =>
	cookie
		.split(/;\s*/)
		.filter(Boolean)
		.map((c) => c.split("=")[0])
		.sort();
/** The headers the echo page in the tab says it received, once the tab shows `url`. */
async function echoed(page, url) {
	await page.waitForFunction((u) => active.url === u && !active.loading, url);
	return received(await bodyText(await tabFrame(page)));
}

test("a page's requests to other sites say where they come from, and no more", async ({ app }) => {
	const fetches = {
		other: `fetch("${ECHO}/headers")`,
		quiet: `fetch("${ECHO}/headers?quiet", { referrerPolicy: "no-referrer" })`,
		own: `fetch("/headers")`,
	};
	const frame = await open(
		app,
		testPage(`<!doctype html><title>asks</title><script>
${Object.entries(fetches)
	.map(([id, call]) => `${call}.then((r) => r.text()).then((t) => (document.getElementById("${id}").textContent = t));`)
	.join("\n")}
</script>${Object.keys(fetches)
			.map((id) => `<pre id="${id}"></pre>`)
			.join("")}`)
	);
	await frame.waitForFunction((ids) => ids.every((id) => document.getElementById(id).textContent), Object.keys(fetches));
	const [other, quiet, own] = await Promise.all(
		Object.keys(fetches).map(async (id) => received(await frame.locator("#" + id).textContent()))
	);
	// another site learns the site a request comes from, never the page
	expect(other["sec-fetch-site"]).toBe("cross-site");
	expect(other.referer).toBe("https://httpbin.org/");
	// a page that asks for no referrer sends none; the request is still another site's
	expect(quiet["sec-fetch-site"]).toBe("cross-site");
	expect(quiet.referer).toBeUndefined();
	// the page's own site gets its address
	expect(own["sec-fetch-site"]).toBe("same-origin");
	expect(own.referer).toMatch(/^https:\/\/httpbin\.org\/base64\//);
	// (Global Privacy Control and the language are in privacy.spec.js)
});

test("a link or a form to another site arrives as another site's (isolated)", async ({ page }) => {
	await openIsolated(page);
	// its own origin's service worker first: a form's fields don't survive that origin's first load
	await open(page, ECHO + "/get");
	await open(
		page,
		testPage(`<!doctype html><title>leaves</title>
<a id="link" href="${ECHO}/headers">link</a>
<form id="form" method="post" action="${ECHO}/post"><input name="a" value="1"></form>
<form id="own" method="post" action="/post"><input name="a" value="1"></form>`)
	);
	const page1 = await page.evaluate(() => active.url);

	let headers = received(await bodyText(await follow(page, "link", ECHO + "/headers")));
	expect(headers["sec-fetch-site"]).toBe("cross-site");
	// which page of which site isn't known across origins, and isn't told
	expect(headers.referer).toBeUndefined();

	await open(page, page1);
	headers = received(await bodyText(await follow(page, "form", ECHO + "/post")));
	expect(headers["sec-fetch-site"]).toBe("cross-site");
	expect(headers.origin).toBe("null");

	// a form to its own site: the site checks these to tell its own forms from forged ones
	await open(page, page1);
	headers = received(await bodyText(await follow(page, "own", "https://httpbin.org/post")));
	expect(headers["sec-fetch-site"]).toBe("same-origin");
	expect(headers.origin).toBe("https://httpbin.org");
	expect(headers.referer).toBe(page1);
});

test("a site's SameSite cookies stay home when another site sends the request", async ({ app }) => {
	const cookies = ["strict=1; SameSite=Strict", "lax=1; SameSite=Lax", "plain=1"];
	await open(app, `${ECHO}/response-headers?${cookies.map((c) => "Set-Cookie=" + encodeURIComponent(c)).join("&")}`);
	// typed into the bar: the site's own visitor, every cookie
	let frame = await open(app, ECHO + "/cookies");
	expect(Object.keys(JSON.parse(await bodyText(frame)).cookies).sort()).toEqual(["lax", "plain", "strict"]);

	const from = testPage(`<!doctype html><title>other site</title>
<a id="link" href="${ECHO}/cookies">link</a>
<form id="form" method="post" action="${ECHO}/post"><input name="a" value="1"></form>
<script>fetch("${ECHO}/cookies", { credentials: "include" }).then((r) => r.text()).then((t) => (document.getElementById("fetched").textContent = t));</script>
<pre id="fetched"></pre>`);
	frame = await open(app, from);
	// in the background (a fetch, an image): only cookies that didn't ask to stay home
	await frame.waitForFunction(() => document.getElementById("fetched").textContent);
	expect(Object.keys(JSON.parse(await frame.locator("#fetched").textContent()).cookies)).toEqual(["plain"]);
	// a link the person follows: Lax travels, Strict doesn't
	frame = await follow(app, "link", ECHO + "/cookies");
	expect(Object.keys(JSON.parse(await bodyText(frame)).cookies).sort()).toEqual(["lax", "plain"]);
	// a form posted from the other site (how forged requests are made): neither
	await open(app, from);
	frame = await follow(app, "form", ECHO + "/post");
	expect(received(await bodyText(frame)).cookie).toBe("plain=1");
});

test("a site that forbids framing stays out of other pages' frames", async ({ app }) => {
	// a page the site sends with a rule (httpbin's echo of its own headers, served as HTML)
	const ruled = (host, name, value) =>
		`https://${host}/response-headers?Content-Type=text/html&${name}=${encodeURIComponent(value)}&x=FRAMED-CONTENT`;
	const frames = {
		deny: ruled("httpbin.org", "X-Frame-Options", "DENY"),
		none: ruled("httpbin.org", "Content-Security-Policy", "frame-ancestors 'none'"),
		elsewhere: ruled("httpbin.org", "Content-Security-Policy", "default-src *; frame-ancestors https://example.com"),
		otherSite: ruled("httpbingo.org", "X-Frame-Options", "SAMEORIGIN"),
		// allowed: the framing page is the site's own, or named
		sameOrigin: ruled("httpbin.org", "X-Frame-Options", "SAMEORIGIN"),
		named: ruled("httpbin.org", "Content-Security-Policy", "frame-ancestors https://*.example.com https://httpbin.org"),
	};
	const frame = await open(
		app,
		testPage(
			`<!doctype html><title>framer</title>` +
				Object.entries(frames)
					.map(([id, src]) => `<iframe id="${id}" src="${src}" width="300" height="60"></iframe>`)
					.join("")
		)
	);
	// (a refused frame is left without a body)
	const shown = (id) => frame.frameLocator("#" + id).locator("html");
	for (const id of ["sameOrigin", "named"]) await expect(shown(id), id).toContainText("FRAMED-CONTENT");
	// the others have had the same time to load
	await app.waitForTimeout(3000);
	for (const id of ["deny", "none", "elsewhere", "otherSite"]) await expect(shown(id), id).not.toContainText("FRAMED-CONTENT");

	// opened as a tab, a page with such a rule loads as usual
	const tab = await open(app, frames.deny);
	await expect(tab.locator("body")).toContainText("FRAMED-CONTENT");
});

test("a form posted to a site not opened before arrives with its fields (isolated)", async ({ page }) => {
	await openIsolated(page);
	// (nothing of the echo site opened first: its origin has no service worker yet)
	await open(page, testPage(`<!doctype html><title>form</title>
<form id="form" method="post" action="${ECHO}/post"><input name="a" value="1"></form>`));
	const sent = JSON.parse(await bodyText(await follow(page, "form", ECHO + "/post")));
	expect(sent.form).toEqual({ a: ["1"] });
});

const OPENER = testPage(`<!doctype html><title>opener</title><a id="out" target="_blank" href="${ECHO}/headers">out</a>`);

test("a tab a page opens arrives as that page's site's request, not as typed", async ({ app }) => {
	await signIn(app);
	await (await open(app, OPENER)).click("#out");
	const headers = await echoed(app, ECHO + "/headers");
	expect(await app.evaluate(() => tabs.length)).toBe(2);
	expect(headers["sec-fetch-site"]).toBe("cross-site");
	expect(names(headers.cookie)).toEqual(["lax", "plain"]);
});

test("a tab a page opens arrives as that page's site's request, not as typed (isolated)", async ({ page }) => {
	await openIsolated(page);
	await signIn(page);
	await (await open(page, OPENER)).click("#out");
	const headers = await echoed(page, ECHO + "/headers");
	expect(headers["sec-fetch-site"]).toBe("cross-site");
	expect(names(headers.cookie)).toEqual(["lax", "plain"]);
});

// What a page that got around the proxy's hooks can do: send its own tab
// straight to another site's origin, with the browser's own setAttribute
// (borrowed from a frame Scramjet hasn't hooked) and no referrer.
const FORGER = testPage(`<!doctype html><title>forger</title><meta name="referrer" content="no-referrer"><script>
function raw(to, post) {
	document.body.append(document.createElement("iframe"));
	const untouched = window[window.length - 1];
	const el = document.createElement(post ? "form" : "a");
	untouched.Element.prototype.setAttribute.call(el, post ? "action" : "href", to);
	if (post) {
		el.method = "post";
		el.innerHTML = '<input name="a" value="1">';
	}
	document.body.append(el);
	post ? el.submit() : el.click();
}
</script>`);

test("a page that sends its tab straight to another site, hiding where from, isn't taken for the person (isolated)", async ({ page }) => {
	await openIsolated(page);
	await signIn(page);
	// typed into the bar: the person's own request, with every cookie
	let headers = received(await bodyText(await open(page, ECHO + "/headers")));
	expect(headers["sec-fetch-site"]).toBe("none");
	expect(names(headers.cookie)).toEqual(["lax", "plain", "strict"]);

	const echoOrigin = await page.evaluate(async () => originFor(await BiosSiteKey.siteKey("httpbingo.org")));
	const forge = async (path, post) => {
		const frame = await open(page, FORGER);
		await frame.evaluate(([to, post]) => window.raw(to, post), [echoOrigin + "/scramjet/" + encodeURIComponent(ECHO + path), post]);
		return echoed(page, ECHO + path);
	};
	// a link: like any from another site, Lax cookies go and Strict ones stay home
	headers = await forge("/headers", false);
	expect(headers["sec-fetch-site"]).toBe("cross-site");
	expect(names(headers.cookie)).toEqual(["lax", "plain"]);
	// a form posted from another site, as forged requests are: neither
	headers = await forge("/post", true);
	expect(headers["sec-fetch-site"]).toBe("cross-site");
	expect(headers.origin).toBe("null");
	expect(names(headers.cookie)).toEqual(["plain"]);
});

test("a site's own page that hides its referrer still gets its own cookies (isolated)", async ({ page }) => {
	await openIsolated(page);
	await signIn(page, "https://httpbin.org");
	const quiet =
		"https://httpbin.org/response-headers?Content-Type=text/html&Referrer-Policy=no-referrer&x=" +
		encodeURIComponent("<a id=link href=/headers>link</a><form id=form method=post action=/post><input name=a value=1></form>");
	await open(page, quiet);
	let headers = received(await bodyText(await follow(page, "link", "https://httpbin.org/headers")));
	expect(headers["sec-fetch-site"]).toBe("same-origin");
	expect(headers.referer).toBeUndefined();
	expect(names(headers.cookie)).toEqual(["lax", "plain", "strict"]);
	await open(page, quiet);
	const sent = JSON.parse(await bodyText(await follow(page, "form", "https://httpbin.org/post")));
	expect(sent.form).toEqual({ a: "1" });
	expect(names(sent.headers.Cookie)).toEqual(["lax", "plain", "strict"]);
});

test("going back to a page typed into the bar is still the person's own request (isolated)", async ({ page }) => {
	await openIsolated(page);
	await signIn(page);
	await open(page, ECHO + "/headers");
	await open(page, "https://example.com/");
	await page.waitForFunction(() => active.title === "Example Domain");
	await page.click("#back");
	const headers = await echoed(page, ECHO + "/headers");
	expect(headers["sec-fetch-site"]).toBe("none");
	expect(names(headers.cookie)).toEqual(["lax", "plain", "strict"]);
});

test("a site's cookies outlive its service worker being stopped", async ({ app, browserName }) => {
	test.skip(browserName !== "chromium", "stops the worker through Chromium's DevTools protocol");
	const cdp = await app.context().newCDPSession(app);
	await cdp.send("ServiceWorker.enable");
	const cookies = async (site) => JSON.parse(await bodyText(await open(app, site + "/cookies"))).cookies;
	await open(app, `${ECHO}/response-headers?Set-Cookie=${encodeURIComponent("kept=1; Max-Age=3600")}&Set-Cookie=gone%3D1`);
	await cdp.send("ServiceWorker.stopAllWorkers");
	expect(await cookies(ECHO)).toEqual({ kept: "1", gone: "1" });
	// signed out (Max-Age=0): gone, for good
	await open(app, `${ECHO}/response-headers?Set-Cookie=${encodeURIComponent("gone=; Max-Age=0")}`);
	await cdp.send("ServiceWorker.stopAllWorkers");
	expect(await cookies(ECHO)).toEqual({ kept: "1" });
	// a page's script setting one wakes the worker, and doesn't write over the others
	const frame = await open(app, testPage("<!doctype html><title>sets</title>"));
	await cdp.send("ServiceWorker.stopAllWorkers");
	await frame.evaluate(() => (document.cookie = "script=1; path=/"));
	await expect.poll(() => cookies("https://httpbin.org")).toEqual({ script: "1" });
	expect(await cookies(ECHO)).toEqual({ kept: "1" });
});

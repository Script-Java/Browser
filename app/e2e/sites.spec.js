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

// The site's own subdomain in isolation mode, worked out as an attacker's
// page could (it's a hash of the site's name).
const originOf = (page, url) =>
	page.evaluate(async (u) => originFor(await BiosSiteKey.siteKey(new URL(u).hostname)), url);

test("a form posted to a site not opened before keeps its fields (isolated)", async ({ page }) => {
	await openIsolated(page);
	// no visit to the echo site first: its origin has no service worker yet
	await open(
		page,
		testPage(`<!doctype html><title>posts</title>
<form id="form" method="post" action="${ECHO}/post"><input name="kept" value="yes"><input name="also" value="2"></form>`)
	);
	const frame = await follow(page, "form", ECHO + "/post");
	expect(JSON.parse(await bodyText(frame)).form).toEqual({ kept: ["yes"], also: ["2"] });
});

test("only the app's own navigations count as the person's (isolated)", async ({ page }) => {
	await openIsolated(page);
	const cookies = ["strict=1; SameSite=Strict", "lax=1; SameSite=Lax"];
	await open(page, `${ECHO}/response-headers?${cookies.map((c) => "Set-Cookie=" + encodeURIComponent(c)).join("&")}`);
	// typed: the site's own visitor, with every cookie
	let headers = received(await bodyText(await open(page, ECHO + "/headers")));
	expect(headers["sec-fetch-site"]).toBe("none");
	expect(headers.cookie).toContain("strict=1");

	// A page that gets around the proxy's hooks sends the tab straight to the
	// site's own origin, without a referrer: another site's request.
	const target = (await originOf(page, ECHO)) + "/scramjet/" + encodeURIComponent(ECHO + "/headers?forged=1");
	const frame = await open(page, testPage(`<!doctype html><title>forger</title><meta name="referrer" content="no-referrer">`));
	await frame.evaluate((u) => (window.location.href = u), target);
	await page.waitForFunction(() => active.url.includes("forged=1") && !active.loading);
	headers = received(await bodyText(await tabFrame(page)));
	expect(headers["sec-fetch-site"]).toBe("cross-site");
	expect(headers.cookie || "").not.toContain("strict=1");
});

test("a tab a page opened arrives as that page's request (isolated)", async ({ page }) => {
	await openIsolated(page);
	await open(page, ECHO + "/get");
	const frame = await open(page, testPage(`<!doctype html><title>opener</title><a id="out" target="_blank" href="${ECHO}/headers">new tab</a>`));
	await frame.click("#out");
	await page.waitForFunction((u) => tabs.length === 2 && active.url === u && !active.loading, ECHO + "/headers");
	const headers = received(await bodyText(await tabFrame(page)));
	expect(headers["sec-fetch-site"]).toBe("cross-site");
	// the opening page's site, not its address
	expect(headers.referer).toBe("https://httpbin.org/");
});

// What sites don't get to learn: the parameters that follow a person from
// site to site, the device's languages, and what a privacy signal says for them.

import { expect, test } from "./fixtures.js";
import { ECHO, bodyText, follow, open, received, setSettings, tabFrame, testPage } from "./fixtures.js";
import { SHARED_URL } from "./env.js";

const args = async (frame) => Object.keys(JSON.parse(await bodyText(frame)).args).sort();

test("typed addresses and links from other sites lose their tracking parameters", async ({ app }) => {
	// typed or pasted into the bar (names in any case)
	await open(app, `${ECHO}/get?fbclid=abc&utm_source=news&keep=1&GCLID=x`);
	await app.waitForFunction((u) => active.url === u, `${ECHO}/get?keep=1`);
	expect(await args(await tabFrame(app))).toEqual(["keep"]);

	const links = testPage(`<!doctype html><title>links</title>
<a id="out" href="${ECHO}/get?keep=2&msclkid=m&x=a%2Fb">another site</a>
<a id="own" href="/get?utm_source=own&keep=3">its own</a>`);
	// a link from another site; what stays is left exactly as written
	await open(app, links);
	expect(await args(await follow(app, "out", `${ECHO}/get?keep=2&x=a%2Fb`))).toEqual(["keep", "x"]);
	// a site's own links are its own business
	await open(app, links);
	expect(await args(await follow(app, "own", "https://httpbin.org/get?utm_source=own&keep=3"))).toEqual([
		"keep",
		"utm_source",
	]);

	// the per-site switch turns it off with the rest of the blocking
	await setSettings(app, { allow: ["httpbingo.org"] });
	expect(await args(await open(app, `${ECHO}/get?fbclid=abc&keep=1`))).toEqual(["fbclid", "keep"]);
});

test("sites are asked not to sell or share data, and aren't told the device's languages", async ({ app }) => {
	const frame = await open(
		app,
		testPage(`<!doctype html><title>asks</title><pre id="sent"></pre><script>
document.title = "gpc " + navigator.globalPrivacyControl;
fetch("${ECHO}/headers").then((r) => r.text()).then((t) => (document.getElementById("sent").textContent = t));
</script>`)
	);
	// to scripts in the page
	await expect.poll(() => frame.title()).toBe("gpc true");
	// with a request the page makes, and with the page's own
	await frame.waitForFunction(() => document.getElementById("sent").textContent);
	const requests = [
		received(await frame.locator("#sent").textContent()),
		received(await bodyText(await open(app, ECHO + "/headers"))),
	];
	for (const headers of requests) {
		expect(headers["sec-gpc"]).toBe("1");
		expect(headers["accept-language"]).toBe("en-US,en;q=0.9");
	}
});

test("cookie notices are hidden once that is switched on", async ({ app }) => {
	await expect
		.poll(async () => (await (await app.request.get(`${SHARED_URL}/filters/status`)).json()).noticeFilters, {
			message: "cookie-notice lists downloaded",
			timeout: 110_000,
		})
		.toBeGreaterThan(0);
	// a consent tool's banner, by the id its lists know it by
	const notice = testPage(`<!doctype html><title>notice</title>
<div id="onetrust-banner-sdk">We value your privacy</div><p id="text">the article</p>`);

	// not unless asked for: the hiding rules have had time to arrive
	let frame = await open(app, notice);
	await app.waitForTimeout(2000);
	await expect(frame.locator("#onetrust-banner-sdk")).toBeVisible();

	await setSettings(app, { notices: true });
	frame = await open(app, notice);
	await expect(frame.locator("#onetrust-banner-sdk")).toBeHidden();
	await expect(frame.locator("#text")).toBeVisible();
});

test("cookie notices are answered with a no, unless that is switched off", async ({ app }) => {
	// a consent tool's banner (CookieYes), as autoconsent knows it; its
	// buttons say in the page's title which one was pressed
	const notice = (note) =>
		testPage(`<!doctype html><title>notice</title><p>the article</p>
<div class="cky-consent-container" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:20px">
<p>We use cookies</p>
<button data-cky-tag="accept-button" onclick="document.title='ACCEPTED';this.parentNode.remove()">Accept all</button>
<button data-cky-tag="reject-button" onclick="document.title='REJECTED';this.parentNode.remove()">Reject all</button>
</div><!-- ${note} -->`);
	let frame = await open(app, notice("on"));
	await expect.poll(() => frame.title(), { timeout: 30_000 }).toBe("REJECTED");
	// the shield menu says what happened
	await app.evaluate(() => openSheet());
	await expect(app.locator("#consent-here")).toContainText("no to tracking");
	await app.evaluate(() => (sheet.hidden = true));

	await setSettings(app, { consent: false });
	frame = await open(app, notice("off"));
	await app.waitForTimeout(4000);
	expect(await frame.title()).toBe("notice");
});

test("a bounce-tracking address goes straight to where it leads", async ({ app }) => {
	// Brave's own test rule (debounce.json): the tracker's page is never asked for
	const target = `${ECHO}/get?landed=1`;
	await open(app, `https://dev-pages.brave.software/navigation-tracking/${encodeURIComponent(target)};.html`);
	await app.waitForFunction((u) => active.url === u, target);
	expect(await args(await tabFrame(app))).toEqual(["landed"]);
	// a site with blocking off is left alone: off for the tracker's site, the hop stays
	await setSettings(app, { allow: ["brave.software"] });
	await open(app, `https://dev-pages.brave.software/navigation-tracking/${encodeURIComponent(target + "&again=1")};.html`);
	expect(await app.evaluate(() => active.url)).toMatch(/^https:\/\/dev-pages\.brave\.software\//);
});

test("parameters on Brave's list go too", async ({ app }) => {
	// bbeml, oft_id: not on Badger's own list, on Brave's
	await open(app, `${ECHO}/get?bbeml=1&oft_id=2&keep=1`);
	await app.waitForFunction((u) => active.url === u, `${ECHO}/get?keep=1`);
	expect(await args(await tabFrame(app))).toEqual(["keep"]);
});

test("rules that hide ads by their link's address work on proxied pages", async ({ app }) => {
	await expect
		.poll(async () => (await (await app.request.get(`${SHARED_URL}/filters/status`)).json()).updatedAt, {
			message: "block lists downloaded",
			timeout: 110_000,
		})
		.toBeTruthy();
	// EasyList: ##a[href^="http://partners.etoro.com/"] (the proxy rewrites the
	// link itself, so the rule has to look at the address the page wrote)
	const frame = await open(
		app,
		testPage(`<!doctype html><title>links</title>
<a id="ad" href="http://partners.etoro.com/aw.aspx?A=1">an affiliate</a>
<a id="ok" href="https://example.com/">a link</a>`)
	);
	await expect(frame.locator("#ad")).toBeHidden({ timeout: 15_000 });
	await expect(frame.locator("#ok")).toBeVisible();
});

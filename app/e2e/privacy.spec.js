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

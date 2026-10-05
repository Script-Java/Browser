// The production setup: the browser check at the door, every site on its own
// subdomain, and the app's strict page policy. Shell commands to a tab cross
// origins here, which shared mode never exercises.

import { expect, test } from "@playwright/test";
import { SCRIPTED_PAGE, leaks, open, proxied, setSettings, tabFrame, testPage } from "./fixtures.js";
import { CATCHER, ISOLATED_URL } from "./env.js";

test("browser check, site isolation, verified address and tab commands", async ({ page }) => {
	await fetch(`http://127.0.0.1:${CATCHER}/__seen`, { method: "DELETE" });
	const violations = [];
	page.on("console", (msg) => {
		if (/Content.Security.Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
	});

	// the proof-of-work page runs (its inline script is allowed by hash) and lets us in
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	expect(await page.evaluate(() => isolated)).toBe(true);

	let frame = await open(page, "https://example.com/");
	await page.waitForFunction(() => active.url === "https://example.com/" && active.title === "Example Domain");
	// the site runs on its own subdomain, walled off from the app
	expect(await page.evaluate(() => active.siteOrigin)).toMatch(/^http:\/\/s[a-z2-7]{25}\.app\.localhost:\d+$/);
	expect(new URL(frame.url()).hostname).not.toBe("app.localhost");
	expect(await proxied(frame)).toEqual({ scramjet: true, badger: true });
	expect(await frame.evaluate(() => typeof RTCPeerConnection)).toBe("undefined");

	// back and reload go to the cross-origin page as messages
	frame = await open(page, "https://example.org/");
	await page.waitForFunction(() => active.url === "https://example.org/");
	await page.click("#back");
	await page.waitForFunction(() => active.url === "https://example.com/");
	await page.click("#forward");
	await page.waitForFunction(() => active.url === "https://example.org/");

	expect(violations, "the app's pages broke their own policy").toEqual([]);
	expect(await leaks(), "requests went around the proxy").toEqual([]);

	// a site's own service worker gets the settings from the app
	await setSettings(page, { level: "safest" });
	frame = await open(page, testPage(SCRIPTED_PAGE));
	await expect.poll(() => frame.locator("#t").textContent()).toBe("test");
	await page.waitForTimeout(2000);
	expect(await frame.title()).toBe("ORIGINAL");
	await setSettings(page, { level: "standard" });
});

test("a single-page app can change its address (history.pushState) on an isolated site", async ({ page }) => {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	await open(page, "https://example.com/");
	// Scramjet's hook read the shell's window, on another origin, and threw
	await (await tabFrame(page)).evaluate(() => history.pushState(null, "", "/moved"));
	await page.waitForFunction(() => active.url === "https://example.com/moved");
});

test("a page can read window.top and window.parent on an isolated site", async ({ page }) => {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	// Scramjet's stand-ins asked the shell's window, on another origin, and threw
	const frame = await open(
		page,
		testPage(`<!doctype html><title>WAIT</title><script>
			try { document.title = top === self && parent === self ? "TOP" : "FRAMED"; } catch { document.title = "THREW"; }
		</script>`)
	);
	expect(await frame.title()).toBe("TOP");
});

test("the address bar follows a tab to a page that isn't HTML (isolated)", async ({ page }) => {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	const frame = await open(page, testPage('<title>links</title><a id="json" href="https://httpbingo.org/get?x=1">data</a>'));
	// a JSON file has no page script to tell the app where the tab went
	await frame.evaluate(() => document.getElementById("json").click());
	await page.waitForFunction(() => active.url === "https://httpbingo.org/get?x=1" && !active.title);
	await expect(page.locator("#bar-input")).toHaveValue("httpbingo.org");
});

test("nothing on one site's origin can put its address on another site's tab", async ({ page }) => {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	await open(page, "https://example.com/");
	// a second tab on another site: a page there could reach into that site's anchor frame
	await page.evaluate(() => createTab("https://example.org/"));
	await page.waitForFunction(() => active.url === "https://example.org/" && !active.loading && !!active.siteOrigin);
	const victim = await page.evaluate(() => ({
		origin: active.siteOrigin,
		name: tabs[0].frame.name,
		index: [...Array(window.length).keys()].find((i) => window.frames[i] === tabs[0].frame.contentWindow),
	}));
	const anchor = page.frames().find((frame) => frame.url() === victim.origin + "/anchor.html");
	await anchor.evaluate(({ index, name }) => {
		const href = location.origin + "/scramjet/" + encodeURIComponent("https://example.org/forged");
		// the anchor's own kind of report, naming the other site's tab
		parent.postMessage({ bios: "docs", docs: [{ index, name, href }] }, "*");
		// and an answer as if that tab's frame had been asked, with a made-up word
		parent.postMessage({ bios: "docs", word: "made-up", href }, "*");
	}, victim);
	await page.waitForTimeout(1500);
	expect(await page.evaluate(() => tabs[0].url)).toBe("https://example.com/");
});

test("a site chosen to stay signed in keeps its data when the rest is cleared", async ({ page }) => {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	// the site's own page, not the in-between page that starts its origin
	const site = async (url) => {
		await open(page, url);
		await page.waitForFunction(() => active.title === "Example Domain");
		return tabFrame(page);
	};
	const cookieAt = async (url) => (await site(url)).evaluate(() => document.cookie);
	for (const url of ["https://example.com/", "https://example.org/"]) {
		const frame = await site(url);
		await frame.evaluate(() => (document.cookie = "signed=in; path=/"));
		// the service worker has it too, not only the page
		await expect.poll(() => cookieAt(url)).toContain("signed=in");
	}

	await setSettings(page, { keep: ["example.com"] });
	await page.evaluate(() => clearAllSiteData());
	expect(await cookieAt("https://example.com/")).toContain("signed=in");
	expect(await cookieAt("https://example.org/")).toBe("");
	// its history went with everyone else's
	expect(await page.evaluate(() => readEntries(HISTORY).filter((entry) => entry.url.includes("example.com")).length)).toBeLessThanOrEqual(1);

	// New identity clears it too
	await page.evaluate(() => clearAllSiteData(true));
	expect(await cookieAt("https://example.com/")).toBe("");
});

// A frame from another site inside a page (an ad, a player, a widget). With
// isolation it runs in the page's origin, so the browser itself keeps nothing
// between the two; only Scramjet's and the app's page scripts stand there.
const EMBEDDED = `<!doctype html><title>embedded</title><pre id="out"></pre><script>
const out = {};
const attempt = (name, read) => { try { out[name] = String(read()); } catch (e) { out[name] = "REFUSED"; } };
attempt("page text", () => parent.document.body.innerText.slice(0, 40));
attempt("page cookies", () => parent.document.cookie);
attempt("page storage", () => parent.localStorage.getItem("note"));
attempt("page address", () => top.location.href);
attempt("own cookies", () => document.cookie);
attempt("past the tab", () => top.parent === top);
document.getElementById("out").textContent = JSON.stringify(out);
</script>`;

async function embed(page) {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	// the embedded site has a cookie of its own, from a visit as a tab
	await open(page, "https://httpbin.org/cookies/set?visitor=1");
	await open(page, "https://example.com/");
	await page.waitForFunction(() => active.title === "Example Domain");
	const frame = await tabFrame(page);
	await frame.evaluate((src) => {
		document.cookie = "session=secret; path=/";
		localStorage.setItem("note", "private");
		const embedded = document.createElement("iframe");
		embedded.id = "embedded";
		embedded.src = src;
		document.body.append(embedded);
	}, testPage(EMBEDDED));
	const out = frame.frameLocator("#embedded").locator("#out");
	await expect(out).toContainText("own cookies");
	return JSON.parse(await out.textContent());
}

test("a frame from another site gets no cookies of its own site, and can't reach the app", async ({ page }) => {
	const got = await embed(page);
	// its site's cookies are kept apart under every site that embeds it
	expect(got["own cookies"]).toBe("");
	// the tab's page is the top: nothing above it to reach
	expect(got["past the tab"]).toBe("true");
});

test("known gap: a frame from another site can read the page around it", async ({ page }) => {
	// A browser refuses all three. Here nothing does yet (SECURITY-GAPS.md,
	// "Embedded frames share the page's space"): this test fails until that
	// is closed, and says so when it is.
	test.fail();
	const got = await embed(page);
	expect(got["page text"]).toBe("REFUSED");
	expect(got["page cookies"]).toBe("REFUSED");
	expect(got["page storage"]).toBe("REFUSED");
	expect(got["page address"]).toBe("REFUSED");
});

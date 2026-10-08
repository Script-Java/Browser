// The everyday tools in the menu: zoom, print, reader view, translation and
// the list of downloads. The page does most of them (page.js), since the app
// can't reach into a tab on another origin.

import { expect, test } from "./fixtures.js";
import { ECHO, open, tabFrame, testPage } from "./fixtures.js";
import { ISOLATED_URL } from "./env.js";

const zoomOfPage = async (page) => (await tabFrame(page)).evaluate(() => document.documentElement.style.zoom || "1");

test("zoom is the page's, kept for its site, and the keys work in the page too", async ({ app }) => {
	await open(app, testPage("<!doctype html><title>one</title><p>text</p>"));
	await app.evaluate(() => openSheet());
	await app.click("#zoom-in");
	await expect(app.locator("#zoom-level")).toHaveText("110%");
	await expect.poll(() => zoomOfPage(app)).toBe("1.1");
	await app.click("#sheet-close");
	// another page of the site gets it as it loads; another site doesn't
	await open(app, testPage("<!doctype html><title>two</title><p>text</p>"));
	await expect.poll(() => zoomOfPage(app)).toBe("1.1");
	await open(app, "https://example.com/");
	await app.waitForTimeout(1000);
	expect(await zoomOfPage(app)).toBe("1");
	// Ctrl/⌘ and + in the page zooms the page, not the app
	await open(app, testPage("<!doctype html><title>three</title><p>text</p>"));
	await (await tabFrame(app)).locator("p").click();
	await app.keyboard.press("ControlOrMeta+Equal");
	await expect.poll(() => zoomOfPage(app)).toBe("1.25");
	await app.keyboard.press("ControlOrMeta+Digit0");
	await expect.poll(() => zoomOfPage(app)).toBe("1");
	// and the app itself never zoomed
	expect(await app.evaluate(() => document.documentElement.style.zoom || "1")).toBe("1");
});

test("the menu prints the page, and a page's own Print button works after a tap", async ({ app, browserName }) => {
	test.skip(browserName !== "chromium", "this headless build of Safari's engine doesn't print (no beforeprint)");
	const frame = await open(
		app,
		testPage(`<!doctype html><title>doc</title><button id="print" onclick="print()">Print</button><script>
window.printed = 0;
addEventListener("beforeprint", () => { printed++; });
setTimeout(() => print(), 200);
</script>`)
	);
	// by itself, with no tap, a page can't open the print sheet
	await app.waitForTimeout(1000);
	expect(await frame.evaluate(() => window.printed)).toBe(0);
	await app.evaluate(() => printPage());
	await expect.poll(() => frame.evaluate(() => window.printed)).toBe(1);
	await frame.click("#print");
	await expect.poll(() => frame.evaluate(() => window.printed)).toBe(2);
});

const ARTICLE = testPage(`<!doctype html><title>The badger</title>
<nav id="menu"><a href="/">Home</a> <a href="/news">News</a> <a href="/shop">Shop</a></nav>
<article><h1>The badger</h1><p class="byline">By A. Writer</p>
${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i + 1}: badgers are short-legged omnivores of the family Mustelidae, which also includes the otters, wolverines, martens and weasels. They dig burrows called setts.</p>`).join("")}
</article><aside id="ad">Buy now, best prices on everything!</aside>`);

test("reader view shows the article alone, and goes away again", async ({ app }) => {
	const frame = await open(app, ARTICLE);
	await app.evaluate(() => readerView());
	const reader = frame.locator("#bios-reader");
	await expect(reader.locator("#bios-reader-page")).toContainText("Paragraph 8: badgers are short-legged omnivores");
	await expect(reader.locator("#bios-reader-page > h1")).toHaveText("The badger");
	await expect(reader.locator("#bios-reader-page")).not.toContainText("Buy now");
	await expect(reader.locator("#bios-reader-page")).not.toContainText("Shop");
	await reader.locator("button").click();
	await expect(reader).toHaveCount(0);
});

test("reader view works on a site's own origin too (isolated)", async ({ page }) => {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	const frame = await open(page, ARTICLE);
	await page.evaluate(() => readerView());
	await expect(frame.locator("#bios-reader #bios-reader-page")).toContainText("Paragraph 3");
});

test("translate opens the page through Google Translate's proxy, in the device's language", async ({ app }) => {
	await open(app, "https://example.com/news?id=1");
	expect(await app.evaluate(() => translated(active.url))).toBe(
		`https://example-com.translate.goog/news?id=1&_x_tr_sl=auto&_x_tr_tl=${await app.evaluate(() => navigator.language.split("-")[0])}&_x_tr_hl=${await app.evaluate(() => navigator.language.split("-")[0])}`
	);
	await app.evaluate(() => translatePage());
	// ponytail: only where the tab goes; Google may show a test browser a robot check
	await app.waitForFunction(() => new URL(active.url).hostname === "example-com.translate.goog");
	// a page already translated isn't offered again
	expect(await app.evaluate(() => translated(active.url))).toBeNull();
});

test("a file a site sends to save is listed in Downloads", async ({ app }) => {
	const name = "notes " + Date.now() + ".txt";
	const url = `${ECHO}/response-headers?Content-Type=text/plain&Content-Disposition=${encodeURIComponent(`attachment; filename="${name}"`)}`;
	const saved = app.waitForEvent("download");
	await app.evaluate((u) => go(u), url);
	expect((await saved).suggestedFilename()).toBe(name);
	await app.evaluate(() => openDownloads());
	await expect(app.locator("#downloads-list")).toContainText(name);
	await expect(app.locator("#downloads-list")).toContainText("httpbingo.org");
	// and it goes with the history
	await app.evaluate(() => clearAllSiteData());
	await app.evaluate(() => openDownloads());
	await expect(app.locator("#downloads-empty")).toBeVisible();
});

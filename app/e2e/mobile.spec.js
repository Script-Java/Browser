// The shell as the home-screen app on a phone: reload, and tabs without a tab strip.

import { expect, test } from "./fixtures.js";
import { open, tabFrame } from "./fixtures.js";
import { ISOLATED_URL } from "./env.js";

// A reloaded page is a new document: a mark left on the old one is gone.
async function expectReload(page, url = "https://example.com/") {
	let frame = await tabFrame(page);
	await frame.evaluate(() => (window.__mark = 1));
	await page.click("#reload");
	await expect
		.poll(async () => {
			frame = await tabFrame(page);
			return frame.evaluate(() => window.__mark === undefined && document.readyState === "complete").catch(() => false);
		})
		.toBe(true);
	await page.waitForFunction((u) => active.url === u && !active.loading, url);
}

test("reload loads the page again", async ({ app }) => {
	await open(app, "https://example.com/");
	await expectReload(app);
});

test("reload loads the page again across origins (site isolation)", async ({ page }) => {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	await open(page, "https://example.com/");
	await expectReload(page);
	// reloading in place adds no step to go back through
	expect(await page.evaluate(() => active.back.length)).toBe(0);
	// an address with a # reloads too, rather than scrolling to it
	await open(page, "https://example.org/#top");
	await expectReload(page, "https://example.org/#top");
});

test("a phone gets a bottom bar and a tab list instead of the tab strip", async ({ app, isMobile }) => {
	test.skip(!isMobile, "phones only");
	await expect(app.locator("#tabstrip")).toBeHidden();
	await open(app, "https://example.com/");
	await app.click("#dock #dock-new");
	// the count jumps, so a new tab doesn't open unseen
	expect(await app.evaluate(() => $("tab-count").getAnimations().length)).toBe(1);
	await app.click("#dock #tabs-btn");
	await expect(app.locator("#tab-count")).toHaveText("2");
	await app.click("#tab-list .link >> nth=0");
	await expect(app.locator("#switcher")).toBeHidden();
	expect(await app.evaluate(() => active.url)).toBe("https://example.com/");
	// the page ends where the bottom bar begins
	const gap = await app.evaluate(
		() => $("dock").getBoundingClientRect().top - active.frame.getBoundingClientRect().bottom
	);
	expect(gap).toBe(0);
	await app.click("#dock #tabs-btn");
	await app.click("#tab-list .tab-close >> nth=1");
	await expect(app.locator("#tab-count")).toHaveText("1");
	await app.click("#switcher-close");
	await expect(app.locator("#dock #back")).toBeVisible();
});

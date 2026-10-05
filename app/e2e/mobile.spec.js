// The shell as the home-screen app on a phone: reload, and tabs without a tab strip.

import { expect, test } from "./fixtures.js";
import { open, tabFrame, testPage } from "./fixtures.js";
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

// iPhones play streams through a <source> (ManagedMediaSource), not video.src
test("a stream given to a <source> element opens", async ({ app, browserName }) => {
	test.skip(browserName !== "chromium", "this WebKit build has no MediaSource");
	const frame = await open(
		app,
		testPage(`<!doctype html><title>WAIT</title><video id="a"></video><video id="b"></video><script>
			let opened = 0;
			for (const [id, set] of [["a", (el, url) => (el.src = url)], ["b", (el, url) => el.setAttribute("src", url)]]) {
				const stream = new MediaSource();
				stream.addEventListener("sourceopen", () => (document.title = "OPENED " + ++opened));
				const source = document.createElement("source");
				set(source, URL.createObjectURL(stream));
				document.getElementById(id).append(source);
			}
		</script>`)
	);
	await expect.poll(() => frame.title()).toBe("OPENED 2");
});

// A phone's home-screen app has no find of its own, so the app brings one.
const selected = (frame) =>
	frame.evaluate(() => ({
		text: getSelection().toString(),
		around: getSelection().anchorNode?.textContent ?? "",
		// (browsers without CSS highlights only get the selection)
		marked: CSS.highlights ? CSS.highlights.has("bios-find") : true,
		scrolled: scrollY > 0,
	}));

test("find in page goes from match to match", async ({ app }) => {
	const frame = await open(
		app,
		testPage(`<!doctype html><title>words</title><p>alpha beta</p><p style="margin-top:3000px">gamma beta</p>`)
	);
	await app.evaluate(() => openFind());
	const input = app.locator("#find-input");
	await input.fill("beta");
	await expect.poll(() => selected(frame)).toEqual({ text: "beta", around: "alpha beta", marked: true, scrolled: false });
	await input.press("Enter");
	await expect.poll(() => selected(frame)).toEqual({ text: "beta", around: "gamma beta", marked: true, scrolled: true });
	await input.press("Shift+Enter");
	await expect.poll(async () => (await selected(frame)).around).toBe("alpha beta");

	await input.fill("zebra");
	await expect(app.locator("#find-status")).toHaveText("No matches");
	await input.fill("alpha");
	await expect.poll(async () => (await selected(frame)).text).toBe("alpha");
	await app.locator("#find-close").click();
	await expect(app.locator("#find")).toBeHidden();
	await expect.poll(() => selected(frame)).toMatchObject({ text: "", marked: false });
});

test("find in page reaches a tab on its own origin (site isolation)", async ({ page }) => {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	await open(page, "https://example.com/");
	await page.waitForFunction(() => active.title === "Example Domain");
	await page.evaluate(() => openFind());
	await page.locator("#find-input").fill("example");
	const frame = await tabFrame(page);
	await expect.poll(async () => (await selected(frame)).text.toLowerCase()).toBe("example");
	await page.locator("#find-input").fill("zebra");
	await expect(page.locator("#find-status")).toHaveText("No matches");
});

// The passphrase lock: history, bookmarks and tabs never sit on the device
// unencrypted, and only the right passphrase opens them again.

import { expect, open, test } from "./fixtures.js";

test("passphrase lock encrypts history, bookmarks and tabs", async ({ app: page }) => {
	await open(page, "https://example.com/");
	await page.evaluate(() => toggleBookmark());
	await page.evaluate(() => setPassphrase("correct horse"));

	const stored = () => page.evaluate(() => JSON.stringify({ ...localStorage }));
	expect(await stored()).toContain("bios:vault");
	expect(await stored(), "a site address was stored unencrypted").not.toContain("example.com");

	// a reload asks first, and nothing opens until it's unlocked
	await page.reload();
	await expect(page.locator("#vault")).toBeVisible();
	expect(await page.evaluate(() => tabs.length)).toBe(0);

	await page.fill("#vault-pass", "wrong passphrase");
	await page.click("#vault-submit");
	await expect(page.locator("#vault-error")).toHaveText("Wrong passphrase.");

	await page.fill("#vault-pass", "correct horse");
	await page.click("#vault-submit");
	await expect(page.locator("#vault")).toBeHidden();
	await page.waitForFunction(() => active?.url === "https://example.com/");
	expect(await page.evaluate(() => isBookmarked("https://example.com/"))).toBe(true);
	expect(await stored(), "unlocking wrote something unencrypted").not.toContain("example.com");

	// back from five minutes in the background (a phone rarely closes the
	// app): locked again. A quick switch away doesn't lock.
	const away = (ms) =>
		page.evaluate((ms) => {
			let hidden = true;
			Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
			hiddenAt -= ms;
			hidden = false;
			document.dispatchEvent(new Event("visibilitychange"));
		}, ms);
	await away(60_000);
	await page.waitForTimeout(1000);
	await expect(page.locator("#vault")).toBeHidden();
	await away(6 * 60_000).catch(() => {});
	await expect(page.locator("#vault")).toBeVisible();
	await page.fill("#vault-pass", "correct horse");
	await page.click("#vault-submit");
	await expect(page.locator("#vault")).toBeHidden();
	await page.waitForFunction(() => active?.url === "https://example.com/");

	// turning it off puts everything back as before
	await page.evaluate(() => removePassphrase());
	expect(await stored()).not.toContain("bios:vault");
	expect(await page.evaluate(() => isBookmarked("https://example.com/"))).toBe(true);
});

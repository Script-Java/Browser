// Searching from the new tab page: words, not an address, typed into the bar.

import { expect, test } from "./fixtures.js";

test("words typed into the new tab's bar open a search", async ({ app }) => {
	// iOS's URL keyboard has no space bar, so the bars must not ask for it
	for (const id of ["#home-input", "#bar-input"])
		expect(await app.locator(id).getAttribute("inputmode"), id).not.toBe("url");
	await app.click("#home-input");
	await app.keyboard.type("honey badger");
	await app.keyboard.press("Enter");
	// shortcut: only where the tab lands; Google often sends proxied searches to its robot check (/sorry/) instead of results
	await app.waitForFunction(
		() => /^https:\/\/www\.google\.com\/(search\?q=honey%20badger|sorry\/.*honey)/.test(active.url) && !active.loading,
	);
});

// The production setup: the browser check at the door, every site on its own
// subdomain, and the app's strict page policy. Shell commands to a tab cross
// origins here, which shared mode never exercises.

import { expect, test } from "@playwright/test";
import { leaks, open, proxied } from "./fixtures.js";
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
});

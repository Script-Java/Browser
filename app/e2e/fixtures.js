import { test as base, expect } from "@playwright/test";
import { CATCHER, SHARED_URL } from "./env.js";

const seenUrl = `http://127.0.0.1:${CATCHER}/__seen`;

/** Requests that went around Badger's proxy since the last reset. */
export const leaks = async () => (await fetch(seenUrl)).json();

/**
 * `app`: the shell, open and ready, in shared mode. Every test also fails
 * if anything leaked past the proxy or a page put up a dialog.
 */
export const test = base.extend({
	app: async ({ page }, use) => {
		await fetch(seenUrl, { method: "DELETE" });
		const dialogs = [];
		page.on("dialog", (dialog) => {
			dialogs.push(`${dialog.type()}: ${dialog.message()}`);
			dialog.dismiss();
		});
		await openShell(page, SHARED_URL);
		await use(page);
		expect(dialogs, "pages showed dialogs").toEqual([]);
		expect(await leaks(), "requests went around the proxy").toEqual([]);
	},
});
export { expect };

export async function openShell(page, url) {
	await page.goto(url);
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	// the service worker and the proxy connection, before the first page
	await page.evaluate(() => startup.then(ensureReady));
}

/**
 * An HTML page on a public host (httpbin echoes it back), over http or https.
 * URL-safe base64 with its padding: an encoded "/" (%2F) in the path gets a 404.
 */
export function testPage(html, scheme = "https") {
	const b64 = Buffer.from(html).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
	return `${scheme}://httpbin.org/base64/${b64}`;
}

/** Opens `url` in the active tab and returns the tab's frame once it loaded. */
export async function open(page, url) {
	await page.evaluate((u) => go(u), url);
	await page.waitForFunction(() => !!active.url && !active.loading, null, { timeout: 60_000 });
	return tabFrame(page);
}

export async function tabFrame(page) {
	const name = await page.evaluate(() => active.frame.name);
	return page.frame({ name });
}

/** Scramjet and Badger's page script are both running in the frame. */
export const proxied = (frame) =>
	frame.evaluate(() => ({
		scramjet: !!window[Symbol.for("scramjet client global")],
		badger: !!window.__noPopups,
	}));

export const setSettings = (page, changes) =>
	page.evaluate(async (c) => {
		await loadSettings();
		await saveSettings({ ...settings, ...c });
	}, changes);

// A page that tries to run its own code three ways: an inline <script>, an
// onerror handler and an onload handler. Its title says which ran last.
export const SCRIPTED_PAGE = `<!doctype html><html><head><title>ORIGINAL</title></head>
<body onload="document.title='ONLOAD'"><img src="x" onerror="document.title='HANDLER'">
<script>document.title='INLINE'</script><p id="t">test</p></body></html>`;

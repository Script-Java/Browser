// Downloads: files a site sends to be saved land in the app's own list (a
// home-screen app would otherwise hand them to a sheet outside the app), and
// are encrypted with the passphrase lock like the history.

import { expect, open, test, testPage } from "./fixtures.js";

// What the app keeps: the list, and each file's contents as text.
const kept = (page) =>
	page.evaluate(async () =>
		Promise.all(
			readEntriesOf(DOWNLOADS).map(async (entry) => {
				const record = await downloadStore("readonly", (store) => store.get(entry.id));
				return { name: entry.name, text: await (await openBlob(record, entry.type)).text(), sealed: !record.plain };
			})
		)
	);

test("a file a site sends to be saved goes to the downloads, and the tab goes back", async ({ app }) => {
	const file = `https://httpbin.org/response-headers?Content-Type=text/plain&Content-Disposition=${encodeURIComponent(
		'attachment; filename="report.txt"'
	)}`;
	const page = testPage(`<!doctype html><title>files</title><a id="file" href="${file}">the report</a>
<a id="made" download="made.csv" href="data:text/csv,a%2Cb">an export</a>`);
	const frame = await open(app, page);
	await frame.click("#file");
	await expect.poll(() => kept(app), { timeout: 30_000 }).toHaveLength(1);
	const [report] = await kept(app);
	expect(report.name).toBe("report.txt");
	expect(report.text).toContain("Content-Disposition");
	expect(report.sealed).toBe(false);
	await expect(app.locator("#toast")).toContainText("Downloaded report.txt");
	// the page that had the link comes back
	await app.waitForFunction((u) => active.url === u, page);

	// a file the page made itself (<a download>), after a tap
	await (await (async () => app.frame({ name: await app.evaluate(() => active.frame.name) }))()).click("#made");
	await expect.poll(async () => (await kept(app)).map((d) => d.name)).toEqual(["made.csv", "report.txt"]);
	expect((await kept(app))[0].text).toBe("a,b");

	// in the list, and gone when deleted
	await app.evaluate(() => openDownloads());
	await expect(app.locator("#downloads-list li")).toHaveCount(2);
	await app.locator("#downloads-list li").first().getByRole("button", { name: "Delete made.csv" }).click();
	await expect(app.locator("#downloads-list li")).toHaveCount(1);
});

test("a page can't drop a file on anyone without a tap", async ({ app }) => {
	await open(
		app,
		testPage(`<!doctype html><title>drop</title><a id="made" download="evil.txt" href="data:text/plain,boo">x</a>
<script>setTimeout(() => { document.getElementById("made").click(); document.title = "clicked"; }, 300);</script>`)
	);
	await app.waitForTimeout(2500);
	expect(await kept(app)).toEqual([]);
});

test("downloads are encrypted with the passphrase lock", async ({ app }) => {
	await app.evaluate(() => setPassphrase("correct horse"));
	const frame = await open(app, testPage(`<!doctype html><title>files</title><a id="made" download="secret.txt" href="data:text/plain,private">x</a>`));
	await frame.click("#made");
	await expect.poll(() => kept(app)).toHaveLength(1);
	const [secret] = await kept(app);
	expect(secret).toEqual({ name: "secret.txt", text: "private", sealed: true });
	// the list isn't stored where it could be read without the passphrase
	expect(await app.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain("secret.txt");
	// turning the lock off stores it plainly again
	await app.evaluate(() => removePassphrase());
	expect((await kept(app))[0]).toEqual({ name: "secret.txt", text: "private", sealed: false });
});

// Workspaces: each task's tabs kept apart, on a computer and on a phone.

import { expect, open, openShell, test } from "./fixtures.js";
import { SHARED_URL } from "./env.js";

const shownUrls = (page) => page.evaluate(() => wsTabs().map((t) => t.url));

test("workspaces keep their tabs apart, and come back after a reload", async ({ app, isMobile }) => {
	test.skip(isMobile, "the tab strip's workspace button is for wider screens");
	await open(app, "https://example.com/");
	await expect(app.locator("#ws-name")).toHaveText("Personal");

	// a new workspace opens named first, on a new tab of its own
	await app.click("#ws-btn");
	await app.click("#ws-new");
	const name = app.locator("#ws-list .ws-edit input");
	await expect(name).toBeFocused();
	await name.fill("Research");
	await name.press("Enter");
	await app.click("#workspaces-close");
	await expect(app.locator("#ws-name")).toHaveText("Research");
	await expect(app.locator("#tabs .tab")).toHaveCount(1);
	await open(app, "https://example.org/");

	// back to the first: only its tab shows, where it was
	await app.click("#ws-btn");
	await app.click("#ws-list .link >> text=Personal");
	await expect(app.locator("#workspaces")).toBeHidden();
	expect(await shownUrls(app)).toEqual(["https://example.com/"]);
	expect(await app.evaluate(() => active.url)).toBe("https://example.com/");

	// split view pairs only tabs of the same workspace
	expect(await app.evaluate(() => canSplit())).toBe(false);

	// the palette switches too
	await app.evaluate(() => suggestions("research").find((s) => s.label === "Switch to Research").run());
	expect(await shownUrls(app)).toEqual(["https://example.org/"]);

	await app.reload();
	await openShell(app, SHARED_URL);
	expect(await app.evaluate(() => workspaces.map((w) => w.name))).toEqual(["Personal", "Research"]);
	await expect(app.locator("#ws-name")).toHaveText("Research");
	expect(await shownUrls(app)).toEqual(["https://example.org/"]);
	expect(await app.evaluate(() => wsTabs(workspaces[0].id).map((t) => t.url))).toEqual(["https://example.com/"]);
});

test("a tab moves to another workspace, and deleting a workspace closes its tabs", async ({ app, isMobile }) => {
	test.skip(isMobile, "the tab strip's workspace button is for wider screens");
	await open(app, "https://example.com/");
	await app.evaluate(() => createTab());
	await open(app, "https://example.org/");
	await app.evaluate(() => newWorkspace());
	await app.locator("#ws-list .ws-edit input").fill("Errands");
	await app.click("#ws-list .ws-edit button[type=submit]");
	await app.click("#ws-list .link >> text=Personal");
	expect(await app.evaluate(() => active.url)).toBe("https://example.org/");

	// sent away, the tab leaves the strip and its neighbour shows
	await app.click("#ws-btn");
	await app.click('#ws-list li:has-text("Errands") >> text=Move tab here');
	await expect(app.locator("#toast")).toContainText("Moved to Errands");
	expect(await shownUrls(app)).toEqual(["https://example.com/"]);
	expect(await app.evaluate(() => wsTabs(workspaces[1].id).map((t) => t.url))).toContain("https://example.org/");

	await app.click('#ws-list [aria-label="Edit Errands"]');
	await app.click("#ws-list .ws-edit button.danger");
	await app.click("#choice-ok");
	expect(await app.evaluate(() => workspaces.map((w) => w.name))).toEqual(["Personal"]);
	expect(await app.evaluate(() => tabs.map((t) => t.url))).toEqual(["https://example.com/"]);
	// the last workspace can't go
	await app.click('#ws-list [aria-label="Edit Personal"]');
	await expect(app.locator("#ws-list .ws-edit button.danger")).toBeDisabled();
});

test("a phone flips between workspaces from the tab list", async ({ app, isMobile }) => {
	test.skip(!isMobile, "phones only");
	await open(app, "https://example.com/");
	await app.click("#dock #tabs-btn");
	await expect(app.locator("#ws-chips .ws-chip[aria-pressed=true]")).toContainText("Personal");

	await app.click('#ws-chips [aria-label="New workspace"]');
	await expect(app.locator("#switcher")).toBeHidden();
	const name = app.locator("#ws-list .ws-edit input");
	await name.fill("Trip");
	await name.press("Enter");
	await app.click("#workspaces-close");
	await expect(app.locator("#tab-count")).toHaveText("1");
	// the tab button wears the workspace's color once there are two
	expect(await app.evaluate(() => getComputedStyle($("tab-count")).borderTopColor)).toBe("rgb(58, 111, 216)");

	await app.click("#dock #tabs-btn");
	await app.click('#ws-chips .ws-chip:has-text("Personal")');
	// the list follows, and stays open to pick from
	await expect(app.locator("#switcher")).toBeVisible();
	await expect(app.locator("#tab-list .link")).toHaveCount(1);
	await expect(app.locator("#tab-list .link")).toContainText("example.com");

	// big enough for a thumb, and the sheet doesn't scroll sideways
	const chip = await app.locator("#ws-chips .ws-chip >> nth=0").boundingBox();
	expect(chip.height).toBeGreaterThanOrEqual(38);
	expect(
		await app.evaluate(() => {
			const card = $("switcher").querySelector(".panel-card");
			return card.scrollWidth <= card.clientWidth;
		})
	).toBe(true);
});

// The production setup: the browser check at the door, every site on its own
// subdomain, and the app's strict page policy. Shell commands to a tab cross
// origins here, which shared mode never exercises.

import { expect, test } from "@playwright/test";
import { SCRIPTED_PAGE, bodyText, leaks, open, proxied, setSettings, tabFrame, testPage } from "./fixtures.js";
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
// isolation it runs on an origin of its own (shield.js inFrame), so the
// browser itself keeps the two apart, as it would without the proxy.
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

test("a frame from another site can't read or change the page around it", async ({ page }) => {
	const got = await embed(page);
	expect(got["page text"]).toBe("REFUSED");
	expect(got["page cookies"]).toBe("REFUSED");
	expect(got["page storage"]).toBe("REFUSED");
	expect(got["page address"]).toBe("REFUSED");
	// on an origin of its own, walled off by the browser
	const origins = await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => f.src));
	expect(origins.length).toBeGreaterThan(0);
});

// A page and a frame of another site talk the way embedded players and
// widgets do: messages each way, each naming the other's real origin.
const TALKER = `<!doctype html><title>talker</title><script>
addEventListener("message", (event) => {
	if (event.data !== "ping") return;
	event.source.postMessage({ pong: true, heard: event.origin }, event.origin);
	parent.postMessage("to the page", "https://example.com");
	parent.postMessage("not for that page", "https://elsewhere.example");
});
</script>`;

test("a page and a frame of another site exchange messages with their real origins", async ({ page }) => {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	await open(page, "https://example.com/");
	await page.waitForFunction(() => active.title === "Example Domain");
	const frame = await tabFrame(page);
	const heard = await frame.evaluate(
		(src) =>
			new Promise((resolve) => {
				const got = [];
				const embedded = document.createElement("iframe");
				addEventListener("message", (event) => {
					got.push({
						data: event.data,
						origin: event.origin,
						fromFrame: event.source === embedded.contentWindow,
					});
					if (got.length === 2) setTimeout(() => resolve(got), 1500);
				});
				embedded.onload = () => {
					// only the frame's real origin gets it; another name, nothing
					embedded.contentWindow.postMessage("ping", "https://elsewhere.example");
					embedded.contentWindow.postMessage("ping", "https://httpbin.org");
				};
				embedded.src = src;
				document.body.append(embedded);
			}),
		testPage(TALKER)
	);
	expect(heard).toEqual([
		{ data: { pong: true, heard: "https://example.com" }, origin: "https://httpbin.org", fromFrame: true },
		{ data: "to the page", origin: "https://httpbin.org", fromFrame: true },
	]);
});

// Two frames of one site inside a page find each other by name (payment
// widgets do), through the page around them, which is another site's.
const SIBLING = (name) => `<!doctype html><title>${name}</title><script>
addEventListener("message", (event) => {
	if (event.data === "hello, sibling") parent.postMessage("${name} heard its sibling", "*");
});
if ("${name}" === "second") setTimeout(() => {
	try { parent.frames["first"].postMessage("hello, sibling", "https://httpbin.org"); }
	catch (e) { parent.postMessage("lookup threw " + e.name, "*"); }
}, 1500);
</script>`;

test("frames of one site inside a page find each other by name", async ({ page }) => {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	await open(page, "https://example.com/");
	await page.waitForFunction(() => active.title === "Example Domain");
	const frame = await tabFrame(page);
	const heard = await frame.evaluate(
		([first, second]) =>
			new Promise((resolve) => {
				addEventListener("message", (event) => resolve(String(event.data)));
				for (const [name, src] of [["first", first], ["second", second]]) {
					const f = document.createElement("iframe");
					f.name = name;
					f.src = src;
					document.body.append(f);
				}
			}),
		[testPage(SIBLING("first")), testPage(SIBLING("second"))]
	);
	expect(heard).toBe("first heard its sibling");
});

test("a site that forbids framing stays out of frames on its own origin too", async ({ page }) => {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	const ruled = `https://httpbin.org/response-headers?Content-Type=text/html&X-Frame-Options=DENY&x=FRAMED-CONTENT`;
	const allowed = testPage("<!doctype html><title>ok</title><p>ALLOWED-CONTENT</p>");
	await open(page, "https://example.com/");
	await page.waitForFunction(() => active.title === "Example Domain");
	const frame = await tabFrame(page);
	await frame.evaluate(
		([ruled, allowed]) => {
			for (const [id, src] of [["ruled", ruled], ["allowed", allowed]]) {
				const f = document.createElement("iframe");
				f.id = id;
				f.src = src;
				document.body.append(f);
			}
		},
		[ruled, allowed]
	);
	await expect(frame.frameLocator("#allowed").locator("body")).toContainText("ALLOWED-CONTENT", { timeout: 30_000 });
	await page.waitForTimeout(2000);
	await expect(frame.frameLocator("#ruled").locator("html")).not.toContainText("FRAMED-CONTENT");
});

// Tor tabs (src/tor.js): only where the server runs Tor (the Docker image
// installs it; elsewhere, TOR_BIN). The Tor network can be slow to answer.
test("a Tor tab's sites see a Tor exit, onion sites open, and nothing is kept", async ({ page }) => {
	test.setTimeout(420_000);
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
	await page.evaluate(() => startup);
	const tor = await page.evaluate(() => torState());
	test.skip(!tor.available, "this server runs no Tor");

	await page.evaluate(() => newTorTab("https://check.torproject.org/api/ip"));
	await page.waitForFunction(() => active.tor && active.url === "https://check.torproject.org/api/ip" && !active.loading, null, {
		timeout: 180_000,
	});
	expect(JSON.parse(await bodyText(await tabFrame(page))).IsTor).toBe(true);
	// a site of its own, walled off from the same site's ordinary one
	expect(await page.evaluate(() => active.siteOrigin)).toMatch(/^http:\/\/t[a-z2-7]{25}\.app\.localhost:\d+$/);

	// an onion site: the Tor Project's own
	await page.evaluate(() => go("http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/"));
	// (an onion site's page arrives well before all its pictures do, and an
	// onion site can take a try or two to answer: "Try again", as a person would)
	await expect
		.poll(
			async () => {
				if (!(await page.evaluate(() => active.url)).includes(".onion")) return "";
				const tab = await tabFrame(page);
				const title = await tab.title().catch(() => "");
				if (title === "Couldn't open this page") await tab.click("#go").catch(() => {});
				return title;
			},
			{ timeout: 240_000, intervals: [2000] }
		)
		.toContain("Tor Project");

	// no history, and it isn't brought back when the app opens
	expect(await page.evaluate(() => readEntries(HISTORY).filter((h) => /torproject|onion/.test(h.url)).length)).toBe(0);
	expect(await page.evaluate(() => JSON.stringify(readList(TABS)))).not.toContain("onion");

	// an onion address in an ordinary tab is offered a Tor tab instead
	await page.evaluate(() => {
		for (const tab of [...tabs]) if (tab.tor) closeTab(tab);
	});
	const frame = await open(page, testPage(`<!doctype html><title>link</title><a id="onion" href="http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/">onion</a>`));
	await frame.click("#onion");
	await expect.poll(async () => (await tabFrame(page)).locator("h1").textContent().catch(() => "")).toBe("This is an onion site");
});

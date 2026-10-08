// A frame from another site inside a page (an ad, a player, a widget). With
// site isolation it gets an origin of its own, one for each pair of page and
// framed site, so the browser itself keeps the page and the frame apart, as
// it does outside the proxy. These tests are about that wall, and about what
// still has to get across it: messages, and links aimed at the whole tab.

import { expect, test } from "@playwright/test";
import { ECHO, bodyText, open, received, setSettings, tabFrame, testPage } from "./fixtures.js";
import { ISOLATED_URL } from "./env.js";

async function openIsolated(page) {
	await page.goto(ISOLATED_URL + "/");
	await page.waitForFunction(() => typeof go === "function" && !!active, null, { timeout: 60_000 });
}

// What example.com, .org and .net say on their page.
const EXAMPLE = "documentation examples";

/** example.com in the tab, as itself and not the page that starts its origin. */
async function host(page, url = "https://example.com/") {
	await open(page, url);
	await page.waitForFunction(() => active.title === "Example Domain");
	return tabFrame(page);
}

/** Puts a frame showing `src` in the tab's page, the way a page's own script would. */
const embed = (frame, src, id = "embedded") =>
	frame.evaluate(
		([src, id]) => {
			const embedded = document.createElement("iframe");
			embedded.id = id;
			embedded.src = src;
			document.body.append(embedded);
		},
		[src, id]
	);

/** The origins of the proxied pages in the tab: its own, and its frames'. */
const origins = (page) =>
	page
		.frames()
		.filter((each) => each.url().includes("/scramjet/"))
		.map((each) => new URL(each.url()).origin);

// What a hostile frame would try, each attempt by itself.
const PRYING = `<!doctype html><title>embedded</title><pre id="out"></pre><script>
const out = {};
const attempt = (name, read) => { try { out[name] = String(read()); } catch (e) { out[name] = "REFUSED"; } };
attempt("page text", () => parent.document.body.innerText.slice(0, 40));
attempt("page cookies", () => parent.document.cookie);
attempt("page storage", () => parent.localStorage.getItem("note"));
attempt("page address", () => top.location.href);
attempt("change the page", () => (top.document.title = "CHANGED"));
attempt("own cookies", () => document.cookie);
attempt("past the tab", () => top.parent === top);
document.getElementById("out").textContent = JSON.stringify(out);
</script>`;

test("a frame from another site can't read or change the page around it", async ({ page }) => {
	await openIsolated(page);
	// the embedded site has a cookie of its own, from a visit as a tab
	await open(page, "https://httpbin.org/cookies/set?visitor=1");
	const frame = await host(page);
	await frame.evaluate(() => {
		document.cookie = "session=secret; path=/";
		localStorage.setItem("note", "private");
	});
	await embed(frame, testPage(PRYING));
	const out = frame.frameLocator("#embedded").locator("#out");
	await expect(out).toContainText("own cookies");
	const got = JSON.parse(await out.textContent());

	// the browser's own wall: two origins
	expect(new Set(origins(page)).size).toBe(2);
	for (const reach of ["page text", "page cookies", "page storage", "page address", "change the page"])
		expect(got[reach], reach).toBe("REFUSED");
	expect(await frame.title()).toBe("Example Domain");
	// its own site's cookies are kept apart under every site that embeds it
	expect(got["own cookies"]).toBe("");
	// and the tab's page is the top: nothing above it to reach
	expect(got["past the tab"]).toBe("true");
});

test("a frame of the page's own site stays within its reach", async ({ page }) => {
	await openIsolated(page);
	const frame = await host(page);
	await embed(frame, "https://example.com/?inner");
	await expect(frame.frameLocator("#embedded").locator("body")).toContainText(EXAMPLE);
	expect(new Set(origins(page)).size).toBe(1);
	expect(await frame.evaluate(() => document.getElementById("embedded").contentWindow.document.title)).toBe(
		"Example Domain"
	);
});

test("a frame inside a frame gets an origin of its own too", async ({ page }) => {
	await openIsolated(page);
	const frame = await host(page);
	await embed(frame, testPage(`<!doctype html><title>middle</title><iframe id="deep" src="https://example.org/"></iframe>`));
	await expect(frame.frameLocator("#embedded").frameLocator("#deep").locator("body")).toContainText(EXAMPLE);
	expect(new Set(origins(page)).size).toBe(3);
});

test("a page and a frame from another site can still write to each other", async ({ page }) => {
	await openIsolated(page);
	const frame = await host(page);
	// the page listens, as a site's script that embeds a player or a widget does
	await frame.evaluate(() => {
		window.heard = [];
		addEventListener("message", (event) => {
			if (!event.data || typeof event.data !== "object") return;
			heard.push({
				...event.data,
				origin: event.origin,
				fromTheFrame: event.source === document.getElementById("embedded").contentWindow,
			});
		});
	});
	await embed(
		frame,
		testPage(`<!doctype html><title>widget</title><script>
addEventListener("message", (event) => {
	if (!event.data || !event.data.ask) return;
	event.source.postMessage(
		{ answer: event.data.ask + "!", askedBy: event.origin, byThePage: event.source === parent },
		event.origin
	);
});
parent.postMessage({ said: "to anyone" }, "*");
parent.postMessage({ said: "to another site" }, "https://not-the-page.example");
parent.postMessage({ said: "to the page" }, "https://example.com");
</script>`)
	);
	const heard = () => frame.evaluate(() => heard.map((message) => message.said || message.answer));
	await expect.poll(heard).toEqual(["to anyone", "to the page"]);

	await frame.evaluate(() => {
		const widget = document.getElementById("embedded").contentWindow;
		widget.postMessage({ ask: "lost" }, "https://elsewhere.example");
		widget.postMessage({ ask: "ping" }, "https://httpbin.org");
	});
	await expect.poll(heard).toEqual(["to anyone", "to the page", "ping!"]);
	const messages = await frame.evaluate(() => heard);
	// each side is told the other's site, and can tell who wrote
	for (const message of messages) expect(message).toMatchObject({ origin: "https://httpbin.org", fromTheFrame: true });
	expect(messages[2]).toMatchObject({ askedBy: "https://example.com", byThePage: true });
});

test("a frame finds the frames around it by name or place, across origins", async ({ page }) => {
	await openIsolated(page);
	const frame = await host(page);
	await frame.evaluate(() => {
		window.heard = [];
		addEventListener("message", (event) => event.data && event.data.report && heard.push(event.data.report));
		// what a consent script's stub leaves for frames to find it by
		const locator = document.createElement("iframe");
		locator.name = "__tcfapiLocator";
		document.body.append(locator);
	});
	await embed(
		frame,
		testPage(`<!doctype html><title>widget</title><iframe id="deep" src="https://example.org/"></iframe><script>
const report = (what) => parent.postMessage({ report: what }, "*");
try { report("named: " + (parent.frames["__tcfapiLocator"] ? "found" : "missing")); } catch (e) { report("named: " + e.name); }
document.getElementById("deep").onload = () => {
	try { frames[0].postMessage("hi", "*"); report("its own frame: sent"); } catch (e) { report("its own frame: " + e.name); }
};
</script>`)
	);
	await expect.poll(() => frame.evaluate(() => heard)).toContain("its own frame: sent");
	expect(await frame.evaluate(() => heard)).toContain("named: found");
});

test("a link or a form in a frame, aimed at the whole tab, takes the tab there after a click", async ({ page }) => {
	await openIsolated(page);
	// (its origin's service worker first: a form's fields don't survive that origin's first load)
	await open(page, ECHO + "/get");
	const inner = testPage(`<!doctype html><title>widget</title>
<a id="up" href="https://example.org/" target="_top">open</a>
<form method="post" action="${ECHO}/post" target="_top"><input name="a" value="1"><button id="send">send</button></form>
<script>setTimeout(() => { top.location.href = "https://example.net/"; }, 300);</script>`);

	let frame = await host(page);
	await embed(frame, inner);
	const widget = () => frame.frameLocator("#embedded");
	await expect(widget().locator("#up")).toBeVisible();
	// by itself, with no click, a frame can't send the tab anywhere
	await page.waitForTimeout(1500);
	expect(await page.evaluate(() => active.url)).toBe("https://example.com/");

	await widget().locator("#up").click();
	await page.waitForFunction(() => active.url === "https://example.org/" && active.title === "Example Domain");

	frame = await host(page);
	await embed(frame, inner);
	await widget().locator("#send").click();
	await page.waitForFunction((url) => active.url === url && !active.loading, ECHO + "/post");
	expect(JSON.parse(await bodyText(await tabFrame(page))).form).toEqual({ a: ["1"] });
});

test("a form in a frame, sent to another site, arrives there with its fields", async ({ page }) => {
	await openIsolated(page);
	const frame = await host(page);
	// a payment frame posting to the bank's: the frame moves on to another site's origin
	// (a field named "submit" takes the place of the form's submit())
	await embed(
		frame,
		testPage(`<!doctype html><title>widget</title>
<form method="post" action="${ECHO}/post"><input name="a" value="1"><input name="submit" value="go"></form>
<script>HTMLFormElement.prototype.submit.call(document.forms[0]);</script>`)
	);
	const posted = () => page.frames().find((each) => decodeURIComponent(each.url()).includes(ECHO + "/post"));
	const sent = async () => {
		try {
			return JSON.parse(await bodyText(posted()));
		} catch {
			return null; // not there yet
		}
	};
	await expect.poll(async () => (await sent())?.form, { timeout: 30_000 }).toEqual({ a: ["1"], submit: ["go"] });
	// the frame's site sent it, not the bank's own page
	expect(received(await bodyText(posted()))["sec-fetch-site"]).toBe("cross-site");
});

test("a frame in a site chosen to stay signed in keeps its data when the rest is cleared", async ({ page }) => {
	await openIsolated(page);
	// a sign-in widget: its cookie lives in the origin kept for it under each page's site
	const widget = (set) =>
		testPage(`<!doctype html><title>widget</title><pre id="out"></pre><script>
${set ? 'document.cookie = "in=frame; path=/";' : ""}
document.getElementById("out").textContent = "[" + document.cookie + "]";
</script>`);
	const cookieIn = async (url, src) => {
		const frame = await host(page, url);
		await embed(frame, src);
		const out = frame.frameLocator("#embedded").locator("#out");
		await expect(out).toContainText("[");
		return out.textContent();
	};
	for (const url of ["https://example.com/", "https://example.org/"]) {
		await cookieIn(url, widget(true));
		// the service worker has it too, not only the page
		await expect.poll(() => cookieIn(url, widget(false))).toContain("in=frame");
	}

	await setSettings(page, { keep: ["example.com"] });
	await page.evaluate(() => clearAllSiteData());
	// (and a frame origin wiped whole takes a frame again)
	expect(await cookieIn("https://example.com/", widget(false))).toContain("in=frame");
	expect(await cookieIn("https://example.org/", widget(false))).toBe("[]");
});

// What a page that got around the proxy's hooks could try: a frame pointed
// straight at another origin of the app, with the browser's own DOM methods
// (borrowed from a frame Scramjet hasn't hooked).
const forge = (frame, src, id) =>
	frame.evaluate(
		([src, id]) => {
			document.body.append(document.createElement("iframe"));
			const untouched = window[window.length - 1];
			const forged = document.createElement("iframe");
			forged.id = id;
			document.body.append(forged);
			untouched.Element.prototype.setAttribute.call(forged, "src", src);
		},
		[src, id]
	);
const proxiedPath = (url) => "/scramjet/" + encodeURIComponent(url);
const shown = async (page, id) => {
	const frame = await tabFrame(page);
	return frame
		.frameLocator("#" + id)
		.locator("body")
		.innerText({ timeout: 3000 })
		.catch(() => "");
};

test("a page can't frame a site's own origin, or get into the origin kept for another page's frame", async ({ page }) => {
	await openIsolated(page);
	// example.org as a tab, signed in: its own origin holds that
	let frame = await host(page, "https://example.org/");
	await frame.evaluate(() => (document.cookie = "session=secret; path=/"));
	const labels = await page.evaluate(async () => ({
		org: await BiosSiteKey.siteKey("example.org"),
		com: await BiosSiteKey.siteKey("example.com"),
		// the origin kept for httpbin.org's pages in frames of example.com's
		kept: await BiosSiteKey.frameKey(await BiosSiteKey.siteKey("example.com"), "httpbin.org"),
		orgHere: await BiosSiteKey.frameKey(await BiosSiteKey.siteKey("example.com"), "example.org"),
	}));
	const originFor = (label) => ISOLATED_URL.replace("://", `://${label}.`);

	frame = await host(page);
	// a real frame first, so the origin kept for httpbin.org under example.com is in use
	await embed(frame, testPage(`<!doctype html><title>widget</title><p id="ok">widget</p>`));
	await expect(frame.frameLocator("#embedded").locator("#ok")).toHaveText("widget");

	// 1. the site's own origin, where its sign-in lives: only the app may frame that
	await forge(frame, originFor(labels.org) + proxiedPath("https://example.org/"), "own");
	// 2. the kept origin, entered with another site's page: it serves the one site it was made for
	await forge(
		frame,
		`${originFor(labels.kept)}/scramjet/__bios/enter?u=${encodeURIComponent(proxiedPath("https://example.org/"))}&a=${labels.com}`,
		"entered"
	);
	// 3. the same, without the way in: the address alone
	await forge(frame, originFor(labels.kept) + proxiedPath("https://example.org/"), "direct");
	await page.waitForTimeout(4000);
	// (the page's own text is what the forged frames would show)
	expect(await bodyText(frame)).toContain(EXAMPLE);
	for (const id of ["own", "entered"]) expect(await shown(page, id), id).not.toContain(EXAMPLE);
	// the address alone only moves the frame on, to the origin an ordinary frame
	// of example.org gets here: not the one asked for, and not the site's own
	const direct = await (await frame.$("#direct")).contentFrame();
	expect(new URL(direct.url()).origin).toBe(originFor(labels.orgHere));
	expect(await direct.evaluate(() => document.cookie)).toBe("");

	// 4. from another site's page: the origin kept for example.com's frames isn't for it to show
	frame = await host(page, "https://example.org/");
	await forge(frame, originFor(labels.kept) + proxiedPath(testPage(`<!doctype html><title>widget</title><p id="ok">widget</p>`)), "borrowed");
	await page.waitForTimeout(4000);
	expect(await shown(page, "borrowed")).not.toContain("widget");
});

test("a site's rule against framing holds for a frame on its own origin (the service worker's check)", async ({ page }) => {
	await openIsolated(page);
	const ruled = (host, name, value) =>
		`https://${host}/response-headers?Content-Type=text/html&${name}=${encodeURIComponent(value)}&x=FRAMED-CONTENT`;
	const frames = {
		deny: ruled("httpbin.org", "X-Frame-Options", "DENY"),
		sameOrigin: ruled("httpbin.org", "X-Frame-Options", "SAMEORIGIN"),
		elsewhere: ruled("httpbin.org", "Content-Security-Policy", "frame-ancestors https://example.org"),
		// allowed: the rule names the page around it
		named: ruled("httpbin.org", "Content-Security-Policy", "frame-ancestors https://example.com https://example.net"),
		anyone: ruled("httpbin.org", "Content-Security-Policy", "default-src *; frame-ancestors *"),
	};
	const frame = await host(page);
	for (const [id, src] of Object.entries(frames)) await embed(frame, src, id);
	const content = (id) => frame.frameLocator("#" + id).locator("html");
	for (const id of ["named", "anyone"]) await expect(content(id), id).toContainText("FRAMED-CONTENT");
	// the others have had the same time to load
	await page.waitForTimeout(3000);
	for (const id of ["deny", "sameOrigin", "elsewhere"]) await expect(content(id), id).not.toContainText("FRAMED-CONTENT");
});

test("a site's rule against framing holds in a frame whose scripts are switched off (sandbox)", async ({ page, browserName }) => {
	await openIsolated(page);
	const frame = await host(page);
	// a real frame first, so the origin kept for httpbin.org under example.com is in use
	await embed(frame, testPage(`<!doctype html><title>widget</title><p id="ok">widget</p>`));
	await expect(frame.frameLocator("#embedded").locator("#ok")).toHaveText("widget");
	const labels = await page.evaluate(async () => {
		const com = await BiosSiteKey.siteKey("example.com");
		return { com, kept: await BiosSiteKey.frameKey(com, "httpbin.org") };
	});
	const enter = (url) =>
		`${ISOLATED_URL.replace("://", `://${labels.kept}.`)}/scramjet/__bios/enter?u=${encodeURIComponent(proxiedPath(url))}&a=${labels.com}`;
	const page1 = (rule) => `https://httpbin.org/response-headers?Content-Type=text/html${rule}&x=FRAMED-CONTENT`;
	// Scramjet takes a frame's sandbox away; a page that got around its hooks keeps it,
	// and then no script of ours runs in the frame either: only the service worker is left
	await frame.evaluate(
		(frames) => {
			document.body.append(document.createElement("iframe"));
			const untouched = window[window.length - 1];
			for (const [id, sandbox, src] of frames) {
				const sandboxed = document.createElement("iframe");
				sandboxed.id = id;
				untouched.Element.prototype.setAttribute.call(sandboxed, "sandbox", sandbox);
				document.body.append(sandboxed);
				untouched.Element.prototype.setAttribute.call(sandboxed, "src", src);
			}
		},
		[
			["control", "allow-same-origin", enter(page1(""))],
			["deny", "allow-same-origin", enter(page1("&X-Frame-Options=DENY"))],
			["elsewhere", "allow-same-origin", enter(page1("&Content-Security-Policy=" + encodeURIComponent("frame-ancestors https://example.org")))],
			// with no origin of its own, a frame gets nothing of the proxy's at all
			["opaque", "", enter(page1(""))],
		]
	);
	const content = (id) => frame.frameLocator("#" + id).locator("html");
	// (Safari lets no service worker answer for a sandboxed frame: there nothing of
	// the proxy's reaches one, the page without a rule neither)
	if (browserName === "chromium") await expect(content("control")).toContainText("FRAMED-CONTENT");
	await page.waitForTimeout(browserName === "chromium" ? 2000 : 6000);
	for (const id of ["deny", "elsewhere", "opaque"]) await expect(content(id), id).not.toContainText("FRAMED-CONTENT");
});

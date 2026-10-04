// What Badger promises a page can't do, checked in a real browser through
// the real proxy. Every test also fails if a request went around the proxy
// or a page showed a dialog (see fixtures.js).

import {
	SCRIPTED_PAGE,
	expect,
	open,
	proxied,
	setSettings,
	test,
	testPage,
} from "./fixtures.js";
import { SHARED_URL } from "./env.js";

test("nothing a page loads goes around the proxy", async ({ app }) => {
	// Every way a page can reach a server. The fixture checks afterwards that
	// none of it reached the leak catcher, i.e. all of it went through Badger.
	const frame = await open(
		app,
		testPage(`<!doctype html><title>leaky</title>
<link rel="preconnect" href="https://example.org">
<link rel="prefetch" href="https://example.net/prefetch">
<img src="https://example.com/img.png">
<iframe src="https://example.org/"></iframe>
<script src="https://example.com/script.js"></script>
<video src="https://example.com/video.mp4"></video>
<script>
fetch("https://example.com/fetch").catch(() => {});
var x = new XMLHttpRequest(); x.open("GET", "https://example.com/xhr"); x.send();
navigator.sendBeacon && navigator.sendBeacon("https://example.com/beacon", "x");
try { new WebSocket("wss://example.com/socket"); } catch (e) {}
try { new EventSource("https://example.com/events"); } catch (e) {}
new Image().src = "https://example.net/pixel.gif";
document.title = "ran";
</script>`)
	);
	await expect.poll(() => frame.title()).toBe("ran");
	expect(await proxied(frame)).toEqual({ scramjet: true, badger: true });
	// give slow requests (beacon, socket, prefetch) time to show up
	await app.waitForTimeout(5000);
});

test("pages get no WebRTC, which would reveal the real IP address", async ({ app }) => {
	const frame = await open(app, "https://example.com/");
	const rtc = await frame.evaluate(() => {
		const child = document.createElement("iframe");
		document.body.append(child);
		return {
			page: typeof RTCPeerConnection,
			prefixed: typeof webkitRTCPeerConnection,
			dataChannel: typeof RTCDataChannel,
			childFrame: typeof child.contentWindow.RTCPeerConnection,
		};
	});
	expect(rtc).toEqual({
		page: "undefined",
		prefixed: "undefined",
		dataChannel: "undefined",
		childFrame: "undefined",
	});
});

test("a page can't get around the proxy through a frame of its own", async ({ app }) => {
	// A fresh frame has the browser's own fetch, WebSocket and WebRTC, without
	// Scramjet's hooks, and window[i] reaches it with no getter to hook. The
	// fixture checks that none of these requests left the proxy.
	const frame = await open(
		app,
		testPage(`<!doctype html><title>raw</title><body>
<iframe src="https://example.org/"></iframe>
<object data="about:blank" type="text/html"></object>
<iframe srcdoc="<script>parent.inSrcdoc = typeof RTCPeerConnection</script>"></iframe>
<script>
var rtc = [];
for (var i = 0; i < window.length; i++) rtc.push(typeof window[i].RTCPeerConnection);
var added = document.createElement("iframe");
document.body.appendChild(added);
var raw = window[window.length - 1];
rtc.push(typeof raw.RTCPeerConnection);
var holder = document.createElement("div");
document.body.appendChild(holder);
holder.innerHTML = "<p><iframe></iframe></p>";
rtc.push(typeof window[window.length - 1].RTCPeerConnection);
var inner = raw.document.createElement("iframe");
raw.document.body.appendChild(inner);
rtc.push(typeof raw[0].RTCPeerConnection);
try { new raw.WebSocket("wss://example.com/socket"); } catch (e) {}
try { raw.fetch("https://example.com/fetch").catch(function () {}); } catch (e) {}
new raw.Image().src = "https://example.net/pixel.gif";
setTimeout(function () {
	rtc.push(window.inSrcdoc);
	document.title = "done " + rtc.filter(function (t) { return t !== "undefined"; }).length + "/" + rtc.length;
}, 1500);
</script>`)
	);
	await expect.poll(() => frame.title()).toContain("done");
	expect(await frame.title()).toMatch(/^done 0\/[6-9]$/);
	await app.waitForTimeout(4000);
});

test("even a tapped page can't open a window or a dialog through a frame of its own", async ({ app }) => {
	// the browser's own window.open, alert and links, from a frame without
	// the proxy's hooks (the fixture fails the test on a dialog or a leak)
	const frame = await open(
		app,
		testPage(`<!doctype html><title>pop</title><body><button id="pop">pop</button>
<script>
var added = document.createElement("iframe");
added.style.cssText = "width:200px;height:60px";
document.body.appendChild(added);
var raw = window[window.length - 1];
raw.document.body.innerHTML = '<a id="out" href="https://example.org/direct" target="_blank">out</a>';
document.getElementById("pop").onclick = function () {
	var opened = null;
	try { opened = raw.open("https://example.com/popup"); } catch (e) {}
	try { raw.alert("hi"); } catch (e) {}
	document.title = opened ? "OPENED" : "refused";
};
</script>`)
	);
	await frame.click("#pop");
	await expect.poll(() => frame.title()).toBe("refused");
	await frame.frameLocator("iframe").locator("#out").click();
	await app.waitForTimeout(3000);
	expect(app.context().pages().length).toBe(1);
	expect(app.url().startsWith(SHARED_URL)).toBe(true);
});

test("pages can't open windows, show dialogs or hand off to other apps", async ({ app }) => {
	// The page tries it all by itself right after it loads, with no click or
	// tap of its own, and reports the results in its title. (The app's tap
	// that opened the page doesn't count; Playwright's evaluate() would, so
	// the page's own script makes these calls.)
	const frame = await open(
		app,
		testPage(`<!doctype html><title>popups</title>
<a id="blank" href="https://example.org/" target="_blank">new window</a>
<a id="mail" href="mailto:someone@example.com">mail</a>
<a id="tel" href="tel:+15555550100">call</a>
<button id="opener" onclick="window.open('https://example.net/')">open</button>
<script>
setTimeout(function () {
	var r = {
		open: window.open("https://example.org/") === null,
		confirm: confirm("Delete everything?"),
		prompt: prompt("Password?"),
		alert: alert("hi") === undefined,
	};
	document.getElementById("blank").click();
	document.title = "result " + JSON.stringify(r);
}, 300);
</script>`)
	);
	await expect.poll(() => frame.title()).toContain("result");
	expect(JSON.parse((await frame.title()).slice("result ".length))).toEqual({
		open: true,
		confirm: false,
		prompt: null,
		alert: true,
	});
	await app.waitForTimeout(1000);
	expect(await app.evaluate(() => tabs.length), "a script opened a tab").toBe(1);
	await frame.evaluate(() => (document.title = "popups"));

	const windows = app.context().pages().length;
	await frame.click("#mail");
	await frame.click("#tel");
	await app.waitForTimeout(1500);
	expect(await app.evaluate(() => tabs.length)).toBe(1);
	expect(await frame.title()).toBe("popups");

	// A real click still works: a _blank link, or window.open from a click,
	// becomes a Badger tab, never a browser window.
	await frame.click("#blank");
	await app.waitForFunction(() => tabs.length === 2);
	await app.evaluate(() => selectTab(tabs[0]));
	await app.waitForTimeout(500);
	await frame.click("#opener");
	await app.waitForFunction(() => tabs.length === 3);
	expect(app.context().pages().length).toBe(windows);
});

test("a page can't take over the app's window", async ({ app }) => {
	await open(
		app,
		testPage(`<!doctype html><title>escape</title>
<script>setTimeout(function () { try { top.location.href = "https://example.org/"; } catch (e) {} }, 300);</script>`)
	);
	await app.waitForTimeout(4000);
	// still the app's own address, with the app running
	expect(app.url().startsWith(SHARED_URL)).toBe(true);
	await app.waitForFunction(() => window.__biosShell === true && typeof go === "function");
});

test("a page whose stylesheets set cookies still finishes loading", async ({ app }) => {
	// Scramjet's worker waits for the page to confirm each cookie, and the
	// page's parser waits for the stylesheet: Wikipedia never finished loading
	const frame = await open(app, "https://www.wikipedia.org/");
	await expect.poll(() => frame.evaluate(() => document.readyState)).toBe("complete");
});

test("the new tab's search bar takes a click, text and Enter", async ({ app }) => {
	await app.click("#home-input");
	await app.keyboard.type("example.com");
	await app.keyboard.press("Enter");
	await app.waitForFunction(() => active.url === "https://example.com/" && !active.loading);
});

test("Windows browsers are offered the desktop app; phones aren't", async ({ app, isMobile }) => {
	const link = app.locator("#get-app a");
	if (isMobile) return expect(link).toBeHidden();
	// Playwright's Chromium is Windows here, Linux in CI
	test.skip(!/Windows/.test(await app.evaluate(() => navigator.userAgent)), "Windows only");
	await expect(link).toBeVisible();
	expect(await link.getAttribute("href")).toMatch(/releases\/latest\/download\/Badger-Setup\.exe$/);
});

test("HTTPS-Only opens the secure version of a site", async ({ app }) => {
	await open(app, "http://example.com/");
	await app.waitForFunction(() => active.url === "https://example.com/");
});

test("HTTPS-Only warns before a site without https, and continues on request", async ({ app }) => {
	const frame = await open(app, "http://httpforever.com/");
	await expect.poll(() => frame.title()).toBe("This site isn't secure");
	await frame.click("#go");
	await expect.poll(() => frame.title()).toContain("HTTP Forever");
});

test("a link can't click through a warning for someone", async ({ app }) => {
	// the warning's own button carries a token; this made-up address doesn't
	const page = `${SHARED_URL}/scramjet/${encodeURIComponent("http://httpforever.com/")}`;
	await app.evaluate((src) => (active.frame.src = src), `${SHARED_URL}/scramjet/__bios/go?do=http&u=${encodeURIComponent(page)}`);
	const frame = app.frame({ name: await app.evaluate(() => active.frame.name) });
	await expect.poll(() => frame.title()).toBe("This site isn't secure");
});

test("Standard: a page's own scripts run (control for the next tests)", async ({ app }) => {
	await setSettings(app, { httpsOnly: false, level: "standard" });
	const frame = await open(app, testPage(SCRIPTED_PAGE, "http"));
	await expect.poll(() => frame.title()).not.toBe("ORIGINAL");
});

test("Safer: no scripts from http pages, the proxy still runs", async ({ app }) => {
	await setSettings(app, { httpsOnly: false, level: "safer" });
	const frame = await open(app, testPage(SCRIPTED_PAGE, "http"));
	await expect.poll(() => frame.locator("#t").textContent()).toBe("test");
	await app.waitForTimeout(2000);
	expect(await frame.title()).toBe("ORIGINAL");
	expect(await proxied(frame)).toEqual({ scramjet: true, badger: true });
});

test("Safer: https pages keep their scripts, but lose WebGL, WebGPU and web fonts", async ({ app }) => {
	await setSettings(app, { level: "safer" });
	const frame = await open(app, testPage(SCRIPTED_PAGE));
	await expect.poll(() => frame.title()).not.toBe("ORIGINAL");
	const gpu = await frame.evaluate(() => ({
		webgl: document.createElement("canvas").getContext("webgl"),
		webgl2: document.createElement("canvas").getContext("webgl2"),
		webgpu: typeof navigator.gpu,
		canvas2d: !!document.createElement("canvas").getContext("2d"),
	}));
	expect(gpu).toEqual({ webgl: null, webgl2: null, webgpu: "undefined", canvas2d: true });
	expect(await loadFont(frame)).toBe("blocked");

	await setSettings(app, { level: "standard" });
	const again = await open(app, testPage(SCRIPTED_PAGE + "<!-- standard -->"));
	await expect.poll(() => again.title()).not.toBe("ORIGINAL");
	expect(await loadFont(again)).toBe("loaded");
});

test("Safest: no site's own scripts, even over https", async ({ app }) => {
	await setSettings(app, { level: "safest" });
	const frame = await open(app, testPage(SCRIPTED_PAGE));
	await expect.poll(() => frame.locator("#t").textContent()).toBe("test");
	await app.waitForTimeout(2000);
	expect(await frame.title()).toBe("ORIGINAL");
	expect(await proxied(frame)).toEqual({ scramjet: true, badger: true });
});

// data: URLs carry the page's own code as much as an inline script does.
for (const [name, body] of [
	["script", `<script src="data:text/javascript,document.title='RAN'"></script>`],
	["module script", `<script type="module" src="data:text/javascript,document.title='RAN'"></script>`],
	["frame", `<iframe src="data:text/html,<script>parent.document.title='RAN'</script>"></iframe>`],
	["page", `<meta http-equiv="refresh" content="0;url=data:text/html,<title>ORIGINAL</title><script>document.title='RAN'</script><p id=t>test</p>">`],
])
	test(`Safest: no scripts from a data: ${name} either`, async ({ app }) => {
		await setSettings(app, { level: "safest" });
		const frame = await open(app, testPage(`<!doctype html><title>ORIGINAL</title>${body}<p id="t">test</p>`));
		await expect.poll(() => frame.locator("#t").textContent()).toBe("test");
		await app.waitForTimeout(2000);
		expect(await frame.title()).toBe("ORIGINAL");
		expect(await proxied(frame)).toEqual({ scramjet: true, badger: true });
	});

test("ad and tracker requests are blocked", async ({ app }) => {
	await expect
		.poll(async () => (await (await app.request.get(`${SHARED_URL}/filters/status`)).json()).updatedAt, {
			message: "block lists downloaded",
			timeout: 110_000,
		})
		.toBeTruthy();
	const frame = await open(
		app,
		testPage(`<!doctype html><title>ads</title>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
<img src="https://www.google-analytics.com/collect?v=1&t=pageview">
<img src="https://ad.doubleclick.net/ddm/ad/x">`)
	);
	await expect.poll(() => frame.title()).toBe("ads");
	// the service worker reports what it blocked to the app every few seconds
	await expect.poll(() => app.evaluate(() => blockedThisWeek()), { timeout: 20_000 }).toBeGreaterThan(0);
});

test("an embedded player's ads get no tab and can't take the player's place", async ({ app }) => {
	// like a streaming site: the player is another page in a frame, and its ad
	// script opens a pop-up on a tap, or sends the player's own frame to the ad
	const player = testPage(`<!doctype html><title>player</title>
<button id="popup" onclick="window.open('https://ad.doubleclick.net/ddm/pop')">pop-up ad</button>
<button id="redirect" onclick="location.href='https://ad.doubleclick.net/ddm/redirect'">redirect ad</button>
<button id="link" onclick="window.open('https://example.org/')">a real link</button>`);
	await open(app, testPage(`<!doctype html><title>site</title><iframe src="${player}" width="300" height="200"></iframe>`));
	const frame = app.frameLocator("#frames iframe:visible").frameLocator("iframe");
	await frame.locator("#popup").click();
	await frame.locator("#redirect").click();
	// time for a tab to open or the frame to leave, if either were going to
	await app.waitForTimeout(3000);
	expect(await app.evaluate(() => tabs.length)).toBe(1);
	await expect(frame.locator("#redirect")).toBeVisible();
	// a pop-up that isn't an ad still opens as a tab
	await frame.locator("#link").click();
	await app.waitForFunction(() => tabs.length === 2 && active.url === "https://example.org/");
});

test("New identity: cookies, history, tabs and exceptions go; bookmarks and settings stay", async ({ app }) => {
	await setSettings(app, { level: "safer" });
	let frame = await open(app, "https://example.com/");
	await frame.evaluate(() => (document.cookie = "identity=old; path=/"));
	expect(await frame.evaluate(() => document.cookie)).toContain("identity=old");
	await app.evaluate(() => toggleBookmark());

	frame = await open(app, "http://httpforever.com/");
	await expect.poll(() => frame.title()).toBe("This site isn't secure");
	await frame.click("#go");
	await expect.poll(() => frame.title()).toContain("HTTP Forever");

	// answer its "are you sure?" (the fixture fails tests on page dialogs,
	// and this one is the app's own)
	await app.evaluate(() => {
		window.confirm = () => true;
		newIdentity();
	});
	await app.waitForFunction(() => typeof go === "function" && !!active && tabs.length === 1 && !active.url, null, {
		timeout: 60_000,
	});
	await app.evaluate(() => startup.then(ensureReady));
	expect(
		await app.evaluate(async () => ({
			history: readEntries(HISTORY).length,
			bookmarks: readEntries(BOOKMARKS).length,
			level: (await loadSettings()).level,
		}))
	).toEqual({ history: 0, bookmarks: 1, level: "safer" });

	frame = await open(app, "https://example.com/");
	expect(await frame.evaluate(() => document.cookie)).toBe("");
	frame = await open(app, "http://httpforever.com/");
	await expect.poll(() => frame.title()).toBe("This site isn't secure");
});

/** Loads a web font the browser hasn't cached yet. */
function loadFont(frame) {
	return frame.evaluate(async (bust) => {
		const url = `https://fonts.gstatic.com/s/roboto/v30/KFOlCnqEu92Fr1MmEU9fBBc4.woff2?${bust}`;
		try {
			await new FontFace("probe" + bust, `url(${url})`).load();
			return "loaded";
		} catch {
			return "blocked";
		}
	}, String(Date.now()) + Math.random());
}

test("the address bar follows a tab to a page that isn't HTML", async ({ app }) => {
	const frame = await open(app, testPage('<title>links</title><a id="json" href="https://httpbingo.org/get?x=1">data</a>'));
	await frame.evaluate(() => document.getElementById("json").click());
	await app.waitForFunction(() => active.url === "https://httpbingo.org/get?x=1" && !active.title);
	await expect(app.locator("#bar-input")).toHaveValue("httpbingo.org");
});

test("a site whose certificate is bad gets a warning with no way past it", async ({ app }) => {
	for (const [host, problem] of [
		["expired.badssl.com", "has expired"],
		["wrong.host.badssl.com", "belongs to a different address"],
		["self-signed.badssl.com", "isn't signed by an authority"],
	]) {
		const frame = await open(app, `https://${host}/`);
		await expect(frame.locator("body"), host).toContainText(problem);
		await expect(frame.locator("body"), host).toContainText("wasn't opened");
		await expect(frame.locator("#go"), host).toHaveCount(0);
	}
});

test("a site that can't be reached says so, and offers to try again", async ({ app }) => {
	const frame = await open(app, "https://no-such-site.badger-test.invalid/");
	await expect(frame.locator("h1")).toHaveText("Couldn't open this page");
	await expect(frame.locator("#go")).toHaveText("Try again");
});

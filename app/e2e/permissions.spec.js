// A site asking for the location, the camera or the microphone. The app asks
// the person first, naming the site; the location it reads and hands over
// itself, and for the camera the browser asks too (page.js, index.js).

import { expect, test } from "./fixtures.js";
import { open, testPage } from "./fixtures.js";

// (the browser's own answer, for the test: yes, from Parliament Square)
test.use({ permissions: ["geolocation"], geolocation: { latitude: 51.5007, longitude: -0.1246 } });

const MAP = testPage(`<!doctype html><title>map</title><script>
window.where = () => new Promise((resolve) =>
	navigator.geolocation.getCurrentPosition(
		(p) => resolve(p.coords.latitude + "," + p.coords.longitude),
		(e) => resolve("refused " + e.code)
	)
);
// a frame inside the page asks too
window.whereInFrame = () => {
	const frame = document.body.appendChild(document.createElement("iframe"));
	return new Promise((resolve) =>
		frame.contentWindow.navigator.geolocation.getCurrentPosition(() => resolve("given"), (e) => resolve("refused " + e.code))
	);
};
</script>`);

test("a page gets the location only once the person lets it, in the app", async ({ app }) => {
	const frame = await open(app, MAP);
	let answer = frame.evaluate(() => window.where());
	await expect(app.locator("#ask-text")).toHaveText("httpbin.org wants to use your location.");
	await app.click("#ask-no");
	expect(await answer).toBe("refused 1");
	// kept for the site: asked again, refused without a word
	expect(await frame.evaluate(() => window.where())).toBe("refused 1");
	await expect(app.locator("#ask")).toBeHidden();

	// forgotten from the menu, then let
	await app.evaluate(() => openSheet());
	await expect(app.locator("#allowed-text")).toHaveText("Location not allowed");
	await app.click("#allowed-forget");
	await expect(app.locator("#allowed-row")).toBeHidden();
	await app.click("#sheet-close");
	answer = frame.evaluate(() => window.where());
	await app.click("#ask-yes");
	expect(await answer).toBe("51.5007,-0.1246");
	// a frame inside the page gets nothing, as in a browser
	expect(await frame.evaluate(() => window.whereInFrame())).toBe("refused 1");
	// and it all goes with the site data
	await app.evaluate(() => clearAllSiteData());
	const again = await open(app, MAP);
	answer = again.evaluate(() => window.where());
	await expect(app.locator("#ask")).toBeVisible();
	await app.click("#ask-no");
	expect(await answer).toBe("refused 1");
});

test("the camera: the app asks first, naming the site, then the browser", async ({ app, browserName }) => {
	test.skip(browserName !== "chromium", "a made-up camera in Chromium only");
	const frame = await open(
		app,
		testPage(`<!doctype html><title>camera</title><script>
window.film = () => navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(
	(stream) => "tracks " + stream.getTracks().map((t) => t.kind).sort().join(" "),
	(e) => e.name
);
</script>`)
	);
	let answer = frame.evaluate(() => window.film());
	await expect(app.locator("#ask-text")).toHaveText("httpbin.org wants to use your camera and microphone.");
	await app.click("#ask-yes");
	expect(await answer).toBe("tracks audio video");
	// still no WebRTC to send it anywhere around the proxy
	expect(await frame.evaluate(() => typeof RTCPeerConnection)).toBe("undefined");
	// another site asks for itself
	const other = await open(app, `https://example.com/`);
	answer = other.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then(() => "given", (e) => e.name));
	await expect(app.locator("#ask-text")).toHaveText("example.com wants to use your camera.");
	await app.click("#ask-no");
	expect(await answer).toBe("NotAllowedError");
});

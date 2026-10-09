// "Safer": what a page can learn about the device to tell it from others.
// The test browser is set somewhere unusual, so an answer that leaks shows.

import { expect, test } from "./fixtures.js";
import { open, setSettings, testPage } from "./fixtures.js";

// (a zone with one name and a half-hour offset)
test.use({ timezoneId: "Asia/Tehran", locale: "de-DE" });

// what a script can ask about the device, without drawing anything
const ask = (frame) =>
	frame.evaluate(() => ({
		language: navigator.language,
		languages: navigator.languages.join(),
		cores: navigator.hardwareConcurrency,
		zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		locale: Intl.NumberFormat().resolvedOptions().locale,
		offset: new Date().getTimezoneOffset(),
		// every way to turn a time into text or numbers, and text back into a time
		text: new Date(0).toString(),
		// (newer browsers put a narrow space before AM)
		localText: new Date(0).toLocaleString().replace(/\s/g, " "),
		number: (1234.5).toLocaleString(),
		hours: new Date(Date.UTC(2026, 0, 1, 13)).getHours(),
		midnight: new Date(2026, 0, 1).getTime() - Date.UTC(2026, 0, 1),
		parsed: new Date("2026-01-01T00:00:00").getTime() - Date.UTC(2026, 0, 1),
		parsedLoose: Date.parse("Jan 1 2026 00:00:00") - Date.UTC(2026, 0, 1),
		// a time that names its zone means the same everywhere
		zoned: Date.parse("2026-01-01T00:00:00+02:00") - Date.UTC(2025, 11, 31, 22),
		isoDay: new Date("2026-01-01").getTime() - Date.UTC(2026, 0, 1),
		// a frame the page makes for itself gives the same answers
		inFrame: (() => {
			const frame = document.body.appendChild(document.createElement("iframe"));
			return frame.contentWindow.Intl.DateTimeFormat().resolvedOptions().timeZone + " " + frame.contentWindow.navigator.language;
		})(),
	}));

const EVERYONE = {
	language: "en-US",
	languages: "en-US,en",
	cores: 4,
	zone: "UTC",
	locale: "en-US",
	offset: 0,
	text: "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)",
	localText: "1/1/1970, 12:00:00 AM",
	number: "1,234.5",
	hours: 13,
	midnight: 0,
	parsed: 0,
	parsedLoose: 0,
	zoned: 0,
	isoDay: 0,
	inFrame: "UTC en-US",
};

test("Safer: scripts get everyone's answers about language, time zone and processor", async ({ app }) => {
	// the control: at Standard the device's own answers come through
	const own = await ask(await open(app, testPage("<!doctype html><title>own</title><p>page</p>")));
	expect(own).toMatchObject({ language: "de-DE", zone: "Asia/Tehran", offset: -210, midnight: -210 * 60_000, inFrame: "Asia/Tehran de-DE" });

	await setSettings(app, { level: "safer" });
	expect(await ask(await open(app, testPage("<!doctype html><title>everyone</title><p>page</p>")))).toEqual(EVERYONE);
});

// A drawing and a sound, read back the ways fingerprinting scripts do.
const DRAWS = `<!doctype html><title>draws</title><canvas id="c" width="220" height="60"></canvas><script>
const c = document.getElementById("c").getContext("2d");
c.fillStyle = "#f60"; c.fillRect(10, 5, 120, 40);
c.fillStyle = "#069"; c.font = "18px Arial"; c.fillText("Badger, 123 <canvas>", 4, 30);
</script>`;

const readBack = (frame) =>
	frame.evaluate(async () => {
		const canvas = document.getElementById("c");
		const pixels = () => Array.from(canvas.getContext("2d").getImageData(0, 0, 220, 60).data);
		// (the build of Safari's engine these tests run on Windows has no Web
		// Audio: there the sound half goes unchecked)
		let samples = () => null;
		if (window.OfflineAudioContext) {
			const context = new OfflineAudioContext(1, 5000, 44100);
			const tone = context.createOscillator();
			tone.type = "triangle";
			tone.frequency.value = 1000;
			tone.connect(context.destination);
			tone.start();
			const sound = await context.startRendering();
			samples = () => Array.from(sound.getChannelData(0).slice(4000, 5000));
		}
		const blob = await new Promise((resolve) => canvas.toBlob(resolve));
		return {
			url: canvas.toDataURL(),
			urlAgain: canvas.toDataURL(),
			blobBytes: blob.size,
			pixels: pixels(),
			pixelsAgain: pixels(),
			// part of the canvas, read by itself, agrees with the whole
			corner: Array.from(canvas.getContext("2d").getImageData(100, 20, 50, 20).data),
			samples: samples(),
			samplesAgain: samples(),
		};
	});

const differing = (a, b) => a.reduce((count, value, i) => count + (value !== b[i] ? 1 : 0), 0);

test("what a canvas or a sound reads back can't be the device's signature", async ({ app }) => {
	// the control: a site with blocking switched off gets the device's own
	await setSettings(app, { allow: ["httpbin.org"] });
	const clean = await readBack(await open(app, testPage(DRAWS)));
	// Standard: every other site, as in Brave
	await setSettings(app, { allow: [] });
	const first = await readBack(await open(app, testPage(DRAWS + "<!-- first -->")));
	await setSettings(app, { level: "safer" });
	const second = await readBack(await open(app, testPage(DRAWS + "<!-- second -->")));

	for (const seen of [first, second]) {
		// not the device's own picture or sound…
		expect(seen.url).not.toBe(clean.url);
		expect(seen.pixels).not.toEqual(clean.pixels);
		// …but nearly: two pixels a row, by the smallest step
		const changed = differing(seen.pixels, clean.pixels);
		expect(changed).toBeGreaterThan(20);
		expect(changed).toBeLessThanOrEqual(120);
		expect(Math.max(...seen.pixels.map((value, i) => Math.abs(value - clean.pixels[i])))).toBe(1);
		if (clean.samples) {
			// and sound moved by a ten-millionth
			expect(seen.samples).not.toEqual(clean.samples);
			expect(Math.max(...seen.samples.map((value, i) => Math.abs(value - clean.samples[i])))).toBeLessThan(1e-6);
		}
		// the same each time within the page, so asking twice doesn't give the noise away
		expect(seen.urlAgain).toBe(seen.url);
		expect(seen.pixelsAgain).toEqual(seen.pixels);
		expect(seen.samplesAgain).toEqual(seen.samples);
		const whole = [];
		for (let y = 20; y < 40; y++) whole.push(...seen.pixels.slice((y * 220 + 100) * 4, (y * 220 + 150) * 4));
		expect(seen.corner).toEqual(whole);
	}
	// and different on the next page
	expect(second.url).not.toBe(first.url);
	if (clean.samples) expect(second.samples).not.toEqual(first.samples);
});

// What a script can ask from inside a worker, a page's own (a blob:) or one
// from an address: the same as the page answers.
const WORKERS = `<!doctype html><title>workers</title><script>
const code = \`postMessage({
	cores: navigator.hardwareConcurrency,
	languages: navigator.languages.join(),
	language: navigator.language,
	zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	gpc: navigator.globalPrivacyControl === true,
})\`;
const ask = (worker) => new Promise((resolve) => (worker.onmessage = (e) => resolve(e.data)));
Promise.all([
	ask(new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })))),
	ask(new Worker("data:text/javascript," + encodeURIComponent(code))),
]).then(([blob, data]) => (document.title = "done " + JSON.stringify({ blob, data })));
</script>`;

const workerAnswers = async (frame) => {
	await expect.poll(() => frame.title(), { timeout: 20_000 }).toMatch(/^done /);
	return JSON.parse((await frame.title()).slice(5));
};

test("workers get the page's answers too", async ({ app }) => {
	const standard = await workerAnswers(await open(app, testPage(WORKERS)));
	for (const answers of Object.values(standard)) {
		expect(answers).toMatchObject({ cores: 4, zone: "Asia/Tehran", gpc: true });
		// one language, not the list (Chromium's test locale doesn't reach
		// workers, so which one depends on the test browser)
		expect(answers.languages).toBe(answers.language);
	}

	await setSettings(app, { level: "safer" });
	const safer = await workerAnswers(await open(app, testPage(WORKERS + "<!-- safer -->")));
	for (const answers of Object.values(safer))
		expect(answers).toEqual({ cores: 4, languages: "en-US,en", language: "en-US", zone: "UTC", gpc: true });
});

test("the battery, the storage allowance and the graphics card say nothing", async ({ app }) => {
	const frame = await open(app, testPage("<!doctype html><title>device</title><p>page</p>"));
	const answers = await frame.evaluate(async () => {
		const gl = document.createElement("canvas").getContext("webgl");
		const info = gl && gl.getExtension("WEBGL_debug_renderer_info");
		const battery = navigator.getBattery ? await navigator.getBattery() : null;
		const { quota } = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
		return {
			battery: battery && { level: battery.level, charging: battery.charging },
			quota,
			renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) === gl.getParameter(gl.RENDERER) : true,
			vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) === gl.getParameter(gl.VENDOR) : true,
		};
	});
	if (answers.battery) expect(answers.battery).toEqual({ level: 1, charging: true });
	if (answers.quota !== undefined) expect(answers.quota).toBe(4 * 1024 ** 3);
	expect(answers.renderer).toBe(true);
	expect(answers.vendor).toBe(true);
});

test("Safer: the screen is the page's size, rounded", async ({ app }) => {
	await setSettings(app, { level: "safer" });
	const frame = await open(app, testPage("<!doctype html><title>screen</title><p>page</p>"));
	const seen = await frame.evaluate(() => ({
		width: screen.width,
		height: screen.height,
		availWidth: screen.availWidth,
		inner: [innerWidth, innerHeight],
	}));
	expect(seen.width % 50).toBe(0);
	expect(seen.height % 50).toBe(0);
	expect(seen.availWidth).toBe(seen.width);
	expect(seen.width).toBeLessThanOrEqual(seen.inner[0]);
	expect(seen.width).toBeGreaterThan(seen.inner[0] - 50);
});

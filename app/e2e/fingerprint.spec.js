// "Safer": what a page can learn about the device to tell it from others.
// The test browser is set somewhere unusual, so an answer that leaks shows.

import { expect, test } from "./fixtures.js";
import { open, setSettings, tabFrame, testPage } from "./fixtures.js";

// (a zone with one name and a half-hour offset, and a screen bigger than the window)
test.use({ timezoneId: "Asia/Tehran", locale: "de-DE", screen: { width: 1920, height: 1200 } });

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

test("Safer: what a canvas or a sound reads back can't be the device's signature", async ({ app }) => {
	// (the device's own: Standard adds noise of its own while blocking is on)
	await setSettings(app, { allow: ["httpbin.org"] });
	const clean = await readBack(await open(app, testPage(DRAWS)));
	await setSettings(app, { allow: [], level: "safer" });
	const first = await readBack(await open(app, testPage(DRAWS + "<!-- first -->")));
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

/** What a worker started from the page says about the device: one from a blob, one from a site. */
const inWorkers = (frame) =>
	frame.evaluate(async () => {
		const code = `postMessage([navigator.language, navigator.hardwareConcurrency, Intl.DateTimeFormat().resolvedOptions().timeZone, new Date(0).getTimezoneOffset()].join())`;
		const ask = (url) =>
			new Promise((resolve) => {
				const worker = new Worker(url);
				worker.onmessage = (event) => resolve(event.data);
				worker.onerror = (event) => resolve("error: " + event.message);
			});
		return [
			await ask(URL.createObjectURL(new Blob([code], { type: "text/javascript" }))),
			await ask(
				`https://httpbingo.org/base64/${btoa(code).replace(/\+/g, "-").replace(/\//g, "_")}?content-type=text/javascript`
			),
		];
	});

test("Safer: a worker the page starts gets everyone's answers too", async ({ app }) => {
	// (the control: the device's own zone; Playwright's language doesn't reach Chromium's workers)
	const own = await inWorkers(await open(app, testPage("<!doctype html><title>own</title><p>page</p>")));
	expect(own[0]).toMatch(/^[\w-]+,\d+,Asia\/Tehran,-210$/);
	expect(own[1]).toBe(own[0]);
	await setSettings(app, { level: "safer" });
	expect(await inWorkers(await open(app, testPage("<!doctype html><title>everyone</title><p>page</p>")))).toEqual([
		"en-US,4,UTC,0",
		"en-US,4,UTC,0",
	]);
});

// The screen, and the fonts installed: what measuring text and a canvas give away.
const looks = (frame) =>
	frame.evaluate(() => {
		const width = (family) => {
			const span = Object.assign(document.createElement("span"), { textContent: "mmmmmmmmmmlli" });
			span.style.cssText = "font-size:72px";
			span.style.fontFamily = family;
			document.body.append(span);
			const measured = span.offsetWidth;
			span.remove();
			return measured;
		};
		const context = document.createElement("canvas").getContext("2d");
		context.font = "20px 'Times New Roman', serif";
		return {
			screen: screen.width === innerWidth && screen.height === innerHeight,
			deviceQuery: matchMedia(`(device-width: ${innerWidth}px)`).matches,
			widths: new Set(["monospace", "serif", "'Courier New', monospace", "'Arial Black', sans-serif"].map(width)).size,
			canvasFont: context.font,
		};
	});

test("Safer: the screen is the window, and the fonts on the device can't be told apart", async ({ app }) => {
	// (the control; Chromium's emulation already answers the device's width with the window's)
	const own = await looks(await open(app, testPage("<!doctype html><title>own</title><p>page</p>")));
	expect(own.screen).toBe(false);
	expect(own.widths).toBeGreaterThan(1);
	await setSettings(app, { level: "safer" });
	expect(await looks(await open(app, testPage("<!doctype html><title>everyone</title><p>page</p>")))).toEqual({
		screen: true,
		deviceQuery: true,
		widths: 1,
		canvasFont: "20px serif",
	});
});

const gpuName = (frame) =>
	frame.evaluate(() => {
		const gl = document.createElement("canvas").getContext("webgl");
		const info = gl?.getExtension("WEBGL_debug_renderer_info");
		return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
	});

test("Standard: a canvas, a sound and WebGL give no signature either, unless blocking is off for the site", async ({ app }) => {
	await setSettings(app, { allow: ["httpbin.org"] });
	const clean = await readBack(await open(app, testPage(DRAWS)));
	const realGpu = await gpuName(await tabFrame(app));
	await setSettings(app, { allow: [] });
	const first = await readBack(await open(app, testPage(DRAWS + "<!-- first -->")));
	expect(first.url).not.toBe(clean.url);
	expect(differing(first.pixels, clean.pixels)).toBeGreaterThan(20);
	expect(differing(first.pixels, clean.pixels)).toBeLessThanOrEqual(120);
	if (clean.samples) expect(first.samples).not.toEqual(clean.samples);
	// the graphics chip goes unnamed (when this browser has WebGL to ask)
	if (realGpu) expect(await gpuName(await tabFrame(app))).toBe("WebKit WebGL");
	// and none of the device's own answers change at Standard
	expect(await (await tabFrame(app)).evaluate(() => navigator.language)).toBe("de-DE");
});

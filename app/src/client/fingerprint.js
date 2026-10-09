// Fingerprinting protection: what a script learns about the device, made the
// same as everyone's or blurred, so it can't serve as the device's signature.
// Shared by page.js (every page and frame) and worker.js (every worker a page
// starts), so a script gets the same answers wherever it asks.
//
// Two levels, as in Brave: "standard" (on for every site but those with
// blocking switched off) changes nothing a site needs to work; "safer" (the
// Safer and Safest security levels) also gives one language, the time in UTC,
// a screen the size of the page, and no WebGL or WebGPU.
// ponytail: page script against page script, like the WebRTC block. Not
// covered: the fonts installed (a script can measure them) and what CSS media
// queries say about the screen. Tor Browser does all of it in the browser.

/**
 * @param {Window | WorkerGlobalScope} scope a window, or a worker's global
 * @param {"standard" | "safer"} level
 */
export function protect(scope, level) {
	if (scope.__biosProtected) return;
	try {
		Object.defineProperty(scope, "__biosProtected", { value: level });
	} catch {
		return;
	}
	commonAnswers(scope);
	noisyCanvas(scope);
	noisySound(scope);
	quietGraphicsCard(scope);
	if (level !== "safer") return;
	noGpu(scope);
	everyonesLanguage(scope);
	utcClock(scope);
	pageSizedScreen(scope);
}

// For the noise below: one draw for this page and the frames it writes. What
// a script reads back stays the same within the page (reading twice doesn't
// give the noise away) and is different on the next page.
const NOISE = crypto.getRandomValues(new Uint32Array(1))[0];
function mix(n) {
	let h = Math.imul(NOISE ^ n, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	return (h ^ (h >>> 16)) >>> 0;
}

function answer(object, name, value) {
	if (!object) return;
	try {
		Object.defineProperty(object, name, { get: () => value, enumerable: true, configurable: true });
	} catch {
		// not there, or locked
	}
}

function patch(object, name, value) {
	if (!object || typeof object[name] !== "function") return;
	try {
		Object.defineProperty(object, name, { value, writable: true, configurable: true });
	} catch {
		// locked
	}
}

const navigatorOf = (scope) => (scope.Navigator || scope.WorkerNavigator)?.prototype;

/**
 * Answers that are the same on most devices, where the real one would narrow
 * a device down: a common processor count and memory size, one language (the
 * first, as Brave does; the whole list says more than any one entry), a
 * battery that is always full, and the same storage allowance everywhere (its
 * size follows the disk's). DuckDuckGo's content-scope-scripts (Apache-2.0)
 * answer the battery and the storage allowance the same way.
 * @param {Window | WorkerGlobalScope} scope
 */
function commonAnswers(scope) {
	const nav = navigatorOf(scope);
	if (!nav) return;
	answer(nav, "hardwareConcurrency", 4);
	if ("deviceMemory" in nav) answer(nav, "deviceMemory", 8);
	try {
		const first = scope.navigator.language;
		if (first) answer(nav, "languages", Object.freeze([first]));
	} catch {
		// no navigator here
	}
	if (typeof nav.getBattery === "function") {
		const battery = Object.freeze({
			charging: true,
			chargingTime: 0,
			dischargingTime: Infinity,
			level: 1,
			onchargingchange: null,
			onchargingtimechange: null,
			ondischargingtimechange: null,
			onlevelchange: null,
			addEventListener() {},
			removeEventListener() {},
			dispatchEvent: () => true,
		});
		patch(nav, "getBattery", function getBattery() {
			return Promise.resolve(battery);
		});
	}
	const QUOTA = 4 * 1024 ** 3;
	const storage = scope.StorageManager?.prototype;
	const estimate = storage?.estimate;
	if (typeof estimate === "function")
		patch(storage, "estimate", function () {
			return estimate.call(this).then(
				(found) => ({ usage: Math.min(Number(found?.usage) || 0, QUOTA), quota: QUOTA }),
				() => ({ usage: 0, quota: QUOTA })
			);
		});
	const temporary = scope.navigator?.webkitTemporaryStorage;
	if (temporary && typeof temporary.queryUsageAndQuota === "function") {
		const real = temporary.queryUsageAndQuota.bind(temporary);
		patch(temporary, "queryUsageAndQuota", (done, failed) =>
			real((usage) => done && done(Math.min(usage, QUOTA), QUOTA), failed)
		);
	}
}

/**
 * WebGL names the graphics card through an extension (WEBGL_debug_renderer_info):
 * scripts get the generic names WebGL gives everyone instead.
 * @param {Window | WorkerGlobalScope} scope
 */
function quietGraphicsCard(scope) {
	const UNMASKED_VENDOR = 0x9245;
	const UNMASKED_RENDERER = 0x9246;
	const VENDOR = 0x1f00;
	const RENDERER = 0x1f01;
	for (const Context of [scope.WebGLRenderingContext, scope.WebGL2RenderingContext]) {
		const proto = Context?.prototype;
		const real = proto?.getParameter;
		if (typeof real !== "function") continue;
		patch(proto, "getParameter", function getParameter(name) {
			if (name === UNMASKED_VENDOR) return real.call(this, VENDOR);
			if (name === UNMASKED_RENDERER) return real.call(this, RENDERER);
			return real.apply(this, arguments);
		});
	}
}

/**
 * "Safer": one language for everyone, the same as the Accept-Language
 * shield.js sends.
 * @param {Window | WorkerGlobalScope} scope
 */
function everyonesLanguage(scope) {
	const nav = navigatorOf(scope);
	answer(nav, "language", "en-US");
	answer(nav, "languages", Object.freeze(["en-US", "en"]));
}

/**
 * "Safer": the screen is as big as the page, in steps of 50 pixels, as Tor
 * Browser's rounded windows are: the real one would say which phone it is.
 * The page's own size is no secret: it's where the page draws.
 * @param {Window} win
 */
function pageSizedScreen(win) {
	const proto = win.Screen?.prototype;
	if (!proto) return;
	const top = () => {
		try {
			return win.__biosTabWindow || win;
		} catch {
			return win;
		}
	};
	const width = () => Math.max(50, Math.floor((top().innerWidth || 1000) / 50) * 50);
	const height = () => Math.max(50, Math.floor((top().innerHeight || 700) / 50) * 50);
	for (const [name, get] of [
		["width", width],
		["height", height],
		["availWidth", width],
		["availHeight", height],
		["availLeft", () => 0],
		["availTop", () => 0],
		["colorDepth", () => 24],
		["pixelDepth", () => 24],
	])
		try {
			Object.defineProperty(proto, name, { get, enumerable: true, configurable: true });
		} catch {
			// locked
		}
	for (const [name, get] of [
		["outerWidth", () => top().innerWidth],
		["outerHeight", () => top().innerHeight],
		["screenX", () => 0],
		["screenY", () => 0],
		["screenLeft", () => 0],
		["screenTop", () => 0],
	])
		try {
			Object.defineProperty(win, name, { get, enumerable: true, configurable: true });
		} catch {
			// locked
		}
}

/**
 * The time zone says where a device is. Every way a page can ask is answered
 * as in UTC, and in English: Date's local-time methods, its text forms and its
 * reading of times without a zone, and the defaults of Intl's formatters.
 * @param {Window} win
 */
export function utcClock(win) {
	const RealDate = win.Date;
	const proto = RealDate.prototype;
	const realOffset = proto.getTimezoneOffset;
	const utcText = proto.toUTCString;
	const ZONE = "GMT+0000 (Coordinated Universal Time)";

	for (const part of ["Date", "Day", "FullYear", "Hours", "Milliseconds", "Minutes", "Month", "Seconds"]) {
		proto["get" + part] = proto["getUTC" + part];
		if (proto["setUTC" + part]) proto["set" + part] = proto["setUTC" + part];
	}
	// 0, or NaN for an invalid date, as the real one answers
	proto.getTimezoneOffset = function () {
		return this.getTime() * 0 + 0;
	};

	// "Thu, 01 Jan 1970 00:00:00 GMT", taken apart
	const parts = (date) => /^(\w+), (\d+) (\w+) (-?\d+) (\S+) GMT$/.exec(utcText.call(date));
	proto.toDateString = function () {
		const p = parts(this);
		return p ? `${p[1]} ${p[3]} ${p[2]} ${p[4]}` : "Invalid Date";
	};
	proto.toTimeString = function () {
		const p = parts(this);
		return p ? `${p[5]} ${ZONE}` : "Invalid Date";
	};
	proto.toString = function () {
		const p = parts(this);
		return p ? `${p[1]} ${p[3]} ${p[2]} ${p[4]} ${p[5]} ${ZONE}` : "Invalid Date";
	};

	for (const name of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) {
		const real = proto[name];
		proto[name] = function (locales, options) {
			return real.call(this, locales ?? "en-US", { timeZone: "UTC", ...options });
		};
	}
	const numberText = win.Number.prototype.toLocaleString;
	win.Number.prototype.toLocaleString = function (locales, options) {
		return numberText.call(this, locales ?? "en-US", options);
	};
	// Intl.DateTimeFormat, NumberFormat and the rest: English unless the page
	// names a language, and UTC unless it names a zone
	for (const name of Object.getOwnPropertyNames(win.Intl || {})) {
		const Real = win.Intl[name];
		if (typeof Real !== "function" || typeof Real.prototype?.resolvedOptions !== "function") continue;
		const withDefaults = ([locales, options]) => [
			locales ?? "en-US",
			name === "DateTimeFormat" ? { timeZone: "UTC", ...options } : options,
		];
		const stand = new win.Proxy(Real, {
			construct: (target, args, newTarget) =>
				Reflect.construct(target, withDefaults(args), newTarget === stand ? target : newTarget),
			apply: (target, self, args) => Reflect.apply(target, self, withDefaults(args)),
		});
		Real.prototype.constructor = stand;
		win.Intl[name] = stand;
	}

	// A time written without a zone is the device's: read it as UTC's
	// instead. One with a zone ("…Z", "GMT+2", "10:00+05:30", "EST"), or a
	// plain ISO date (UTC by the standard), is left as it is.
	// ponytail: by the text's look; an unusual form with a zone the browser
	// understands and this doesn't is read an offset out.
	const ZONED = /Z\s*$|\b(?:GMT|UTC?)\b|:\d{2}(?:\.\d+)?\s*[+-]\d{2}(?::?\d{2})?|\b[ECMP][SD]T\b/i;
	const DAY_ONLY = /^\s*\d{4}(?:-\d{2}){0,2}\s*$/;
	const parse = (text) => {
		text = String(text);
		const ms = RealDate.parse(text);
		if (Number.isNaN(ms) || ZONED.test(text) || DAY_ONLY.test(text)) return ms;
		return ms - realOffset.call(new RealDate(ms)) * 60_000;
	};
	const StandDate = new win.Proxy(RealDate, {
		construct(target, args, newTarget) {
			// new Date(2026, 0, 1): the device's midnight, read as UTC's
			if (args.length > 1) args = [RealDate.UTC(...args)];
			else if (typeof args[0] === "string") args = [parse(args[0])];
			return Reflect.construct(target, args, newTarget === StandDate ? target : newTarget);
		},
		apply: () => new StandDate().toString(),
		get: (target, key, receiver) => (key === "parse" ? parse : Reflect.get(target, key, receiver)),
	});
	proto.constructor = StandDate;
	win.Date = StandDate;
	// the newer date API has its own ways to ask for the zone; pages still
	// check for it before using it
	try {
		delete win.Temporal;
	} catch {
		// locked
	}
}

/**
 * What a canvas draws differs by device (fonts, graphics chip, smoothing), so
 * reading it back gives a signature. Two pixels in every row are changed by
 * the smallest step before a script sees them: invisible, and enough to
 * change the signature from page to page.
 * @param {Window} win
 */
export function noisyCanvas(win) {
	// by the pixel's place on the canvas, so two readings that overlap agree
	const speckle = (image, left, top, canvas) => {
		const { data, width, height } = image;
		for (let row = 0; row < height; row++) {
			const y = top + row;
			if (y < 0 || y >= canvas.height) continue;
			for (const salt of [0, 1]) {
				const h = mix(y * 2 + salt);
				const x = (h % canvas.width) - left;
				if (x >= 0 && x < width) data[(row * width + x) * 4 + ((h >>> 20) % 3)] ^= 1;
			}
		}
	};
	const contexts = [win.CanvasRenderingContext2D, win.OffscreenCanvasRenderingContext2D].filter(Boolean);
	const readers = new Map();
	for (const Context of contexts) {
		const real = Context.prototype.getImageData;
		readers.set(Context, real);
		Context.prototype.getImageData = function (sx, sy, sw, sh, ...rest) {
			const image = real.call(this, sx, sy, sw, sh, ...rest);
			// a negative width or height reads leftwards or upwards
			speckle(image, Math.trunc(sw < 0 ? sx + sw : sx), Math.trunc(sh < 0 ? sy + sh : sy), this.canvas);
			return image;
		};
	}
	// The canvas as it is, speckled, on a canvas of its own: the picture a
	// script takes away (toDataURL, toBlob) is of that one.
	const twin = (canvas, blank) => {
		if (!canvas.width || !canvas.height) return canvas;
		const copy = blank(canvas.width, canvas.height);
		const context = copy.getContext("2d");
		const read = readers.get(Object.getPrototypeOf(context).constructor) || context.getImageData;
		context.drawImage(canvas, 0, 0);
		const image = read.call(context, 0, 0, copy.width, copy.height);
		speckle(image, 0, 0, copy);
		context.putImageData(image, 0, 0);
		return copy;
	};
	const onPage = (width, height) => Object.assign(win.document.createElement("canvas"), { width, height });
	const offPage = (width, height) => new win.OffscreenCanvas(width, height);
	for (const [proto, names, blank] of [
		[win.HTMLCanvasElement?.prototype, ["toDataURL", "toBlob"], onPage],
		[win.OffscreenCanvas?.prototype, ["convertToBlob"], offPage],
	])
		for (const name of names) {
			const real = proto?.[name];
			if (typeof real !== "function") continue;
			proto[name] = function (...args) {
				return real.apply(twin(this, blank), args);
			};
		}
}

/**
 * The same for sound: how a device's audio code rounds its sums is a
 * signature. Samples a script reads back are moved by one part in ten
 * million, far below hearing.
 * @param {Window} win
 */
export function noisySound(win) {
	const buffer = win.AudioBuffer?.prototype;
	if (buffer) {
		const real = buffer.getChannelData;
		// once for each channel of each buffer: the samples are the buffer's own
		const shaken = new WeakMap();
		const shake = (sound, channel) => {
			const data = real.call(sound, channel);
			const done = shaken.get(sound) || new Set();
			shaken.set(sound, done);
			if (!done.has(channel)) {
				done.add(channel);
				for (let i = mix(channel) % 89; i < data.length; i += 89) data[i] += mix(i) & 1 ? 1e-7 : -1e-7;
			}
			return data;
		};
		buffer.getChannelData = function (channel) {
			return shake(this, channel);
		};
		const copy = buffer.copyFromChannel;
		if (copy)
			buffer.copyFromChannel = function (destination, channel, ...rest) {
				shake(this, channel);
				return copy.call(this, destination, channel, ...rest);
			};
	}
	const analyser = win.AnalyserNode?.prototype;
	for (const name of ["getFloatFrequencyData", "getFloatTimeDomainData", "getByteFrequencyData", "getByteTimeDomainData"]) {
		const real = analyser?.[name];
		if (typeof real !== "function") continue;
		const whole = name.includes("Byte");
		analyser[name] = function (array) {
			real.call(this, array);
			for (let i = mix(1) % 13; i < array.length; i += 13) {
				if (whole) array[i] ^= mix(i) & 1;
				else array[i] += mix(i) & 1 ? 1e-4 : -1e-4;
			}
		};
	}
}

/**
 * "Safer" security level: no WebGL or WebGPU. Both expose the graphics card
 * (a strong fingerprint) and are a common way into browser bugs.
 * ponytail: OffscreenCanvas inside a worker is out of reach here.
 * @param {Window} win
 */
export function noGpu(win) {
	for (const ctor of [win.HTMLCanvasElement, win.OffscreenCanvas]) {
		const proto = ctor?.prototype;
		const real = proto?.getContext;
		if (typeof real !== "function") continue;
		Object.defineProperty(proto, "getContext", {
			value: function getContext(type, ...rest) {
				if (/webgl|webgpu/i.test(String(type))) return null;
				return real.call(this, type, ...rest);
			},
			writable: true,
			configurable: true,
		});
	}
	try {
		Object.defineProperty(win.navigator, "gpu", { value: undefined });
	} catch {
		// not configurable here
	}
}


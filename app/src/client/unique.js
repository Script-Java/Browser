// What a script can learn about the device to tell it from every other one
// (a fingerprint), and the everyone's-answers the app gives instead. For a
// page's window (page.js) and for a worker (worker.js): `win` is either's
// global.
//
// ponytail: page script against page script, like the WebRTC block. Tor
// Browser does all of this in the browser itself.

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

const answer = (object, name, value) => {
	try {
		Object.defineProperty(object, name, { get: () => value, enumerable: true, configurable: true });
	} catch {
		// not there, or locked
	}
};

/**
 * Every security level, while blocking is on for the site: what a canvas, a
 * sound buffer or WebGL reads back carries a little noise, and WebGL names
 * no graphics chip. Nothing a site shows changes, as in Brave's default.
 * @param {Window} win
 */
export function everyday(win) {
	if (win.__biosEveryday) return;
	Object.defineProperty(win, "__biosEveryday", { value: true });
	noisyCanvas(win);
	noisySound(win);
	quietGpu(win);
}

/**
 * The "Safer" security level: no WebGL or WebGPU, and the answers a script
 * gets about the device are everyone's.
 * @param {Window} win
 */
export function safer(win) {
	if (win.__biosSafer) return;
	Object.defineProperty(win, "__biosSafer", { value: true });
	noGpu(win);
	lessUnique(win);
}

/**
 * "Safer": less for a site to tell this device from others by. Scripts get
 * one language, a common processor count, and the time in UTC; what they read
 * back from a canvas or a sound buffer carries a little noise, so it can't
 * serve as the device's signature. A page's window also gets the screen and
 * the fonts (screenAndFonts in page.js's use of it).
 * @param {Window} win
 */
function lessUnique(win) {
	const nav = (win.Navigator || win.WorkerNavigator)?.prototype;
	if (nav) {
		// the same as the Accept-Language shield.js sends
		answer(nav, "language", "en-US");
		answer(nav, "languages", Object.freeze(["en-US", "en"]));
		answer(nav, "hardwareConcurrency", 4);
		if ("deviceMemory" in nav) answer(nav, "deviceMemory", 8);
	}
	utcClock(win);
	noisyCanvas(win);
	noisySound(win);
}

/**
 * The time zone says where a device is. Every way a page can ask is answered
 * as in UTC, and in English: Date's local-time methods, its text forms and its
 * reading of times without a zone, and the defaults of Intl's formatters.
 * @param {Window} win
 */
function utcClock(win) {
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

// Two pixels in every row of `image` changed by the smallest step, by their
// place on the canvas (so two readings that overlap agree).
function speckle(image, left, top, canvas) {
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
}

/**
 * What a canvas draws differs by device (fonts, graphics chip, smoothing), so
 * reading it back gives a signature. Two pixels in every row are changed by
 * the smallest step before a script sees them: invisible, and enough to
 * change the signature from page to page.
 * @param {Window} win
 */
function noisyCanvas(win) {
	if (win.__biosCanvas) return;
	Object.defineProperty(win, "__biosCanvas", { value: true });
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
function noisySound(win) {
	if (win.__biosSound) return;
	Object.defineProperty(win, "__biosSound", { value: true });
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
 * WebGL names the graphics chip to anyone who asks (WEBGL_debug_renderer_info):
 * a strong signature. It gets the browser's own generic answer instead, and
 * pixels a script reads back carry the canvas's noise.
 * @param {Window} win
 */
function quietGpu(win) {
	const VENDOR = 0x9245; // UNMASKED_VENDOR_WEBGL
	const RENDERER = 0x9246; // UNMASKED_RENDERER_WEBGL
	for (const Context of [win.WebGLRenderingContext, win.WebGL2RenderingContext]) {
		const proto = Context?.prototype;
		if (!proto) continue;
		const getParameter = proto.getParameter;
		proto.getParameter = function (name) {
			if (name === VENDOR) return "WebKit";
			if (name === RENDERER) return "WebKit WebGL";
			return getParameter.call(this, name);
		};
		const readPixels = proto.readPixels;
		proto.readPixels = function (x, y, width, height, format, type, pixels, ...rest) {
			readPixels.call(this, x, y, width, height, format, type, pixels, ...rest);
			if (ArrayBuffer.isView(pixels) && pixels.length && Number.isInteger(width) && width > 0)
				for (let row = 0; row < height; row++) {
					const h = mix(y + row);
					const at = (row * width + (h % width)) * 4 + ((h >>> 20) % 3);
					if (at < pixels.length) pixels[at] ^= 1;
				}
		};
	}
}

/**
 * "Safer" security level: no WebGL or WebGPU. Both expose the graphics card
 * (a strong fingerprint) and are a common way into browser bugs.
 * @param {Window} win
 */
function noGpu(win) {
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

// The families a canvas or a page may name and still get: the generic ones,
// which every device has.
const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|emoji|fangsong)$/i;
// "bold 12px/1.5 'Some Font', serif": what comes after the size is the families
const FONT = /^(.*?(?:\d*\.?\d+(?:px|pt|pc|em|rem|ex|ch|vw|vh|in|cm|mm|q|%)|(?:xx?-|xxx-)?(?:small|large)|medium|larger|smaller)(?:\s*\/\s*\S+)?\s+)(.+)$/i;

/**
 * "Safer", in a page's window: the screen's size is the window's (what a
 * script can learn anyway), and the fonts installed on the device can't be
 * told apart. Text everywhere is in the system's own font (page.js puts the
 * rule in each page), so measuring text in one family or another gives the
 * same answer; a canvas only draws in the families every device has.
 * @param {Window} win
 */
export function screenAndFonts(win) {
	const screen = win.Screen?.prototype;
	if (screen) {
		for (const [name, side] of [
			["width", "innerWidth"],
			["height", "innerHeight"],
			["availWidth", "innerWidth"],
			["availHeight", "innerHeight"],
		])
			try {
				Object.defineProperty(screen, name, { get: () => win[side], enumerable: true, configurable: true });
			} catch {
				// locked
			}
		for (const name of ["availLeft", "availTop"]) if (name in screen) answer(screen, name, 0);
		answer(screen, "colorDepth", 24);
		answer(screen, "pixelDepth", 24);
	}
	for (const [name, value] of [
		["outerWidth", () => win.innerWidth],
		["outerHeight", () => win.innerHeight],
		["screenX", () => 0],
		["screenY", () => 0],
		["screenLeft", () => 0],
		["screenTop", () => 0],
	])
		try {
			Object.defineProperty(win, name, { get: value, configurable: true });
		} catch {
			// locked
		}
	// a query about the device's screen is answered about the window, as above
	const matchMedia = win.matchMedia;
	if (typeof matchMedia === "function")
		win.matchMedia = function (query) {
			return matchMedia.call(this, String(query).replace(/device-(width|height|aspect-ratio)/gi, "$1"));
		};

	for (const Context of [win.CanvasRenderingContext2D, win.OffscreenCanvasRenderingContext2D]) {
		const desc = Context && Object.getOwnPropertyDescriptor(Context.prototype, "font");
		if (!desc?.set || !desc.configurable) continue;
		Object.defineProperty(Context.prototype, "font", {
			...desc,
			set(value) {
				const parts = FONT.exec(String(value));
				if (parts) {
					const families = parts[2]
						.split(",")
						.map((family) => family.trim().replace(/^["']|["']$/g, ""))
						.filter((family) => GENERIC.test(family));
					value = parts[1] + (families.join(", ") || "sans-serif");
				}
				desc.set.call(this, value);
			},
		});
	}
}

// For page.js: in every page at "Safer", all text in the system's font (see
// screenAndFonts). Code keeps a font with letters of one width.
export const ONE_FONT =
	"*:not(pre):not(code):not(kbd):not(samp):not(tt):not(pre *):not(code *){font-family:-apple-system,system-ui,sans-serif!important}" +
	"pre,code,kbd,samp,tt,pre *,code *{font-family:ui-monospace,monospace!important}";

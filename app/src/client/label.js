// The labels of site origins (see sitekey.js), worked out at once: page.js
// checks who sent a message while the page's script is reading it, and the
// browser's own SHA-256 only answers later.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * "s" + 25 base32 chars of a digest: a DNS label that gives nothing away.
 * @param {Uint8Array} digest
 */
export function named(digest) {
	let out = "s";
	let bits = 0;
	let value = 0;
	for (const byte of digest) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5 && out.length < 26) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	return out;
}

// SHA-256's constants: the first bits of the square roots (where it starts)
// and cube roots (one for each round) of the first 64 primes.
const START = [];
const ROUND = [];
const bits32 = (x) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
for (let n = 2; ROUND.length < 64; n++) {
	let prime = true;
	for (let d = 2; d * d <= n; d++) if (n % d === 0) prime = false;
	if (!prime) continue;
	if (START.length < 8) START.push(bits32(Math.sqrt(n)));
	ROUND.push(bits32(Math.cbrt(n)));
}

const turn = (x, by) => (x >>> by) | (x << (32 - by));

/**
 * SHA-256 (label.test.js holds it to the platform's).
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function sha256(bytes) {
	// the message, a 1 bit, zeros, and its length in bits, in blocks of 64 bytes
	const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 4, bytes.length * 8);
	const hash = Uint32Array.from(START);
	const w = new Uint32Array(64);
	for (let at = 0; at < padded.length; at += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4);
		for (let i = 16; i < 64; i++) {
			const a = w[i - 15];
			const b = w[i - 2];
			w[i] = w[i - 16] + (turn(a, 7) ^ turn(a, 18) ^ (a >>> 3)) + w[i - 7] + (turn(b, 17) ^ turn(b, 19) ^ (b >>> 10));
		}
		let [a, b, c, d, e, f, g, h] = hash;
		for (let i = 0; i < 64; i++) {
			const t1 = (h + (turn(e, 6) ^ turn(e, 11) ^ turn(e, 25)) + ((e & f) ^ (~e & g)) + ROUND[i] + w[i]) | 0;
			const t2 = ((turn(a, 2) ^ turn(a, 13) ^ turn(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
			h = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) | 0;
		}
		[a, b, c, d, e, f, g, h].forEach((word, i) => (hash[i] += word));
	}
	const out = new Uint8Array(32);
	hash.forEach((word, i) => new DataView(out.buffer).setUint32(i * 4, word));
	return out;
}

/**
 * The label sitekey.js gives the same text.
 * @param {string} text
 */
export function label(text) {
	return named(sha256(new TextEncoder().encode(text)));
}

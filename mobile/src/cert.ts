// The fields of an X.509 certificate (RFC 5280) the shield menu shows, read
// from its DER by hand: the libraries that parse certificates want Node's or
// a browser's crypto, which React Native lacks, and these few need ~60 lines.

export type Certificate = { subject: string; issuer: string; notBefore: Date; notAfter: Date };

type Item = { tag: number; start: number; end: number };

// One DER item at `at`: its tag and where its contents are.
function item(der: Uint8Array, at: number): Item {
	if (at + 2 > der.length) throw new Error("Not a certificate");
	let length = der[at + 1];
	let start = at + 2;
	if (length & 0x80) {
		const bytes = length & 0x7f;
		if (bytes < 1 || bytes > 4) throw new Error("Not a certificate");
		length = 0;
		for (let i = 0; i < bytes; i++) length = length * 256 + der[start + i];
		start += bytes;
	}
	if (start + length > der.length) throw new Error("Not a certificate");
	return { tag: der[at], start, end: start + length };
}

function children(der: Uint8Array, parent: Item): Item[] {
	const out: Item[] = [];
	for (let at = parent.start; at < parent.end; at = out[out.length - 1].end) out.push(item(der, at));
	return out;
}

function oid(bytes: Uint8Array): string {
	const ids: number[] = [];
	let value = 0;
	for (const b of bytes) {
		value = value * 128 + (b & 0x7f);
		if (!(b & 0x80)) {
			ids.push(value);
			value = 0;
		}
	}
	const first = ids.shift() ?? 0;
	const top = Math.min(2, Math.floor(first / 40));
	return [top, first - top * 40, ...ids].join(".");
}

function text(der: Uint8Array, { tag, start, end }: Item): string {
	const bytes = der.subarray(start, end);
	if (tag === 0x0c) return new TextDecoder().decode(bytes); // UTF8String
	if (tag === 0x1e) {
		// BMPString: UTF-16, big-endian
		let out = "";
		for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
		return out;
	}
	return String.fromCharCode(...bytes); // PrintableString, IA5String, TeletexString
}

const NAMES: Record<string, string> = {
	"2.5.4.3": "CN",
	"2.5.4.5": "serialNumber",
	"2.5.4.6": "C",
	"2.5.4.7": "L",
	"2.5.4.8": "ST",
	"2.5.4.10": "O",
	"2.5.4.11": "OU",
	"1.2.840.113549.1.9.1": "emailAddress",
};

// "C=US, O=Example, CN=example.com", in the certificate's own order
function name(der: Uint8Array, seq: Item): string {
	const parts: string[] = [];
	for (const set of children(der, seq))
		for (const pair of children(der, set)) {
			const [type, value] = children(der, pair);
			const id = oid(der.subarray(type.start, type.end));
			parts.push(`${NAMES[id] ?? id}=${text(der, value)}`);
		}
	return parts.join(", ");
}

function time(der: Uint8Array, at: Item): Date {
	const s = text(der, at);
	// UTCTime YYMMDDHHMMSSZ (50-99 are 19xx), GeneralizedTime YYYYMMDDHHMMSSZ
	const m = at.tag === 0x17 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s) : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s);
	if (!m) throw new Error("Not a certificate");
	let year = Number(m[1]);
	if (at.tag === 0x17) year += year < 50 ? 2000 : 1900;
	return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

export function parseCertificate(der: Uint8Array): Certificate {
	const [tbs] = children(der, item(der, 0));
	const fields = children(der, tbs);
	// [0] version is optional; then serial, signature algorithm, issuer, validity, subject
	const [, , issuer, validity, subject] = fields[0].tag === 0xa0 ? fields.slice(1) : fields;
	const [notBefore, notAfter] = children(der, validity);
	return { subject: name(der, subject), issuer: name(der, issuer), notBefore: time(der, notBefore), notAfter: time(der, notAfter) };
}

export function fromBase64(b64: string): Uint8Array {
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** AB:CD:… as certificate viewers show a fingerprint. */
export function colonHex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

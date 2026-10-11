// Addresses made to pass for a well-known site's, as Chrome's lookalike
// warning catches them: letters that look alike (g00gle.com, rnicrosoft.com,
// a Cyrillic а), a slip of one letter (paypall.com, amazom.com), or the real
// name tucked into another site's address (paypal.com.account-check.net).
// ponytail: a short list of the sites people sign in to and pay on; Chrome
// checks its top 10,000 and the sites a person uses, and that's the upgrade

import { parse } from "tldts";

// Their registrable domains. The label alone (paypal) is what's compared.
export const TOP_SITES = (
	"google.com youtube.com gmail.com facebook.com instagram.com whatsapp.com messenger.com threads.net " +
	"x.com twitter.com linkedin.com tiktok.com snapchat.com pinterest.com reddit.com discord.com telegram.org signal.org " +
	"apple.com icloud.com microsoft.com live.com outlook.com office.com microsoftonline.com xbox.com skype.com " +
	"amazon.com aws.amazon.com ebay.com walmart.com target.com bestbuy.com costco.com etsy.com aliexpress.com alibaba.com " +
	"shopify.com temu.com shein.com wayfair.com homedepot.com lowes.com ikea.com " +
	"paypal.com venmo.com cash.app zelle.com stripe.com wise.com revolut.com klarna.com afterpay.com squareup.com " +
	"chase.com bankofamerica.com wellsfargo.com citi.com capitalone.com usbank.com pnc.com truist.com schwab.com " +
	"fidelity.com vanguard.com robinhood.com etrade.com americanexpress.com discover.com hsbc.com barclays.co.uk " +
	"lloydsbank.com natwest.com santander.com tdbank.com ally.com sofi.com navyfederal.org " +
	"coinbase.com binance.com kraken.com crypto.com metamask.io ledger.com trezor.io blockchain.com bitpanda.com " +
	"netflix.com spotify.com hulu.com disneyplus.com max.com primevideo.com twitch.tv steampowered.com steamcommunity.com " +
	"epicgames.com roblox.com playstation.com nintendo.com ea.com battle.net " +
	"github.com gitlab.com dropbox.com box.com wetransfer.com docusign.com adobe.com zoom.us slack.com notion.so " +
	"yahoo.com aol.com proton.me protonmail.com zoho.com gmx.com mail.ru yandex.ru " +
	"irs.gov ssa.gov usps.com ups.com fedex.com dhl.com " +
	"booking.com airbnb.com expedia.com uber.com lyft.com doordash.com instacart.com " +
	"wikipedia.org openai.com chatgpt.com claude.ai cloudflare.com godaddy.com namecheap.com"
).split(" ");

// Words too ordinary for the one-letter-slip test: real sites sit one letter away.
const ORDINARY = new Set(["target", "office", "outlook", "discover", "booking", "venmo", "signal", "threads", "ledger"]);
// Real sites one letter from one on the list
const KNOWN_NEIGHBOURS = new Set(["paypay.ne.jp", "goggle.com", "amazon.co.uk", "amazon.de", "amazon.ca", "googl.com"]);

// What a name looks like, written with one letter per look: digits and
// letters that pass for each other, and pairs that pass for one.
const LOOKS = { 0: "o", 1: "l", i: "l", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g", "|": "l" };
const PAIRS = [["rn", "m"], ["vv", "w"], ["cl", "d"], ["nn", "m"]];
// Cyrillic and Greek letters that look Latin
const SCRIPTS = { а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", һ: "h", ԁ: "d", ӏ: "l", ο: "o", α: "a", ν: "v", ρ: "p", τ: "t", ι: "i", κ: "k", ε: "e" };

export function skeleton(label) {
	let out = [...label.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()].map((c) => SCRIPTS[c] || c).join("");
	for (const [pair, one] of PAIRS) out = out.replaceAll(pair, one);
	return [...out].map((c) => LOOKS[c] || c).join("").replace(/-/g, "");
}

// Levenshtein with transpositions, stopping once it passes `max`.
function within(a, b, max) {
	if (Math.abs(a.length - b.length) > max) return false;
	let prev2 = null;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], prev2[j - 2] + 1);
		}
		if (Math.min(...row) > max) return false;
		prev2 = prev;
		prev = row;
	}
	return prev[b.length] <= max;
}

// A label's letters, from the xn--… form an address arrives in (RFC 3492).
export function fromPunycode(label) {
	if (!label.startsWith("xn--")) return label;
	const input = label.slice(4);
	const base = 36;
	const basic = input.lastIndexOf("-");
	const out = basic > 0 ? [...input.slice(0, basic)].map((c) => c.codePointAt(0)) : [];
	let n = 128;
	let i = 0;
	let bias = 72;
	for (let pos = basic > 0 ? basic + 1 : 0; pos < input.length; ) {
		const old = i;
		for (let w = 1, k = base; ; k += base) {
			if (pos >= input.length) return label;
			const c = input.charCodeAt(pos++);
			const digit = c >= 48 && c < 58 ? c - 22 : c >= 65 && c < 91 ? c - 65 : c >= 97 && c < 123 ? c - 97 : base;
			if (digit >= base) return label;
			i += digit * w;
			const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
			if (digit < t) break;
			w *= base - t;
		}
		const count = out.length + 1;
		let delta = old === 0 ? Math.floor((i - old) / 700) : Math.floor((i - old) / 2);
		delta += Math.floor(delta / count);
		let k = 0;
		for (; delta > 455; k += base) delta = Math.floor(delta / 35);
		bias = k + Math.floor((36 * delta) / (delta + 38));
		n += Math.floor(i / count);
		i %= count;
		if (n > 0x10ffff) return label;
		out.splice(i++, 0, n);
	}
	return String.fromCodePoint(...out);
}

const labelOf = (domain) => domain.slice(0, domain.indexOf("."));
const TOP = TOP_SITES.map((site) => {
	const domain = parse(site).domain || site;
	return { site, domain, label: labelOf(domain), looks: skeleton(labelOf(domain)) };
});
const TOP_DOMAINS = new Set(TOP.map((t) => t.domain));

/**
 * The well-known site `hostname` seems made to pass for, or null.
 * @param {string} hostname as an address has it (xn--… or Unicode)
 */
export function lookalikeOf(hostname) {
	const host = hostname.toLowerCase().replace(/\.$/, "").split(".").map(fromPunycode).join(".");
	const { domain, publicSuffix } = parse(host);
	if (!domain || TOP_DOMAINS.has(domain) || KNOWN_NEIGHBOURS.has(domain)) return null;
	const label = domain.slice(0, domain.length - publicSuffix.length - 1);
	// the real name in another site's address: paypal.com.account-check.net
	const sub = "." + host.slice(0, host.length - domain.length);
	for (const top of TOP) if (sub.includes("." + top.domain + ".") || sub.includes("." + top.label + "-")) return top.site;
	const looks = skeleton(label);
	for (const top of TOP) {
		// the same name under another suffix (paypal.co.uk) is usually the site's own
		if (label === top.label) continue;
		if (looks === top.looks) return top.site;
		if (top.label.length >= 6 && !ORDINARY.has(top.label) && /^[a-z0-9-]+$/.test(label) && within(label, top.label, 1)) return top.site;
	}
	return null;
}

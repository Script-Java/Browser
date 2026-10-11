import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPunycode, lookalikeOf } from "./lookalike.js";

test("addresses made to pass for a well-known site are caught", () => {
	for (const [host, real] of [
		["g00gle.com", "google.com"],
		["rnicrosoft.com", "microsoft.com"],
		["paypaI.com", "paypal.com"],
		["pаypal.com", "paypal.com"], // Cyrillic а
		["paypall.com", "paypal.com"],
		["amazom.com", "amazon.com"],
		["netlfix.com", "netflix.com"],
		["coinbase-support.secure-wallet.net", "coinbase.com"],
		["paypal.com.account-check.net", "paypal.com"],
		["secure.chase.com.login-verify.io", "chase.com"],
		["faceb00k.co", "facebook.com"],
	])
		assert.equal(lookalikeOf(host), real, host);
});

test("the sites themselves, their own subdomains and ordinary neighbours aren't", () => {
	for (const host of [
		"google.com",
		"mail.google.com",
		"www.paypal.com",
		"paypal.co.uk",
		"accounts.google.co.uk",
		"amazon.de",
		"paypay.ne.jp",
		"example.com",
		"httpbin.org",
		"targets.com",
		"offices.com",
		"chaser.com",
		"bingo.com",
		"apple.news",
		"wikipedia.org",
		"en.wikipedia.org",
		"github.io",
		"badssl.com",
		"news.ycombinator.com",
		"maps.apple.com",
	])
		assert.equal(lookalikeOf(host), null, host);
});

test("names in their xn-- form are read as the letters they show", async () => {
	const { domainToASCII, domainToUnicode } = await import("node:url");
	for (const name of ["pаypal.com", "bücher.de", "日本語.jp", "münchen-straße.de", "ελληνικά.gr", "example.com"]) {
		const ascii = domainToASCII(name);
		assert.equal(ascii.split(".").map(fromPunycode).join("."), domainToUnicode(ascii), name);
	}
	assert.equal(lookalikeOf(domainToASCII("pаypal.com")), "paypal.com");
	assert.equal(lookalikeOf("xn--zz-bad"), null);
});

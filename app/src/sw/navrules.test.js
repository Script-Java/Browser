import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "tldts";
import { compileRules } from "../privacyrules.js";
import { bounceTarget, compileNavRules, withoutTracking } from "./navrules.js";

// Brave's rule formats, through the server's compiler and over the wire as JSON
const rules = compileNavRules(
	JSON.parse(
		JSON.stringify(
			compileRules(
				JSON.stringify([
					{ include: ["*://click.example-mail.com/*"], exclude: [], action: "redirect", param: "url" },
					{ include: ["*://*.ampproject.org/c/s/*"], exclude: [], action: "regex-path", param: "^/c/s/(.*)$", prepend_scheme: "https" },
				]),
				JSON.stringify([{ include: ["*://*.youtube.com/*"], exclude: [], params: ["si"] }])
			)
		)
	)
);
const siteOf = (host) => parse(host).domain || host;

test("tracking parameters go, the rest of the query stays as written", () => {
	assert.equal(withoutTracking(new URL("https://a.example/p?fbclid=1&keep=a%20b&utm_source=x"), rules)?.href, "https://a.example/p?keep=a%20b");
	assert.equal(withoutTracking(new URL("https://m.youtube.com/watch?v=1&si=2"), rules)?.href, "https://m.youtube.com/watch?v=1");
	// a site-only parameter elsewhere, and nothing to strip
	assert.equal(withoutTracking(new URL("https://a.example/?si=2"), rules), null);
	assert.equal(withoutTracking(new URL("https://a.example/"), rules), null);
});

test("a bounce through a tracker goes straight to where it leads, but not within one site", () => {
	const to = encodeURIComponent("https://shop.example/item");
	assert.equal(bounceTarget(new URL(`https://click.example-mail.com/t?url=${to}`), rules, siteOf)?.href, "https://shop.example/item");
	assert.equal(bounceTarget(new URL("https://cdn.ampproject.org/c/s/news.example/story"), rules, siteOf)?.href, "https://news.example/story");
	assert.equal(bounceTarget(new URL(`https://click.example-mail.com/t?url=${encodeURIComponent("https://www.example-mail.com/")}`), rules, siteOf), null);
	assert.equal(bounceTarget(new URL("https://shop.example/"), rules, siteOf), null);
});

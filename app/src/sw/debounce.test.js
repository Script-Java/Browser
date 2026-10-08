import { test } from "node:test";
import assert from "node:assert/strict";
import { OWN_RULES, compile, debounce, matches, parsePattern } from "./debounce.js";

const go = (rules, url) => debounce(compile(rules), new URL(url))?.href ?? null;

test("match patterns read as browsers read them", () => {
	const fits = (pattern, url) => {
		const parsed = parsePattern(pattern);
		const at = new URL(url);
		return matches(parsed, at.protocol.slice(0, -1), at.hostname.toLowerCase(), (at.pathname + at.search).toLowerCase());
	};
	const p = "*://*.example.com/go?*";
	assert.ok(fits(p, "https://example.com/go?x=1"));
	assert.ok(fits(p, "http://a.b.example.com/go?x=1"));
	assert.ok(!fits(p, "https://example.com/gone?x=1"));
	assert.ok(!fits(p, "https://notexample.com/go?x=1"));
	assert.ok(!fits(p, "ftp://example.com/go?x=1"));
	// pieces must appear in order, and the tail must really be at the end
	assert.ok(fits("*://x/a*b*c", "https://x/a1b2c"));
	assert.ok(!fits("*://x/a*b*c", "https://x/a1c2b"));
	assert.ok(!fits("*://x/a*b*c", "https://x/a1b2cd"));
	assert.ok(fits("*://x/*", "https://x/anything?q"));
	assert.equal(parsePattern("not a pattern"), null);
	// a pattern full of wildcards is decided quickly, match or no (no backtracking)
	const started = Date.now();
	assert.ok(!fits("*://x/" + "a*b*".repeat(60) + "z", "https://x/" + "a".repeat(5000)));
	assert.ok(fits("*://x/" + "a*".repeat(60), "https://x/" + "a".repeat(5000)));
	assert.ok(Date.now() - started < 200);
});

test("the big sites' link wrappers go straight to where they point", () => {
	assert.equal(go(OWN_RULES, "https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&h=AT0"), "https://example.com/a?b=1");
	assert.equal(go(OWN_RULES, "https://www.google.com/url?sa=t&url=https://example.org/&ved=x"), "https://example.org/");
	assert.equal(go(OWN_RULES, "https://www.google.com/url?q=https://example.net/&sa=D"), "https://example.net/");
	assert.equal(go(OWN_RULES, "https://www.youtube.com/redirect?event=video&q=http%3A%2F%2Fexample.com%2F"), "http://example.com/");
	// not an address, or not a web one: stays
	assert.equal(go(OWN_RULES, "https://www.google.com/url?q=hello"), null);
	assert.equal(go(OWN_RULES, "https://l.facebook.com/l.php?u=javascript%3Aalert(1)"), null);
	assert.equal(go(OWN_RULES, "https://www.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2F"), null);
});

test("Brave's other kinds of rule", () => {
	const rules = [
		{ include: ["*://track.example/*"], exclude: ["*://track.example/keep*"], action: "redirect", param: "to", prepend_scheme: "https" },
		{ include: ["*://b64.example/*"], action: "base64,redirect", param: "u" },
		{ include: ["*://www.google.com/amp/s/*"], action: "regex-path", param: "^/amp/s/(.*)$", prepend_scheme: "https" },
		{ include: ["*://tpl.example/*"], action: "regex-path-template", param: "^/(\\w+)/(\\w+)$", redirect_url_template: "https://$2.example/$1" },
		{ include: ["*://bad.example/*"], action: "regex-path", param: "(" },
	];
	assert.equal(go(rules, "https://track.example/c?to=example.com/x"), "https://example.com/x");
	assert.equal(go(rules, "https://track.example/keep?to=example.com/x"), null);
	assert.equal(go(rules, "https://b64.example/?u=" + btoa("https://example.org/b64").replace(/=+$/, "")), "https://example.org/b64");
	assert.equal(go(rules, "https://www.google.com/amp/s/example.com/news/1.amp"), "https://example.com/news/1.amp");
	assert.equal(go(rules, "https://tpl.example/page/news"), "https://news.example/page");
	// a wrapper around a wrapper
	assert.equal(go(rules, "https://track.example/c?to=" + encodeURIComponent("www.google.com/amp/s/example.net/")), "https://example.net/");
});

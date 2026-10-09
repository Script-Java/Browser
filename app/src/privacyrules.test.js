import { test } from "node:test";
import assert from "node:assert/strict";
import { compileRules, patternToRegex } from "./privacyrules.js";

const matches = (pattern, url) => new RegExp(patternToRegex(pattern)).test(url);

test("match patterns: scheme, subdomains and the path with its query", () => {
	assert.ok(matches("*://*.prsm1.com/r?*", "https://a.b.prsm1.com/r?u=x"));
	assert.ok(matches("*://*.prsm1.com/r?*", "http://prsm1.com/r?u=x"));
	assert.ok(!matches("*://*.prsm1.com/r?*", "https://notprsm1.com/r?u=x"));
	assert.ok(!matches("*://*.prsm1.com/r?*", "https://prsm1.com/other?u=x"));
	assert.ok(matches("https://www.goodreads.com/book/show/*", "https://www.goodreads.com/book/show/1?qid=2"));
	assert.ok(!matches("https://www.goodreads.com/book/show/*", "http://www.goodreads.com/book/show/1"));
	assert.ok(matches("*://*/*", "https://anything.example/x"));
	// dots are literal, not "any character"
	assert.ok(!matches("*://x.com/*", "https://xacom/a"));
	assert.equal(patternToRegex("not a pattern"), null);
});

test("Brave's rules compile to what the worker needs", () => {
	const debounce = JSON.stringify([
		{ include: ["*://go.skimresources.com/*"], exclude: [], action: "redirect", param: "url" },
		{ include: ["*://*.ouo.today/*"], exclude: [], action: "base64,redirect", param: "cr" },
		{ include: ["*://y2u.be/*"], exclude: [], action: "regex-path-template", param: "^/([^/]+)$", redirect_url_template: "https://www.youtube.com/watch?v=$1" },
		{ include: ["*://x/*"], exclude: [], action: "regex-path", param: "(unclosed" },
		{ include: ["*://x.example/*"], exclude: [], action: "unknown", param: "u" },
	]);
	const query = JSON.stringify([
		{ include: ["*://*/*"], exclude: [], params: ["fbclid", "__cft__%5B0%5D"] },
		{ include: ["*://*.youtube.com/*"], exclude: [], params: ["si"] },
	]);
	const { debounce: rules, params } = compileRules(debounce, query);
	assert.deepEqual(
		rules.map((r) => r.action),
		["redirect", "base64,redirect", "regex-path-template"]
	);
	assert.equal(rules[2].template, "https://www.youtube.com/watch?v=$1");
	assert.equal(params[0].match, null);
	assert.deepEqual(params[0].params, ["fbclid", "__cft__[0]"]);
	assert.ok(new RegExp(params[1].match[0]).test("https://m.youtube.com/watch?v=1&si=2"));
});

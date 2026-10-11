import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { seal } from "./auth.js";
import { cleanRules, cleanSettings, DEFAULT_SETTINGS } from "./settings.js";

test("a long allow list drops its oldest sites to fit the cookie", () => {
	const allow = Array.from(
		{ length: 400 },
		(_, i) => `site-number-${i}.example.com`
	);
	const out = cleanSettings({ ...DEFAULT_SETTINGS, allow });
	assert.ok(
		seal(randomBytes(32), out).length < 3900
	);
	assert.equal(out.allow.at(-1), allow.at(-1));
	assert.ok(!out.allow.includes(allow[0]));
});

test("every list of sites is cleaned, and the longest gives way first", () => {
	const many = Array.from({ length: 400 }, (_, i) => `site-number-${i}.example.com`);
	const out = cleanSettings({ allow: many, noScripts: ["a.com", "<b>"], keep: ["c.com", 7] });
	assert.deepEqual(out.noScripts, ["a.com"]);
	assert.deepEqual(out.keep, ["c.com"]);
	assert.ok(out.allow.length < many.length);
});

test("junk is replaced by defaults", () => {
	const out = cleanSettings({
		ads: "yes",
		search: "evil",
		allow: ["ok.com", "<script>", 5],
	});
	assert.equal(out.ads, DEFAULT_SETTINGS.ads);
	assert.equal(out.search, DEFAULT_SETTINGS.search);
	assert.deepEqual(out.allow, ["ok.com"]);
});

test("security level and HTTPS-Only", () => {
	assert.equal(cleanSettings({}).httpsOnly, true);
	assert.equal(cleanSettings({ httpsOnly: false }).httpsOnly, false);
	assert.equal(cleanSettings({ level: "safer" }).level, "safer");
	assert.equal(cleanSettings({ level: "safest" }).level, "safest");
	assert.equal(cleanSettings({ level: "extreme" }).level, "standard");
});

test("a person's own rules are kept one a line, without junk, and fit their cookie", () => {
	assert.equal(cleanRules("  ||tracker.example^ \r\n\r\nexample.com##.promo\n||tracker.example^\nbad\u0007rule"), "||tracker.example^\nexample.com##.promo");
	assert.equal(cleanRules(42), "");
	const many = Array.from({ length: 300 }, (_, i) => `||tracker-${i}.example^`).join("\n");
	const out = cleanRules(many);
	assert.ok(seal(randomBytes(32), out).length < 3900);
	assert.ok(out.startsWith("||tracker-0.example^"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { seal } from "./auth.js";
import { cleanSettings, DEFAULT_SETTINGS } from "./settings.js";

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

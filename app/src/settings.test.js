import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSettings, DEFAULT_SETTINGS } from "./settings.js";

test("a long allow list drops its oldest sites to fit the cookie", () => {
	const allow = Array.from(
		{ length: 400 },
		(_, i) => `site-number-${i}.example.com`
	);
	const out = cleanSettings({ ...DEFAULT_SETTINGS, allow });
	assert.ok(
		Buffer.from(JSON.stringify(out)).toString("base64url").length < 3900
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

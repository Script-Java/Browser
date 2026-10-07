import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { label, sha256 } from "./label.js";
import { frameKey, siteKey } from "./sitekey.js";

test("sha256 is the platform's, at every length around a block's end", () => {
	for (let length = 0; length < 200; length++) {
		const bytes = Uint8Array.from({ length }, (_, i) => (i * 131 + length) & 255);
		assert.deepEqual(Buffer.from(sha256(bytes)), createHash("sha256").update(bytes).digest(), `${length} bytes`);
	}
});

test("label is the label the app and the service worker give", async () => {
	// the origin example.com has had since isolation shipped
	assert.equal(await siteKey("www.example.com"), "sun42n5xov642kxrxrqiyanhco");
	assert.equal(label("example.com"), "sun42n5xov642kxrxrqiyanhco");
	const holder = await siteKey("example.com");
	assert.equal(label(holder + " example.org"), await frameKey(holder, "www.example.org"));
	assert.equal(label("münchen.example"), await siteKey("münchen.example"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { expiresFromMaxAge } from "./cookies.js";

const NOW = Date.UTC(2026, 0, 1);

test("Max-Age becomes the Expires it means, replacing any Expires", () => {
	assert.equal(
		expiresFromMaxAge("id=1; Path=/; Max-Age=60; Expires=Wed, 01 Jan 2031 00:00:00 GMT", NOW),
		"id=1; Path=/; Expires=Thu, 01 Jan 2026 00:01:00 GMT"
	);
	// signing out: gone at once
	assert.equal(expiresFromMaxAge("id=; Max-Age=0", NOW), "id=; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
	assert.equal(expiresFromMaxAge("id=; max-age=-1; Secure", NOW), "id=; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
	// no longer than a browser would keep it
	assert.equal(
		expiresFromMaxAge("id=1; Max-Age=99999999999999999999", NOW),
		"id=1; Expires=" + new Date(NOW + 400 * 86_400_000).toUTCString()
	);
});

test("cookies without a valid Max-Age stay as they are", () => {
	for (const cookie of ["id=1", "id=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT", "id=1; Max-Age=soon", "max-age=5"])
		assert.equal(expiresFromMaxAge(cookie, NOW), cookie);
});

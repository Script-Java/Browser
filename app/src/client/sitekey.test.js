import { test } from "node:test";
import assert from "node:assert/strict";
import { frameKey, isFrameKey, keyLike, namespaceOf, siteKey, torKey } from "./sitekey.js";

test("a namespace gives a site an origin of its own, and says which one it's in", async () => {
	const plain = await siteKey("mail.google.com");
	// the same as before namespaces, so nobody's sign-ins move
	assert.match(plain, /^s[a-z2-7]{25}$/);
	assert.equal(await siteKey("google.com"), plain);
	assert.equal(await siteKey("google.com", ""), plain);

	const work = await siteKey("google.com", "w3");
	assert.match(work, /^s[a-z2-7]{25}-w3$/);
	assert.notEqual(work.slice(0, 26), plain);
	assert.notEqual(await siteKey("google.com", "w4"), work);
	assert.equal(namespaceOf(work), "w3");
	assert.equal(namespaceOf(plain), "");
	// another site in that namespace, worked out from the label alone
	assert.equal(await keyLike(work, "www.youtube.com"), await siteKey("youtube.com", "w3"));
	assert.equal(await keyLike(await torKey("x.com"), "example.com"), await torKey("example.com"));

	// a frame inside a namespaced tab's page is in the namespace too
	const frame = await frameKey("google.com", "youtube.com", false, "pabcde");
	assert.match(frame, /^f[a-z2-7]{25}-pabcde$/);
	assert.ok(isFrameKey(frame));
	assert.notEqual(frame, await frameKey("google.com", "youtube.com"));
	// nothing but letters and digits makes a namespace
	assert.equal(await siteKey("google.com", "../x"), plain);
});

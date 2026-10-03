import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeUrl } from "./codec.js";
import { serveMedia } from "./media.js";

// Fails before connecting, so no network is needed.
async function statusFor(url) {
	let status;
	const res = { status: (s) => ((status = s), res), type: () => res, send: () => res };
	await serveMedia({ method: "GET", originalUrl: encodeUrl(url), headers: {} }, res);
	return status;
}

test("media fetches only public hosts on ports 80 and 443", async () => {
	assert.equal(await statusFor("http://example.com:25/a.mp4"), 502);
	assert.equal(await statusFor("https://example.com:8443/a.m3u8"), 502);
	assert.equal(await statusFor("http://127.0.0.1/a.mp4"), 502);
	assert.equal(await statusFor("http://[::ffff:10.0.0.1]/a.mp4"), 502);
});

test("media isn't fetched for scripts or workers", async () => {
	for (const dest of ["script", "serviceworker", "worker", "document"]) {
		const req = { method: "GET", originalUrl: encodeUrl("https://example.com/a.js"), headers: { "sec-fetch-dest": dest } };
		assert.equal(await serveMedia(req, {}), false);
	}
});

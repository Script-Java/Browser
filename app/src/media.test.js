import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeUrl } from "./codec.js";
import { rewritePlaylist, sealUrl, serveMedia, unsealUrl } from "./media.js";

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

test("a playlist's addresses are sealed: the logs see none of them, the server reads them back", () => {
	const playlist = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nseg-1.ts?sig=abc\n";
	const out = rewritePlaylist(playlist, new URL("https://cdn.example.com/show/ep1/index.m3u8"), sealUrl);
	assert.doesNotMatch(out, /cdn|example|show|ep1|seg-1|key\.bin|sig/);
	const [key] = /\/scramjet\/__m\/[\w-]+/.exec(out);
	const segment = out.trim().split("\n").pop();
	assert.equal(unsealUrl(key).href, "https://cdn.example.com/show/ep1/key.bin");
	assert.equal(unsealUrl("https://s1.browse.example" + segment).href, "https://cdn.example.com/show/ep1/seg-1.ts?sig=abc");
	// a changed or made-up one opens to nothing
	assert.equal(unsealUrl(segment.slice(0, -2) + (segment.endsWith("A") ? "BB" : "AA")), null);
	assert.equal(unsealUrl("/scramjet/__m/AAAA"), null);
	assert.equal(unsealUrl("/scramjet/" + encodeURIComponent("https://example.com/")), null);
	assert.notEqual(sealUrl("https://example.com/"), sealUrl("https://example.com/"));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeUrl, encodeUrl } from "./codec.js";

test("codec", () => {
	const url = "https://example.com/a b?q=1&r=%2F#top";
	const path = encodeUrl(url);
	assert.ok(path.startsWith("/scramjet/https%3A%2F%2F"));
	// the hash stays in the browser, so it never reaches the decoder
	assert.equal(decodeUrl(path.split("#")[0]).href, "https://example.com/a%20b?q=1&r=%2F");
	assert.equal(decodeUrl("https://proxy.example" + path.split("#")[0]).hostname, "example.com");

	// a GET form adds its fields; Scramjet's own parameters are dropped
	const form = decodeUrl(encodeUrl("https://example.com/search") + "?q=cats&type=module");
	assert.equal(form.href, "https://example.com/search?q=cats");

	assert.equal(decodeUrl("/scramjet/" + encodeURIComponent("javascript:alert(1)")), null);
	assert.equal(decodeUrl("/scramjet/data:text/html,hi"), null);
	assert.equal(decodeUrl("/elsewhere/x"), null);
});

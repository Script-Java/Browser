import { test } from "node:test";
import assert from "node:assert/strict";
import { createCnames } from "./cname.js";

const RECORDS = {
	"metrics.example.com": ["example.com.tracker.net."],
	"example.com.tracker.net": ["edge.cdn.net"],
	"loop.example.com": ["loop2.example.com"],
	"loop2.example.com": ["loop.example.com"],
	"bad.example.com": ["not a name"],
};
const fake = () => {
	const asked = [];
	const resolve = async (host) => {
		asked.push(host);
		if (RECORDS[host]) return RECORDS[host];
		throw Object.assign(new Error("no data"), { code: "ENODATA" });
	};
	return { asked, cnames: createCnames({ resolve }) };
};

test("follows a host's CNAME chain, and remembers it", async () => {
	const { asked, cnames } = fake();
	assert.deepEqual(await cnames.chain("Metrics.Example.com."), ["example.com.tracker.net", "edge.cdn.net"]);
	assert.deepEqual(await cnames.chain("metrics.example.com"), ["example.com.tracker.net", "edge.cdn.net"]);
	assert.equal(asked.filter((h) => h === "metrics.example.com").length, 1);
	assert.deepEqual(await cnames.chain("www.example.com"), []);
});

test("stops at a loop, a bad answer, or what isn't a hostname", async () => {
	const { asked, cnames } = fake();
	assert.deepEqual(await cnames.chain("loop.example.com"), ["loop2.example.com"]);
	assert.deepEqual(await cnames.chain("bad.example.com"), []);
	for (const host of ["", "localhost", "a b.com", "x".repeat(300) + ".com", "1.2.3.4"]) assert.deepEqual(await cnames.chain(host), []);
	assert.ok(!asked.includes("localhost"));
});

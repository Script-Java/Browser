import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WebRisk, hostExpressions } from "./webrisk.js";

const sha = (text) => createHash("sha256").update(text).digest();

test("a host is looked up by itself and the domains it's under", () => {
	assert.deepEqual(hostExpressions("a.b.c.d.e.f.example.com"), [
		"a.b.c.d.e.f.example.com/",
		"d.e.f.example.com/",
		"e.f.example.com/",
		"f.example.com/",
		"example.com/",
	]);
	assert.deepEqual(hostExpressions("example.com"), ["example.com/"]);
	assert.deepEqual(hostExpressions("1.2.3.4"), ["1.2.3.4/"]);
});

test("lists of prefixes, and a full-hash check only when one matches", async () => {
	const evil = sha("evil.example/");
	const other = sha("other.example/");
	const prefixes = [evil.subarray(0, 4), other.subarray(0, 4)].sort(Buffer.compare);
	const asked = [];
	const fetchJson = async (url) => {
		asked.push(url);
		const params = new URL(url).searchParams;
		if (url.includes("computeDiff")) {
			const list = params.get("threatType") === "SOCIAL_ENGINEERING" ? prefixes : [];
			return {
				responseType: "RESET",
				additions: { rawHashes: [{ prefixSize: 4, rawHashes: Buffer.concat(list).toString("base64") }] },
				newVersionToken: "v1",
				checksum: { sha256: createHash("sha256").update(Buffer.concat(list)).digest("base64") },
			};
		}
		// hashes:search: the evil one is listed under its prefix
		const prefix = Buffer.from(params.get("hashPrefix"), "base64");
		return prefix.equals(evil.subarray(0, 4))
			? { threats: [{ threatTypes: ["SOCIAL_ENGINEERING"], hash: evil.toString("base64"), expireTime: new Date(Date.now() + 60_000).toISOString() }] }
			: { negativeExpireTime: new Date(Date.now() + 60_000).toISOString() };
	};
	const risk = new WebRisk({ key: "k", fetchJson });
	await risk.update();
	assert.equal(await risk.check("evil.example"), "phishing");
	assert.equal(await risk.check("www.evil.example"), "phishing");
	// a prefix that matches, but no full hash: fine
	assert.equal(await risk.check("other.example"), null);
	// no prefix: nothing is asked
	const before = asked.length;
	assert.equal(await risk.check("fine.example"), null);
	assert.equal(asked.length, before);
	// the answers are kept
	await risk.check("evil.example");
	assert.equal(asked.length, before);
	// an update with removals keeps the list in step (and checks its checksum)
	await assert.doesNotReject(risk.update());
});

test("a list whose checksum doesn't match starts over", async () => {
	const risk = new WebRisk({
		key: "k",
		fetchJson: async () => ({
			responseType: "RESET",
			additions: { rawHashes: [{ prefixSize: 4, rawHashes: Buffer.from("abcd").toString("base64") }] },
			newVersionToken: "v1",
			checksum: { sha256: Buffer.alloc(32).toString("base64") },
		}),
	});
	await assert.rejects(risk.update(), /checksum/);
	assert.equal(risk.lists.MALWARE.version, "");
});

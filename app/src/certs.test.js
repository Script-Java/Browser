import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readLogList, setCtLogs, transparency } from "./certs.js";

// example.com's certificate and its issuer, and the two CT logs its SCTs
// name (from Chrome's list), as they were on 2026-10-10
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const chain = fixture("ct-chain.json").chain.map((b64) => Buffer.from(b64, "base64"));
const logs = readLogList(fixture("ct-logs.json"));

test("a certificate is logged when SCTs from two operators' logs check out", () => {
	setCtLogs(null);
	assert.equal(transparency(chain).logged, null);
	setCtLogs(logs);
	const { logged, scts } = transparency(chain);
	assert.equal(logged, true);
	assert.deepEqual(scts.map((s) => [s.operator, s.valid]), [["DigiCert", true], ["Cloudflare", true]]);
});

test("a changed certificate, a log not on the list or one operator alone isn't enough", () => {
	setCtLogs(logs);
	// a byte of the subject's key changed: what the logs signed was another certificate
	const changed = Buffer.from(chain[0]);
	changed[changed.length - 120] ^= 1;
	assert.equal(transparency([changed, chain[1]]).logged, false);
	// one of the two logs unknown
	const [first] = logs.keys();
	const fewer = new Map(logs);
	fewer.delete(first);
	setCtLogs(fewer);
	const { logged, scts } = transparency(chain);
	assert.equal(logged, false);
	assert.equal(scts.filter((s) => s.valid).length, 1);
	// both logs run by one operator
	setCtLogs(new Map([...logs].map(([id, log]) => [id, { ...log, operator: "Same" }])));
	assert.equal(transparency(chain).logged, false);
	// a log retired before the timestamp
	setCtLogs(new Map([...logs].map(([id, log]) => [id, { ...log, retiredAt: 0 }])));
	assert.equal(transparency(chain).logged, false);
});

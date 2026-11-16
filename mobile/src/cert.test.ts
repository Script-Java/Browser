/// <reference types="node" />
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { colonHex, fromBase64, parseCertificate } from "./cert";

// a real chain (example.com, Cloudflare's CA), checked against Node's own parser
const { chain } = JSON.parse(readFileSync(new URL("../../app/src/fixtures/ct-chain.json", import.meta.url), "utf8"));

test("reads subject, issuer and validity as Node's X.509 parser does", () => {
	assert.ok(chain.length >= 2);
	for (const b64 of chain) {
		const real = new X509Certificate(Buffer.from(b64, "base64"));
		const ours = parseCertificate(fromBase64(b64));
		assert.equal(ours.subject, real.subject.split("\n").join(", "));
		assert.equal(ours.issuer, real.issuer.split("\n").join(", "));
		assert.equal(ours.notBefore.getTime(), real.validFromDate.getTime());
		assert.equal(ours.notAfter.getTime(), real.validToDate.getTime());
	}
});

test("fingerprints print as Node prints them", async () => {
	const der = fromBase64(chain[0]);
	const digest = await crypto.subtle.digest("SHA-256", der as Uint8Array<ArrayBuffer>);
	assert.equal(colonHex(digest), new X509Certificate(Buffer.from(der)).fingerprint256);
});

test("refuses what isn't a certificate", () => {
	assert.throws(() => parseCertificate(new Uint8Array([0x30, 0x82, 0xff])));
	assert.throws(() => parseCertificate(fromBase64(chain[0]).subarray(0, 100)));
});

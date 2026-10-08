import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createCerts, crlUrls, parseCrl, signedBy } from "./certs.js";

// A test CA's: leaf 1001 is revoked on its list, leaf 1002 isn't (fixtures/).
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const ca = new X509Certificate(fixture("ca.pem"));

test("a certificate's revocation lists, from its CRL distribution points", () => {
	assert.deepEqual(crlUrls(new X509Certificate(fixture("leaf1001.pem")).raw), ["http://crl.badger-test.invalid/test.crl"]);
	assert.deepEqual(crlUrls(ca.raw), []);
});

test("a revocation list says what it revokes, and only its issuer's signature counts", () => {
	const crl = parseCrl(fixture("test.crl"));
	assert.ok(crl.serials.has("1001"));
	assert.ok(!crl.serials.has("1002"));
	assert.ok(crl.nextUpdate > new Date("2100-01-01"));
	assert.equal(signedBy(crl, ca.publicKey), true);
	// signed by anyone else: not believed
	assert.equal(signedBy(crl, new X509Certificate(fixture("leaf1002.pem")).publicKey), false);
	// changed after signing (1001 made 1002): not believed either
	const changed = Buffer.from(fixture("test.crl"));
	changed[changed.indexOf(Buffer.from([0x02, 0x02, 0x10, 0x01])) + 3] = 0x02;
	const forged = parseCrl(changed);
	assert.ok(forged.serials.has("1002"));
	assert.equal(signedBy(forged, ca.publicKey), false);
});

test("a site's certificate: revoked, not revoked, or no telling", async () => {
	const connect = async (host) => ({
		leaf: new X509Certificate(fixture(host.startsWith("revoked") ? "leaf1001.pem" : "leaf1002.pem")),
		issuer: ca,
		trusted: true,
		problem: null,
	});
	let fetched = 0;
	const certs = createCerts({ connect, fetchCrl: async () => (fetched++, fixture("test.crl")) });
	assert.equal((await certs.about("revoked.badger-test.invalid")).revoked, true);
	const fine = await certs.about("fine.badger-test.invalid");
	assert.equal(fine.revoked, false);
	assert.equal(fine.subject, "leaf1002.badger-test.invalid");
	assert.equal(fine.issuer, "Badger Test CA");
	assert.match(fine.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
	// one list, fetched once for both
	assert.equal(fetched, 1);

	// the list can't be had: no telling, which isn't "revoked"
	const offline = createCerts({
		connect,
		fetchCrl: async () => {
			throw new Error("down");
		},
	});
	assert.equal((await offline.about("revoked.badger-test.invalid")).revoked, null);
	// a certificate that fails anyway isn't looked up
	const untrusted = createCerts({ connect: async (host) => ({ ...(await connect(host)), trusted: false, problem: "CERT_HAS_EXPIRED" }) });
	assert.deepEqual(
		[(await untrusted.about("revoked.badger-test.invalid")).revoked, (await untrusted.about("revoked.badger-test.invalid")).problem],
		[null, "CERT_HAS_EXPIRED"]
	);
	// not a web port, or not a host name: nothing asked
	assert.equal(await certs.about("x.badger-test.invalid", 25), null);
	assert.equal(await certs.about("not a host"), null);
});

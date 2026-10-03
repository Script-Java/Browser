import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { CHALLENGE_BITS, createAuth, parseCookies, seal, unseal } from "./auth.js";

const zeroBits = (hex) => {
	const bits = BigInt("0x" + hex).toString(2).padStart(256, "0");
	return bits.length - bits.replace(/^0+/, "").length;
};

function solve(challenge) {
	for (let n = 0; ; n++) {
		const hash = createHash("sha256").update(`${challenge}:${n}`).digest("hex");
		if (zeroBits(hash) >= CHALLENGE_BITS) return n;
	}
}

test("proof-of-work challenge", () => {
	const auth = createAuth({ secret: "s".repeat(32), cookieDomain: () => null });
	assert.equal(auth.mode, "challenge");

	const challenge = auth.newChallenge();
	const solution = solve(challenge);
	assert.ok(auth.solves(challenge, solution));
	const next = createHash("sha256").update(`${challenge}:${solution + 1}`).digest("hex");
	assert.equal(auth.solves(challenge, solution + 1), zeroBits(next) >= CHALLENGE_BITS, "only real answers pass");

	// forged or tampered challenges fail even with a valid-looking answer
	const other = createAuth({ secret: "t".repeat(32), cookieDomain: () => null });
	assert.ok(!other.solves(challenge, solution), "another server's key");
	const [, nonce, mac] = challenge.split(".");
	assert.ok(!auth.solves(`${Date.now() - 11 * 60_000}.${nonce}.${mac}`, solution), "expired");
	assert.ok(!auth.solves(challenge, "1e9"), "non-numeric answer");
});

test("modes", () => {
	assert.equal(createAuth({ password: "p", secret: "", cookieDomain: () => null }).mode, "password");
	assert.equal(createAuth({ password: "", secret: "", cookieDomain: () => null }).mode, "off");
});

test("a malformed cookie doesn't throw", () => {
	assert.deepEqual(parseCookies("bios_auth=%E0%A4%A; a=b%20c"), { bios_auth: "%E0%A4%A", a: "b c" });
	const auth = createAuth({ password: "pw", cookieDomain: () => null });
	assert.equal(auth.isAuthed({ headers: { cookie: "bios_auth=%E0%A4%A" } }), false);
});

test("sealed cookies can't be read, changed or opened with another key", () => {
	const key = randomBytes(32);
	const token = seal(key, { allow: ["secret-site.example"] });
	assert.deepEqual(unseal(key, token), { allow: ["secret-site.example"] });
	assert.ok(!Buffer.from(token, "base64url").toString("latin1").includes("secret-site"));
	assert.equal(unseal(randomBytes(32), token), null);
	const flipped = Buffer.from(token, "base64url");
	flipped[20] ^= 1;
	assert.equal(unseal(key, flipped.toString("base64url")), null);
	// a truncated tag must not pass
	assert.equal(unseal(key, token.slice(0, -10)), null);
	assert.equal(unseal(key, "not.a.token"), null);
});

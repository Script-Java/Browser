import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CHALLENGE_BITS, createAuth } from "./auth.js";

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

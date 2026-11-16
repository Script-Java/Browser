/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import * as generated from "./generated";
import { scriptsFor } from "./index";

const base = { route: "relay", blocking: true, level: "standard", passkeys: false, consent: true } as const;

test("every generated script is valid JavaScript", () => {
	for (const [name, text] of Object.entries(generated)) assert.doesNotThrow(() => new Function(text), name);
});

test("relay sites lose WebRTC, WebTransport and DNS prefetching, first thing", () => {
	assert.equal(scriptsFor(base).page[0], generated.relay);
	assert.ok(!scriptsFor({ ...base, route: "direct" }).page.includes(generated.relay));
});

test("passkeys on relay sites only where allowed, and on direct ones", () => {
	assert.ok(scriptsFor(base).page.includes(generated.noCredentials));
	assert.ok(!scriptsFor({ ...base, passkeys: true }).page.includes(generated.noCredentials));
	assert.ok(!scriptsFor({ ...base, route: "direct" }).page.includes(generated.noCredentials));
});

test("fingerprinting: Safer's answers at Safer and Safest, the standard ones where blocking is on", () => {
	assert.ok(scriptsFor({ ...base, level: "safest", blocking: false }).page.includes(generated.fingerprintSafer));
	assert.ok(scriptsFor(base).page.includes(generated.fingerprintStandard));
	const off = scriptsFor({ ...base, blocking: false }).page;
	assert.ok(!off.includes(generated.fingerprintStandard) && off.includes(generated.gpc));
});

test("cookie notices are answered where blocking is on and the setting is", () => {
	assert.deepEqual(scriptsFor(base).isolated, [generated.consent]);
	assert.deepEqual(scriptsFor({ ...base, consent: false }).isolated, []);
	assert.deepEqual(scriptsFor({ ...base, blocking: false }).isolated, []);
});

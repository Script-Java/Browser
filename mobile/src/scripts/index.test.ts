/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import * as generated from "./generated";
import { scriptsFor } from "./index";

const base = { route: "relay", blocking: true, level: "standard", passkeys: false, consent: true } as const;

test("every generated script is valid JavaScript", () => {
	for (const [name, text] of Object.entries(generated)) assert.doesNotThrow(() => new Function(text), name);
});

test("relay sites lose WebRTC and WebTransport, first thing", () => {
	assert.equal(scriptsFor(base).page[0], generated.relay);
	assert.ok(!scriptsFor({ ...base, route: "direct" }).page.includes(generated.relay));
});

// A page's realm with the parts of the DOM relay.js touches; `frame()` makes a frame still on its first document.
const PAGE = `
	class Document { get defaultView() { return this.view; } }
	class HTMLIFrameElement {
		get contentWindow() { return this.view; }
		get contentDocument() { return this.view.document; }
	}
	class HTMLFrameElement {}
	class HTMLObjectElement {}
	const engine = () => ({ RTCPeerConnection: class {}, RTCDataChannel: class {}, Worker: class {}, SharedWorker: class {}, WebTransport: class {} });
	Object.assign(globalThis, engine(), { self: globalThis });
	const frame = () => {
		const view = engine();
		view.document = Object.assign(new Document(), { view });
		return Object.assign(new HTMLIFrameElement(), { view });
	};
	const source = (o, name) => Function.prototype.toString.call(Object.getOwnPropertyDescriptor(o, name).get);
	const before = source(HTMLIFrameElement.prototype, "contentWindow");
`;

function page(withWebTransport = true) {
	const realm = vm.createContext({});
	vm.runInContext(PAGE, realm);
	if (!withWebTransport) vm.runInContext("delete globalThis.WebTransport", realm);
	vm.runInContext(generated.relay, realm);
	return (code: string) => vm.runInContext(code, realm);
}

test("relay.js: no WebRTC or WebTransport in the page, and no workers where they'd have WebTransport", () => {
	const run = page();
	assert.equal(run("typeof RTCPeerConnection + typeof RTCDataChannel + typeof WebTransport"), "undefinedundefinedundefined");
	assert.equal(run("typeof Worker + typeof SharedWorker"), "undefinedundefined");
	// the page can't put them back
	assert.equal(run("RTCPeerConnection = class {}; typeof RTCPeerConnection"), "undefined");
	// Lockdown, or an engine without WebTransport: workers stay
	assert.equal(page(false)("typeof Worker + typeof RTCPeerConnection"), "functionundefined");
	assert.ok(!generated.relay.includes("dns-prefetch"));
});

test("relay.js: a frame's window is locked before the page gets it, however it asks", () => {
	const run = page();
	assert.equal(run("typeof frame().contentWindow.RTCPeerConnection"), "undefined");
	assert.equal(run("const f = frame(); f.contentDocument; typeof f.view.WebTransport + typeof f.view.Worker"), "undefinedundefined");
	// the page swaps the built-ins relay.js could have used
	run(`
		Reflect.apply = () => undefined;
		Object.defineProperty = () => undefined;
		Function.prototype.call = Function.prototype.apply = () => undefined;
		WeakMap.prototype.get = () => undefined;
		Array.prototype[Symbol.iterator] = function* () {};
	`);
	assert.equal(run("typeof frame().contentWindow.RTCPeerConnection"), "undefined");
});

test("relay.js: its getters read as the engine's own", () => {
	const run = page();
	assert.equal(run('source(HTMLIFrameElement.prototype, "contentWindow") === before'), true);
	assert.equal(run('Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow").get.name'), "get contentWindow");
	assert.match(run("Function.prototype.toString.call(Function.prototype.toString)"), /\[native code\]/);
	assert.equal(run("Function.prototype.toString.name + Function.prototype.toString.length + ('prototype' in Function.prototype.toString)"), "toString0false");
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

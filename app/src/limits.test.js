import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { clientKey, createLimits } from "./limits.js";

const req = (xff, remote = "100.64.0.1") => ({
	headers: xff ? { "x-forwarded-for": xff } : {},
	socket: { remoteAddress: remote },
});

test("clientKey", () => {
	assert.equal(clientKey(req("203.0.113.5, 100.64.0.2")), "203.0.113.5");
	assert.equal(clientKey(req("", "::ffff:198.51.100.7")), "198.51.100.7");
	// every address in one /64 is one client
	assert.equal(clientKey(req("2001:db8:a:b::1")), "2001:db8:a:b::/64");
	assert.equal(clientKey(req("2001:db8:a:b:ffff:1:2:3")), "2001:db8:a:b::/64");
	assert.equal(clientKey(req("2001:db8::1")), "2001:db8:0:0::/64");
	assert.notEqual(clientKey(req("2001:db8:a:c::1")), clientKey(req("2001:db8:a:b::1")));
});

function fakeSocket() {
	const s = new EventEmitter();
	s.bytesRead = 0;
	s.bytesWritten = 0;
	s.destroy = () => s.emit("close");
	return s;
}

test("socket cap and daily quota", () => {
	const limits = createLimits({ maxSockets: 2, dailyBytes: 1000 });
	const a = fakeSocket();
	assert.ok(limits.trackSocket("x", a));
	assert.ok(limits.trackSocket("x", fakeSocket()));
	assert.ok(!limits.trackSocket("x", fakeSocket()), "third socket refused");
	assert.ok(limits.trackSocket("y", fakeSocket()), "other clients unaffected");

	a.bytesWritten = 600;
	a.emit("close"); // counted on close, frees a slot
	assert.ok(!limits.overQuota("x"));
	limits.addBytes("x", 500); // media traffic counts too
	assert.ok(limits.overQuota("x"));
	assert.ok(!limits.trackSocket("x", fakeSocket()), "over quota refuses new sockets");
});

test("server-wide daily cap", () => {
	const limits = createLimits({ maxSockets: 10, dailyBytes: 0, totalDailyBytes: 1000 });
	limits.addBytes("a", 600);
	assert.ok(!limits.overQuota("b"));
	limits.addBytes("b", 400);
	assert.ok(limits.overQuota("c"), "everyone is refused once the server total is reached");
	assert.ok(!limits.trackSocket("c", fakeSocket()));
});

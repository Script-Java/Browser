/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import { isRobotCheck, warningFor } from "./navigation";

const never = async () => {
	throw new Error("the server shouldn't be asked");
};

test("look-alike addresses are caught on the phone, whatever the route", async () => {
	assert.deepEqual(await warningFor("https://paypa1.com/login", "direct", never), {
		kind: "lookalike",
		host: "paypa1.com",
		url: "https://paypa1.com/login",
		real: "paypal.com",
	});
	assert.equal(await warningFor("https://www.paypal.com/", "direct", never), null);
});

test("the server's lists are asked about relay sites only", async () => {
	const asked: string[] = [];
	const threat = async (host: string) => (asked.push(host), host === "bad.example" ? ("phishing" as const) : null);
	assert.equal((await warningFor("https://bad.example/", "relay", threat))?.kind, "phishing");
	assert.equal(await warningFor("https://good.example/", "relay", threat), null);
	assert.equal(await warningFor("https://bad.example/", "direct", threat), null);
	assert.deepEqual(asked, ["bad.example", "good.example"]);
});

test("a failing server lets the page open; other schemes aren't checked", async () => {
	assert.equal(await warningFor("https://example.com/", "relay", never), null);
	assert.equal(await warningFor("about:blank", "relay", never), null);
	assert.equal(await warningFor("data:text/html,hi", "relay", never), null);
});

test("robot checks", () => {
	assert.ok(isRobotCheck({ url: "https://www.google.com/sorry/index?continue=x", title: "" }));
	assert.ok(isRobotCheck({ url: "https://www.google.co.uk/sorry/index", title: "" }));
	assert.ok(isRobotCheck({ url: "https://example.com/", title: "Just a moment..." }));
	assert.ok(isRobotCheck({ url: "https://example.com/", title: "Just a moment…" }));
	assert.ok(!isRobotCheck({ url: "https://example.com/sorry/", title: "Sorry" }));
	assert.ok(!isRobotCheck({ url: "https://www.google.com/search?q=sorry", title: "sorry - Google Search" }));
});

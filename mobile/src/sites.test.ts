/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import { addressFor } from "./address";
import { effective, siteOf } from "./sites";

test("sites are registrable domains, private suffixes included", () => {
	assert.equal(siteOf("https://mail.google.com/x"), "google.com");
	assert.equal(siteOf("https://www.bbc.co.uk/"), "bbc.co.uk");
	assert.equal(siteOf("https://someone.github.io/"), "someone.github.io");
	assert.equal(siteOf("https://192.168.1.1:8080/"), "192.168.1.1");
	assert.equal(siteOf("WWW.Example.COM."), "example.com");
	assert.equal(siteOf("about:blank"), null);
});

test("Relay, blocking and no passkeys unless the site says otherwise; Safest brings Lockdown", () => {
	assert.deepEqual(effective(undefined, "standard"), { route: "relay", blocking: true, level: "standard", lockdown: false, passkeys: false });
	assert.equal(effective({ level: "safest" }, "standard").lockdown, true);
	assert.equal(effective(undefined, "safest").lockdown, true);
	assert.equal(effective({ lockdown: false }, "safest").lockdown, false);
	assert.equal(effective({ route: "direct" }, "standard").route, "direct");
});

test("the address bar opens addresses and searches the rest", () => {
	assert.equal(addressFor("example.com", "google"), "https://example.com/");
	assert.equal(addressFor("http://example.com/a", "google"), "http://example.com/a");
	assert.equal(addressFor("cats and dogs", "duckduckgo"), "https://duckduckgo.com/?q=cats%20and%20dogs");
	assert.equal(addressFor("localhost", "google"), "https://www.google.com/search?q=localhost");
	assert.equal(addressFor("javascript:alert(1)", "bing"), "https://www.bing.com/search?q=javascript%3Aalert(1)");
});

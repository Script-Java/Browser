import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSettings, DEFAULT_SETTINGS, parseHosts, shortcutFor, siteOf, threatFor } from "./rules.js";

test("settings: junk becomes defaults", () => {
	const out = cleanSettings({ ads: "no", search: "evil", allow: ["ok.com", "<x>", 3], extra: 1 });
	assert.deepEqual(out, { ...DEFAULT_SETTINGS, allow: ["ok.com"] });
	assert.equal(cleanSettings({ search: "toString" }).search, DEFAULT_SETTINGS.search, "no prototype keys");
});

test("threat lists", () => {
	const hosts = parseHosts("# comment\n0.0.0.0 bad.example\n\n0.0.0.0 evil.test \n0.0.0.0 0.0.0.0\n");
	assert.deepEqual(hosts, ["bad.example", "evil.test"]);
	const threats = new Map([["bad.example", "phishing"]]);
	assert.equal(threatFor(threats, "bad.example"), "phishing");
	assert.equal(threatFor(threats, "login.bad.example."), "phishing", "subdomains too");
	assert.equal(threatFor(threats, "notbad.example"), null);
	assert.equal(threatFor(threats, "example"), null);
});

test("sites", () => {
	assert.equal(siteOf("mail.google.com"), "google.com");
	assert.equal(siteOf("news.bbc.co.uk"), "bbc.co.uk");
	assert.equal(siteOf("user.github.io"), "user.github.io");
});

test("shortcuts", () => {
	const key = (key, mods = {}) => ({ type: "keyDown", key, ...mods });
	assert.equal(shortcutFor(key("t", { control: true }), "win32"), "new-tab");
	assert.equal(shortcutFor(key("t", { meta: true }), "darwin"), "new-tab");
	assert.equal(shortcutFor(key("t", { control: true }), "darwin"), null, "Ctrl is not Cmd on a Mac");
	assert.equal(shortcutFor(key("Tab", { control: true, shift: true }), "win32"), "prev-tab");
	assert.equal(shortcutFor(key("ArrowLeft", { alt: true }), "win32"), "back");
	assert.equal(shortcutFor(key("F5"), "win32"), "reload");
	assert.equal(shortcutFor(key("c", { control: true }), "win32"), null, "copy stays with the page");
	assert.equal(shortcutFor({ type: "keyUp", key: "t", control: true }, "win32"), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Filters, parseDebounce } from "./filters.js";

test("threat lists are checked again often, and fetched only when they changed", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "bios-threats-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let version = 1;
	const asked = [];
	const fetch = async (url, since) => {
		asked.push([url, since?.etag]);
		if (url.includes("urlhaus.abuse.ch")) {
			if (since?.etag === `"v${version}"`) return { unchanged: true };
			const hosts = version === 1 ? ["bad.example"] : ["bad.example", "worse.example"];
			return { text: hosts.map((h) => `127.0.0.1\t${h}`).join("\n"), etag: `"v${version}"` };
		}
		if (url.includes("phishing.army")) throw new Error("down");
		return { text: "# list\n0.0.0.0 phish.example\n", etag: '"same"' };
	};
	const filters = new Filters({ cacheDir: dir, refreshHours: 24, fetch });
	await filters.refreshThreats();
	assert.equal(filters.threat("bad.example"), "malware");
	assert.equal(filters.threat("www.phish.example"), "phishing");
	assert.equal(filters.threat("worse.example"), null);
	assert.ok(filters.status().threatsCheckedAt > 0);

	// asked again with what it takes to answer "unchanged"
	asked.length = 0;
	await filters.refreshThreats();
	assert.ok(asked.some(([url, etag]) => url.includes("urlhaus.abuse.ch") && etag === '"v1"'));
	// a host new on the five-minute list is there at the next check
	version = 2;
	await filters.refreshThreats();
	assert.equal(filters.threat("worse.example"), "malware");

	// kept on disk for the next start; offline, each list keeps its copy
	const offline = async () => {
		throw new Error("offline");
	};
	const again = new Filters({ cacheDir: dir, refreshHours: 24, fetch: offline });
	await again.loadThreats();
	await again.refreshThreats();
	assert.equal(again.threat("worse.example"), "malware");
	assert.equal(again.threat("phish.example"), "phishing");
});

test("the server's own hosts are warned about from the start, whatever the lists say", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "bios-threats-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const fetch = async () => ({ text: "0.0.0.0 scam.example\n" });
	const filters = new Filters({ cacheDir: dir, refreshHours: 24, fetch, ownThreats: ["scam.example", "own.example"] });
	assert.equal(filters.threat("own.example"), "phishing");
	await filters.refreshThreats();
	assert.equal(filters.threat("www.own.example"), "phishing");
	assert.equal(filters.threat("scam.example"), "phishing");
});

test("Brave's bounce rules: only the fields the worker reads, nothing malformed", () => {
	const rules = parseDebounce(
		JSON.stringify([
			{ include: ["*://a.example/*"], exclude: [], action: "redirect", param: "u", pref: "x", extra: { a: 1 } },
			{ include: "not a list", action: "redirect", param: "u" },
			null,
		])
	);
	assert.deepEqual(rules, [
		{ include: ["*://a.example/*"], exclude: [], action: "redirect", param: "u", prepend_scheme: undefined, redirect_url_template: undefined },
	]);
	assert.throws(() => parseDebounce('{"not": "a list"}'));
});

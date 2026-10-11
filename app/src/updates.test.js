import { test } from "node:test";
import assert from "node:assert/strict";
import { fromGitHub, releaseFile } from "./updates.js";

test("the update relay fetches GitHub's release files and nothing else", async () => {
	assert.ok(fromGitHub("https://github.com/Script-Java/Browser/releases/latest/download/latest.yml"));
	assert.ok(fromGitHub("https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r"));
	for (const url of [
		"http://github.com/x",
		"https://github.com.evil.example/x",
		"https://evil.example/github.com",
		"https://github.com:8443/x",
		"https://user@github.com/x",
		"https://169.254.169.254/latest/meta-data",
		"not a url",
	])
		assert.equal(fromGitHub(url), false, url);
	await assert.rejects(releaseFile("../../etc/passwd"), /not an update file/);
	await assert.rejects(releaseFile("latest.yml", "https://evil.example/latest.yml"), /not an update file/);
});

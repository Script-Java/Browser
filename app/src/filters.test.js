import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Filters } from "./filters.js";

test("every threat list counts, each refetched only when it changed, with the operator's own", async () => {
	const lists = {
		"https://malware-filter.gitlab.io/malware-filter/phishing-filter-hosts.txt": "0.0.0.0 fish.example\n# note\n",
		"https://phishing.army/download/phishing_army_blocklist.txt": "army.example\nboth.example\n",
		"https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts-online.txt": "0.0.0.0 bad.example\n",
		"https://urlhaus.abuse.ch/downloads/hostfile/": "127.0.0.1\tlive.example\n127.0.0.1\tboth.example\n",
	};
	const asked = [];
	const fetchList = async ([url], since) => {
		asked.push([url, !!since]);
		return since ? null : { text: lists[url], etag: "x", modified: null };
	};
	const filters = new Filters({
		cacheDir: await mkdtemp(join(tmpdir(), "filters-")),
		refreshHours: 24,
		ownThreats: ["scam.example"],
		fetchList,
	});
	// the operator's own work before any list comes down
	assert.equal(filters.threat("scam.example"), "phishing");
	await filters.buildThreats();
	assert.equal(filters.threat("fish.example"), "phishing");
	assert.equal(filters.threat("army.example"), "phishing");
	assert.equal(filters.threat("bad.example"), "malware");
	assert.equal(filters.threat("www.live.example"), "malware");
	// on a phishing list and a malware list: the phishing warning
	assert.equal(filters.threat("both.example"), "phishing");
	assert.equal(filters.threat("fine.example"), null);
	// the next round asks with what each list said last time
	asked.length = 0;
	await filters.buildThreats();
	assert.equal(asked.length, 4);
	assert.ok(asked.every(([, since]) => since));
	assert.equal(filters.threat("live.example"), "malware");
});

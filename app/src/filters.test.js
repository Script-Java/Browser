import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FiltersEngine } from "@ghostery/adblocker";
import { Filters, contentRuleLists } from "./filters.js";

test("every threat list counts, each refetched only when it changed, with the operator's own", async () => {
	const lists = {
		"https://malware-filter.gitlab.io/malware-filter/phishing-filter-hosts.txt": "0.0.0.0 fish.example\n# note\n",
		"https://phishing.army/download/phishing_army_blocklist.txt": "army.example\nboth.example\n",
		"https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts-online.txt": "0.0.0.0 bad.example\n0.0.0.0 both.example\n",
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
	assert.equal(filters.threat("www.bad.example"), "malware");
	// on a phishing list and a malware list: the phishing warning
	assert.equal(filters.threat("both.example"), "phishing");
	assert.equal(filters.threat("fine.example"), null);
	// the next round asks with what each list said last time
	asked.length = 0;
	await filters.buildThreats();
	assert.equal(asked.length, 3);
	assert.ok(asked.every(([, since]) => since));
	assert.equal(filters.threat("bad.example"), "malware");
});

test("the ad lists become content-blocker lists of at most the limit, each ending with every exception", () => {
	const fixture = [
		"! a comment",
		"||ads.example^",
		"||track.example^$third-party",
		"||pixel.example^$image",
		"/banner/*$script",
		"##.ad-banner",
		"news.example##.promo",
		"@@||ads.example/ok^",
		// scriptlets can't be content rules: left out
		"example.com##+js(nobab)",
	].join("\n");
	const lists = contentRuleLists([fixture], 4);
	const exceptions = (list) => list.filter((rule) => rule.action.type === "ignore-previous-rules");
	assert.ok(lists.length > 1);
	for (const list of lists) {
		assert.ok(list.length <= 4);
		// the site's own exception, then Brave's "never block the page itself"
		assert.deepEqual(exceptions(list), exceptions(lists[0]));
		assert.equal(exceptions(list).length, 2);
		assert.deepEqual(list.slice(-2), exceptions(list));
	}
	const others = lists.flatMap((list) => list.filter((rule) => rule.action.type !== "ignore-previous-rules"));
	assert.equal(others.length, 6);
	assert.ok(others.some((rule) => rule.action.selector === ".promo" && rule.trigger["if-domain"][0] === "news.example"));
	assert.equal(contentRuleLists([fixture]).length, 1);
	assert.throws(() => contentRuleLists([fixture], 2), /no room/);
});

test("content rules survive a restart under the same ids", async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), "filters-"));
	const filters = new Filters({ cacheDir, refreshHours: 24 });
	filters.setEngine(Buffer.from(FiltersEngine.parse("").serialize()));
	filters.setContentRules(contentRuleLists(["||ads.example^\n##.ad\n@@||ads.example/ok^"], 3));
	await filters.saveCache();
	const again = new Filters({ cacheDir, refreshHours: 24 });
	await again.loadCache();
	const index = JSON.parse(again.contentRules.index.raw);
	assert.equal(index.lists.length, 2);
	assert.deepEqual(index, JSON.parse(filters.contentRules.index.raw));
	assert.deepEqual(JSON.parse(again.contentRules.lists.get(index.lists[1]).raw), JSON.parse(filters.contentRules.lists.get(index.lists[1]).raw));
});

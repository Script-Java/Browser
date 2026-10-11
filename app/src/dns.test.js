import { test } from "node:test";
import assert from "node:assert/strict";
import { query } from "./dns.js";

test("a DoH answer gives the records asked for, kept for their TTL within limits", async () => {
	const asked = [];
	const answer = (json) => async (url) => (asked.push(url), json);
	// an alias first, then its addresses: only the addresses
	assert.deepEqual(
		await query("www.example.com", "A", answer({
			Status: 0,
			Answer: [
				{ name: "www.example.com", type: 5, TTL: 3600, data: "edge.example.net." },
				{ name: "edge.example.net", type: 1, TTL: 60, data: "93.184.215.14" },
				{ name: "edge.example.net", type: 1, TTL: 120, data: "93.184.215.15" },
			],
		})),
		{ records: ["93.184.215.14", "93.184.215.15"], ttl: 120 }
	);
	assert.match(asked[0], /\?name=www\.example\.com&type=A$/);
	// an alias, as asked for one, without its trailing dot
	assert.deepEqual(await query("m.example.com", "CNAME", answer({ Status: 0, Answer: [{ type: 5, TTL: 5, data: "Tracker.Example.NET." }] })), {
		records: ["tracker.example.net"],
		ttl: 30,
	});
	// no such name: none; a failed lookup: an error
	assert.deepEqual(await query("nope.example", "A", answer({ Status: 3 })), { records: [], ttl: 30 });
	await assert.rejects(query("x.example", "A", answer({ Status: 2 })), /DNS answered 2/);
	// never kept longer than five minutes
	assert.equal((await query("a.example", "AAAA", answer({ Status: 0, Answer: [{ type: 28, TTL: 86400, data: "2606:2800::1" }] }))).ttl, 300);
});

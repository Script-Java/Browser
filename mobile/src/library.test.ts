import assert from "node:assert/strict";
import { test } from "node:test";

import { type Entry, recordVisit, shortcuts, suggestions, timeAgo, toggleBookmark } from "./library";

const at = 1_700_000_000_000;

test("a visit is recorded once: its title, arriving later or from a tab loading alongside, updates it", () => {
	let h = recordVisit([], { url: "https://a.example/", title: "" }, at);
	h = recordVisit(h, { url: "https://b.example/", title: "B" }, at + 1);
	h = recordVisit(h, { url: "https://a.example/", title: "A" }, at + 2);
	assert.deepEqual(h, [
		{ url: "https://b.example/", title: "B", at: at + 1 },
		{ url: "https://a.example/", title: "A", at },
	]);
	// the same unchanged state again: the same list, so nothing is written
	assert.equal(recordVisit(h, { url: "https://a.example/", title: "A" }, at + 3), h);
	// back an hour later: a new visit
	assert.equal(recordVisit(h, { url: "https://a.example/", title: "A" }, at + 3_600_000).length, 3);
});

test("only web pages, at most 1000, titles cut at 200", () => {
	assert.deepEqual(recordVisit([], { url: "about:blank", title: "" }), []);
	const full: Entry[] = Array.from({ length: 1000 }, (_, i) => ({ url: `https://e${i}.example/`, title: "", at: at - i * 3_600_000 }));
	const h = recordVisit(full, { url: "https://new.example/", title: "x".repeat(300) }, at);
	assert.equal(h.length, 1000);
	assert.equal(h[0].title.length, 200);
});

test("bookmarking toggles, and names a page without a title by its host", () => {
	const marks = toggleBookmark([], { url: "https://www.example.com/a", title: "" });
	assert.deepEqual(marks, [{ url: "https://www.example.com/a", title: "example.com" }]);
	assert.deepEqual(toggleBookmark(marks, { url: "https://www.example.com/a", title: "" }), []);
	assert.deepEqual(toggleBookmark([], { url: "about:blank", title: "" }), []);
});

test("suggestions: bookmarks first, each address once, by title or address", () => {
	const marks = [{ url: "https://news.example/", title: "Daily News" }];
	const history = [
		{ url: "https://news.example/", title: "Daily News", at },
		{ url: "https://other.example/news", title: "Other", at },
		{ url: "https://unrelated.example/", title: "Nothing", at },
	];
	assert.deepEqual(
		suggestions(" NEWS ", marks, history).map((s) => [s.url, s.bookmark]),
		[
			["https://news.example/", true],
			["https://other.example/news", false],
		]
	);
	assert.deepEqual(suggestions("", marks, history), []);
});

test("shortcuts: bookmarks, then the most visited sites' front pages", () => {
	const history = [
		{ url: "https://b.example/1", title: "", at },
		{ url: "https://c.example/1", title: "", at },
		{ url: "https://c.example/2", title: "", at },
		{ url: "https://a.example/x", title: "", at },
	];
	assert.deepEqual(
		shortcuts([{ url: "https://a.example/mark", title: "A" }], history).map((s) => s.url),
		["https://a.example/mark", "https://c.example/", "https://b.example/"]
	);
});

test("how long ago", () => {
	assert.equal(timeAgo(at, at + 30_000), "just now");
	assert.equal(timeAgo(at, at + 5 * 60_000), "5 min ago");
	assert.equal(timeAgo(at, at + 3 * 3_600_000), "3 h ago");
	assert.equal(timeAgo(at, at + 2 * 86_400_000), new Date(at).toLocaleDateString());
});

// History and bookmarks, as the old app keeps them (app/public/index.js,
// recordVisit, toggleBookmark, suggestions, shortcuts). Only on this phone:
// never sent to the server. Private tabs add nothing.
import { hostOf } from "./address";

export type Entry = { url: string; title: string; at: number };
export type Page = { url: string; title: string };

const MAX_HISTORY = 1000;
// a visit's title comes after its address, and tabs load side by side: an
// entry this recent for the same address is the same visit
const SAME_VISIT_MS = 30 * 60_000;

const web = (url: string) => /^https?:/.test(url);

export function recordVisit(history: Entry[], { url, title }: Page, now = Date.now()): Entry[] {
	if (!web(url)) return history;
	title = title.slice(0, 200);
	const i = history.slice(0, 10).findIndex((e) => e.url === url && now - e.at < SAME_VISIT_MS);
	if (i !== -1) {
		if (!title || history[i].title === title) return history;
		return history.map((e, j) => (j === i ? { ...e, title } : e));
	}
	return [{ url, title, at: now }, ...history].slice(0, MAX_HISTORY);
}

export const isBookmarked = (bookmarks: Page[], url: string | undefined) => !!url && bookmarks.some((b) => b.url === url);

export function toggleBookmark(bookmarks: Page[], { url, title }: Page): Page[] {
	if (!web(url)) return bookmarks;
	return isBookmarked(bookmarks, url) ? bookmarks.filter((b) => b.url !== url) : [{ url, title: nameOf({ url, title }).slice(0, 200) }, ...bookmarks];
}

export const nameOf = ({ url, title }: Page) => title || hostOf(url).replace(/^www\./, "");

/** Bookmarks first, then history, whose title or address has what was typed. */
export function suggestions(typed: string, bookmarks: Page[], history: Entry[], max = 6): (Page & { bookmark: boolean })[] {
	const q = typed.trim().toLowerCase();
	if (!q) return [];
	const seen = new Set<string>();
	const found: (Page & { bookmark: boolean })[] = [];
	for (const [list, bookmark] of [[bookmarks, true], [history, false]] as const)
		for (const page of list) {
			if (found.length >= max) return found;
			if (seen.has(page.url) || !(page.title.toLowerCase().includes(q) || page.url.toLowerCase().includes(q))) continue;
			seen.add(page.url);
			found.push({ url: page.url, title: page.title, bookmark });
		}
	return found;
}

/** A new tab's shortcuts: the bookmarks, then the most visited sites' front pages. */
export function shortcuts(bookmarks: Page[], history: Entry[], max = 8): Page[] {
	const picked = new Map<string, Page>();
	for (const b of bookmarks) if (!picked.has(hostOf(b.url))) picked.set(hostOf(b.url), b);
	const visits = new Map<string, { count: number; url: string }>();
	for (const h of history) {
		const host = hostOf(h.url);
		const seen = visits.get(host);
		if (seen) seen.count++;
		else visits.set(host, { count: 1, url: new URL(h.url).origin + "/" });
	}
	for (const [host, { url }] of [...visits].sort((a, b) => b[1].count - a[1].count))
		if (!picked.has(host)) picked.set(host, { url, title: "" });
	return [...picked.values()].slice(0, max);
}

/** "just now", "5 min ago", "3 h ago", then the date. */
export function timeAgo(at: number, now = Date.now()): string {
	const minutes = Math.floor((now - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
	return new Date(at).toLocaleDateString();
}

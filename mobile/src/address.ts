// What the address bar opens: an address, or a search.

// Keys match SEARCH_ENGINES in app/src/settings.js; templates from app/public/index.js.
export const SEARCH = {
	google: "https://www.google.com/search?q=%s",
	duckduckgo: "https://duckduckgo.com/?q=%s",
	bing: "https://www.bing.com/search?q=%s",
	brave: "https://search.brave.com/search?q=%s",
};
export type Engine = keyof typeof SEARCH;
export const ENGINE_NAMES: Record<Engine, string> = { google: "Google", brave: "Brave Search", duckduckgo: "DuckDuckGo", bing: "Bing" };

/** As the old app's toUrl: a full http(s) address, a host name, or else a search. */
export function addressFor(input: string, engine: Engine): string {
	input = input.trim();
	try {
		const url = new URL(input);
		if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
	} catch {
		// not a full address
	}
	try {
		const url = new URL(`https://${input}`);
		if (url.hostname.includes(".") && !input.includes(" ")) return url.toString();
	} catch {
		// not a host name
	}
	return (SEARCH[engine] ?? SEARCH.google).replace("%s", encodeURIComponent(input));
}

/** The host to show for an address, or the address itself. */
export function hostOf(address: string): string {
	try {
		return new URL(address).hostname || address;
	} catch {
		return address;
	}
}

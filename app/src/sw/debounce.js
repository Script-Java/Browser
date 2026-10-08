// Bounce tracking: a link that goes through a tracker's address on its way to
// the real one (an affiliate network, a social site's "you're leaving" page),
// so the tracker learns of every click. Rules in Brave's format ("debounce")
// say where such an address carries the real one, and the app goes straight
// there. The server adds Brave's own list to these (filters.js).

// The link wrappers of the big sites, which Brave's list leaves out.
export const OWN_RULES = [
	{ include: ["*://l.facebook.com/l.php?*", "*://lm.facebook.com/l.php?*", "*://l.messenger.com/l.php?*"], action: "redirect", param: "u" },
	{ include: ["*://l.instagram.com/?*", "*://l.threads.net/?*"], action: "redirect", param: "u" },
	{ include: ["*://www.google.com/url?*"], action: "redirect", param: "q" },
	{ include: ["*://www.google.com/url?*"], action: "redirect", param: "url" },
	{ include: ["*://www.youtube.com/redirect?*"], action: "redirect", param: "q" },
	{ include: ["*://out.reddit.com/*"], action: "redirect", param: "url" },
	{ include: ["*://slack-redir.net/link?*"], action: "redirect", param: "url" },
	{ include: ["*://duckduckgo.com/l/?*"], action: "redirect", param: "uddg" },
	{ include: ["*://vk.com/away.php?*"], action: "redirect", param: "to" },
	{ include: ["*://t.umblr.com/redirect?*"], action: "redirect", param: "z" },
	{ include: ["*://medium.com/r/?*"], action: "redirect", param: "url" },
	{ include: ["*://steamcommunity.com/linkfilter/?*"], action: "redirect", param: "u" },
	{ include: ["*://steamcommunity.com/linkfilter/?*"], action: "redirect", param: "url" },
];

const ACTIONS = new Set(["redirect", "base64,redirect", "regex-path", "regex-path-template"]);

/**
 * A match pattern ("*://*.example.com/go?*") taken apart, or null. Matched
 * below without a regex, so a pattern from the list can't make matching slow
 * (a glob to a RegExp can backtrack; a two-pointer scan can't).
 */
export function parsePattern(pattern) {
	const parts = /^(\*|https?):\/\/([^/]*)(\/.*)$/.exec(String(pattern));
	if (!parts) return null;
	const [, scheme, host, path] = parts;
	// the path split on its wildcards: the literal pieces between them
	return { scheme, host: host.toLowerCase(), pieces: path.toLowerCase().split("*") };
}

/**
 * Whether `url` (its scheme, lower-case host and lower-case path+query) fits
 * the pattern. The path is a glob: its literal pieces must appear in order,
 * which a left-to-right scan decides without backtracking.
 */
export function matches(pattern, scheme, host, path) {
	// "*" means http or https, as match patterns read it
	if (pattern.scheme === "*" ? scheme !== "http" && scheme !== "https" : pattern.scheme !== scheme) return false;
	if (pattern.host === "*") {
		// any host
	} else if (pattern.host.startsWith("*.")) {
		const bare = pattern.host.slice(2);
		if (host !== bare && !host.endsWith("." + bare)) return false;
	} else if (host !== pattern.host) {
		return false;
	}
	const { pieces } = pattern;
	if (pieces.length === 1) return path === pieces[0];
	if (!path.startsWith(pieces[0])) return false;
	if (!path.endsWith(pieces[pieces.length - 1])) return false;
	let at = pieces[0].length;
	for (let i = 1; i < pieces.length - 1; i++) {
		const found = pieces[i] === "" ? at : path.indexOf(pieces[i], at);
		if (found === -1) return false;
		at = found + pieces[i].length;
	}
	return at <= path.length - pieces[pieces.length - 1].length;
}

/** Rules as they come (ours and Brave's), ready to match; the malformed are left out. */
export function compile(rules) {
	const out = [];
	for (const rule of Array.isArray(rules) ? rules : []) {
		if (!rule || !ACTIONS.has(rule.action) || typeof rule.param !== "string" || !Array.isArray(rule.include)) continue;
		let path = null;
		if (rule.action.startsWith("regex")) {
			// ponytail: a short pattern from the list can still backtrack; the
			// path it runs on is capped below, which bounds the time
			if (rule.param.length > 200) continue;
			try {
				path = new RegExp(rule.param);
			} catch {
				continue;
			}
			if (rule.action === "regex-path-template" && typeof rule.redirect_url_template !== "string") continue;
		}
		out.push({
			...rule,
			path,
			include: rule.include.map(parsePattern).filter(Boolean),
			exclude: (Array.isArray(rule.exclude) ? rule.exclude : []).map(parsePattern).filter(Boolean),
		});
	}
	return out;
}

const base64 = (text) => {
	const plain = text.replace(/-/g, "+").replace(/_/g, "/");
	return atob(plain + "=".repeat((4 - (plain.length % 4)) % 4));
};

// The address one rule finds in `url`, or null.
function carried(rule, url) {
	let found = null;
	if (rule.path) {
		// capped, so a rule's regex has only so much to chew on
		const match = rule.path.exec(url.pathname.slice(0, 2000));
		if (!match) return null;
		found =
			rule.action === "regex-path"
				? match[1]
				: rule.redirect_url_template.replace(/\$(\d)/g, (_, i) => match[Number(i)] ?? "");
	} else {
		found = url.searchParams.get(rule.param);
		if (found && rule.action === "base64,redirect")
			try {
				found = base64(found);
			} catch {
				return null;
			}
	}
	if (!found) return null;
	// some carry it percent-encoded once more
	if (/^https?%3a/i.test(found))
		try {
			found = decodeURIComponent(found);
		} catch {
			return null;
		}
	if (rule.prepend_scheme && !/^[a-z][a-z0-9+.-]*:/i.test(found)) found = `${rule.prepend_scheme}://${found}`;
	try {
		const to = new URL(found);
		return (to.protocol === "http:" || to.protocol === "https:") && to.href !== url.href ? to : null;
	} catch {
		return null;
	}
}

/**
 * Where `url` really goes once the hops that only track are skipped, or null
 * when it isn't one. Wrapped more than once (a tracker's link to another
 * tracker), each is skipped, five at most.
 * @param {ReturnType<typeof compile>} rules
 * @param {URL} url
 */
export function debounce(rules, url) {
	let to = url;
	for (let hops = 0; hops < 5; hops++) {
		const scheme = to.protocol.slice(0, -1);
		const host = to.hostname.toLowerCase();
		const path = (to.pathname + to.search).toLowerCase();
		const fits = (pattern) => matches(pattern, scheme, host, path);
		let next = null;
		for (const rule of rules) {
			if (!rule.include.some(fits) || rule.exclude.some(fits)) continue;
			next = carried(rule, to);
			if (next) break;
		}
		if (!next) break;
		to = next;
	}
	return to === url ? null : to;
}

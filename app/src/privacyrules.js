// Brave's navigation-tracking rules, compiled for the service worker:
// - debounce.json: addresses that only exist to bounce a visitor through a
//   tracker on the way somewhere else (affiliate links, mail click trackers,
//   AMP caches). The worker skips the hop and goes straight to where it leads.
// - query-filter.json: query parameters that follow a person from site to
//   site, for every site and for some sites only.
// Both come from https://github.com/brave/adblock-lists (MPL-2.0). Patterns
// there are extension match patterns ("*://*.example.com/r?*"); the worker
// gets them as regular expressions.

const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * A match pattern -> the source of a RegExp for whole URLs. The path part
 * covers the query too, as in Chrome's match patterns.
 * @param {string} pattern
 * @returns {string | null} null for a pattern this doesn't understand
 */
export function patternToRegex(pattern) {
	const parts = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)$/.exec(String(pattern).trim());
	if (!parts) return null;
	const [, scheme, host, path] = parts;
	const schemeRe = scheme === "*" ? "https?" : scheme;
	let hostRe;
	if (host === "*") hostRe = "[^/:?#]+";
	else if (host.startsWith("*.")) hostRe = `(?:[^/:?#]+\\.)?${escape(host.slice(2).toLowerCase())}`;
	else hostRe = escape(host.toLowerCase());
	const pathRe = path.split("*").map(escape).join(".*");
	return `^${schemeRe}:\\/\\/${hostRe}(?::\\d+)?${pathRe}$`;
}

const patterns = (list) => (Array.isArray(list) ? list.map(patternToRegex).filter(Boolean) : []);

// Parameter names as Brave writes them, which sometimes percent-encodes them.
function paramNames(list) {
	const names = new Set();
	for (const raw of Array.isArray(list) ? list : []) {
		if (typeof raw !== "string" || !raw) continue;
		let name = raw;
		try {
			name = decodeURIComponent(raw);
		} catch {
			// as written
		}
		names.add(name.toLowerCase());
	}
	return [...names];
}

const ACTIONS = new Set(["redirect", "base64,redirect", "regex-path", "regex-path-template"]);

/**
 * @param {string} debounceText debounce.json
 * @param {string} queryText query-filter.json
 * @returns {{ debounce: object[], params: object[] }}
 */
export function compileRules(debounceText, queryText) {
	const debounce = [];
	for (const rule of debounceText ? JSON.parse(debounceText) : []) {
		if (!rule || !ACTIONS.has(rule.action) || typeof rule.param !== "string") continue;
		// a regular expression the worker would choke on is left out here
		if (rule.action.startsWith("regex"))
			try {
				new RegExp(rule.param);
			} catch {
				continue;
			}
		const match = patterns(rule.include);
		if (!match.length) continue;
		debounce.push({
			match,
			exclude: patterns(rule.exclude),
			action: rule.action,
			param: rule.param,
			scheme: rule.prepend_scheme === "http" || rule.prepend_scheme === "https" ? rule.prepend_scheme : null,
			template: typeof rule.redirect_url_template === "string" ? rule.redirect_url_template : null,
		});
	}
	const params = [];
	for (const rule of queryText ? JSON.parse(queryText) : []) {
		const names = paramNames(rule?.params);
		if (!names.length) continue;
		const match = patterns(rule.include);
		// "*://*/*" is every address: kept as null, so the worker skips matching it
		const everywhere = Array.isArray(rule.include) && rule.include.includes("*://*/*");
		params.push({ match: everywhere ? null : match, exclude: patterns(rule.exclude), params: names });
	}
	return { debounce, params };
}

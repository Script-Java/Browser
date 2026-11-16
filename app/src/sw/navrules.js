// Brave's navigation-tracking rules at work: query parameters that follow a
// person from site to site, and addresses that only bounce a visitor through
// a tracker. The server compiles them (src/privacyrules.js) and serves them as
// /filters/privacy.json. Shared by the proxy's worker (shield.js) and the iOS
// app (mobile/src/ui/Tab.tsx), so pure: no globals, the rules passed in.

// Query parameters that only exist to follow a person from one site to
// the next: click ids and campaign tags (Brave's and DuckDuckGo's lists).
const TRACKING_PARAMS = new Set(
	(
		"fbclid gclid gclsrc dclid gbraid wbraid msclkid twclid ttclid yclid ymclid ysclid igshid " +
		"srsltid li_fat_id irclickid rb_clickid unicorn_click_id wickedid s_cid mc_eid mkt_tok " +
		"_hsenc _hsmi __hssc __hstc __hsfp hsctatracking _openstat __s _gl _kx _bhlid " +
		"oly_anon_id oly_enc_id vero_id vero_conv ml_subscriber ml_subscriber_hash " +
		"fb_action_ids fb_comment_id guce_referrer guce_referrer_sig bsft_clkid bsft_uid " +
		"sc_customer sc_eh sc_uid ss_email_id et_rid vgo_ee mtm_cid pk_cid " +
		"_branch_match_id _branch_referrer at_recipient_id at_recipient_list"
	).split(" ")
);

/** @typedef {{ debounce: any[], params: { match: RegExp[] | null, exclude: RegExp[], params: Set<string> }[] }} NavRules */

const compile = (list) => (list || []).map((source) => new RegExp(source, "i"));

/**
 * The server's /filters/privacy.json, ready to use.
 * @returns {NavRules}
 */
export function compileNavRules(rules) {
	return {
		debounce: (rules?.debounce || []).map((rule) => ({ ...rule, match: compile(rule.match), exclude: compile(rule.exclude) })),
		params: (rules?.params || []).map((rule) => ({
			match: rule.match && compile(rule.match),
			exclude: compile(rule.exclude),
			params: new Set(rule.params),
		})),
	};
}

// Brave's rules that apply to `target`: every address's, and its site's.
const appliesTo = (rule, href) =>
	(!rule.match || rule.match.some((re) => re.test(href))) && !rule.exclude.some((re) => re.test(href));

/**
 * `target` without them, or null when it has none. The rest of the query
 * is left exactly as written (some sites sign theirs).
 * @param {URL} target
 * @param {NavRules} rules
 */
export function withoutTracking(target, rules) {
	if (!target.search) return null;
	const extra = rules.params.filter((rule) => appliesTo(rule, target.href));
	const parts = target.search.slice(1).split("&");
	const kept = parts.filter((part) => {
		let name = part.split("=")[0];
		try {
			name = decodeURIComponent(name.replace(/\+/g, " "));
		} catch {
			// not valid percent-encoding: compare it as written
		}
		name = name.toLowerCase();
		return !TRACKING_PARAMS.has(name) && !name.startsWith("utm_") && !extra.some((rule) => rule.params.has(name));
	});
	if (kept.length === parts.length) return null;
	const clean = new URL(target.href);
	clean.search = kept.join("&");
	return clean;
}

/**
 * Where a bounce-tracking address leads (Brave's debounce rules), or null.
 * Only to another site: a hop within one site may be its own sign-in.
 * @param {URL} target
 * @param {NavRules} rules
 * @param {(host: string) => string | null} siteOf
 */
export function bounceTarget(target, rules, siteOf) {
	let at = target;
	for (let hops = 0; hops < 5; hops++) {
		const next = rules.debounce
			.filter((rule) => appliesTo(rule, at.href))
			.map((rule) => leadsTo(rule, at))
			.find((url) => url && siteOf(url.hostname) !== siteOf(at.hostname));
		if (!next) break;
		at = next;
	}
	return at === target ? null : at;
}

function leadsTo(rule, from) {
	let value = null;
	try {
		if (rule.action === "redirect" || rule.action === "base64,redirect") {
			value = from.searchParams.get(rule.param);
			if (value && rule.action === "base64,redirect")
				value = atob(value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, ""));
		} else {
			const found = new RegExp(rule.param).exec(from.pathname);
			if (!found) return null;
			const groups = found.slice(1).map((part) => decodeURIComponent(part || ""));
			value =
				rule.action === "regex-path-template"
					? rule.template.replace(/\$(\d)/g, (_, n) => groups[n - 1] || "")
					: groups.join("");
		}
		if (!value) return null;
		value = value.trim();
		if (rule.scheme && !/^https?:\/\//i.test(value)) value = `${rule.scheme}://${value.replace(/^\/+/, "")}`;
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

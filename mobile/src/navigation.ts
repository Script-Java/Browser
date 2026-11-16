// Checks before a tab opens a page, and the robot checks that make Relay's
// shared address a nuisance.
import { lookalikeOf } from "../../app/src/sw/lookalike.js";
import type { Route } from "./relay/types";
import type { Threat } from "./server/types";

export type Warning = { kind: keyof typeof WARNINGS; host: string; url: string; real?: string };

// The old app's wording (app/src/sw/shield.js, WARNINGS). `go` is absent where there's no way past.
export const WARNINGS = {
	phishing: {
		title: "Deceptive site ahead",
		text: "This site is on a list of known phishing sites. It may try to trick you into entering a password, card number or other personal details.",
		go: "Continue anyway (unsafe)",
	},
	malware: {
		title: "Dangerous site ahead",
		text: "This site is on a list of sites known to spread malware.",
		go: "Continue anyway (unsafe)",
	},
	lookalike: {
		title: "Is this the site you meant?",
		text: "This address looks like {real}, but it's a different site. Sites like this pretend to be another to get passwords and card numbers.",
		go: "Continue anyway",
	},
	cert: {
		title: "This connection isn't private",
		text: "Someone may be pretending to be this site, so it wasn't opened.",
		go: undefined,
	},
	unreachable: {
		title: "Couldn't open this page",
		text: "The site didn't answer. It may be down, the address may be wrong, or the connection dropped.",
		go: "Try again",
	},
};

// past this, the page opens and the server's verdict is lost; the native side refuses an unanswered navigation at 10 s
const THREAT_WAIT = 4000;

/**
 * The warning `url` gets before it opens, or null. The look-alike check is
 * on the phone; the server's lists are asked only about relay sites, which
 * the server sees anyway.
 */
export async function warningFor(url: string, route: Route, threat: (host: string) => Promise<Threat>): Promise<Warning | null> {
	let host: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
		host = parsed.hostname;
	} catch {
		return null;
	}
	const real = lookalikeOf(host);
	if (real) return { kind: "lookalike", host, url, real };
	if (route !== "relay") return null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const kind = await Promise.race([
		threat(host).catch(() => null),
		new Promise<null>((done) => (timer = setTimeout(done, THREAT_WAIT, null))),
	]);
	clearTimeout(timer);
	return kind ? { kind, host, url } : null;
}

/** Google's "unusual traffic" page, or Cloudflare's "Just a moment…". */
export function isRobotCheck({ url, title }: { url: string; title: string }): boolean {
	try {
		const { hostname, pathname } = new URL(url);
		if (/(^|\.)google\.[a-z.]+$/.test(hostname) && pathname.startsWith("/sorry/")) return true;
	} catch {
		// no address yet
	}
	return /^Just a moment(\.\.\.|…)$/.test(title.trim());
}

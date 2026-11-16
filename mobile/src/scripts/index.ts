import type { Level } from "../../modules/badger-webview/src/BadgerWebView.types";
import type { Route } from "../relay/types";
import { consent, fingerprintSafer, fingerprintStandard, gpc, noCredentials, relay } from "./generated";

export type ScriptChoice = { route: Route; blocking: boolean; level: Level; passkeys: boolean; consent: boolean };

/** A tab's injected scripts, from its current site's settings. */
export function scriptsFor(site: ScriptChoice): { page: string[]; isolated: string[] } {
	const page: string[] = [];
	// first: it puts the dns-prefetch switch in before anything else in the page
	if (site.route === "relay") page.push(relay);
	page.push(gpc);
	// as the old app: Safer's answers on every site, the standard ones where blocking is on
	if (site.level !== "standard") page.push(fingerprintSafer);
	else if (site.blocking) page.push(fingerprintStandard);
	// WebKit's passkey lookups go around the proxy (mysk, 2026); a direct site sees the phone's address anyway
	if (site.route === "relay" && !site.passkeys) page.push(noCredentials);
	return { page, isolated: site.consent && site.blocking ? [consent] : [] };
}

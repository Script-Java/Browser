// Settings kept per site, keyed by registrable domain.
import { getDomain } from "tldts";

import type { Level } from "../modules/badger-webview/src/BadgerWebView.types";
import type { Engine } from "./address";
import type { Route } from "./relay/types";

/** The app's own settings; a site's own choices go over `level`. */
export type Settings = { search: Engine; level: Level; consent: boolean };
export const DEFAULT_SETTINGS: Settings = { search: "google", level: "standard", consent: true };

export type SiteSettings = { route?: Route; blocking?: boolean; level?: Level; lockdown?: boolean; passkeys?: boolean };
export type Sites = Record<string, SiteSettings>;

/** mail.google.com -> google.com; an address or a bare host name; null when it has no host. As the old app's sitekey.js. */
export function siteOf(address: string): string | null {
	let host = address;
	try {
		host = new URL(address).hostname;
	} catch {
		// a bare host name
	}
	host = host.toLowerCase().replace(/\.$/, "");
	if (!host) return null;
	return getDomain(host, { allowPrivateDomains: true }) || host;
}

/** What applies to a site: its own choices over the defaults. Relay is the default connection; Safest brings Lockdown. */
export function effective(site: SiteSettings | undefined, defaultLevel: Level) {
	const level = site?.level ?? defaultLevel;
	return {
		route: site?.route ?? ("relay" as Route),
		blocking: site?.blocking ?? true,
		level,
		lockdown: site?.lockdown ?? level === "safest",
		passkeys: site?.passkeys ?? false,
	};
}

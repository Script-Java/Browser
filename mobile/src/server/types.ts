// Contract: the app's dealings with the Badger server (app/src/index.js).

export type AccessMode = "password" | "challenge" | "off";

export type Threat = "phishing" | "malware" | null;

export type ContentRules = {
	/** changes whenever any list does; the app recompiles only then */
	version: string;
	/** each list at most 150,000 rules (WKContentRuleList's limit), as Safari content-blocker JSON */
	lists: { id: string; json: string }[];
};

export type Session = {
	/** https://badger.example */
	origin: string;
	/** how this server lets people in (app/src/auth.js) */
	accessMode(): Promise<AccessMode>;
	signedIn(): Promise<boolean>;
	/** password mode needs the password; challenge mode solves the puzzle itself */
	signIn(password?: string): Promise<void>;
	/** the server forgets this device's sign-in cookie */
	signOut(): Promise<void>;
	/** wss://…/wisp/ for the relay */
	wispUrl: string;
	/** the server's phishing and malware lists (/api/nav); only asked for relay sites, which the server sees anyway */
	threat(host: string): Promise<Threat>;
	/** with `since`, the version the app already has: no lists when it's still current */
	contentRules(since?: string): Promise<ContentRules>;
	/** Brave's navigation-tracking rules, compiled by the server (app/src/privacyrules.js), for app/src/sw/navrules.js */
	navRules(): Promise<unknown>;
};

export type CreateSession = (origin: string) => Session;

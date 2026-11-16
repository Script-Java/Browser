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
	/** wss://…/wisp/ for the relay */
	wispUrl: string;
	/** the server's phishing and malware lists (/api/nav); only asked for relay sites, which the server sees anyway */
	threat(host: string): Promise<Threat>;
	contentRules(): Promise<ContentRules>;
};

export type CreateSession = (origin: string) => Session;

// Contract: the relay the tabs' data stores use as their proxy (Store.proxy).
// WebKit connects to it over SOCKS5; it carries each connection over the
// server's wisp WebSocket (relay) or straight from the phone (direct).
import type { Proxy } from "../../modules/badger-webview";

export type Route = "relay" | "direct";

export type Relay = {
	/** the value for Store.proxy */
	proxy: Proxy;
	/**
	 * How connections to a site go: `site` is a registrable domain
	 * (example.co.uk) and covers its subdomains. Unlisted sites take the default.
	 * Applies to new connections.
	 */
	setRoute(site: string, route: Route | null): void;
	close(): Promise<void>;
};

export type StartRelay = (options: {
	/** wss://server/wisp/ ; the server's session cookie must already be in place (src/server) */
	wispUrl: string;
	defaultRoute: Route;
}) => Promise<Relay>;

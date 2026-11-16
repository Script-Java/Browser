import { NativeModule, requireNativeModule } from "expo";

import type { Route } from "../../../src/relay/types";

declare class BadgerRelayModule extends NativeModule<Record<string, never>> {
	/** Listens on 127.0.0.1: the same port all launch, new credentials each start. A second start stops the first. */
	start(options: { wispUrl: string; defaultRoute: Route }): Promise<{ port: number; username: string; password: string }>;
	/** `site` covers its subdomains; null removes it. Applies to new connections. */
	setRoute(site: string, route: Route | null): Promise<void>;
	setDefaultRoute(route: Route): Promise<void>;
	stop(): Promise<void>;
	/** the server's sign-in puzzle (CryptoKit): the first n whose SHA-256 of `${challenge}:${n}` starts with `bits` zero bits */
	solveChallenge(challenge: string, bits: number): Promise<number>;
}

export default requireNativeModule<BadgerRelayModule>("BadgerRelay");

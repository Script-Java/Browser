import { NativeModule, requireNativeModule } from "expo";

import type { Route } from "../../../src/relay/types";

export type BadgerRelayEvents = {
	/** the listener is gone and couldn't come back on its port within 5 seconds; the relay has stopped for this launch */
	onBroken(event: { reason: string }): void;
};

declare class BadgerRelayModule extends NativeModule<BadgerRelayEvents> {
	/** Listens on 127.0.0.1: the same port all launch, new credentials each start. A second start stops the first. */
	start(options: { wispUrl: string; defaultRoute: Route }): Promise<{ port: number; username: string; password: string }>;
	/** `site` covers its subdomains; null removes it. Its connections open on the other route close, and reopen on this one. */
	setRoute(site: string, route: Route | null): Promise<void>;
	setDefaultRoute(route: Route): Promise<void>;
	stop(): Promise<void>;
	/** the server's sign-in puzzle (CryptoKit): the first n whose SHA-256 of `${challenge}:${n}` starts with `bits` zero bits */
	solveChallenge(challenge: string, bits: number): Promise<number>;
}

export default requireNativeModule<BadgerRelayModule>("BadgerRelay");

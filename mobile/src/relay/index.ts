// The relay (types.ts) on top of the native SOCKS5 server, modules/badger-relay.
import BadgerRelay from "../../modules/badger-relay";
import type { StartRelay } from "./types";

export const startRelay: StartRelay = async ({ wispUrl, defaultRoute }) => {
	const { port, username, password } = await BadgerRelay.start({ wispUrl, defaultRoute });
	// heard from the start and kept, so a break before the browser listens still stops it
	let broken: string | null = null;
	const listeners = new Set<(reason: string) => void>();
	const subscription = BadgerRelay.addListener("onBroken", ({ reason }) => {
		broken = reason;
		for (const listener of listeners) listener(reason);
	});
	return {
		proxy: { host: "127.0.0.1", port, username, password },
		setRoute: (site, route) => void BadgerRelay.setRoute(site, route),
		onBroken(listener) {
			if (broken !== null) listener(broken);
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		close: () => {
			subscription.remove();
			return BadgerRelay.stop();
		},
	};
};

// The relay (types.ts) on top of the native SOCKS5 server, modules/badger-relay.
import BadgerRelay from "../../modules/badger-relay";
import type { StartRelay } from "./types";

export const startRelay: StartRelay = async ({ wispUrl, defaultRoute }) => {
	const { port, username, password } = await BadgerRelay.start({ wispUrl, defaultRoute });
	return {
		proxy: { host: "127.0.0.1", port, username, password },
		setRoute: (site, route) => void BadgerRelay.setRoute(site, route),
		close: () => BadgerRelay.stop(),
	};
};

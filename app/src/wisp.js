// The proxy's network side (wisp): which connections the server will make for
// a proxied page. Web ports only, nothing on the server's own network.

import net from "node:net";
import { lookup } from "node:dns/promises";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

// Private, loopback, link-local and other non-public ranges. wisp-js has its
// own check, but it lets through IPv6 private (fc00::/7, which Railway's
// internal network uses) and IPv4-mapped addresses like ::ffff:127.0.0.1.
const blocked = new net.BlockList();
for (const [range, bits] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
	["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
])
	blocked.addSubnet(range, bits, "ipv4");
for (const [range, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]])
	blocked.addSubnet(range, bits, "ipv6");

/** True for anything that isn't a public IP address. */
export function isBlockedAddress(address) {
	address = address.split("%")[0];
	const family = net.isIP(address);
	if (family === 4) return blocked.check(address, "ipv4");
	if (family !== 6) return true;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	return mapped ? blocked.check(mapped[1], "ipv4") : blocked.check(address, "ipv6");
}

// Every name wisp connects to resolves through here, so a site can't point
// its DNS at a private address. wisp-js caches the answer and connects to it.
async function publicLookup(hostname) {
	const allowed = (await lookup(hostname, { all: true })).filter((a) => !isBlockedAddress(a.address));
	if (!allowed.length) throw Object.assign(new Error("private address"), { code: "EACCES" });
	return allowed[0].address;
}

Object.assign(wisp.options, {
	// Web traffic only, so the server can't be used for mail spam, port scans
	// or UDP floods.
	// ponytail: sites on other ports (e.g. :8080) won't load; extend the list if that matters.
	port_whitelist: [80, 443],
	allow_udp_streams: false,
	allow_private_ips: false,
	allow_loopback_ips: false,
	// IP addresses typed directly skip DNS, so check them here. wisp-js only
	// needs a .test(hostname) from each entry.
	hostname_blacklist: [{ test: (host) => net.isIP(host.split("%")[0]) !== 0 && isBlockedAddress(host) }],
	dns_method: publicLookup,
	stream_limit_total: 128,
	// The app logs nothing that names a site.
	parse_real_ip: false,
});
logging.set_level(logging.NONE);

export const routeRequest = wisp.routeRequest;

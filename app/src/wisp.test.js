import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { client } from "@mercuryworkshop/wisp-js/client";
import { isBlockedAddress, routeRequest } from "./wisp.js";

test("isBlockedAddress", () => {
	for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
		"::1", "::", "fd12:3456::1", "fe80::1%eth0", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "not-an-ip"])
		assert.equal(isBlockedAddress(ip), true, ip);
	for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:1.1.1.1"])
		assert.equal(isBlockedAddress(ip), false, ip);
});

// Every stream here must be refused by the server, never connected.
test("wisp refuses private addresses, other ports and UDP", async (t) => {
	const server = createServer();
	server.on("upgrade", (req, socket, head) => routeRequest(req, socket, head));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());

	const connect = async (options) => {
		const conn = new client.ClientConnection(`ws://127.0.0.1:${server.address().port}/wisp/`, options);
		await new Promise((resolve, reject) => {
			conn.onopen = resolve;
			conn.onerror = reject;
		});
		t.after(() => conn.close());
		return conn;
	};
	const v2 = await connect();
	// a wisp v2 client won't even try UDP (the server doesn't offer it); v1 can ask
	const v1 = await connect({ wisp_version: 1 });

	const refused = (host, port, type, conn = type ? v1 : v2) =>
		new Promise((resolve) => {
			const stream = conn.create_stream(host, port, type);
			stream.onmessage = () => resolve("connected");
			stream.onclose = (reason) => resolve(reason);
			stream.send(new TextEncoder().encode("GET / HTTP/1.0\r\n\r\n"));
		});

	for (const [host, port, type] of [
		["127.0.0.1", 80],
		["::ffff:127.0.0.1", 443],
		["fd12::1", 443],
		["localhost", 443], // resolves to loopback
		["169.254.169.254", 80], // cloud metadata
		["example.com", 22],
		["1.1.1.1", 53, "udp"],
	])
		assert.notEqual(await refused(host, port, type), "connected", `${host}:${port}`);
});

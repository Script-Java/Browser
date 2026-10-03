// The server's own defences, checked over plain HTTP.

import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { expect, test } from "@playwright/test";
import { ISOLATED, SECRET, SHARED_URL } from "./env.js";

const ISOLATED_LOCAL = `http://localhost:${ISOLATED}`;
const SHELL_HOST = `app.localhost:${ISOLATED}`;
// a site's own subdomain in isolation mode (any valid key)
const SITE_HOST = `s${"a".repeat(25)}.app.localhost:${ISOLATED}`;

// Browsers send *.localhost to this machine, Node doesn't: connect to it
// directly and name the address in the Host header.
function get(host, path, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ host: "127.0.0.1", port: ISOLATED, path, headers: { host, ...headers } },
			(res) => {
				res.resume();
				resolve({ status: res.statusCode, headers: res.headers });
			}
		);
		req.on("upgrade", (res, socket) => {
			socket.destroy();
			resolve({ status: res.statusCode, headers: res.headers });
		});
		req.on("error", reject);
		req.end();
	});
}

test("the app's pages run only their own scripts and can't be framed by others", async ({ request }) => {
	const page = await request.get(`${SHARED_URL}/`, { headers: { "sec-fetch-dest": "document" } });
	const csp = page.headers()["content-security-policy"];
	expect(csp).toContain("script-src 'self'");
	expect(csp).not.toContain("unsafe-inline' 'self'");
	expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
	expect(csp).toContain("object-src 'none'");
	expect(csp).toContain("base-uri 'none'");
	expect(csp).toContain("frame-ancestors 'self'");
	expect(page.headers()["x-content-type-options"]).toBe("nosniff");
	expect(page.headers()["referrer-policy"]).toBe("same-origin");

	// workers run Scramjet's WebAssembly, so they only get the framing rule
	const worker = await request.get(`${SHARED_URL}/scramjet-sw.js`, {
		headers: { "sec-fetch-dest": "serviceworker" },
	});
	expect(worker.headers()["content-security-policy"]).toBe("frame-ancestors 'self'");
});

test("HTTPS responses tell browsers to stay on HTTPS", async ({ request }) => {
	const res = await request.get(`${SHARED_URL}/`, { headers: { "x-forwarded-proto": "https" } });
	expect(res.headers()["strict-transport-security"]).toContain("max-age=");
});

test("only the app itself can change settings", async ({ request }) => {
	const res = await request.post(`${SHARED_URL}/api/settings`, {
		headers: { origin: "https://evil.example" },
		data: { ads: false },
	});
	expect(res.status()).toBe(403);
});

test("the health check proves which server answers", async ({ request }) => {
	expect(await (await request.get(`${ISOLATED_LOCAL}/healthz`)).text()).toBe("ok");
	const nonce = "e2e-nonce";
	const answer = await (await request.get(`${ISOLATED_LOCAL}/healthz?nonce=${nonce}`)).text();
	expect(answer).toBe(createHmac("sha256", SECRET).update("healthz:" + nonce).digest("hex"));
});

test("with a password or browser check, nothing but sign-in is reachable", async () => {
	for (const path of ["/", "/index.js", "/api/settings", "/bios/page.js", "/filters/engine.bin", "/scramjet-sw.js"]) {
		const res = await get(SHELL_HOST, path);
		expect([302, 401], path).toContain(res.status);
	}
	expect((await get(SHELL_HOST, "/login")).status).toBe(200);
});

test("a site's subdomain never serves the app itself", async () => {
	// the app on a site's address could be reached into by that site
	for (const path of ["/index.js", "/index.html", "/login", "/terms"])
		expect((await get(SITE_HOST, path)).status, path).toBe(404);
	const root = await get(SITE_HOST, "/");
	expect(root.status).toBe(302);
	expect(root.headers.location).toBe(`http://app.localhost:${ISOLATED}/`);
});

test("other names under the domain (www, typos) only redirect to the app", async () => {
	const stray = `www.app.localhost:${ISOLATED}`;
	for (const path of ["/", "/index.js", "/login"]) {
		const res = await get(stray, path);
		expect(res.status, path).toBe(302);
		expect(res.headers.location).toBe(`http://app.localhost:${ISOLATED}/`);
	}
	expect((await get(stray, "/api/settings", { origin: `http://${stray}` })).status).not.toBe(200);
});

test("the proxy connection needs a signed-in browser", async () => {
	const res = await get(SHELL_HOST, "/wisp/", {
		connection: "Upgrade",
		upgrade: "websocket",
		"sec-websocket-version": "13",
		"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
	});
	expect(res.status).not.toBe(101);
});

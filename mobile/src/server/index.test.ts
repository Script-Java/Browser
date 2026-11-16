// The client against the real server (app/src/index.js), in each access mode.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSession } from "./index";

// the native solver's rule (BadgerRelayModule.swift), in Node
async function solve(challenge: string, bits: number) {
	for (let n = 0; ; n++) if (zeroBits(createHash("sha256").update(`${challenge}:${n}`).digest()) >= bits) return n;
}
function zeroBits(bytes: Buffer) {
	let bits = 0;
	for (const byte of bytes) {
		if (byte) return bits + Math.clz32(byte) - 24;
		bits += 8;
	}
	return bits;
}

const APP = resolve(import.meta.dirname, "../../../app");

// A cache of lists, as the server keeps them, so it starts without downloading
// any: an empty engine and the content rules of one tiny list (Brave's
// converter, for real).
const cacheDir = mkdtempSync(join(tmpdir(), "badger-server-test-"));
execFileSync(
	process.execPath,
	[
		"--input-type=module",
		"-e",
		`import { FiltersEngine } from "@ghostery/adblocker";
		import { Filters, contentRuleLists } from "./src/filters.js";
		const filters = new Filters({ cacheDir: process.env.CACHE, refreshHours: 24 });
		filters.setEngine(Buffer.from(FiltersEngine.parse("").serialize()));
		filters.notices = filters.engine;
		filters.privacy = { raw: '{"debounce":[],"params":[]}' };
		filters.setContentRules(contentRuleLists(["||ads.example^\\n@@||ads.example/ok^"]));
		filters.updatedAt = Date.now();
		await filters.saveCache();`,
	],
	{ cwd: APP, env: { ...process.env, CACHE: cacheDir } }
);

let lastPort = 8830;
async function freePort() {
	for (let port = lastPort + 1; ; port++) {
		const free = await new Promise<boolean>((done) => {
			const probe = createServer()
				.once("error", () => done(false))
				.listen(port, () => probe.close(() => done(true)));
		});
		if (free) return (lastPort = port);
	}
}

/** The real server on a free port from 8831 up, in development (NODE_ENV unset). */
function startServer(env: Record<string, string>) {
	let child: ChildProcess;
	let origin = "";
	before(async () => {
		const port = await freePort();
		origin = `http://localhost:${port}`;
		// none of this shell's server settings
		const childEnv: Record<string, string | undefined> = { ...process.env };
		for (const name of ["NODE_ENV", "APP_PASSWORD", "AUTH_SECRET", "ISOLATION_DOMAIN"]) delete childEnv[name];
		Object.assign(childEnv, env, { PORT: String(port), FILTER_CACHE_DIR: cacheDir, PHISHING_HOSTS: "scam.example" });
		child = spawn(process.execPath, ["src/index.js"], {
			cwd: APP,
			env: childEnv as NodeJS.ProcessEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout!.on("data", (chunk) => (output += chunk));
		child.stderr!.on("data", (chunk) => (output += chunk));
		for (let i = 0; ; i++) {
			if ((await fetch(origin + "/healthz").catch(() => null))?.ok) break;
			if (i > 100 || child.exitCode !== null) throw new Error("server didn't start:\n" + output);
			await new Promise((r) => setTimeout(r, 100));
		}
	});
	after(() => child?.kill("SIGKILL"));
	return () => origin;
}

/** fetch with a cookie jar, following redirects itself so it sees their cookies, as URLSession does. */
function cookieJar() {
	const cookies = new Map<string, string>();
	const header = () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	const jarFetch = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const headers = new Headers(init.headers);
		if (cookies.size) headers.set("cookie", header());
		const res = await fetch(url, { ...init, headers, redirect: "manual" });
		for (const line of res.headers.getSetCookie()) {
			const [, name, value] = /^([^=]+)=([^;]*)/.exec(line)!;
			if (/max-age=0/i.test(line)) cookies.delete(name);
			else cookies.set(name, value);
		}
		const location = res.headers.get("location");
		return location ? jarFetch(new URL(location, String(url)).href) : res;
	};
	return { fetch: jarFetch as typeof fetch, header };
}

/** Whether the server takes a WebSocket at `url` with these cookies, as the relay's would. */
const opensWisp = (url: string, cookie: string) =>
	new Promise<boolean>((done, fail) => {
		const req = request(url.replace(/^ws/, "http"), {
			headers: {
				cookie,
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-key": randomBytes(16).toString("base64"),
				"sec-websocket-version": "13",
			},
		});
		req.on("upgrade", (res, socket) => {
			socket.destroy();
			done(true);
		});
		req.on("response", (res) => {
			res.resume();
			done(false);
		});
		req.on("error", fail);
		req.end();
	});

describe("off mode (local development)", () => {
	const origin = startServer({});

	test("signed in already; threats and content rules", async () => {
		const session = createSession(origin() + "/", cookieJar());
		assert.equal(session.origin, origin());
		assert.equal(session.wispUrl, origin().replace("http", "ws") + "/wisp/");
		assert.equal(await session.accessMode(), "off");
		assert.equal(await session.signedIn(), true);
		await session.signIn();
		assert.equal(await session.threat("scam.example"), "phishing");
		assert.equal(await session.threat("www.scam.example"), "phishing");
		assert.equal(await session.threat("fine.example"), null);

		const rules = await session.contentRules();
		assert.match(rules.version, /^[\w-]{24}$/);
		assert.equal(rules.lists.length, 1);
		const list = JSON.parse(rules.lists[0].json);
		assert.ok(list.some((rule: any) => rule.action.type === "block" && rule.trigger["url-filter"].includes("ads\\.example")));
		assert.equal(list.at(-1).action.type, "ignore-previous-rules");
		// the same lists, the same version; and none sent to an app that has them
		assert.equal((await session.contentRules()).version, rules.version);
		assert.deepEqual(await session.contentRules(rules.version), { version: rules.version, lists: [] });
		assert.equal((await session.contentRules("older")).lists.length, 1);
	});

	test("a list from before a rebuild is gone, not mixed in", async () => {
		const res = await fetch(origin() + "/filters/content-rules/nonesuch.json");
		assert.equal(res.status, 404);
	});
});

describe("password mode (APP_PASSWORD)", () => {
	const origin = startServer({ APP_PASSWORD: "correct horse", AUTH_SECRET: randomBytes(32).toString("hex") });

	test("nothing until the right password, then the relay's socket opens", async () => {
		const jar = cookieJar();
		const session = createSession(origin(), jar);
		assert.equal(await session.accessMode(), "password");
		assert.equal(await session.signedIn(), false);
		await assert.rejects(session.threat("scam.example"), /401/);
		await assert.rejects(session.contentRules(), /401/);
		assert.equal(await opensWisp(session.wispUrl, jar.header()), false);

		await assert.rejects(session.signIn(), /needs its password/);
		await assert.rejects(session.signIn("wrong"), /Wrong password/);
		assert.equal(await session.signedIn(), false);

		await session.signIn("correct horse");
		assert.equal(await session.signedIn(), true);
		assert.equal(await session.threat("scam.example"), "phishing");
		assert.equal((await session.contentRules()).lists.length, 1);
		assert.equal(await opensWisp(session.wispUrl, jar.header()), true);
		// another device, without the cookie, still can't
		assert.equal(await createSession(origin(), cookieJar()).signedIn(), false);

		await session.signOut();
		assert.equal(await session.signedIn(), false);
		assert.equal(await opensWisp(session.wispUrl, jar.header()), false);
	});
});

describe("challenge mode (AUTH_SECRET only)", () => {
	const origin = startServer({ AUTH_SECRET: randomBytes(32).toString("hex") });

	test("the app solves the puzzle and is in", async () => {
		const jar = cookieJar();
		const session = createSession(origin(), { ...jar, solve });
		assert.equal(await session.accessMode(), "challenge");
		assert.equal(await session.signedIn(), false);
		await session.signIn();
		assert.equal(await session.signedIn(), true);
		assert.equal(await session.threat("fine.example"), null);
		assert.equal(await opensWisp(session.wispUrl, jar.header()), true);
	});

	test("a wrong solution is turned away with the server's reason", async () => {
		const session = createSession(origin(), { ...cookieJar(), solve: async () => 1 });
		await assert.rejects(session.signIn(), /Check failed/);
	});
});

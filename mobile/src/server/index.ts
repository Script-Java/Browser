// The app's dealings with the Badger server (contract: ./types.ts).
// Cookies: React Native's fetch on iOS keeps them in HTTPCookieStorage.shared
// (RCTHTTPRequestHandler), where the relay's URLSession WebSocket finds the
// session cookie. It sends no Origin header, as the server's fromShell wants.
import type { AccessMode, CreateSession, Session, Threat } from "./types";

/**
 * `fetch`: the tests pass one with a cookie jar of its own. `solve`: the
 * sign-in puzzle's solver, for a native one (see solve below).
 */
export function createSession(
	origin: string,
	{ fetch: fetchFn = fetch, solve: solveFn = solve }: { fetch?: typeof fetch; solve?: typeof solve } = {}
): Session {
	origin = origin.replace(/\/+$/, "");
	const request = (path: string, init?: RequestInit) => fetchFn(origin + path, { credentials: "include", ...init });
	async function get(path: string, headers?: Record<string, string>) {
		const res = await request(path, { headers });
		if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
		return res;
	}
	const accessMode = async (): Promise<AccessMode> => (await (await get("/api/access")).json()).mode;
	async function signedIn() {
		// any route behind the sign-in answers 401 until then
		const res = await request("/filters/status");
		if (res.status === 401) return false;
		if (!res.ok) throw new Error(`/filters/status: HTTP ${res.status}`);
		return true;
	}

	return {
		origin,
		wispUrl: origin.replace(/^http/, "ws") + "/wisp/",
		accessMode,
		signedIn,
		async signIn(password) {
			const mode = await accessMode();
			if (mode === "off") return;
			let body;
			if (mode === "password") {
				if (!password) throw new Error("This server needs its password.");
				body = "password=" + encodeURIComponent(password);
			} else {
				const { challenge, bits } = await (await get("/api/challenge")).json();
				body = `challenge=${encodeURIComponent(challenge)}&solution=${await solveFn(challenge, bits)}`;
			}
			// it redirects to "/" signed in, or to /login?error=… (fetch follows)
			const res = await request("/login", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body,
			});
			if (await signedIn()) return;
			const error = /[?&]error=([^&#]*)/.exec(res.url)?.[1];
			throw new Error(error ? decodeURIComponent(error) : "Couldn't sign in.");
		},
		async signOut() {
			await request("/logout", { method: "POST", redirect: "manual" });
		},
		async navRules() {
			return (await get("/filters/privacy.json")).json();
		},
		async threat(host): Promise<Threat> {
			return (await (await get("/api/nav", { "x-bios-host": host })).json()).threat;
		},
		async contentRules(since) {
			const { version, lists } = await (await get("/filters/content-rules.json")).json();
			if (version === since) return { version, lists: [] };
			return {
				version,
				lists: await Promise.all(
					lists.map(async (id: string) => ({ id, json: await (await get(`/filters/content-rules/${id}.json`)).text() }))
				),
			};
		},
	};
}
createSession satisfies CreateSession;

// The sign-in puzzle (app/src/auth.js), solved with CryptoKit: Hermes has no
// fast SHA-256 of its own. Imported when used, so the Node tests can pass theirs.
async function solve(challenge: string, bits: number): Promise<number> {
	return (await import("../../modules/badger-relay")).default.solveChallenge(challenge, bits);
}

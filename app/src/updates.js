// The desktop app's updates, relayed: desktop/main.js asks this server
// instead of GitHub, so GitHub never learns the computer's address or how
// often it checks. Only the latest release's update files, only from GitHub.

import { get } from "node:https";

const REPO = "Script-Java/Browser";
export const UPDATE_FILES = new Set(["latest.yml", "Badger-Setup.exe"]);
// GitHub answers a release download with a redirect to its file host
const GITHUB_HOST = /^(github\.com|[a-z0-9-]+\.githubusercontent\.com)$/;

/** Whether `url` is one this relay may fetch. */
export const fromGitHub = (url) => {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && !u.port && !u.username && GITHUB_HOST.test(u.hostname);
	} catch {
		return false;
	}
};

/**
 * The response for one of UPDATE_FILES from the latest release, redirects
 * followed (GitHub's hosts only).
 * @returns {Promise<import("node:http").IncomingMessage>}
 */
export function releaseFile(name, url = `https://github.com/${REPO}/releases/latest/download/${name}`, hops = 0) {
	return new Promise((resolve, reject) => {
		if (!UPDATE_FILES.has(name) || !fromGitHub(url)) return reject(new Error("not an update file"));
		const req = get(url, { timeout: 30_000, headers: { "user-agent": "badger-updates" } }, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				if (hops >= 5) return reject(new Error("too many redirects"));
				return resolve(releaseFile(name, new URL(res.headers.location, url).href, hops + 1));
			}
			if (res.statusCode !== 200) {
				res.resume();
				return reject(new Error(`HTTP ${res.statusCode}`));
			}
			resolve(res);
		});
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("error", reject);
	});
}

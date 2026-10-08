// End-to-end security tests: a real browser against real servers (`pnpm e2e`).
// The proxy reaches real sites, so these need internet access.

import { defineConfig, devices } from "@playwright/test";
import { CATCHER, ISOLATED, SECRET, SHARED } from "./e2e/env.js";

export default defineConfig({
	testDir: "./e2e",
	timeout: 120_000,
	expect: { timeout: 30_000 },
	// real sites over the internet are sometimes slow
	retries: process.env.CI ? 1 : 0,
	// one browser at a time: every test also checks the leak catcher's list
	workers: 1,
	reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
	// Safari's engine at a phone's size is what the home-screen app runs on.
	projects: [
		{
			name: "chromium",
			use: {
				browserName: "chromium",
				// a camera and a microphone that make up their picture and sound (permissions.spec.js)
				launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
			},
		},
		{ name: "iphone", use: { ...devices["iPhone 15"] } },
	],
	use: {
		// Everything but the app's own addresses goes to the leak catcher.
		proxy: {
			server: `http://127.0.0.1:${CATCHER}`,
			bypass: "localhost,*.localhost,127.0.0.1",
		},
		trace: "retain-on-failure",
	},
	webServer: [
		{
			command: "node e2e/leak-catcher.js",
			url: `http://127.0.0.1:${CATCHER}/__seen`,
			env: { PORT: String(CATCHER) },
		},
		{
			// shared mode, no sign-in: most tests
			command: "node src/index.js",
			url: `http://localhost:${SHARED}/healthz`,
			env: {
				PORT: String(SHARED),
				FILTER_CACHE_DIR: ".e2e/filters-shared",
				// a reserved name the warning tests can open (.invalid never resolves)
				PHISHING_HOSTS: "phishing.badger-test.invalid",
			},
			timeout: 60_000,
		},
		{
			// like production: site isolation and the browser check
			command: "node src/index.js",
			url: `http://localhost:${ISOLATED}/healthz`,
			env: {
				PORT: String(ISOLATED),
				ISOLATION_DOMAIN: "app.localhost",
				AUTH_SECRET: SECRET,
				CONTACT_EMAIL: "e2e@example.com",
				FILTER_CACHE_DIR: ".e2e/filters-isolated",
			},
			timeout: 60_000,
		},
	],
});

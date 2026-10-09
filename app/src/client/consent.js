// Answers cookie notices with "reject" (bundled to /bios/consent.js): DuckDuckGo's
// autoconsent (https://github.com/duckduckgo/autoconsent, MPL-2.0), the engine
// behind its Cookie Pop-up Protection. The service worker adds this script to
// pages of sites with blocking on, when "Answer cookie notices" is on.
//
// Scramjet doesn't rewrite this file, so the library would see the proxy's
// own address and the app's window above the tab. index.js builds it with
// `location`, `top` and `parent` pointing at the getters below instead.

import AutoConsent, { filterCompactRules } from "@duckduckgo/autoconsent";
import compactRules from "@duckduckgo/autoconsent/rules/compact-rules.json";

const SCRAMJET = Symbol.for("scramjet client global");

(function () {
	const client = self[SCRAMJET];
	if (!client || self.__biosConsentStarted) return;
	Object.defineProperty(self, "__biosConsentStarted", { value: true });

	// The page's own address, read fresh each time (single-page apps move).
	Object.defineProperty(self, "__biosLocation", {
		get: () => new URL(client.url.href),
		configurable: true,
	});
	// page.js says which window is the tab's (the top, as far as a site knows).
	const tab = () => self.__biosTabWindow || self;
	Object.defineProperty(self, "__biosTop", { get: tab, configurable: true });
	Object.defineProperty(self, "__biosParent", {
		get: () => (tab() === self ? self : self.parent),
		configurable: true,
	});

	const mainFrame = tab() === self;
	const rules = {
		autoconsent: [],
		compact: filterCompactRules(compactRules, { url: client.url.href, mainFrame }),
	};
	const config = {
		enabled: true,
		autoAction: "optOut",
		disabledCmps: [],
		// hides a known notice while its "reject" is being found, so it doesn't flash
		enablePrehide: true,
		prehideTimeout: 2000,
		// a notice with no way to say no is hidden instead
		enableCosmeticRules: true,
		enableGeneratedRules: true,
		enableHeuristicDetection: true,
		heuristicMode: "tier2",
		enablePopupMutationObserver: false,
		detectRetries: 20,
		// this runs in the page itself, so its scripted steps need no relay
		isMainWorld: true,
		visualTest: false,
		performanceLoggingEnabled: false,
		logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
	};

	// The shell hears what was answered on the tab's own page, for the shield menu.
	const report = (message) => {
		if (!mainFrame || !self.__biosReport) return;
		if (message.type === "optOutResult" || message.type === "autoconsentDone")
			self.__biosReport({ bios: "consent", cmp: String(message.cmp || ""), result: message.type === "autoconsentDone" || !!message.result });
	};

	try {
		// Built first, then started, as the library's own standalone build does:
		// handed the settings at once, it starts before it has set itself up.
		new AutoConsent(async (message) => report(message)).initialize(config, rules);
	} catch (err) {
		console.warn("bios: cookie notices:", err);
	}
})();

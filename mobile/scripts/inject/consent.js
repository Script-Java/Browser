// Answers cookie notices with "reject": DuckDuckGo's autoconsent
// (https://github.com/duckduckgo/autoconsent, MPL-2.0), with its bundled
// rules, as the old app does (app/src/client/consent.js). Here it runs in a
// world of its own, so `location`, `top` and the DOM are the page's real ones
// and the page can't see or undo it.

import AutoConsent, { filterCompactRules } from "@duckduckgo/autoconsent";
import compactRules from "@duckduckgo/autoconsent/rules/compact-rules.json";

const mainFrame = self === self.top;
const rules = { autoconsent: [], compact: filterCompactRules(compactRules, { url: location.href, mainFrame }) };
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
	isMainWorld: false,
	visualTest: false,
	performanceLoggingEnabled: false,
	logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
};

try {
	const consent = new AutoConsent(async (message) => {
		// shortcut: rules that read the page's own scripts ("eval") need its world,
		// which this one can't reach, so they answer no; upgrade when the native
		// side can evaluate a snippet in the page's world
		if (message.type === "eval") consent.receiveMessageCallback({ type: "evalResp", id: message.id, result: false });
	});
	// built first, then started, as the library's standalone build does
	consent.initialize(config, rules);
} catch (err) {
	console.warn("badger: cookie notices:", err);
}

// Fingerprinting protection and the privacy signal inside workers (bundled to
// /bios/worker.js and /bios/worker-safer.js). The service worker loads it at
// the top of every worker a page starts, before Scramjet's own code, so a
// script asking from a worker gets the page's answers.

import { protect } from "./fingerprint.js";

/* global __BIOS_LEVEL__ */
try {
	protect(self, __BIOS_LEVEL__);
	Object.defineProperty(self.WorkerNavigator.prototype, "globalPrivacyControl", {
		get: () => true,
		enumerable: true,
		configurable: true,
	});
} catch {
	// not a worker this knows: leave it be rather than break it
}

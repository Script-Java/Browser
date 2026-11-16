// Fingerprinting protection, the old app's own (app/src/client/fingerprint.js).
// The build makes one copy per level: "standard", or "safer" (one language,
// UTC, a page-sized screen, no WebGL or WebGPU).
// shortcut: windows only; workers keep the device's answers until the native
// side can run a script in them.
import { protect } from "../../../app/src/client/fingerprint.js";

/* global __LEVEL__ */
protect(self, __LEVEL__);

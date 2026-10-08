// Runs first in every worker a proxied page starts (bundled to
// /bios/worker.js; shield.js puts it at the top of the worker's code). The
// page script never reaches inside a worker, and a script there could ask the
// same things about the device as the page (unique.js). The server puts
// `self.__biosWorker = { safer, fingerprint }` in front of it, from the
// worker's request.

import { everyday, safer } from "./unique.js";

const flags = self.__biosWorker || {};
if (flags.safer) safer(self);
else if (flags.fingerprint) everyday(self);

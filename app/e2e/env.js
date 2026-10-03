// Ports and secrets shared by playwright.config.js and the tests.
export const SHARED = 8811;
export const ISOLATED = 8812;
export const CATCHER = 8819;
export const SECRET = "e2e-test-secret-not-for-production-0123456789";

export const SHARED_URL = `http://localhost:${SHARED}`;
export const ISOLATED_URL = `http://app.localhost:${ISOLATED}`;

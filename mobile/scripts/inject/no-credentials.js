// WebAuthn off unless the site is allowed passkeys: its related-origin
// requests (iOS 18+) go around the data store's proxy (mysk, 2026).
try {
	delete Navigator.prototype.credentials;
} catch {
	// locked
}
try {
	Object.defineProperty(self, "PublicKeyCredential", { value: undefined, writable: false, configurable: false });
} catch {
	// locked
}

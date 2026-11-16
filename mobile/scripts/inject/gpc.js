// Global Privacy Control ("don't sell or share my data"), for scripts that ask the page.
// shortcut: no Sec-GPC header, which WKWebView can't add to every request; add it if the native side gets a way.
try {
	Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true, enumerable: true, configurable: true });
} catch {
	// locked
}

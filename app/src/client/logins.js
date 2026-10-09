// Passwords and passkeys, the page's side (bundled into page.js). The app
// keeps them (public/index.js); this finds the sign-in forms on a page, tells
// the app about a password that was just typed into one, fills one in when
// the person picks it in the app, and hands a site's passkey requests
// (navigator.credentials) to the app, which acts as the passkey's
// authenticator. Nothing here can read what the app keeps: it only ever gets
// the one login the person chose, for the tab's own site.

const isPassword = (el) => el?.localName === "input" && String(el.type).toLowerCase() === "password";
const isUserField = (el) =>
	el?.localName === "input" && /^(text|email|tel|)$/i.test(String(el.getAttribute("type") || "text")) && !el.hidden;

function shown(el) {
	try {
		return el.isConnected && !el.disabled && el.getClientRects().length > 0;
	} catch {
		return false;
	}
}

// The password fields of the form `el` is in (or of the page, for a page
// without forms), and the username field that goes with the first of them.
function loginParts(doc, start) {
	const scope = start?.form || start?.closest?.("form") || doc;
	const fields = [...scope.querySelectorAll("input")].filter(shown);
	const passwords = fields.filter(isPassword);
	if (!passwords.length) return null;
	const first = fields.indexOf(passwords[0]);
	const before = fields.slice(0, first).filter(isUserField);
	const named = before.filter((el) => /user|mail|login|phone|account|name/i.test(`${el.autocomplete} ${el.name} ${el.id} ${el.type}`));
	const username = named.at(-1) || before.at(-1) || null;
	// two or three password fields: a new account, or a new password (the
	// last ones are the new password and its confirmation)
	const fresh =
		passwords.length > 1 || /new-password/i.test(passwords[0].autocomplete) || /sign.?up|register|create/i.test(scope.action || "");
	return { username, passwords, fresh };
}

/**
 * Watches the tab's page for sign-in forms. `tell` sends a message to the app.
 * @param {Window} win
 * @param {(message: object) => void} tell
 */
export function watchLogins(win, tell) {
	const doc = win.document;
	let reported = "";
	const report = () => {
		const parts = loginParts(doc, doc.activeElement?.form ? doc.activeElement : null);
		const state = parts ? (parts.fresh ? "new" : "login") : "";
		if (state === reported) return;
		reported = state;
		tell({ bios: "login-form", form: state });
	};
	new win.MutationObserver(() => win.setTimeout(report, 300)).observe(doc.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["type", "hidden", "style", "class"],
	});
	if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", report, { once: true });
	else report();

	// A password the person just used: the app offers to keep it.
	let last = "";
	const seen = (start) => {
		const parts = loginParts(doc, start);
		if (!parts) return;
		const filled = parts.passwords.filter((el) => el.value);
		if (!filled.length) return;
		const password = (parts.fresh ? filled.at(filled.length > 2 ? -2 : -1) : filled[0]).value;
		const username = parts.username?.value || "";
		if (password.length > 500 || username.length > 300 || username + "\n" + password === last) return;
		last = username + "\n" + password;
		tell({ bios: "login-seen", username, password, fresh: parts.fresh });
	};
	win.addEventListener("submit", (event) => event.isTrusted !== false && seen(event.target), true);
	win.addEventListener(
		"click",
		(event) => {
			if (!event.isTrusted) return;
			const button = event.target?.closest?.("button, input[type=submit], input[type=button], [role=button]");
			if (button && loginParts(doc, button)) seen(button);
		},
		true
	);
	win.addEventListener(
		"keydown",
		(event) => event.isTrusted && event.key === "Enter" && isPassword(event.target) && seen(event.target),
		true
	);
}

// Sets a field's value as typing would, so a page's own framework notices.
function type(win, el, value) {
	const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
	el.focus();
	if (setter) setter.call(el, value);
	else el.value = value;
	el.dispatchEvent(new win.Event("input", { bubbles: true }));
	el.dispatchEvent(new win.Event("change", { bubbles: true }));
}

/**
 * Fills the page's sign-in form with the login the person picked in the app.
 * A new password goes into every new-password field.
 * @param {Window} win
 * @param {string} username
 * @param {string} password
 */
export function fillLogin(win, username, password) {
	const doc = win.document;
	const parts = loginParts(doc, doc.activeElement);
	if (!parts) return false;
	if (parts.username && username) type(win, parts.username, username);
	const targets = parts.fresh && parts.passwords.length > 2 ? parts.passwords.slice(1) : parts.fresh ? parts.passwords : [parts.passwords[0]];
	for (const field of targets) type(win, field, password);
	return true;
}

// ---------------------------------------------------------------- passkeys

const toBuffer = (source) => {
	const kind = Object.prototype.toString.call(source);
	if (kind === "[object ArrayBuffer]") return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	return null;
};

const base64url = (buffer) => {
	let text = "";
	for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// An object a site's code takes for the browser's own: its interface's
// prototype, with the values as properties of its own.
function standIn(Interface, values) {
	const object = Object.create(Interface?.prototype || Object.prototype);
	for (const [name, value] of Object.entries(values))
		Object.defineProperty(object, name, { value, enumerable: typeof value !== "function", configurable: true });
	return object;
}

/**
 * navigator.credentials: passkeys go to the app; passwords and other
 * credential types the browser would store are refused, as before.
 * @param {Window} win
 * @param {(kind: string, details: object) => Promise<any>} ask asks the app
 * @param {boolean} inTab only the tab's own page may use passkeys
 */
export function passkeys(win, ask, inTab) {
	// A browser without WebAuthn of its own (or with it switched off) gets
	// the interfaces too: the passkeys are the app's either way.
	standInInterfaces(win);
	const proto = win.CredentialsContainer?.prototype;
	if (!proto) return;
	const denied = (message = "The operation either timed out or was not allowed.", name = "NotAllowedError") =>
		Promise.reject(new win.DOMException(message, name));
	const aborted = (signal) => signal?.aborted && denied("The operation was aborted.", "AbortError");
	const define = (object, name, value) => {
		try {
			Object.defineProperty(object, name, { value, writable: true, configurable: true });
		} catch {
			// locked
		}
	};

	const credential = (answer, response, extensions, more = {}) => {
		const id = base64url(answer.credentialId);
		const json = () => ({
			id,
			rawId: id,
			type: "public-key",
			authenticatorAttachment: "platform",
			clientExtensionResults: extensions,
			response: {
				...Object.fromEntries(
					Object.entries(response).map(([name, value]) => [name, value === null ? null : base64url(value)])
				),
				...more,
			},
		});
		return standIn(win.PublicKeyCredential, {
			id,
			rawId: answer.credentialId,
			type: "public-key",
			authenticatorAttachment: "platform",
			response,
			getClientExtensionResults: () => extensions,
			toJSON: json,
		});
	};

	define(proto, "create", function (options = {}) {
		if (!options.publicKey) return denied();
		if (!inTab) return denied("Passkeys work in the page itself, not in a frame inside it.");
		if (aborted(options.signal)) return aborted(options.signal);
		const pk = options.publicKey;
		const request = {
			challenge: toBuffer(pk.challenge),
			rp: { id: pk.rp?.id ? String(pk.rp.id) : "", name: String(pk.rp?.name || "") },
			user: { id: toBuffer(pk.user?.id), name: String(pk.user?.name || ""), displayName: String(pk.user?.displayName || "") },
			algorithms: (pk.pubKeyCredParams || []).map((p) => Number(p.alg)),
			exclude: (pk.excludeCredentials || []).map((c) => toBuffer(c.id)).filter(Boolean),
		};
		if (!request.challenge || !request.user.id) return denied("A passkey needs a challenge and a user.", "TypeError");
		return ask("passkey-create", { request }).then((answer) => {
			if (!answer?.ok) return denied(answer?.error, answer?.name);
			const response = standIn(win.AuthenticatorAttestationResponse, {
				clientDataJSON: answer.clientDataJSON,
				attestationObject: answer.attestationObject,
				getTransports: () => ["internal"],
				getAuthenticatorData: () => answer.authenticatorData,
				getPublicKey: () => answer.publicKey,
				getPublicKeyAlgorithm: () => -7,
			});
			const extensions = pk.extensions?.credProps ? { credProps: { rk: true } } : {};
			return credential(answer, response, extensions, {
				transports: ["internal"],
				publicKeyAlgorithm: -7,
				publicKey: base64url(answer.publicKey),
				authenticatorData: base64url(answer.authenticatorData),
			});
		});
	});

	define(proto, "get", function (options = {}) {
		if (!options.publicKey) return denied();
		if (!inTab) return denied("Passkeys work in the page itself, not in a frame inside it.");
		if (aborted(options.signal)) return aborted(options.signal);
		// the autofill kind of request: this app offers no such list, so it
		// waits until the page gives up on it
		if (options.mediation === "conditional")
			return new Promise((resolve, reject) =>
				options.signal?.addEventListener("abort", () => reject(new win.DOMException("The operation was aborted.", "AbortError")))
			);
		const pk = options.publicKey;
		const request = {
			challenge: toBuffer(pk.challenge),
			rpId: pk.rpId ? String(pk.rpId) : "",
			allow: (pk.allowCredentials || []).map((c) => toBuffer(c.id)).filter(Boolean),
		};
		if (!request.challenge) return denied("A passkey needs a challenge.", "TypeError");
		return ask("passkey-get", { request }).then((answer) => {
			if (!answer?.ok) return denied(answer?.error, answer?.name);
			const response = standIn(win.AuthenticatorAssertionResponse, {
				clientDataJSON: answer.clientDataJSON,
				authenticatorData: answer.authenticatorData,
				signature: answer.signature,
				userHandle: answer.userHandle,
			});
			return credential(answer, response, {});
		});
	});

	// Sites look for these before they offer a passkey.
	const Credential = win.PublicKeyCredential;
	if (Credential) {
		define(Credential, "isUserVerifyingPlatformAuthenticatorAvailable", () => Promise.resolve(true));
		define(Credential, "isConditionalMediationAvailable", () => Promise.resolve(false));
		define(Credential, "getClientCapabilities", () =>
			Promise.resolve({ passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true, conditionalGet: false, hybridTransport: false })
		);
	}
}

function standInInterfaces(win) {
	const make = (name) => {
		if (typeof win[name] === "function") return;
		const Interface = function () {
			throw new win.TypeError("Illegal constructor");
		};
		Object.defineProperty(Interface, "name", { value: name });
		try {
			Object.defineProperty(win, name, { value: Interface, writable: true, configurable: true });
		} catch {
			// locked
		}
	};
	for (const name of ["CredentialsContainer", "PublicKeyCredential", "AuthenticatorAttestationResponse", "AuthenticatorAssertionResponse"]) make(name);
	const nav = win.Navigator?.prototype;
	if (nav && !win.navigator.credentials) {
		const container = Object.create(win.CredentialsContainer.prototype);
		try {
			Object.defineProperty(nav, "credentials", { get: () => container, enumerable: true, configurable: true });
		} catch {
			// locked
		}
		for (const [name, value] of [
			["get", () => Promise.reject(new win.DOMException("Not allowed", "NotAllowedError"))],
			["create", () => Promise.reject(new win.DOMException("Not allowed", "NotAllowedError"))],
			["store", () => Promise.reject(new win.DOMException("Not supported", "NotSupportedError"))],
			["preventSilentAccess", () => Promise.resolve()],
		])
			if (!win.CredentialsContainer.prototype[name])
				Object.defineProperty(win.CredentialsContainer.prototype, name, { value, writable: true, configurable: true });
	}
}

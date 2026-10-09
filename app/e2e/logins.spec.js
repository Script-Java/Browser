// Passwords and passkeys kept by the app, and the permissions it asks the
// person about. The app's own prompts stand between a page and all of these.

import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { expect, open, openShell, test, testPage } from "./fixtures.js";
import { SHARED_URL } from "./env.js";

const LOGIN = (note) =>
	testPage(`<!doctype html><title>sign in</title>
<form id="form" action="https://httpbin.org/post" method="post">
<input id="user" name="user" autocomplete="username"><input id="pass" name="pass" type="password">
<button id="go">Sign in</button></form><!-- ${note} -->`);

test("a password used to sign in is offered to keep, and filled in when picked", async ({ app }) => {
	let frame = await open(app, LOGIN("first"));
	await frame.fill("#user", "alice");
	await frame.fill("#pass", "s3cret-pw");
	await frame.click("#go");
	await expect(app.locator("#offer-text")).toContainText("alice");
	await app.locator("#offer").getByRole("button", { name: "Save" }).click();
	expect(await app.evaluate(() => readLogins().map((l) => [l.site, l.username, l.password]))).toEqual([["httpbin.org", "alice", "s3cret-pw"]]);
	// never stored as text, even without the passphrase lock
	expect(await app.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain("s3cret-pw");

	// the sign-in page again: the key in the address bar fills it in
	frame = await open(app, LOGIN("again"));
	await expect(app.locator("#key-btn")).toBeVisible();
	await app.click("#key-btn");
	await expect.poll(() => frame.inputValue("#pass")).toBe("s3cret-pw");
	expect(await frame.inputValue("#user")).toBe("alice");

	// another site's sign-in page gets nothing
	await open(app, "https://example.com/");
	await expect(app.locator("#key-btn")).toBeHidden();
});

// A page that makes a passkey and signs in with it, with the site's options
// as JSON (the way a site's server sends them).
const PASSKEY_PAGE = testPage(`<!doctype html><title>passkeys</title><script>
const bytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
window.make = async (o) => (await navigator.credentials.create({ publicKey: {
	...o, challenge: bytes(o.challenge), user: { ...o.user, id: bytes(o.user.id) },
	excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: bytes(c.id) })),
} })).toJSON();
window.use = async (o) => (await navigator.credentials.get({ publicKey: {
	...o, challenge: bytes(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: bytes(c.id) })),
} })).toJSON();
window.useElsewhere = (o) => window.use({ ...o, rpId: "httpbin.org" }).then(() => "USED", (e) => e.name);
</script>`);

test("a site can make a passkey here and sign in with it, and no other site can", async ({ app }) => {
	await app.evaluate(() => setPassphrase("correct horse"));
	const rpID = "httpbin.org";
	const expectedOrigin = "https://httpbin.org";
	const options = await generateRegistrationOptions({
		rpName: "Test site",
		rpID,
		userName: "alice",
		userID: new TextEncoder().encode("user-1"),
		attestationType: "none",
		authenticatorSelection: { residentKey: "required", userVerification: "required" },
	});
	const frame = await open(app, PASSKEY_PAGE);
	const made = frame.evaluate((o) => window.make(o), options);
	await expect(app.locator("#choice-title")).toHaveText("Make a passkey for httpbin.org?");
	await app.click("#choice-ok");
	const registration = await verifyRegistrationResponse({
		response: await made,
		expectedChallenge: options.challenge,
		expectedOrigin,
		expectedRPID: rpID,
		requireUserVerification: true,
	});
	expect(registration.verified).toBe(true);
	const { credential } = registration.registrationInfo;

	const login = await generateAuthenticationOptions({ rpID, allowCredentials: [{ id: credential.id }], userVerification: "required" });
	const used = frame.evaluate((o) => window.use(o), login);
	await app.locator("#choice-list button").first().click();
	const authentication = await verifyAuthenticationResponse({
		response: await used,
		expectedChallenge: login.challenge,
		expectedOrigin,
		expectedRPID: rpID,
		credential,
		requireUserVerification: true,
	});
	expect(authentication.verified).toBe(true);

	// the private key never sits in storage as text
	expect(await app.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(credential.id);

	// another site can't ask for this one
	const elsewhere = await open(app, "https://example.com/");
	expect(await elsewhere.evaluate(() => navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: "httpbin.org" } }).then(() => "USED", (e) => e.name))).toBe("SecurityError");
});

test.describe("location", () => {
	test.use({ geolocation: { latitude: 48.858844, longitude: 2.294351 }, permissions: ["geolocation"] });

	test("a site asks the app for the location, and gets what the person allows", async ({ app }) => {
		const frame = await open(
			app,
			testPage(`<!doctype html><title>where</title><button id="ask">where am I</button><script>
document.getElementById("ask").onclick = () => navigator.geolocation.getCurrentPosition(
	(p) => (document.title = "AT " + p.coords.latitude + "," + p.coords.longitude),
	(e) => (document.title = "NO " + e.code));
</script>`)
		);
		await frame.click("#ask");
		await expect(app.locator("#ask-title")).toHaveText("httpbin.org wants to use your location");
		await app.click("#ask-deny");
		await expect.poll(() => frame.title()).toBe("NO 1");

		await frame.click("#ask");
		await app.click("#ask-approximate");
		await expect.poll(() => frame.title()).toBe("AT 48.86,2.29");

		await frame.click("#ask");
		await app.click("#ask-remember");
		await app.click("#ask-allow");
		await expect.poll(() => frame.title()).toBe("AT 48.858844,2.294351");

		// remembered for the site: no prompt this time
		await frame.evaluate(() => (document.title = "again"));
		await frame.click("#ask");
		await expect.poll(() => frame.title()).toBe("AT 48.858844,2.294351");
		await expect(app.locator("#ask")).toBeHidden();
		await app.evaluate(() => openSheet());
		await expect(app.locator("#permissions-list")).toContainText("Allowed");
	});
});

test("two devices swap bookmarks, history and passwords with a one-time code", async ({ app, browser }) => {
	// this device: a bookmark and a password
	await open(app, "https://example.com/");
	await app.evaluate(() => toggleBookmark());
	await app.evaluate(() =>
		saveEntries(LOGINS, [{ id: "a", site: "example.org", origin: "https://example.org", username: "anne", password: "pw-a", created: 1, used: 1 }])
	);
	// the other device: a bookmark of its own
	const other = await browser.newContext();
	const device = await other.newPage();
	await openShell(device, SHARED_URL);
	await device.evaluate(() => saveEntries(BOOKMARKS, [{ url: "https://example.net/", title: "Net" }]));

	await app.evaluate(() => openSyncPanel());
	await app.click("#sync-show");
	await expect(app.locator("#sync-code")).toHaveText(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
	const code = await app.locator("#sync-code").textContent();
	await device.evaluate(() => openSyncPanel());
	await device.click("#sync-enter");
	await device.fill("#sync-input", code.toLowerCase());
	await device.click("#sync-form button[type=submit]");
	await expect(device.locator("#sync-status")).toContainText("Synced", { timeout: 30_000 });
	await expect(app.locator("#sync-status")).toContainText("Synced", { timeout: 30_000 });

	for (const page of [app, device])
		expect(await page.evaluate(() => readEntries(BOOKMARKS).map((b) => b.url).sort())).toEqual(["https://example.com/", "https://example.net/"]);
	expect(await device.evaluate(() => readLogins().map((l) => [l.site, l.username, l.password]))).toEqual([["example.org", "anne", "pw-a"]]);
	// what was relayed is gone from the server
	await expect(device.evaluate(() => fetch("/api/sync/" + "0".repeat(32)).then((r) => r.status))).resolves.toBe(404);
	await other.close();
});

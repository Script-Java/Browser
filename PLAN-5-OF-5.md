# Plan: 5 out of 5

How Badger gets from its scores on 2026-11-16 to 5 in privacy, functionality and security, measured against Chrome, Safari, Edge, Firefox and Brave. Sizes are as in `SECURITY-PLAN.md`: S is under a day, M is one to three days, L is a week or more. Every item follows that file's rules (test first, both e2e projects, whole suite alone, Snyk, tick it off).

| | Privacy | Functionality | Security |
|---|---|---|---|
| Badger today | 3.5 | 2 | 2.5 |
| Brave (best of the five) | 4.5 | 4.5 | 4.5 |
| Badger after phase 6 (native app) | 4 | 4 | 4 |
| Badger after phase 9 | 5 | 5 | 5 |

## Why the PWA alone can't get there

The ceilings are the proxy's, not missing features (`SECURITY-GAPS.md`, "What's left"):

- **Security tops out near 3.** The server sends the app's code at every launch, unsigned. Sites' own `script-src` can't be enforced on rewritten scripts. WebRTC, the permission prompts and fingerprinting protection are page script. TLS is rustls compiled for the web, with no post-quantum key exchange and no ECH.
- **Functionality tops out near 3.** It has no video calls, no DRM, no security keys or iCloud passkeys, and no extensions. Rewriting breaks some sites, everyone shares one exit address (robot checks), and there's a 2 GB daily cap.
- **Privacy tops out near 4.** The operator sees every site, Tor tabs included, and fingerprinting protection is script against script.

So phase 6 changes the foundation: **a native iOS app built on WKWebView, with Apple's default-browser entitlement**. iOS gives it the same WebKit Safari uses, with no rewriting. The server becomes an optional relay, and Tor runs on the phone. The PWA and server stay as they are for people who can't install the app.

Two open-source iOS browsers already do most of this, so copy their approach before inventing one (add each to `THIRD-PARTY.md`): Brave's iOS browser (MPL 2.0, inside `brave-core`) and DuckDuckGo's (Apache 2.0, `duckduckgo/iOS`). Onion Browser (`OnionBrowser/OnionBrowser`, with iCepa's `Tor.framework`) shows how to run Tor on the phone.

**The honest limit:** on iOS, every browser runs Apple's WebKit (outside the EU). So 5 in security means "everything Safari has, plus what Safari doesn't do by default", not a stronger engine. And no browser gets 5 in privacy and 5 in functionality in one mode at the same time. Tor Browser scores 5 for privacy and 2 for functionality. The plan gets there with modes per tab and per site (Decision 1).

## Phase 0: housekeeping (done 2026-11-16)

| # | Item | Where | Size |
|---|---|---|---|
| 0.1 | Commit the Google default search (uncommitted: `settings.js`, `index.html`, `index.js`, `search.spec.js`, README). Its tests passed on 2026-11-16. | | S |
| 0.2 | **URLhaus's own list is gone.** `urlhaus.abuse.ch/downloads/hostfile/` answers 410 (checked 2026-11-16), so phase 5.12's five-minute list loads nothing. Drop it from `THREAT_LISTS`, its fixture in `filters.test.js`, and the lines in README, `SECURITY-GAPS.md` and `THIRD-PARTY.md`. malware-filter's URLhaus mirror still answers 200. abuse.ch's API with an Auth-Key is the way back to five-minute updates, if wanted. | `app/src/filters.js:110` | S |
| 0.3 | Merge Dependabot's Electron 45.3.1 and electron-updater 6.8.11 branches after their tests pass. Electron 44.5.1 is behind Chrome's security fixes. | `desktop/package.json` | S |

## Phase 6: the native iOS app (the foundation)

This phase removes the biggest single risk: code that whoever runs the server can change at any time.

| # | Item | How | Test | Size |
|---|---|---|---|---|
| 6.1 | `ios/` Xcode project: SwiftUI chrome (address bar, tabs, menus) and one `WKWebView` per tab. The shell's code ships inside the signed app. | Request `com.apple.developer.web-browser` (default browser), as Brave and DuckDuckGo do. Minimum iOS 26 (6.6 needs it). | XCUITest: open a site, open a tab, go back. | L |
| 6.2 | Workspaces, private tabs and Tor tabs as separate data stores | `WKWebsiteDataStore(forIdentifier:)` (iOS 17) per workspace. `.nonPersistent()` for private and Tor tabs. | Signed in to a site in one workspace, signed out in another. | M |
| 6.3 | Blocking in the engine | Compile uBlock Origin's default lists, Brave's CNAME list and the user's own rules to `WKContentRuleList`s, at most 150,000 rules each. Brave's iOS code does this conversion. Cosmetic rules, scriptlets and autoconsent run as `WKUserScript`s at document start in every frame, in their own `WKContentWorld`, so pages can't see or undo them. | The existing `privacy.spec.js` cases, ported to XCUITest. | L |
| 6.4 | Fingerprinting protection and GPC in every frame | Run `fingerprint.js` as a `WKUserScript` (document start, `forMainFrameOnly: false`), so it reaches cross-site frames before their scripts run. Check whether iOS 26's Advanced Fingerprinting Protection applies to `WKWebView`. If it does, turn it on and keep only what it lacks. | `fingerprint.spec.js` cases. | M |
| 6.5 | Passwords and passkeys in the Keychain | Move the vault to Keychain items with `.biometryCurrentSet` access control (Secure Enclave, Face ID). Sites' passkeys and security keys come from the system: request `com.apple.developer.web-browser.public-key-credential` too. Apple's forum answers conflict on which entitlement iOS needs, so ask for both. Sync (`sync.js`) carries over unchanged. | A real WebAuthn verifier with an iCloud passkey and with a YubiKey (NFC). | M |
| 6.6 | Engine TLS | iOS 26 offers X25519MLKEM768 by default. Check that `WKWebView` does too (Cloudflare's `/cdn-cgi/trace`, `kex=`). Apple's docs confirm it for URLSession and Safari, not for embedded web views. CT and revocation are then the system's (Apple's CT policy), and the certificate viewer reads `serverTrust`. | The trace page shows the ML-KEM group. | S |
| 6.7 | Threat warnings | `WKPreferences.isFraudulentWebsiteWarningEnabled` (Safari's Safe Browsing, privacy-proxied by Apple), plus the server's lists and the lookalike check in `decidePolicyFor`. `lookalike.js` ports as a pure function. | `security.spec.js` warning cases. | M |
| 6.8 | Release | TestFlight, then the App Store. The privacy label says "Data Not Collected". | | M |

Scores after phase 6: about 4 / 4 / 4. The code is signed, sites' CSP is enforced again, nothing is rewritten, and calls, DRM and passkeys work in Direct mode.

## Phase 7: functionality to 5

| # | Item | How | Size |
|---|---|---|---|
| 7.1 | Extensions | `WKWebExtensionController` (iOS 18.4) loads WebExtensions. Start with uBlock Origin Lite, Bitwarden and 1Password. A permission prompt goes through its delegate. | L |
| 7.2 | Video calls and DRM | Native in Direct mode. Test Meet, Zoom's web client, and a FairPlay site. In Relay and Tor modes WebRTC stays off (7.5). | S |
| 7.3 | On-device translation | Apple's Translation framework (`TranslationSession`). Nothing leaves the phone, which closes the "translation tells Google" gap. | M |
| 7.4 | Native everyday features | `isFindInteractionEnabled` (find), `WKDownload` (downloads), reader view (keep Readability), print, zoom, and the system share sheet. | M |
| 7.5 | Per-site connection mode | Shield menu: Relay, Direct or Tor for this site, remembered. Offer Direct when a site shows a robot check or asks for the camera or microphone. That keeps privacy the default without leaving people stuck. | M |
| 7.6 | Fewer robot checks in Relay | Check whether Private Access Tokens (Cloudflare, Fastly) work through `WKWebView` and the relay. Let an operator run relays in several regions, so not everyone shares one address. | M |
| 7.7 | Speed budget | Measure cold start, time to first paint on the top 50 sites and memory with 20 tabs, against Safari on the same phone. Fail the build at 20% slower. | M |

## Phase 8: privacy to 5

| # | Item | How | Size |
|---|---|---|---|
| 8.1 | Relay mode reuses the server | A local SOCKS5 listener in the app (Network.framework) carries each connection over the existing wisp WebSocket. `WKWebsiteDataStore.proxyConfigurations` (iOS 17) points each data store at it. TLS runs end to end from WebKit, so the server sees only host names, as today, and needs no change. | L |
| 8.2 | Tor on the phone | `Tor.framework`'s SOCKS port as the Tor data stores' proxy. Tor tabs no longer pass through the server, which closes "the server sees Tor tabs' sites". Arti, once it ships for iOS, replaces it. | L |
| 8.3 | Close WebKit's proxy leaks | mysk (2026-08-04) found that `dns-prefetch` hints, WebAuthn related-origin requests (iOS 18+) and WebTransport (iOS 26.4+) go around `proxyConfigurations`. In Relay and Tor: strip `dns-prefetch` with a content rule, deny WebTransport (CSP `connect-src` through a content rule, or the user script), and turn WebAuthn off unless the site is allowed. This is Psylo's fix. WebRTC is off in those modes (user script, plus Lockdown in Tor). | M |
| 8.4 | Leak tests for the native app | Port `e2e/leak-catcher.js`: the test phone's only route out is the catcher, and every mode must leave it empty. One case per leak in 8.3, plus WebRTC, preconnect and the system's own requests. | M |
| 8.5 | Look like everyone else | Tor tabs: letterboxing to common sizes, one language and UTC, as Tor Browser does. Relay: the same fixed values as Safer today. | M |
| 8.6 | The operator can't see sites (optional) | Relay with two hops, as iCloud Private Relay does: the first hop sees the address but not the site, the second sees the site but not the address. It needs a second operator. Until then, the README says plainly what Relay's operator sees. | L |

## Phase 9: security to 5

| # | Item | How | Size |
|---|---|---|---|
| 9.1 | Lockdown per site | `WKWebpagePreferences.isLockdownModeEnabled` (iOS 16) for Safest, for any site the person picks, and for Tor tabs. It's the engine's own hardening (no JIT, no WebGL, fewer fonts and media formats), not page script. | S |
| 9.2 | Desktop signed and current | Code-sign the installer and updates (README's "Code signing"). Ship within a week of each Electron security release, with Dependabot plus a CI check that fails when Electron is two majors behind its latest (done 2026-11-16: `ci.yml`). Signing still needs the certificate. | M |
| 9.3 | ECH | Check whether `WKWebView` on iOS 26 sends Encrypted Client Hello to sites that publish it (Cloudflare's `/cdn-cgi/trace`, `sni=encrypted`). If not, record it as Apple's gap. Safari has the same one. | S |
| 9.4 | Outside review | An independent audit of the app, relay and sync, plus a public security policy (`SECURITY.md`, done 2026-11-16: reports through GitHub's private vulnerability reporting, which must be switched on in the repo's settings). Five in security from a small project needs someone else to have looked. | L |
| 9.5 | Reproducible builds | CI builds the iOS app and the desktop installer from a tag, and publishes the hashes, so a release can be checked against the source. | M |

## Not planned

| Item | Why |
|---|---|
| A browser engine of Badger's own (BrowserEngineKit) | EU only, and years of work. Every iOS browser shares WebKit's security outside the EU. |
| Turning the PWA into the 5/5 product | The limits above are the proxy's. The PWA keeps working, at today's scores. |

## Decisions needed

1. **Default connection mode** for the native app: **Relay** (decided 2026-11-16). Sites don't see the phone's address, as today, and Direct is offered where Relay breaks.
2. **Minimum iOS version:** **26** (decided 2026-11-16), for post-quantum TLS and today's WebKit fixes.
3. **Apple Developer account and entitlement requests** (`web-browser`, `public-key-credential`): the account costs $99 a year, and Apple decides on the entitlements.
4. **App name and listing:** App Store review looks at how proxy and Tor apps are described.

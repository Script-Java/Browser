# Gaps against other browsers

What Badger lacks next to mainstream browsers (Safari, Chrome) and the privacy-first ones (Tor Browser, Brave, DuckDuckGo). Ticked items are fixed, each with a test in `app/e2e/` (or a unit test in `app/src/`). What's left at the bottom can't be fixed while Badger is a proxy, or isn't worth it.

## Closed on 2026-10-09

Measured against Brave, DuckDuckGo, Safari and Tor Browser; built from their open-source parts where they had one (`THIRD-PARTY.md`).

### Security

- [x] **Embedded frames shared the page's space.** A frame from another site inside a page now runs on an origin of its own (`f…`, or `g…` in a Tor tab), one per pair of sites (the page's site and the frame's), so the browser itself keeps the two apart, as it would without the proxy: the frame can't read the page's text, cookies, storage or address, or change it. Messages between the two still work (`page.js`, `standInWindow`): each side learns the other's real origin, and a message meant for another origin never arrives. The frame's own site's cookies stay partitioned under every site that embeds it. (`isolation.spec.js`)
- [x] **The framing rule was page script.** A frame's own origin knows which site's page it's in, so its service worker now holds a site's `X-Frame-Options` and `frame-ancestors` itself, even for a frame whose scripts the page switched off. Every origin's pages also say who may frame them: a tab's site only the app and itself, so no other site can frame a signed-in site to trick taps.
- [x] **Revoked certificates were accepted.** The server opens a TLS connection of its own to the site, reads its certificate and checks it against its authority's revocation list (CRL), signature checked, the way Chrome's CRLSets and Firefox's CRLite cover what device TLS doesn't. `revoked.badssl.com` gets a warning with no way past it. Big lists (Cloudflare's is 42 MB) are searched in place and refreshed in the background. (`certs.js`, `security.spec.js`)
- [x] **No certificate viewer.** "Certificate" in the shield menu: who it belongs to, the names it covers, who issued it, when it's valid, the chain, the fingerprint, and whether it was revoked.
- [x] **Phishing and malware lists refreshed daily.** They're asked again every half hour (`THREAT_REFRESH_MINUTES`), and cost nothing when unchanged. With `WEB_RISK_API_KEY`, every page's site is also checked against Google Web Risk (Safe Browsing's commercial form), privately: the server keeps hash prefixes and only asks Google about the rare match. (`webrisk.js`)
- [x] **No passkeys.** The app is the passkey's authenticator, as a password manager's is: it makes the key for the site whose verified address the tab shows, keeps it in the passphrase vault, and signs only after the person says yes. A real WebAuthn verifier accepts them (`logins.spec.js`); another site can't ask for one.
- [x] **No password manager.** Passwords used to sign in are offered to keep, filled only when the person taps the key in the address bar, and only on the site they belong to. Stored encrypted: with the passphrase, or with a key the browser keeps and won't hand out.
- [x] **A page that got around the proxy's hooks and hid its referrer looked like the site's own visitor.** With isolation, only the app's own navigations (typed, bookmarks, back, reload) count as the person's: the app announces them to the site's worker first. Anything else without a referrer is another site's request, so Strict cookies stay home. (`sites.spec.js`)
- [x] **A tab opened by a page counted as typed.** It now arrives as the opening page's request, with its site as the referrer.
- [x] **A form posted to a site not opened before lost its fields.** The page waits for that site's worker before it posts.

### Privacy

- [x] **One hop, one exit address.** Tor tabs, as in Brave: their sites' connections leave through Tor from the server, a separate circuit per site, so sites see a Tor exit instead of the server. Onion sites open in them. A Tor tab keeps no history, isn't brought back, and its sites' data goes with the last one. The server still sees which sites a Tor tab opens: it hands the connections to Tor. (`tor.js`)
- [x] **No .onion sites.** In Tor tabs; an onion address in an ordinary tab offers one.
- [x] **No fingerprint protection at Standard.** Now on everywhere but sites with blocking switched off, as in Brave: noise in what a canvas or a sound reads back, a common processor count and memory, one language, a battery that's always full, the same storage allowance for everyone, and WebGL's generic names for the graphics card. Safer adds English, UTC, a screen the page's size and no WebGL. All of it reaches workers too, blob: ones included. (`fingerprint.js`, `fingerprint.spec.js`)
- [x] **No bounce-tracking protection.** Brave's debounce rules: an affiliate or mail-click link goes straight to where it leads, and AMP pages to the publisher's own.
- [x] **No CNAME uncloaking.** Brave's list of cloaked first-party trackers, and a live check: the server says what a site's own subdomain is an alias of, and the worker checks that against the lists (`f7ds.liberation.fr` → Eulerian).
- [x] **Cookie banners were only hidden.** "Answer cookie notices" (on): DuckDuckGo's autoconsent says no to tracking where the notice offers that, and hides the rest.
- [x] **Tracking parameters came from one list.** Brave's query filter too, including its per-site rules.
- [x] **Hiding rules that match by link or image address didn't apply.** They now look at the address the page wrote.

### Everyday features

- [x] Find in page counts the matches ("3 of 12") and marks them all
- [x] Zoom (per site), reader view (Readability, cleaned by DOMPurify, shown by the app), printing, translation (Google's page translator, which fetches the page itself)
- [x] Sync of bookmarks, history, passwords and passkeys between devices, with a one-time code; end-to-end encrypted, and the server keeps nothing
- [x] Camera, microphone and location, after the app's own prompt; location can be approximate, and answers can be kept per site
- [x] A download list: files go to the app (and to the share sheet from there) instead of a sheet that leaves the app; encrypted with the passphrase lock
- [x] Sites on ports 8080, 8443, 8000 and 8888 (`EXTRA_PORTS`)

## Checked on 2026-10-04 (emulated iPhone, local server with site isolation)

- [x] **The address bar went stale on pages that aren't HTML.** Fixed: the site's anchor frame reports those tabs' addresses.
- [x] **A refused certificate showed no error.** Fixed: a warning says what is wrong with the certificate, with no way past it; an unreachable site offers to try again.
- [x] **Sites were told every request was their own.** Fixed, and carried across the app's in-between pages and redirects.
- [x] **Every request to another site carried the page's whole address.** Fixed: other sites get the origin only, and nothing when the page says so.
- [x] **SameSite cookies went with every request.** Fixed: Strict cookies stay home on another site's request, Lax ones go only when a link takes the tab there.
- [x] **A posted form had no `Origin`.** Fixed.
- [x] **Sites' framing rules were dropped.** Fixed (and now in the worker too, above).
- [x] **No Global Privacy Control header, and no `Accept-Language`.** Fixed: `Sec-GPC: 1`, and one language for everyone.
- [x] **Tracking parameters were not stripped.** Fixed.
- [x] **The security levels didn't hold against what the browser had kept.** Fixed: pages always ask, and the no-scripts and no-fonts rules are in the page's policy.
- [x] **The anchor frame's address report could be forged.** Fixed: the app checks with the tab's own frame.
- [x] **Third-party cookies are partitioned.** On par with Safari, Brave and Tor.

## What's left, and why

- **Sites' own script rules (`Content-Security-Policy: script-src`) aren't enforced.** The proxy rewrites every script and address, so a site's policy no longer matches what the browser sees. Only the framing rules carry over cleanly.
- **The app's prompt for location, camera and microphone is page script.** For the app to ask and then pass the person's yes on, pages' `Permissions-Policy` allows the three (it used to refuse them outright). `page.js` hooks them in every window it reaches; a page that finds a same-origin frame the hooks miss gets the browser's own, which only asks if the browser hasn't already given the app that permission. The same limit as WebRTC's, below.
- **WebRTC is removed by page script.** No browser has a rule that switches it off for a page; the desktop app also cuts its UDP inside Chromium.
- **Site logins on the device aren't encrypted by the app.** They live in each site's own storage, out of the app's reach; iOS encrypts it at rest while the phone is locked, and wipe-on-launch clears it. The app's own data (history, bookmarks, tabs, passwords, passkeys, downloads) is encrypted with the passphrase lock.
- **No signed releases of the web app.** The server delivers the app's code on every launch, so whoever runs it is trusted completely. Fixing that needs browser support for verified web apps (Chrome's Isolated Web Apps, the WAICT proposal), or a native app.
- **The server sees which sites people open** (Tor tabs included), so it can check them against the lists and hand the connections on. It keeps no record of them.
- **Fingerprinting by installed fonts and by CSS** (media queries about the screen) is out of page script's reach. Tor Browser does it in the browser itself.
- **Robot checks.** Every user shares the server's address, so sites challenge more, Google search most of all; Tor tabs more still. A fix would mean many exit addresses.
- **DRM video** (Netflix and similar): frames may use it (`encrypted-media`), but it's untested, and the desktop app's Electron has no Widevine.
- **Video calls** don't work: they need WebRTC, which pages don't get.
- **Translation sends the page's address to Google**, whose translator fetches the page itself (without the person's cookies). On-device translation (Firefox's Bergamot) would keep it private, at tens of megabytes per language pair.

# Security and privacy plan

What to build, in order, to close the gaps in `SECURITY-GAPS.md`. Sizes are estimates: S is under a day, M is one to three days, L is a week or more.

## Rules for every item

1. Write the test first and watch it fail (`app/e2e/`, both the `chromium` and `iphone` projects).
2. Make the change. Nothing in this plan may loosen site isolation, the tab sandbox, the network lock or the block lists.
3. Run the whole suite alone (two runs at once fail each other), then the Snyk scan.
4. Commit, push `scramjet` and `main`, deploy from the commit, and compare the live files with it.
5. Tick the item in `SECURITY-GAPS.md`.
6. Anything that touches the keyboard, background suspension or video gets a check on a real iPhone; emulation can't cover those.

## Phase 0: before starting

| # | Item | Size |
|---|---|---|
| 0.1 | Commit `SECURITY-GAPS.md` and this file. | S |
| 0.2 | Sign Snyk in again (`snyk auth`) and scan the embedded-player ad fix (`8addebc`), which shipped unscanned. | S |
| 0.3 | On a real iPhone: two-word search, 15 minutes in the background then a search, donkey.to playback. These are still unconfirmed. | S |

## Phase 1: things the app already promises

These are bugs against what the README says today, so they come first.

| # | Item | Where | How | Test | Size |
|---|---|---|---|---|---|
| 1.1 | Address bar stays right on pages that aren't HTML | `app/src/sw/shield.js`, `app/public/anchor.html`, `app/public/index.js` | The page script reports the address, and a JSON, image or PDF page has no page script. The service worker sees every page load, so it reports those itself, through the anchor frame that already carries its messages to the app. Open question: how the app matches the report to a tab (the previous address is the likely key). If that proves unreliable, the fallback is to blank the bar the moment a tab's page stops reporting, so it never names the wrong site. | A link from one site to a JSON address on another: the bar names the second site. | M |
| 1.2 | A refused certificate says so | `app/src/sw/shield.js` | Find why the request hangs instead of failing (the reconnect-and-retry path is the suspect). Answer with a warning page naming the reason. No "continue anyway": the TLS library can't skip the check, and shouldn't. | `expired.badssl.com` shows the warning within a few seconds. | S |
| 1.3 | Sites' framing rules are enforced | `app/src/sw/shield.js` (response hook) | Scramjet deletes `X-Frame-Options` and `Content-Security-Policy` from every response. Before it does, read `X-Frame-Options` and `frame-ancestors`; when a page is loading into a frame of a site those rules exclude, answer with a blank page. First confirm the hook sees the headers before Scramjet strips them. | A `DENY` page inside a frame shows nothing; the same page as a tab loads. | M |
| 1.4 | Sites are told the truth about cross-site requests | `app/src/sw/shield.js` (request hook) | Every request arrives as `Sec-Fetch-Site: same-origin`. Work it out from the real page and the real target (`same-origin`, `same-site`, `cross-site`, or `none` for a typed address) and overwrite Scramjet's value. | A cross-site frame's request carries `cross-site`; a same-site one carries `same-site`. | S to M |

## Phase 2: small privacy wins

All in the service worker, which already sees every request.

| # | Item | How | Test | Size |
|---|---|---|---|---|
| 2.1 | Strip tracking parameters | On page loads, drop a fixed list (`fbclid`, `gclid`, `msclkid`, `utm_*`, `mc_eid`, `igshid` and the rest of Brave's list) and redirect to the clean address. The per-site switch turns it off with the rest of the blocking. | `?fbclid=x&keep=1` arrives as `?keep=1`. | S |
| 2.2 | Global Privacy Control | Add `Sec-GPC: 1` to every request and `navigator.globalPrivacyControl = true` in the page script. | The echo site shows the header; a page reads the property. | S |
| 2.3 | Cookie banners | Add the EasyList Cookie and uBlock annoyance lists behind a new setting, off by default. Every site keeps its own copy of the engine, so measure memory on a phone before turning it on for everyone. | A page with a listed banner loads without it. | S, plus the measurement |
| 2.4 | `Accept-Language` | Nothing is sent today, which is private but unusual, and some sites pick a language badly without it. Decision needed: leave it, or send one fixed value for everybody (`en-US,en;q=0.9`), as Tor does. Never the device's own list. | The echo site shows the chosen value. | S |

## Phase 3: larger features

| # | Item | How | Size |
|---|---|---|---|
| 3.1 | Fingerprint protection at Safer | The page script runs first in every frame. Fix the timezone to UTC, the language to one value, CPU and memory readings to common ones, and add per-site noise to canvas and audio readouts. Script against script, like the WebRTC removal, so the README must say so. Kept off Standard because it breaks some sites. | M to L |
| 3.2 | Per-site script switch | Safest's no-scripts policy, applied to one site from the shield menu, stored with the other per-site exceptions. | M |
| 3.3 | "Keep me signed in here" | A per-site flag that wipe-on-launch and "Clear now" skip. New identity still clears everything. Each site already has its own address, so the wipe can pick. | M |
| 3.4 | What was blocked on this page | The service worker already counts blocks; keep the hosts per page and list them in the shield menu. | S to M |
| 3.5 | Hostile-frame test | Tests in which an embedded third-party frame tries to read its parent's page, cookies and storage. This measures the deepest gap; what it finds decides whether anything can be done about it. | M |
| 3.6 | Find in page | The one everyday feature in this plan, because its absence is felt daily. The app can't reach into an isolated tab, so the page script does the search on the app's request. | M |

## Phase 4: closing the gaps against Brave and DuckDuckGo (done 2026-10-09)

Each item has its test in `app/e2e/` or `app/src/*.test.js`; `SECURITY-GAPS.md` says what each closed. Built from the open-source projects in `THIRD-PARTY.md` where one fit.

| # | Item | Where | Size |
|---|---|---|---|
| 4.1 | Frames of other sites on origins of their own (f…, g…), messages between page and frame with real origins, framing rules held by the frame's worker, `frame-ancestors` on every origin | `shield.js` (inFrame), `page.js` (standInWindow), `sitekey.js` (frameKey), `index.js` | L |
| 4.2 | Revocation (CRLs, checked by the server) and a certificate viewer | `certs.js`, `shield.js`, shell | M |
| 4.3 | Tor tabs and onion sites | `tor.js`, `sitekey.js` (torKey), `register-sw.js`, shell, Docker image | L |
| 4.4 | Passkeys (the app as authenticator) and a password manager | `logins.js`, shell | L |
| 4.5 | Fingerprinting protection at Standard, and in workers | `fingerprint.js`, `worker.js`, `shield.js` | M |
| 4.6 | Cookie notices answered (autoconsent), bounce tracking (Brave's debounce), Brave's query filter, CNAME uncloaking (list and live), address-based hiding rules | `consent.js`, `privacyrules.js`, `cname.js`, `filters.js`, `shield.js` | M |
| 4.7 | Threat lists every half hour; Google Web Risk, optional and private | `filters.js`, `webrisk.js` | M |
| 4.8 | Only the app's navigations count as the person's; opened tabs as the opener's; forms to new sites keep their fields | `shield.js`, `anchor.html`, shell | M |
| 4.9 | Downloads, reader view, zoom, print, translate, find with counts, location/camera/microphone after the app's prompt, sync with a code, more web ports | shell, `page.js`, `shield.js`, `sync.js`, `wisp.js` | L |

## Not planned

| Item | Why |
|---|---|
| Full enforcement of sites' Content-Security-Policy | The proxy rewrites every script and address, so a site's policy no longer matches what the browser sees. Only the framing rules carry over cleanly. |
| Hiding which sites people open from the server | The server hands every connection on, Tor tabs' included. Only Tor running on the device (Arti, compiled for the web) would hide it, and it isn't ready for that. |
| Security keys (USB, NFC) and passkeys from other devices | The app can't reach a device's security keys or its platform passkeys on a site's behalf: they're bound to the site's real address, and every site here lives on the proxy's. Passkeys the app keeps itself work. |
| Signed web-app releases | Needs browser support for verified web apps (Isolated Web Apps, WAICT) or a native app. |
| Encrypting sites' own storage | It's each site's, out of the app's reach; iOS encrypts it while the phone is locked. |

## Decisions needed

Phase 4 picked these defaults; each is one line to change.

1. **Answer cookie notices**: on by default, as in DuckDuckGo (`settings.js`, `consent`).
2. **Fingerprinting protection at Standard**: on for every site but those with blocking off, as in Brave. It changes a few answers sites read (one language in the list, 4 processors, a full battery).
3. **Extra web ports**: 8080, 8443, 8000 and 8888 are open by default (`EXTRA_PORTS`).
4. **Tor tabs**: on wherever the server can run Tor (the Docker image installs it); `TOR=off` to opt out.
5. **Passkeys need the passphrase lock**: so their keys are always encrypted with something only the person knows.
6. **Google Web Risk**: off unless a key is bought and set (`WEB_RISK_API_KEY`).

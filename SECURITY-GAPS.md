# Gaps against other browsers

What Badger lacks next to mainstream browsers (Safari, Chrome) and the privacy-first ones (Tor Browser, Brave, DuckDuckGo). "Unchecked" means nobody has tested how Badger behaves yet; the first job is to find out.

## Checked on 2026-10-04, and again on 2026-10-07 (emulated iPhone and Chromium, local server with site isolation)

Ticked items are fixed, each with a test in `app/e2e/`. The 2026-10-07 round closed the embedded-frame gap, the three open items from the first check, revoked certificates, the certificate viewer, fingerprinting (now also screen, fonts and workers), bounce tracking, CNAME uncloaking, faster threat lists, more web ports, and the everyday features (zoom, reader view, translation, printing, downloads, and camera/microphone/location by permission).

- [x] **The address bar went stale on pages that aren't HTML.** After a link to a JSON file on another site, the bar still named the site before. Fixed: the site's anchor frame reports those tabs' addresses.
- [x] **A refused certificate showed no error.** The tab stayed blank and loading. Fixed: a warning says what is wrong with the certificate, with no way past it; an unreachable site offers to try again.
- [x] **Sites were told every request was their own.** Links, forms and frames arrived as `Sec-Fetch-Site: same-origin`. Fixed, and carried across the app's in-between pages and redirects.
- [x] **Every request to another site carried the page's whole address.** The earlier note here ("no referrer is sent") was wrong: it only looked at links and frames. Scripts, images and fetches sent the full address as `Referer`, even from pages that asked for none. Fixed: other sites get the origin only, and nothing when the page says so.
- [x] **SameSite cookies went with every request,** so a site's protection against forged cross-site requests was lost. Fixed: Strict cookies stay home on another site's request, Lax ones go only when a link takes the tab there. A cookie that doesn't say is sent everywhere, as in Safari.
- [x] **A posted form had no `Origin`,** which some sites need to accept their own forms. Fixed.
- [x] **Sites' framing rules were dropped** (`X-Frame-Options`, `frame-ancestors`). Fixed in the page script: a page that forbids framing stays out of other pages' frames.
- [x] **No Global Privacy Control header, and no `Accept-Language` at all.** Fixed: `Sec-GPC: 1`, and one language for everyone.
- [x] **Tracking parameters were not stripped.** Fixed: an address typed or pasted, or a link from another site, loses `fbclid`, `gclid`, `utm_*` and the like; a site's own links keep theirs.
- [x] **The security levels didn't hold against what the browser had kept.** Safari showed a page its site marked as keepable again as it was, without asking the service worker: after a switch to Safest and a reload, the page still ran its scripts. In both browsers a script or web font kept from an earlier visit was never asked for, so refusing it did nothing. Fixed: pages always ask, and the no-scripts and no-fonts rules are in the page's policy, which the browser enforces itself.
- [x] **The anchor frame's address report could be forged** (introduced with the address-bar fix above, and fixed two deploys later): a page that got around the proxy's hooks could name another site's tab. The app now checks with the tab's own frame.
- [x] **Third-party cookies are partitioned** (already the case). A site embedded in another site's page sees none of the cookies it has as a tab. On par with Safari, Brave and Tor.
- [ ] **Sites' script rules are not enforced.** A page sent with `Content-Security-Policy: script-src 'none'` still runs its inline script: the proxy rewrites every script and address, so a site's policy no longer matches what the browser sees. Not planned.
- [x] **Revoked certificates were accepted.** `revoked.badssl.com` loaded. Fixed: the server opens a connection of its own to the site, reads the certificate, and looks its serial up in the issuer's revocation list (its CRL), with the list's signature checked against the issuer's key. A revoked one is refused like any other bad certificate, with no way past. The app's own TLS (epoxy, on the device) still can't check this itself, and a site whose issuer keeps no CRL can't be checked (Chrome itself only does this in part).
- [x] **A form posted to a site not opened before lost its fields** (in Safari; Chrome posts again when it reloads). That site's origin had no service worker yet, the server answered with the page that installs one, and its reload was a plain GET. Fixed: the in-between page has the app start that site's origin first.
- [x] **A page that got around the proxy's hooks and hid its referrer looked like the person.** It could send its tab straight to another site's origin, where nothing said another site sent it: Strict and Lax cookies went along, on a POST too, and the site was told `Sec-Fetch-Site: none`. Fixed: a page navigation with no referrer counts as another site's unless someone who can tell vouched for it: the app, for what it loads itself (an address typed, a bookmark, reload, back, through the site's anchor frame), or the site's own page, for its own links, forms and address changes when it hides its referrer.
- [x] **The framing rule was page script.** With site isolation, the service worker holds a frame from another site to the site's rule, where no page script runs: a frame with scripts switched off (sandbox) is refused too, and Safari serves a sandboxed frame nothing of the proxy's at all. Still page script for a frame of the page's own site (another of its subdomains, say), and without isolation.
- [x] **A tab opened by a page counted as typed.** Fixed before this list was checked again (the app loads such a tab through the service worker's "cross"); now with tests: the site is told `Sec-Fetch-Site: cross-site` and keeps its Strict cookies.
- [x] **Logins didn't survive the service worker being stopped** (found on the way). Scramjet 1.1.0 saved only the cookies a page's script set, and never read any back: whenever the browser stopped the worker (Chrome does after half a minute without requests), every site's cookies were gone, and the next one a site set was saved over the rest. Fixed in `shield.js`, with a cookie's `Max-Age` counted too (signing out with `Max-Age=0` left the cookie in place).

## Security

- [x] **Embedded frames shared the page's space.** A frame from another site read the text, cookies, storage and address of the page around it with ordinary script, and could change the page. Fixed with site isolation: every frame from another site gets an origin of its own, one for each pair of page and framed site, so the browser keeps the two apart as it does outside the proxy (`app/e2e/frames.spec.js`). Messages, links and forms aimed at the whole tab, the site's rule against framing and "stay signed in" still work across the wall. Each framed site costs one more service worker, block list and proxy connection.
- [ ] **WebRTC is removed by script only.** A page built to get around it may find a way (the desktop app also blocks it in Chromium). Checked: the standard's own rule (CSP `webrtc 'block'`) is known to neither Safari nor Chrome yet, and Chrome still gathered the device's public address with it. Closed one way around the page script: a document it can't go into (SVG, XML) ran scripts of its own, and now runs none.
- [x] **Phishing and malware lists refreshed daily.** Now checked every 15 minutes, fetched again only when changed, with URLhaus's own host file (rebuilt every five minutes) and Phishing Army (every few hours) besides malware-filter's (twice a day). Safe Browsing-style services still update phishing faster; they need an account and see the addresses checked.
- [ ] **No passkeys or security keys.** They are denied, so sites fall back to passwords and SMS codes.
- [ ] **Site logins on the device aren't encrypted.** Wipe-on-launch is the only cover. No password manager.
- [x] **No certificate viewer.** The shield menu now shows the site's certificate as the server sees it: who it was issued to and by, the names it covers, its dates, its fingerprint and serial, and whether its issuer has revoked it. (The app's own TLS, on the device, checks the one it gets; this is a second look from the server.)
- [ ] **No signed releases of the web app.** The server delivers the code on every launch; whoever runs it is trusted completely.
- [x] **Scripts were all-or-nothing.** Now also a switch per site in the shield menu ("Scripts on this site").

## Privacy

- [ ] **One hop, one exit address.** The server sees the person's IP address and every site name; every site sees the same server address for all tabs. Tor uses three hops and a different exit per site.
- [x] **No fingerprint protection.** At Safer: one language, UTC, a common processor count, noise in canvas, sound and WebGL readouts that changes from page to page, no named graphics chip, the screen reported as the window, and all text in the system font so the installed fonts can't be measured apart. In a worker too (its own copy of the script runs first). At Standard, while blocking is on for the site, the readout noise and the unnamed graphics chip come along (as in Brave's default), and `queryLocalFonts` is always refused. A frame of another site, on its own origin, gets its own copy of all of it.
- [x] **No bounce-tracking protection.** Now a link through a tracker's address goes straight to the real one: Brave's list, plus the big sites' link wrappers (Facebook, Google, YouTube, Reddit and others). Not done: Chrome-style deletion of the storage of sites that only ever appear as such hops.
- [x] **No CNAME uncloaking.** Now the server looks up the subdomains of a page's own site that the page loads from, and a request the lists would block under the tracker's name is blocked under the site's too. AdGuard's list of the trackers behind such names is with the block lists.
- [x] **Cookie banners weren't handled.** Now a setting, off by default: "Hide cookie notices" loads EasyList Cookie and uBlock's cookie-notice list (1.5 MB more in every site's service worker, next to 7.1 MB for the ad lists). It hides notices; it doesn't answer them, as DuckDuckGo and Brave do.
- [x] **No "keep me signed in here".** Now a switch per site ("Stay signed in to this site"), with site isolation: that site's cookies and storage survive clearing. New identity still clears everything.
- [x] **No per-site report.** The shield menu now lists the hosts blocked on the page.
- [ ] **No .onion sites.**

## Everyday features

- [x] Find in page, with a count ("2 of 7"), every match marked, across elements and in any case
- [x] Zoom (kept per site), reader view (Mozilla's Readability), translation (through Google Translate's page proxy), and printing
- [ ] Sync of bookmarks, history and tabs between devices
- [x] Camera, microphone and location: the app asks the person first, naming the site; the location it reads and hands over, and the camera and microphone the browser then asks for too. Video calls still can't work (no WebRTC). The desktop app asks with its own dialog.
- [x] Download list: files sites send to save are listed in the menu (iOS still asks before saving each file; the list is kept on the device, with the history)
- [x] Sites on ports other than 80 and 443: the common web ports now (8080, 8443, 3000 and the like); mail, SSH and database ports stay shut
- [ ] DRM video (Netflix and similar): expected not to work, untested
- [ ] Robot checks: every user shares the server's address, so sites challenge more; Google search most of all. Not fixable in the app: Startpage (Google's results without Google's check) refused the shared address outright when tried.

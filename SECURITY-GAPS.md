# Gaps against other browsers

What Badger lacks next to mainstream browsers (Safari, Chrome) and the privacy-first ones (Tor Browser, Brave, DuckDuckGo). "Unchecked" means nobody has tested how Badger behaves yet; the first job is to find out.

## Checked on 2026-10-04 (emulated iPhone, local server with site isolation)

Ticked items are fixed, each with a test in `app/e2e/`.

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
- [ ] **Revoked certificates are accepted.** `revoked.badssl.com` loads. Expired, wrong-host, self-signed and untrusted-root certificates are refused.
- [ ] **A form posted to a site not opened before loses its fields.** That site's origin has no service worker yet, the server answers with the page that installs one, and the reload is a plain GET.
- [ ] **A page that gets around the proxy's hooks and hides its referrer looks like the site's own visitor.** It can send a tab straight to another site's origin, where nothing says another site sent it: SameSite cookies go along and the site is told `Sec-Fetch-Site: none`. A posted form still says `Origin: null`.
- [ ] **The framing rule is page script.** A framing page that switches scripts off in its frame (sandbox) still gets the page shown, without the person's sign-in: embedded sites keep separate cookies.
- [ ] **A tab opened by a page counts as typed.** `window.open` and `target=_blank` become a new tab the app loads itself, so the site is told `Sec-Fetch-Site: none` and gets its Strict cookies.

## Security

- [ ] **Embedded frames share the page's space.** Measured (`app/e2e/isolation.spec.js`, the test marked as a known gap): a frame from another site reads the text, cookies, storage and address of the page around it with ordinary script, and can change the page. A browser refuses all of it. It can't reach the app, other sites' tabs, or its own site's cookies from elsewhere. Closing it means either giving every embedded frame an origin of its own (a redesign of site isolation, and one more service worker, block list and proxy connection per embedded site), or a same-origin policy rebuilt in page script, which code written against this proxy could still get around.
- [ ] **WebRTC is removed by script only.** A page built to get around it may find a way (the desktop app also blocks it in Chromium).
- [ ] **Phishing and malware lists refresh daily.** Safe Browsing-style services update within minutes.
- [ ] **No passkeys or security keys.** They are denied, so sites fall back to passwords and SMS codes.
- [ ] **Site logins on the device aren't encrypted.** Wipe-on-launch is the only cover. No password manager.
- [ ] **No certificate viewer.** The lock icon can't show who a certificate belongs to.
- [ ] **No signed releases of the web app.** The server delivers the code on every launch; whoever runs it is trusted completely.
- [x] **Scripts were all-or-nothing.** Now also a switch per site in the shield menu ("Scripts on this site").

## Privacy

- [ ] **One hop, one exit address.** The server sees the person's IP address and every site name; every site sees the same server address for all tabs. Tor uses three hops and a different exit per site.
- [x] **No fingerprint protection.** Now at Safer: one language, UTC, a common processor count, and noise in canvas and sound readouts that changes from page to page. Still none at Standard, and at Safer the screen's size, the installed fonts and anything read inside a worker are left (page script can't reach those).
- [ ] **No bounce-tracking protection.** Brave and DuckDuckGo skip redirect hops that exist only to track.
- [ ] **No CNAME uncloaking.** Trackers hidden behind a site's own subdomain pass the lists; Brave and Firefox with uBlock resolve the name first. The server does the DNS here, so it could.
- [x] **Cookie banners weren't handled.** Now a setting, off by default: "Hide cookie notices" loads EasyList Cookie and uBlock's cookie-notice list (1.5 MB more in every site's service worker, next to 7.1 MB for the ad lists). It hides notices; it doesn't answer them, as DuckDuckGo and Brave do.
- [x] **No "keep me signed in here".** Now a switch per site ("Stay signed in to this site"), with site isolation: that site's cookies and storage survive clearing. New identity still clears everything.
- [x] **No per-site report.** The shield menu now lists the hosts blocked on the page.
- [ ] **No .onion sites.**

## Everyday features

- [x] Find in page (no count of matches)
- [ ] Zoom, reader mode, translation, printing (print is silenced)
- [ ] Sync of bookmarks, history and tabs between devices
- [ ] Camera, microphone and location (always denied: no video calls or maps)
- [ ] Download list (iOS asks before saving each file)
- [ ] Sites on ports other than 80 and 443
- [ ] DRM video (Netflix and similar): expected not to work, untested
- [ ] Robot checks: every user shares the server's address, so sites challenge more; Google search most of all

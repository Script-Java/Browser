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
- [x] **Third-party cookies are partitioned** (already the case). A site embedded in another site's page sees none of the cookies it has as a tab. On par with Safari, Brave and Tor.
- [ ] **Sites' script rules are not enforced.** A page sent with `Content-Security-Policy: script-src 'none'` still runs its inline script: the proxy rewrites every script and address, so a site's policy no longer matches what the browser sees. Not planned.
- [ ] **Revoked certificates are accepted.** `revoked.badssl.com` loads. Expired, wrong-host, self-signed and untrusted-root certificates are refused.
- [ ] **A form posted to a site not opened before loses its fields.** That site's origin has no service worker yet, the server answers with the page that installs one, and the reload is a plain GET.
- [ ] **A page that gets around the proxy's hooks and hides its referrer looks like the site's own visitor.** It can send a tab straight to another site's origin, where nothing says another site sent it: SameSite cookies go along and the site is told `Sec-Fetch-Site: none`. A posted form still says `Origin: null`.
- [ ] **The framing rule is page script.** A framing page that switches scripts off in its frame (sandbox) still gets the page shown, without the person's sign-in: embedded sites keep separate cookies.
- [ ] **A tab opened by a page counts as typed.** `window.open` and `target=_blank` become a new tab the app loads itself, so the site is told `Sec-Fetch-Site: none` and gets its Strict cookies.

## Security

- [ ] **Embedded frames share the page's space.** A third-party frame is kept from its parent only by Scramjet's script hooks, not by the browser. Try reading the parent from a hostile frame. Deepest gap, hardest to close.
- [ ] **WebRTC is removed by script only.** A page built to get around it may find a way (the desktop app also blocks it in Chromium).
- [ ] **Phishing and malware lists refresh daily.** Safe Browsing-style services update within minutes.
- [ ] **No passkeys or security keys.** They are denied, so sites fall back to passwords and SMS codes.
- [ ] **Site logins on the device aren't encrypted.** Wipe-on-launch is the only cover. No password manager.
- [ ] **No certificate viewer.** The lock icon can't show who a certificate belongs to.
- [ ] **No signed releases of the web app.** The server delivers the code on every launch; whoever runs it is trusted completely.
- [ ] **Scripts are all-or-nothing.** Safest blocks every site's scripts; there is no per-site script switch (Tor's NoScript, Brave's Shields).

## Privacy

- [ ] **One hop, one exit address.** The server sees the person's IP address and every site name; every site sees the same server address for all tabs. Tor uses three hops and a different exit per site.
- [ ] **No fingerprint protection at Standard.** Tor makes every user look the same (fixed window sizes, UTC, one language, one font set); Brave randomises canvas, audio and hardware readings per site. Badger only drops web fonts, WebGL and WebGPU at Safer.
- [ ] **No bounce-tracking protection.** Brave and DuckDuckGo skip redirect hops that exist only to track.
- [ ] **No CNAME uncloaking.** Trackers hidden behind a site's own subdomain pass the lists; Brave and Firefox with uBlock resolve the name first. The server does the DNS here, so it could.
- [ ] **Cookie banners aren't handled.** DuckDuckGo and Brave reject or hide them. The cookie-notice and annoyance lists aren't loaded.
- [ ] **No "keep me signed in here".** Wiping is all sites or none; DuckDuckGo's fireproofing and Brave's per-site forgetting pick.
- [ ] **No per-site report.** Only a weekly blocked count; no list of what was blocked on this page.
- [ ] **No .onion sites.**

## Everyday features

- [ ] Find in page
- [ ] Zoom, reader mode, translation, printing (print is silenced)
- [ ] Sync of bookmarks, history and tabs between devices
- [ ] Camera, microphone and location (always denied: no video calls or maps)
- [ ] Download list (iOS asks before saving each file)
- [ ] Sites on ports other than 80 and 443
- [ ] DRM video (Netflix and similar): expected not to work, untested
- [ ] Robot checks: every user shares the server's address, so sites challenge more; Google search most of all

# Gaps against other browsers

What Badger lacks next to mainstream browsers (Safari, Chrome) and the privacy-first ones (Tor Browser, Brave, DuckDuckGo). "Unchecked" means nobody has tested how Badger behaves yet; the first job is to find out.

## Checked on 2026-10-04 (emulated iPhone, local server with site isolation)

- [ ] **Sites' security headers are not enforced.** A page sent with `Content-Security-Policy: script-src 'none'` still ran its inline script. Pages sent with `X-Frame-Options: DENY` or `frame-ancestors 'none'` still showed inside a frame. A site's own defence against injected scripts and clickjacking is lost through the proxy.
- [ ] **Sites are told every request is same-origin.** A cross-site link click and a cross-site frame both reached the site with `Sec-Fetch-Site: same-origin`. Sites that use that header to refuse cross-site requests (a defence against forged requests) are misled.
- [ ] **Revoked certificates are accepted.** `revoked.badssl.com` loaded. Expired, wrong-host, self-signed and untrusted-root certificates are refused.
- [ ] **A refused certificate shows no error.** The tab stays blank with the loading bar running (45 seconds and counting) instead of saying why.
- [ ] **The address bar goes stale on pages that aren't HTML.** After a link from one site to a JSON address on another, the tab showed the second site's content while the bar still named the first, 15 seconds later. The tab did move to the second site's own walled-off address; only the bar is wrong. Expect the same for images, text and PDFs.
- [ ] **Tracking parameters are not stripped.** `fbclid`, `gclid` and `utm_source` all reached the site.
- [ ] **No Global Privacy Control header** reaches sites (and no `Accept-Language` at all, which is good for privacy but unusual enough to stand out).
- [x] **Third-party cookies are partitioned.** A site embedded in another site's page saw none of the cookies it has as a tab, and a cookie it set while embedded didn't show up in its own tab. On par with Safari, Brave and Tor.
- [x] **No referrer is sent to other sites.** Neither a cross-site frame nor a cross-site link click carried a `Referer` header. Stricter than Brave and DuckDuckGo, which send the origin.

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

# browser-ios

[Scramjet](https://github.com/MercuryWorkshop/scramjet) packaged as an iOS home-screen app (PWA) where nothing pops out of the app.

```
app/           server (express + wisp-js) and the PWA shell; Scramjet comes from npm
desktop/       Windows app (Electron) that opens your server in its own window
```

## Deploy to Railway (one command)

From this folder, run:

```sh
./railway.sh
```

The first run opens your browser to sign in to Railway, then creates the project, builds it from the `Dockerfile`, deploys it, and prints a public `https://….up.railway.app` address. Railway handles HTTPS and WebSockets itself.

On the iPhone, open that address in **Safari**, tap Share → **Add to Home Screen**, and open the app from its home screen icon.

To push changes later, run `./railway.sh` again. It deploys to the same project and keeps the same address, so the installed home screen app keeps working.

Useful commands (run from this folder):

```sh
npx @railway/cli logs       # app logs
npx @railway/cli open       # open the project in the Railway dashboard
```

## Access: public or private

The app runs in one of two modes. Either way there are no accounts and no database.

**Public (default):** anyone can use it. On first open, the phone solves a small puzzle automatically (about a second, no captcha), which keeps casual bots and scanners out. That pass lasts 30 days. A public deploy won't start without these, because strangers will sign in to sites through it:

```sh
npx @railway/cli variable set "AUTH_SECRET=$(openssl rand -hex 32)"
npx @railway/cli variable set "CONTACT_EMAIL=you@example.com"   # shown on /terms for abuse and takedown reports
npx @railway/cli variable set "ISOLATION_DOMAIN=browse.example.com"   # see "Site isolation" below
./railway.sh
```

The first `./railway.sh` deploy stops with a message listing what's missing; set it and run `./railway.sh` again.

**Private:** set `APP_PASSWORD` as well, and the app opens on a password screen instead. Isolation and a contact address are then optional. A sign-in lasts 180 days on that device. The home screen app keeps its own sign-in, separate from Safari's, so sign in from the home screen app. **Lock** in the shield menu signs out. Changing the password signs every device out. After 8 wrong tries from one address, sign-in is blocked for 15 minutes.

The terms and privacy notice is at `/terms` and linked from the start page and the shield menu. It's a plain-language starting point, not legal advice; have it reviewed before you rely on it.

## Limits

So neither one user nor everyone together can run up the bandwidth bill:

- The proxy only connects to web ports over TCP: 80 and 443, and the ones sites commonly run on besides (8080, 8443, 8000, 3000, 8888, control panels' and home servers': `WEB_PORTS` in `app/src/wisp.js`). Mail, SSH, database and other ports and UDP are refused, so the server can't be used for spam, logging in to other people's servers or port scans. A site on a port not on the list won't load.
- Each address may hold 16 proxy connections open, with up to 128 site connections in each.
- Each address may move 2 GB a day through the server (`DAILY_GB_PER_CLIENT`). After that, new connections and videos are refused until the day resets.
- The whole server moves at most 50 GB a day (`DAILY_GB_TOTAL`). At 80% the logs say `bandwidth: 80% of DAILY_GB_TOTAL used today`; at 100% everyone is refused until the day resets. Set Railway to alert you on those log lines, and set a spending limit in Railway's billing settings as a backstop.

Limits are per IP address (IPv6: per /64), so people behind one home router share them.

The address comes from the first entry of `X-Forwarded-For`, which Railway's edge sets. Check once after deploying that a client can't fake it, by getting your own address locked out of sign-in and then trying again under a made-up one:

```sh
APP=https://your-app.up.railway.app
for i in $(seq 9); do curl -s -o /dev/null -w "%{redirect_url}\n" -d "password=x" "$APP/login"; done
curl -s -o /dev/null -w "%{redirect_url}\n" -d "password=x" -H "X-Forwarded-For: 203.0.113.9" "$APP/login"
```

The 9th line says "Too many attempts". If the last one says it too, the header can't be faked. If it says "Wrong password" (or "Check failed" on a public deploy), anyone can dodge the limits by sending a different address each time, and `clientKey` in `app/src/limits.js` must use the last entry instead. The lockout ends after 15 minutes.

## Privacy: what the server sees and keeps

The server has no database and keeps no accounts, history or site data. The only thing it saves to disk is the downloaded block lists.

- **Logins and cookies stay on the phone.** Sites' cookies, logins and storage live in the app's own browser storage on each device, not on the server. They stay until the person clears them (shield menu → **Clear history and site data now**, or the "clear when the app opens" switch).
- **History and bookmarks stay on the phone too.** They're kept in the app's own storage on the device and never sent to the server. Star a page in the address bar to bookmark it; bookmarks show in the bookmarks bar and as shortcuts on the new tab page, and **History** is in the ⋯ menu. The new tab's "trackers blocked this week" count is kept on the device too. Clearing site data also clears history but keeps bookmarks. With site isolation, sites can't read either, because they run on other addresses.
- **HTTPS is encrypted on the phone.** The encryption (TLS) runs inside the app on the phone, and the server only relays encrypted bytes. It can't read passwords, cookies or pages of `https://` sites.
- **What the server does learn:** the name of each site opened (for example `example.com`), so it can check it against the malware and phishing lists, and the names of the site's own subdomains a page loads from, which it looks up to find trackers hidden behind them (CNAME uncloaking, below). They're used for those checks and not logged. Videos that iOS plays with its own player are fetched by the server itself, so for those the server sees the video's address, and the host's request logs (Railway's HTTP logs) record it.
- **Cookies the app sets:** a pass from the bot check (30 days) or the password sign-in, and the person's settings. Neither identifies anyone. The settings cookie belongs to the app's own address only (`__Host-`), so a site on its walled-off subdomain can't plant a copy with protections switched off.
- **Logs** contain errors, startup messages and bandwidth warnings, never the sites people visit.
- **Trust:** the server delivers the app's code, so the people using it are trusting whoever runs the server, like any website.

A public deploy requires site isolation (below). Without it, every site shares one space in the browser, and a malicious site could read the logins other sites stored there.

## Search

The address bar searches with Brave Search by default. Each person can switch to DuckDuckGo, Bing or Google in the shield menu. Google shows a "prove you're not a robot" page for searches made through the proxy, even from a home connection, so it isn't the default.

## Site isolation (needs your own domain; required when public)

By default every site runs in one shared space, the app's own address. A malicious site could reach into what other sites stored there, including their logins. Site isolation gives every site its own address (`<code>.browse.example.com`), and the browser walls those addresses off from each other and from the app.

It needs a domain you own, because Railway's free `*.up.railway.app` address can't have sub-addresses:

1. In the Railway dashboard (`npx @railway/cli open`), open the service, go to **Settings → Networking → Custom Domain**, and add both `browse.example.com` and `*.browse.example.com` (use your own domain). A whole domain works too (`example.com` and `*.example.com`), if your registrar can point the bare domain at Railway (an ALIAS, ANAME or flattened CNAME record). Any other name under it, like `www`, only redirects to the app.
2. Add the DNS records Railway shows you at your domain registrar. The wildcard needs its `_acme-challenge` record too, so Railway can issue its certificate.
3. Set the domain and redeploy:

   ```sh
   npx @railway/cli variable set "ISOLATION_DOMAIN=browse.example.com"
   ./railway.sh
   ```

4. On the iPhone, open `https://browse.example.com` in Safari and add it to the home screen again. The old icon keeps working, but without isolation.

The shield menu says whether isolation is on.

## Desktop app (Windows)

`desktop/` is an installable Windows app that opens your Badger server (the Railway deploy) in its own window. It works like the phone app: sites see the server's address, not the computer's, and it gets around network filters the same way. Blocking, warnings, isolation, tabs and sign-in all come from the server.

Before building, put the server's address in `SERVER_URL` at the top of `desktop/main.js`. Use the `ISOLATION_DOMAIN` address if the deploy has one (for example `https://browse.example.com`); the `*.up.railway.app` address runs without site isolation.

```sh
pnpm -C desktop install      # once: Electron and the installer builder
pnpm desktop                 # run it from source
pnpm desktop:dist            # build desktop/dist/Badger-Setup.exe
```

Running `Badger-Setup.exe` installs Badger for the current user, with a Start menu and desktop shortcut. Uninstall it from Windows Settings like any other app. It signs in like the phone app: with the password, or the automatic check on a public server. The desktop app keeps its own sign-in, separate from any browser's.

How it's locked down:

- **Everything goes through the server:** the window may only contact your server and its per-site subdomains. A page that slips past the proxy still can't reach the internet directly, open a window, or hand a link to the system browser.
- **Permissions are asked about, or refused:** camera, microphone and location bring up a dialog of the app's own (the server-side app's prompt named the site first); notifications and the rest are turned down. Full screen, copying to the clipboard and pointer lock are allowed.
- **No WebRTC around the lock:** its UDP is turned off inside Chromium, and anything that isn't the server is sent to a proxy that doesn't exist, so its TCP connections fail too. It can't show sites the computer's real address.
- **Electron hardened:**
  - Fuses: Node mode, `NODE_OPTIONS` and the inspector are off, and the app only loads from its own (integrity-checked) package.
  - Cookies are encrypted on disk.
  - Sites see a plain Chrome user agent.

If the server can't be reached, the app says so and offers to try again.

### Updates

Badger ships its own Chromium, so browser security fixes only reach people through updates. The installed app checks this repo's GitHub Releases at launch and every 6 hours, downloads a newer version in the background and installs it when the app quits. Dependabot opens a pull request the day a new Electron comes out.

To publish a release:

1. Raise `version` in `desktop/package.json`, since the updater only installs higher versions.
2. Create a GitHub token that can write releases to this repo.
3. Run `GH_TOKEN=<token> pnpm -C desktop release`. It builds the installer and uploads it, with the `latest.yml` the updater reads, to a draft release.
4. Publish that draft on GitHub.

### Code signing

The installer isn't signed yet, so Windows SmartScreen warns on first run (More info → Run anyway). Signing also lets the updater check that an update came from you. Once you have a code-signing certificate (from a certificate authority, or Azure Trusted Signing), set these before `dist` or `release` and electron-builder signs the app, the installer and every update:

```sh
CSC_LINK=path/to/certificate.pfx     # or a base64 string of it
CSC_KEY_PASSWORD=...
```

From the first signed release on, the updater refuses updates that aren't signed by the same publisher.

## Run locally

```sh
pnpm run setup   # install the app
pnpm start       # http://localhost:8787  (PORT=... to change)
pnpm -C app test # unit tests (CI also runs lint, audit and a Docker build)
```

The iPhone needs HTTPS for the proxy's service worker, so a local `http://` address only works on this computer.

To try site isolation locally, run `ISOLATION_DOMAIN=app.localhost pnpm start` and open `http://app.localhost:8787` in Chrome. Chrome sends every `*.localhost` name to this computer.

### Security tests

```sh
pnpm -C app exec playwright install chromium webkit   # once
pnpm -C app e2e                                       # a few minutes; needs the internet
```

`app/e2e/` checks in a real browser, through the real proxy, what Badger promises: nothing a page loads goes around the proxy, pages get no WebRTC, no popups or dialogs or hand-offs to other apps without a tap in the page, HTTPS-Only, the Standard, Safer and Safest levels, ad blocking, New identity, the browser check and site isolation, and the server's headers and access rules. It starts two servers itself (ports 8811 and 8812, one in production-like isolation mode), and runs everything twice: in Chromium, and in Safari's engine at an iPhone's size, which is what the home-screen app runs on.

The browser under test sends everything except the app's own addresses to a small fake proxy (`e2e/leak-catcher.js`) that records whatever reaches it, so a request that escapes Badger's proxy fails the test that caused it. Test pages are served by httpbin.org, so pages can be tried over both http and https. CI runs the suite on every push to `main` and every pull request, and keeps the report and traces when it fails.

| Variable | What it does |
| --- | --- |
| `AUTH_SECRET` | Secret (32+ random characters) that signs every cookie. Required in production (`NODE_ENV=production`, which the Docker image sets). |
| `APP_PASSWORD` | Makes the instance private, behind a password screen. Without it the app is public. |
| `ISOLATION_DOMAIN` | Turns on site isolation (see above). Required in production when public. |
| `CONTACT_EMAIL` | Abuse and takedown contact shown on `/terms`. Required in production when public. |
| `DAILY_GB_PER_CLIENT` | Daily traffic allowance per address (default 2, `0` for no limit). |
| `DAILY_GB_TOTAL` | Daily traffic cap for the whole server (default 50, `0` for no limit). |
| `FILTER_REFRESH_HOURS` | How often block lists are re-downloaded (default 24). |
| `THREAT_REFRESH_MINUTES` | How often the malware and phishing lists are checked for changes (default 15). |
| `PHISHING_HOSTS` | Hosts to warn about as phishing besides the lists, comma-separated (a scam going round your users today). |
| `FILTER_CACHE_DIR` | Where downloaded lists are kept between restarts (default: the system temp folder). |

## Protection

Tap the shield or lock icon at the left of the address bar to see what's on and change it.

| Feature | How it works |
| --- | --- |
| Ad and tracker blocking | The server downloads EasyList, EasyPrivacy, Peter Lowe's list, uBlock Origin's lists and AdGuard's list of hidden trackers every day and builds a blocking engine ([Ghostery's adblocker](https://github.com/ghostery/adblocker)). The proxy's service worker loads it and drops requests to ad and tracking networks before they leave the phone. Known ad scripts are swapped for harmless stand-ins so pages don't break. If you open an ad network's address directly, you get a "Page blocked" screen with an **Open anyway** button. |
| Hidden trackers (CNAME uncloaking) | A site's own subdomain can be another name for a tracker's server (`metrics.example.com` standing for `example.eulerian.net`), which the lists know only by the tracker's name. The server looks such names up in the DNS (the service worker can't), and a request the lists would block under the tracker's name is blocked under the site's too. Only the subdomains of the page's own site are looked up: that's where trackers hide. |
| Bounce tracking | A link that goes through a tracker's address on its way to the real one (an affiliate network, Facebook's or Google's link wrapper, an AMP page) goes straight to the real one, so the tracker never hears of the click. [Brave's list](https://github.com/brave/adblock-lists) of such addresses, plus the big sites' own wrappers. Off with **Block ads and trackers**, for one site too. |
| Hiding ad boxes and overlays | Every page gets the lists' hiding rules for that site, plus rules matched to the class names and ids actually on the page. This catches ads and scam overlays that the site serves itself. |
| Skipping video ads | uBlock Origin's site fixes (for example YouTube's) run in each page before the site's own scripts. As a backup, the app clicks "Skip ad" in YouTube, JW Player and video.js players, and mutes and fast-forwards ad videos that can't be skipped. |
| Malware and phishing warnings | The server keeps the [malware-filter](https://gitlab.com/malware-filter) phishing and URLhaus lists, [Phishing Army](https://phishing.army) and [URLhaus](https://urlhaus.abuse.ch)'s own host file, checks them for changes every 15 minutes (`THREAT_REFRESH_MINUTES`), and checks every page you open. URLhaus updates every five minutes, Phishing Army every few hours, malware-filter twice a day. Listed sites show a red warning first; **Continue anyway** opens the site. |
| Per-site switches | For the site in the active tab, in the shield menu. **Blocking on this site** turns blocking off for one site when it breaks. **Scripts on this site** turns that site's own scripts off (Safest's rule, for one site; with site isolation it covers everything in that site's tabs). **Stay signed in to this site** (with site isolation) keeps that site's cookies and storage when the rest is cleared; New identity still clears them. |
| What was blocked | The shield menu lists the hosts blocked on the page in the active tab, since the app opened. |
| Hide cookie notices | Off unless switched on. Two more lists (EasyList Cookie and uBlock Origin's cookie notices) hide consent banners. It hides them, it doesn't answer them, so a site that waits for an answer may not work; and every site's service worker carries the lists (1.5 MB next to the ad lists' 7 MB). |
| Tracking parameters | An address typed or pasted, or a link from another site, loses the parameters that only follow people between sites (`fbclid`, `gclid`, `utm_*` and the like). A site's own links keep theirs. Off with **Block ads and trackers**, for one site too. |
| What sites are told | Each request says where it really comes from (`Sec-Fetch-Site`, `Origin`), so sites can refuse forged ones, and their SameSite cookies stay home on another site's request. Another site learns the origin a request comes from, never the page's address, and nothing when the page asks for no referrer. With site isolation, a page sent to a site's origin with nothing to say where from counts as another site's, unless the app itself loaded it (an address typed, a bookmark, reload, back) or the site's own page said it was going there: so a page that gets around the proxy's hooks can't pass off a forged request as the person's own. Every request carries Global Privacy Control (`Sec-GPC: 1`) and one language for everyone (`en-US`), not the device's list. A page that forbids being framed (`X-Frame-Options`, `frame-ancestors`) stays out of other pages' frames. |
| HTTPS-Only | On by default. `http://` pages pass through the server unencrypted, so the app opens the `https://` version instead. When a site has none, a warning comes first; **Continue (not secure)** opens that site (and its subdomains) over http for the rest of the session. Images and scripts on a page are upgraded to https too. |
| Security level | Like Tor Browser's. **Standard**: every site works as usual; while blocking is on for a site, what it reads back from a canvas, a sound buffer or WebGL still carries a little page-by-page noise and the graphics chip goes unnamed, as in Brave's default. **Safer**: no web fonts, WebGL or WebGPU on any site (they fingerprint the device and are a common way into browser bugs), none of a page's own scripts on sites without https, and less to tell the device apart by: scripts (in the page and in its workers) get one language (English), the time in UTC, a common processor count, the screen reported as the window, and all text in the system font so the installed fonts can't be measured apart. Some sites look or work worse, and all show times in UTC. **Safest**: everything in Safer, and no site's own scripts at all, including ones in `data:` and `blob:` addresses (a Content-Security-Policy on every page lets only the proxy's and the app's scripts run); many sites stop working. |
| New identity | Settings → **New identity** (or the address bar command), like Tor Browser's: after a confirmation, every tab closes, every site's cookies, storage and logins and the history are deleted, the warnings you clicked through are forgotten, and the app restarts. Settings and bookmarks stay. |
| No WebRTC | WebRTC talks to servers over UDP straight from the device, around the proxy, and would show sites the device's real IP address. The app's page script takes WebRTC away from every page and every frame a page makes, and a document the page script can't go into (an SVG or XML file) runs none of its own scripts. That is script against script, not a browser rule: the standard has one (CSP `webrtc 'block'`), but neither Safari nor Chrome knows it yet (checked; Chrome still gathered the device's address with it), so a page built to get around the page script may find a way. The desktop app also cuts WebRTC's UDP off inside Chromium. Video calls in the browser don't work through the proxy anyway. |
| Network lock | Every proxied page and worker carries a Content-Security-Policy that only lets it talk to the app's own address, which is the proxy. A page that gets around the proxy's hooks (a fresh frame has the browser's own `fetch` and `WebSocket`) still can't reach a site directly. |
| Strict policy on the app's own pages | The app's pages run only their own scripts (a Content-Security-Policy with hashes of the few inline ones), may only be framed by the app, and are HTTPS-only for six months once visited over HTTPS (HSTS). |
| Clear site data on launch | On by default, so a lost or shared device doesn't keep the last session's logins (turn it off in Settings to stay signed in). Each fresh launch deletes every site's cookies, storage and logins, the history and the open tabs (bookmarks are kept). A phone rarely closes a home-screen app, so coming back after 15 minutes away counts as a fresh launch too. **Clear history and site data now** does it on demand. |
| Passphrase lock | Optional (Settings → **Lock history and bookmarks with a passphrase**). History, bookmarks and open tabs are stored on the device encrypted (AES-GCM, with a key made from the passphrase by PBKDF2-SHA256 at 600,000 rounds). The key is only ever in memory, so the passphrase is asked each time the app opens. A phone keeps the app alive in the background, so coming back after five minutes away asks again too. A forgotten passphrase can't be recovered: **Erase and start over** deletes them along with every site's logins. Site logins themselves aren't encrypted; clearing on launch covers them. |
| Password | See above. It also guards the proxy connection itself, not only the page. |
| Site isolation | See above. |
| Trustworthy address bar | The bar shows the site's real domain, never a page's own claim. Look-alike letters from other alphabets show up as `xn--…` instead of passing for a real domain. With site isolation on, the app checks every address against the walled-off address the browser gave that page, so a page can't make the bar show another site. Without isolation, a malicious page can reach into the app and change the bar. |
| Certificate viewer | The shield menu shows the site's certificate as the server sees it: who it was issued to and by, the names it covers, its dates, its fingerprint and serial, and whether its issuer has revoked it. The app's own TLS (epoxy, on the device) checks the certificate it gets; this is a second look, from the server's own connection to the site (`app/src/certs.js`). |
| Revoked certificates | The TLS library inside the app checks a certificate's dates, name and signatures, but not revocation. So the server reads the site's certificate on a connection of its own and looks its serial up in the issuer's revocation list (its CRL), with the list's signature checked against the issuer's key. A revoked certificate gets the same warning as any other bad one, with no way past. A site whose issuer publishes no CRL can't be checked (Chrome itself only does this in part). |
| Camera, microphone and location | A site that asks gets the app's own prompt first, naming the site; the answer is kept for the site until data is cleared. The location the app reads and hands over, so the site's proxied address gets no browser permission of its own; the camera and microphone the page then asks the browser for, so its prompt follows. Only the tab's own page may ask. WebRTC stays gone, so video calls don't work. |

Limits:

- The security levels hold for what the browser kept from before a switch: pages always ask the service worker again, and the no-scripts and no-fonts rules are part of the page's policy, which the browser enforces itself.
- Safer's protection against telling devices apart is page script, like the WebRTC block, so a page built to reach around it may. It now covers a page's workers too (each gets its own copy of the script first), the screen (reported as the window) and the installed fonts (all text in the system font, so they can't be measured apart). Tor Browser does all of this in the browser itself.
- With site isolation, a site's rule against framing holds in the service worker for a frame from another site, where the page script can't be switched off: a frame without scripts (sandbox) is refused too, and Safari serves a sandboxed frame nothing at all. For a frame of the page's own site, and without isolation, the rule is page script: a framing page that switches scripts off in its frame still gets the page shown, without the person's sign-in (embedded sites keep separate cookies).
- No blocker catches everything. Sites change their ads to get around block lists, which is why the lists are refreshed daily. If an ad gets through, it's usually fixed in a list update within a day or two.
- Rules that hide elements by their link or image address don't apply, because the proxy rewrites those addresses.
- With isolation on, a frame from another site embedded *inside* a page (an ad, a video player) gets an origin of its own, one for each pair of page and framed site. The browser keeps it out of the page around it, as it would outside the proxy, and its cookies are kept apart under every site that embeds it, the way Safari partitions embedded frames. Messages between the two, and links and forms aimed at the whole tab, still get across.
- With isolation on, each site you visit costs a little more at first, and so does each site framed inside a page: its own service worker, its own proxy connection and its own copy of the block list in memory.
- The proxy refuses to connect to private, loopback and link-local addresses, so pages can't reach the server's own network. Sites that only exist on a private network can't be opened through it.

## What "no popups" covers

Most of this lives in `app/src/client/page.js` (`noPopups`). It runs inside every proxied page and frame. Frames a page writes itself (`about:blank`, `srcdoc`) get it the moment the page reaches into them, before anything is written inside.

| Would normally… | Now |
| --- | --- |
| `target="_blank"` / unknown named target links open a Safari sheet | open in a new Badger tab next to the page (Ctrl/⌘-click or middle click: in the background) |
| `_top` links and forms replace the app | stay in the page's tab |
| `window.open(url)` opens a new window | opens a new Badger tab after a click or tap; calls without one (pop-ups, pop-unders) are dropped |
| `mailto:`, `tel:`, `sms:`, `maps:`, app-store links hand off to another app | blocked |
| `alert` / `print` | silenced |
| `confirm` / `prompt` | the real in-app dialog right after a click or tap; without one they answer "no" (`false` / `null`), so pages can't loop dialogs or get anything agreed to unseen |
| location, camera/mic, notifications, motion sensors, share sheet, passkeys, Apple Pay, clipboard paste, storage-access prompts | denied without showing a prompt |
| long-press link/image previews | disabled |
| a proxied page escaping to the top level | gets wrapped back into the shell |
| a page reaching around all of the above through a frame of its own, for the browser's own `window.open`, dialogs and links | refused there too: such a frame gets no windows, no dialogs, and links only to the proxy. On phones and tablets the browser enforces it as well: tabs are sandboxed frames without permission to open windows or replace the app |

The shell's only outbound link is the desktop app's installer, offered on the new tab page to Windows browsers (it downloads from this repo's GitHub Releases, directly rather than through the proxy). It draws its own browser chrome, because standalone mode has none:

- **Tabs**: open, close (× or middle click), switch (click or arrow keys). Open tabs come back when the app reopens; background ones load when you switch to them. On a phone there's no tab strip: back, forward, new tab, the tab list and the menu sit in a bar at the bottom.
- **Address bar**: suggestions from bookmarks and history as you type, and commands (New tab, Close tab, History, Downloads, Settings, Bookmark this page, Split view, Reload page, Find in page, Reader view, Translate page, Print, Zoom in/out, Actual size, Clear history and site data). Arrow keys and Enter pick one; plain Enter always searches or opens what you typed. Ctrl/⌘+K or +L jumps to it.
- **Back and forward**: with one tab open they use the page's own history, so it comes back where it was scrolled. With more, the shell keeps each tab's history and reloads the address, because tab frames share one session history and the page's own "back" could move a different tab.
- **Bookmarks**: the star in the address bar, the bookmarks bar, and shortcuts on the new tab page.
- **Split view** (wide screens): two tabs side by side; click a pane to make it the active tab, or pick a tab from the strip to put it in the focused pane.
- **⋯ menu**: settings, history, downloads, the page tools below, and clearing data.
- **Find in page**: a bar under the address bar (a phone's home-screen app has no find of its own). The page does the looking (page.js): it marks every match, selects and scrolls to the current one, and counts them ("2 of 7"). A match may run across elements and ignores case; frames inside the page aren't searched.
- **Zoom**: in the menu (−/+) or with Ctrl/⌘ and +, − or 0, kept per site on the device. The page zooms itself (CSS zoom); the app's own chrome stays put.
- **Reader view**: the article alone, in a plain layout (Mozilla's Readability, Firefox's reader). The page builds it, so it works on an isolated site too.
- **Translate**: opens the page through Google Translate's own page proxy (`example-com.translate.goog`), in the device's language. Google fetches and translates the page, so it sees the page's address and words; it's reached only this way, by the person's choice.
- **Print**: the menu opens the system print sheet for the page (a page's own Print button works too, after a tap; without one, printing is silent, as before).
- **Downloads**: files a site sends to save are listed in the menu. The browser saves the file as always (iOS asks where); the list is kept on the device, with the history, and clears with it.
- **Camera, microphone and location**: a site asking gets the app's own prompt first, naming the site from its verified address; the answer is kept per site. The location the app reads and hands over (the site's address in the proxy never gets a browser permission); the camera and microphone the page then asks the browser for, so its prompt follows too. Only the tab's own page may ask, never a frame inside it, and video calls still can't work (no WebRTC).

Not covered: the iOS keyboard and its autofill bar. In a desktop browser (not the desktop app), a page that was clicked can still send the whole browser tab to another address; phones and the desktop app refuse that.

## How it sits on Scramjet

Scramjet is used unmodified from npm. Everything app-specific is around it:

- `app/public/scramjet-sw.js`: the service worker (scope `/scramjet/`). `shield.js` checks each request before Scramjet fetches it, and after Scramjet rewrites an HTML page it adds `/bios/page.js`, the page's hiding rules and its scriptlets.
- `app/src/sw/shield.js`: the worker's blocker. It asks the server for fresh settings on every page load, so a switch in the shield menu applies to the next page. It also stores Scramjet's config itself (Scramjet normally expects a page to post it) with source maps off (with them on, YouTube's scripts froze the tab), clears Scramjet's in-memory cookies on "Clear all site data", and when the connection to the server has died (a deploy, a network change) asks an open page to reconnect and retries the request once. And it keeps the sites' cookies: Scramjet 1.1.0 saved only the ones a page's script set, and never read any back, so every time the browser stopped the worker (Chrome does after half a minute without requests) the person was signed out. A cookie's `Max-Age` counts too (`sw/cookies.js`).
- `app/src/client/page.js`: runs in every proxied page after Scramjet has hooked it: the no-popup layer, generic ad hiding, video-ad skipping, and reporting the address to the shell. It isn't rewritten by Scramjet, so it reads the site's address from Scramjet's client. Scramjet lets `mailto:` through unproxied, so this drops those navigations.
- `app/src/codec.js`: proxied URLs are `/scramjet/<encodeURIComponent(url)>` (Scramjet's default codec); the server's media fallback and the service worker decode them the same way.
- `app/public/register-sw.js`: registers the worker, waits for it to activate (`serviceWorker.ready` never settles because the shell is outside the worker's scope), removes the old Ultraviolet worker, and answers the worker's reconnect requests.
- `app/src/index.js`: serves Scramjet's files at `/scram/`, sends `Cache-Control: no-cache` because iOS PWAs cache aggressively, and has a recovery page that re-registers the service worker when iOS evicts it. It also runs the password gate (`auth.js`), the block lists (`filters.js`), the bounce and CNAME lookups, the certificate viewer (`certs.js`), the signed settings cookie, and the site-isolation host rules. At startup it bundles `shield.js`, `page.js`, `worker.js`, `reader.js` and `sitekey.js` with esbuild.
- `app/src/certs.js`: the server reads a site's certificate on a connection of its own and looks its serial up in the issuer's revocation list, for the certificate viewer and the revoked-certificate warning (the TLS inside the app can't do either).
- `app/src/client/unique.js`: the device-answers used by both the page script and `worker.js`, so a page's workers give the same answers as the page (Safer, and the readout noise at Standard).
- `app/src/client/reader.js`: reader view (Mozilla's Readability), loaded into a page when the menu asks.
- `app/src/media.js`: iOS plays video with its own media engine, which skips the service worker and asks the server for the proxied URL directly. The server fetches the video itself and rewrites HLS playlists so every segment in them is proxied too.
- `app/src/wisp.js`: the wisp server (wisp-js) only connects to ports 80 and 443 over TCP, and refuses private, loopback and link-local addresses. wisp-js has its own check, but it misses IPv6 private addresses (`fc00::/7`) and IPv4-mapped ones, so ours runs in front of it.

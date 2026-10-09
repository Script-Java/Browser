# browser-ios

[Scramjet](https://github.com/MercuryWorkshop/scramjet) packaged as an iOS home-screen app (PWA) where nothing pops out of the app.

```
app/           server (express + wisp-js) and the PWA shell; Scramjet comes from npm
desktop/       Windows app (Electron) that opens your server in its own window
```

How it measures up against Brave, DuckDuckGo, Safari and Tor Browser, and what's left: `SECURITY-GAPS.md`. The open-source projects it's built from, and their licenses: `THIRD-PARTY.md`.

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

- The proxy only connects to the web's ports over TCP: 80 and 443, and the ones web servers commonly use besides (8080, 8443, 8000 and 8888; `EXTRA_PORTS` replaces those, or `none`). Mail ports, other ports and UDP are refused, so the server can't be used for spam or port scans.
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
- **What the server does learn:** the name of each site opened (for example `example.com`), so it can check it against the malware and phishing lists. It's used for that check and not logged. Videos that iOS plays with its own player are fetched by the server itself, so for those the server sees the video's address, and the host's request logs (Railway's HTTP logs) record it. For the same sites, the server also looks up what a site's own subdomains are aliases of (to catch trackers hiding behind them) and opens a connection of its own to read the site's certificate and check it hasn't been revoked; for Tor tabs it does neither. With `WEB_RISK_API_KEY`, it checks sites against Google Web Risk the private way: Google only ever gets a short hash prefix, for the rare site that matches one.
- **Sync** passes two sealed boxes between a person's devices (bookmarks, history, passwords, passkeys), encrypted with the one-time code before they leave the device. The server keeps them in memory for at most ten minutes, or until the other device takes them, and can't read them.
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

A frame from another site inside a page (a video player, a widget, an ad that got through) gets an origin of its own too, one for each pair of sites, so the browser keeps it and the page apart as it would without the proxy: it can't read or change the page around it, and its site's cookies stay apart under every site that embeds it. The two still exchange messages, each learning the other's real address.

## Tor tabs

With site isolation, the ⋯ menu offers **New Tor tab**, as Brave's private window with Tor: its sites' connections leave the server through Tor, a separate circuit for each site, so sites see a Tor exit instead of the server, and onion (`.onion`) sites open. A Tor tab keeps no history, isn't brought back when the app opens, and its sites' cookies and storage go with the last Tor tab. The server still sees which sites a Tor tab opens, as it does for every tab: it hands the connections to Tor.

The Docker image installs Tor and the server starts it; `TOR=off` switches Tor tabs off, and elsewhere `TOR_BIN` names the program.

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
- **Permissions:** location, camera and microphone only after the app's own prompt, and only for the server's own addresses; notifications and the like are refused. Full screen, copying to the clipboard and pointer lock are allowed.
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
| `EXTRA_PORTS` | Ports besides 80 and 443 sites may be on (default `8080,8443,8000,8888`; `none` for none). |
| `THREAT_REFRESH_MINUTES` | How often the phishing and malware lists are asked again (default 30). |
| `WEB_RISK_API_KEY` | Also check sites against Google Web Risk, privately (hash prefixes). Optional, paid. |
| `TOR` | `off` switches Tor tabs off. |
| `TOR_BIN`, `TOR_DATA_DIR` | Where the Tor program is (default: `tor` on the path) and where it keeps its state. |
| `AUTH_SECRET` | Secret (32+ random characters) that signs every cookie. Required in production (`NODE_ENV=production`, which the Docker image sets). |
| `APP_PASSWORD` | Makes the instance private, behind a password screen. Without it the app is public. |
| `ISOLATION_DOMAIN` | Turns on site isolation (see above). Required in production when public. |
| `CONTACT_EMAIL` | Abuse and takedown contact shown on `/terms`. Required in production when public. |
| `DAILY_GB_PER_CLIENT` | Daily traffic allowance per address (default 2, `0` for no limit). |
| `DAILY_GB_TOTAL` | Daily traffic cap for the whole server (default 50, `0` for no limit). |
| `FILTER_REFRESH_HOURS` | How often block lists are re-downloaded (default 24). |
| `FILTER_CACHE_DIR` | Where downloaded lists are kept between restarts (default: the system temp folder). |

## Protection

Tap the shield or lock icon at the left of the address bar to see what's on and change it.

| Feature | How it works |
| --- | --- |
| Ad and tracker blocking | The server downloads EasyList, EasyPrivacy, Peter Lowe's list and uBlock Origin's lists every day and builds a blocking engine ([Ghostery's adblocker](https://github.com/ghostery/adblocker)). The proxy's service worker loads it and drops requests to ad and tracking networks before they leave the phone. Known ad scripts are swapped for harmless stand-ins so pages don't break. If you open an ad network's address directly, you get a "Page blocked" screen with an **Open anyway** button. |
| Hiding ad boxes and overlays | Every page gets the lists' hiding rules for that site, plus rules matched to the class names and ids actually on the page. This catches ads and scam overlays that the site serves itself. |
| Skipping video ads | uBlock Origin's site fixes (for example YouTube's) run in each page before the site's own scripts. As a backup, the app clicks "Skip ad" in YouTube, JW Player and video.js players, and mutes and fast-forwards ad videos that can't be skipped. |
| Malware and phishing warnings | The server keeps the [malware-filter](https://gitlab.com/malware-filter) phishing and URLhaus lists, updated daily, and checks every page you open. Listed sites show a red warning first; **Continue anyway** opens the site. |
| Per-site switches | For the site in the active tab, in the shield menu. **Blocking on this site** turns blocking off for one site when it breaks. **Scripts on this site** turns that site's own scripts off (Safest's rule, for one site; with site isolation it covers everything in that site's tabs). **Stay signed in to this site** (with site isolation) keeps that site's cookies and storage when the rest is cleared; New identity still clears them. |
| What was blocked | The shield menu lists the hosts blocked on the page in the active tab, since the app opened. |
| Hide cookie notices | Off unless switched on. Two more lists (EasyList Cookie and uBlock Origin's cookie notices) hide consent banners. It hides them, it doesn't answer them, so a site that waits for an answer may not work; and every site's service worker carries the lists (1.5 MB next to the ad lists' 7 MB). |
| Tracking parameters | An address typed or pasted, or a link from another site, loses the parameters that only follow people between sites (`fbclid`, `gclid`, `utm_*` and the like). A site's own links keep theirs. Off with **Block ads and trackers**, for one site too. |
| What sites are told | Each request says where it really comes from (`Sec-Fetch-Site`, `Origin`), so sites can refuse forged ones, and their SameSite cookies stay home on another site's request. Another site learns the origin a request comes from, never the page's address, and nothing when the page asks for no referrer. Every request carries Global Privacy Control (`Sec-GPC: 1`) and one language for everyone (`en-US`), not the device's list. A page that forbids being framed (`X-Frame-Options`, `frame-ancestors`) stays out of other pages' frames. |
| HTTPS-Only | On by default. `http://` pages pass through the server unencrypted, so the app opens the `https://` version instead. When a site has none, a warning comes first; **Continue (not secure)** opens that site (and its subdomains) over http for the rest of the session. Images and scripts on a page are upgraded to https too. |
| Security level | Like Tor Browser's. **Standard**: every site works as usual. **Safer**: no web fonts, WebGL or WebGPU on any site (they fingerprint the device and are a common way into browser bugs), none of a page's own scripts on sites without https, and less to tell the device apart by: scripts get one language (English), the time in UTC and a common processor count, and what they read back from a canvas or a sound buffer carries a little noise that changes from page to page. Some sites look or work worse, and all show times in UTC. **Safest**: everything in Safer, and no site's own scripts at all, including ones in `data:` and `blob:` addresses (a Content-Security-Policy on every page lets only the proxy's and the app's scripts run); many sites stop working. |
| New identity | Settings → **New identity** (or the address bar command), like Tor Browser's: after a confirmation, every tab closes, every site's cookies, storage and logins and the history are deleted, the warnings you clicked through are forgotten, and the app restarts. Settings and bookmarks stay. |
| No WebRTC | WebRTC talks to servers over UDP straight from the device, around the proxy, and would show sites the device's real IP address. The app's page script takes WebRTC away from every page and every frame a page makes. That is script against script, not a browser rule (browsers have none for WebRTC), so a page built to get around it may find a way; the desktop app also cuts WebRTC's UDP off inside Chromium. Video calls in the browser don't work through the proxy anyway. |
| Network lock | Every proxied page and worker carries a Content-Security-Policy that only lets it talk to the app's own address, which is the proxy. A page that gets around the proxy's hooks (a fresh frame has the browser's own `fetch` and `WebSocket`) still can't reach a site directly. |
| Strict policy on the app's own pages | The app's pages run only their own scripts (a Content-Security-Policy with hashes of the few inline ones), may only be framed by the app, and are HTTPS-only for six months once visited over HTTPS (HSTS). |
| Answer cookie notices | On unless switched off. DuckDuckGo's autoconsent says no to tracking where a notice offers that, and hides notices that offer no way to say no. The shield menu says when it answered one. |
| Bounce tracking and cloaked trackers | An affiliate or mail-click link goes straight to where it leads, without visiting the tracker (Brave's debounce rules; AMP pages go to the publisher's own). Trackers hiding behind a site's own subdomain are caught by Brave's list and by a live check of what the subdomain points to. |
| Fingerprinting protection | On everywhere but sites with blocking off, as in Brave: what a canvas or a sound reads back carries a little noise, and scripts get a common processor count and memory, one language, an always-full battery, the same storage allowance as everyone and WebGL's generic graphics-card names. Inside workers too. Safer adds more (above). |
| Revoked certificates | The server checks each site's certificate against its authority's revocation list; a revoked one gets a warning with no way past it. **Certificate** in the shield menu shows who a certificate belongs to. |
| Clear site data on launch | On by default, so a lost or shared device doesn't keep the last session's logins (turn it off in Settings to stay signed in). Each fresh launch deletes every site's cookies, storage and logins, the history and the open tabs (bookmarks are kept). A phone rarely closes a home-screen app, so coming back after 15 minutes away counts as a fresh launch too. **Clear history and site data now** does it on demand. |
| Passphrase lock | Optional (Settings → **Lock history and bookmarks with a passphrase**). History, bookmarks and open tabs are stored on the device encrypted (AES-GCM, with a key made from the passphrase by PBKDF2-SHA256 at 600,000 rounds). The key is only ever in memory, so the passphrase is asked each time the app opens. A phone keeps the app alive in the background, so coming back after five minutes away asks again too. A forgotten passphrase can't be recovered: **Erase and start over** deletes them along with every site's logins. Site logins themselves aren't encrypted; clearing on launch covers them. |
| Password | See above. It also guards the proxy connection itself, not only the page. |
| Site isolation | See above. |
| Trustworthy address bar | The bar shows the site's real domain, never a page's own claim. Look-alike letters from other alphabets show up as `xn--…` instead of passing for a real domain. With site isolation on, the app checks every address against the walled-off address the browser gave that page, so a page can't make the bar show another site. Without isolation, a malicious page can reach into the app and change the bar. |

Limits:

- The security levels hold for what the browser kept from before a switch: pages always ask the service worker again, and the no-scripts and no-fonts rules are part of the page's policy, which the browser enforces itself.
- The protection against telling devices apart is page script, like the WebRTC block (it reaches workers too): it leaves the installed fonts and what CSS media queries say about the screen readable. Tor Browser does that in the browser itself.
- No blocker catches everything. Sites change their ads to get around block lists, which is why the lists are refreshed daily. If an ad gets through, it's usually fixed in a list update within a day or two.
- With isolation on, each site you visit costs a little more at first: its own service worker, its own proxy connection and its own copy of the block list in memory. So does each site whose frames appear inside a page.
- The proxy refuses to connect to private, loopback and link-local addresses, so pages can't reach the server's own network. Sites that only exist on a private network can't be opened through it.

## Everyday features

- **Find in page** counts the matches and marks them all. **Zoom** (the − and + in the shield menu) is kept per site. **Print** prints the page.
- **Reader view** shows the page's article by itself: the page sends its markup, the app picks out the article (Mozilla's Readability), cleans it (DOMPurify) and shows it; the page fetches the pictures. Nothing from the site runs in the app.
- **Translate** opens the page in Google's page translator, through the proxy like any site. Google fetches the page itself, without the person's cookies, so it learns the page's address.
- **Downloads**: a file a site sends to be saved (or one a page makes, like an export) goes to the app's download list, with progress in the tab, instead of a sheet that leaves the app. From the list it goes to Files or another app through the share sheet. Kept on the device, encrypted with the passphrase lock.
- **Passwords**: a password used to sign in is offered to keep. The key in the address bar fills it in on that site, only when tapped (and can make up a strong one on a sign-up form). Kept encrypted: with the passphrase, or without it, with a key the browser keeps and won't hand out.
- **Passkeys**: when a site offers to make one, the app makes it and keeps it, encrypted with the passphrase (passkeys need the passphrase lock), and signs in with it after the person says yes. Each one belongs to the site whose address the app verified, so no other site can use it.
- **Location, camera and microphone**: a site asks, and the app asks the person with its own prompt (location can be approximate, within about a kilometre). Answers can be kept for the site, and taken back in the shield menu.
- **Sync with another device**: one device shows a code, the other types it in, and both end up with each other's bookmarks, history, passwords and passkeys.

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
| location, camera, microphone | the app's own prompt first (see Everyday features) |
| passkeys | the app's own (see Everyday features) |
| notifications, motion sensors, share sheet, Apple Pay, clipboard paste, storage-access prompts | denied without showing a prompt |
| long-press link/image previews | disabled |
| a proxied page escaping to the top level | gets wrapped back into the shell |
| a page reaching around all of the above through a frame of its own, for the browser's own `window.open`, dialogs and links | refused there too: such a frame gets no windows, no dialogs, and links only to the proxy. On phones and tablets the browser enforces it as well: tabs are sandboxed frames without permission to open windows or replace the app |

The shell's only outbound link is the desktop app's installer, offered on the new tab page to Windows browsers (it downloads from this repo's GitHub Releases, directly rather than through the proxy). It draws its own browser chrome, because standalone mode has none:

- **Tabs**: open, close (× or middle click), switch (click or arrow keys). Open tabs come back when the app reopens; background ones load when you switch to them. On a phone there's no tab strip: back, forward, new tab, the tab list and the menu sit in a bar at the bottom.
- **Address bar**: suggestions from bookmarks and history as you type, and commands (New tab, Close tab, History, Settings, Bookmark this page, Split view, Reload page, Find in page, Clear history and site data). Arrow keys and Enter pick one; plain Enter always searches or opens what you typed. Ctrl/⌘+K or +L jumps to it.
- **Back and forward**: with one tab open they use the page's own history, so it comes back where it was scrolled. With more, the shell keeps each tab's history and reloads the address, because tab frames share one session history and the page's own "back" could move a different tab.
- **Bookmarks**: the star in the address bar, the bookmarks bar, and shortcuts on the new tab page.
- **Split view** (wide screens): two tabs side by side; click a pane to make it the active tab, or pick a tab from the strip to put it in the focused pane.
- **⋯ menu**: settings, history, find in page, and clearing data.
- **Find in page**: a bar under the address bar (a phone's home-screen app has no find of its own). The page does the looking, with the browser's own text search, and marks the match. No count of matches, and frames inside the page aren't searched.

Not covered: the iOS keyboard and its autofill bar, and file downloads served as attachments (iOS asks before saving them). In a desktop browser (not the desktop app), a page that was clicked can still send the whole browser tab to another address; phones and the desktop app refuse that.

## How it sits on Scramjet

Scramjet is used unmodified from npm. Everything app-specific is around it:

- `app/public/scramjet-sw.js`: the service worker (scope `/scramjet/`). `shield.js` checks each request before Scramjet fetches it, and after Scramjet rewrites an HTML page it adds `/bios/page.js`, the page's hiding rules and its scriptlets.
- `app/src/sw/shield.js`: the worker's blocker. It asks the server for fresh settings on every page load, so a switch in the shield menu applies to the next page. It also stores Scramjet's config itself (Scramjet normally expects a page to post it) with source maps off (with them on, YouTube's scripts froze the tab), clears Scramjet's in-memory cookies on "Clear all site data", and when the connection to the server has died (a deploy, a network change) asks an open page to reconnect and retries the request once.
- `app/src/client/page.js`: runs in every proxied page after Scramjet has hooked it: the no-popup layer, generic ad hiding, video-ad skipping, and reporting the address to the shell. It isn't rewritten by Scramjet, so it reads the site's address from Scramjet's client. Scramjet lets `mailto:` through unproxied, so this drops those navigations.
- `app/src/codec.js`: proxied URLs are `/scramjet/<encodeURIComponent(url)>` (Scramjet's default codec); the server's media fallback and the service worker decode them the same way.
- `app/public/register-sw.js`: registers the worker, waits for it to activate (`serviceWorker.ready` never settles because the shell is outside the worker's scope), removes the old Ultraviolet worker, and answers the worker's reconnect requests.
- `app/src/index.js`: serves Scramjet's files at `/scram/`, sends `Cache-Control: no-cache` because iOS PWAs cache aggressively, and has a recovery page that re-registers the service worker when iOS evicts it. It also runs the password gate (`auth.js`), the block lists (`filters.js`), the signed settings cookie, and the site-isolation host rules. At startup it bundles `shield.js`, `page.js` and `sitekey.js` with esbuild.
- `app/src/media.js`: iOS plays video with its own media engine, which skips the service worker and asks the server for the proxied URL directly. The server fetches the video itself and rewrites HLS playlists so every segment in them is proxied too.
- `app/src/wisp.js`: the wisp server (wisp-js) only connects to the web's ports over TCP, and refuses private, loopback and link-local addresses. wisp-js has its own check, but it misses IPv6 private addresses (`fc00::/7`) and IPv4-mapped ones, so ours runs in front of it.
- `app/src/client/fingerprint.js` (page and workers), `consent.js` (cookie notices), `logins.js` (passwords and passkeys, the page's side), `reader.js` (reader view, in the shell), `worker.js` (workers' protection): bundled at startup like `page.js`.
- `app/src/privacyrules.js` (Brave's debounce and query rules), `cname.js` (what a subdomain is an alias of), `certs.js` (certificates and revocation), `webrisk.js` (Google Web Risk, optional), `sync.js` (the sync relay), `tor.js` (Tor tabs).

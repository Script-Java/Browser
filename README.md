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

- The proxy only connects to ports 80 and 443 over TCP. Mail ports, other ports and UDP are refused, so the server can't be used for spam or port scans. Sites on unusual ports (like `:8080`) won't load.
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
- **What the server does learn:** the name of each site opened (for example `example.com`), so it can check it against the malware and phishing lists. It's used for that check and not logged. Videos that iOS plays with its own player are fetched by the server itself, so for those the server sees the video's address, and the host's request logs (Railway's HTTP logs) record it.
- **Cookies the app sets:** a pass from the bot check (30 days) or the password sign-in, and the person's settings. Neither identifies anyone.
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
- **Permissions are refused:** camera, microphone, location, notifications and the like are all turned down. Full screen, copying to the clipboard and pointer lock are allowed.
- **No WebRTC:** turned off inside Chromium too, so it can't send UDP around the network lock and show sites the computer's real address.
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
pnpm -C app exec playwright install chromium   # once
pnpm -C app e2e                                # about a minute; needs the internet
```

`app/e2e/` checks in a real browser, through the real proxy, what Badger promises: nothing a page loads goes around the proxy, pages get no WebRTC, no popups or dialogs or hand-offs to other apps without a tap in the page, HTTPS-Only, the Standard, Safer and Safest levels, ad blocking, New identity, the browser check and site isolation, and the server's headers and access rules. It starts two servers itself (ports 8811 and 8812, one in production-like isolation mode).

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
| `FILTER_CACHE_DIR` | Where downloaded lists are kept between restarts (default: the system temp folder). |

## Protection

Tap the shield or lock icon at the left of the address bar to see what's on and change it.

| Feature | How it works |
| --- | --- |
| Ad and tracker blocking | The server downloads EasyList, EasyPrivacy, Peter Lowe's list and uBlock Origin's lists every day and builds a blocking engine ([Ghostery's adblocker](https://github.com/ghostery/adblocker)). The proxy's service worker loads it and drops requests to ad and tracking networks before they leave the phone. Known ad scripts are swapped for harmless stand-ins so pages don't break. If you open an ad network's address directly, you get a "Page blocked" screen with an **Open anyway** button. |
| Hiding ad boxes and overlays | Every page gets the lists' hiding rules for that site, plus rules matched to the class names and ids actually on the page. This catches ads and scam overlays that the site serves itself. |
| Skipping video ads | uBlock Origin's site fixes (for example YouTube's) run in each page before the site's own scripts. As a backup, the app clicks "Skip ad" in YouTube, JW Player and video.js players, and mutes and fast-forwards ad videos that can't be skipped. |
| Malware and phishing warnings | The server keeps the [malware-filter](https://gitlab.com/malware-filter) phishing and URLhaus lists, updated daily, and checks every page you open. Listed sites show a red warning first; **Continue anyway** opens the site. |
| Per-site switch | Turns blocking off for one site when it breaks. |
| HTTPS-Only | On by default. `http://` pages pass through the server unencrypted, so the app opens the `https://` version instead. When a site has none, a warning comes first; **Continue (not secure)** opens that site (and its subdomains) over http for the rest of the session. Images and scripts on a page are upgraded to https too. |
| Security level | Like Tor Browser's. **Standard**: every site works as usual. **Safer**: no web fonts, WebGL or WebGPU on any site (they fingerprint the device and are a common way into browser bugs), and none of a page's own scripts on sites without https; some sites look or work worse. **Safest**: everything in Safer, and no site's own scripts at all (a Content-Security-Policy on every page lets only the proxy's and the app's scripts run); many sites stop working. |
| New identity | Settings → **New identity** (or the address bar command), like Tor Browser's: after a confirmation, every tab closes, every site's cookies, storage and logins and the history are deleted, the warnings you clicked through are forgotten, and the app restarts. Settings and bookmarks stay. |
| No WebRTC | WebRTC talks to servers over UDP straight from the device, around the proxy, and would show sites the device's real IP address. Pages get no WebRTC at all (the desktop app also turns it off inside Chromium). Video calls in the browser don't work through the proxy anyway. |
| Strict policy on the app's own pages | The app's pages run only their own scripts (a Content-Security-Policy with hashes of the few inline ones), may only be framed by the app, and are HTTPS-only for six months once visited over HTTPS (HSTS). |
| Clear site data on launch | On by default, so a lost or shared device doesn't keep the last session's logins (turn it off in Settings to stay signed in). Each fresh launch deletes every site's cookies, storage and logins, the history and the open tabs (bookmarks are kept). **Clear history and site data now** does it on demand. |
| Passphrase lock | Optional (Settings → **Lock history and bookmarks with a passphrase**). History, bookmarks and open tabs are stored on the device encrypted (AES-GCM, with a key made from the passphrase by PBKDF2-SHA256 at 600,000 rounds). The key is only ever in memory, so the passphrase is asked each time the app opens. A forgotten passphrase can't be recovered: **Erase and start over** deletes them along with every site's logins. Site logins themselves aren't encrypted; clearing on launch covers them. |
| Password | See above. It also guards the proxy connection itself, not only the page. |
| Site isolation | See above. |
| Trustworthy address bar | The bar shows the site's real domain, never a page's own claim. Look-alike letters from other alphabets show up as `xn--…` instead of passing for a real domain. With site isolation on, the app checks every address against the walled-off address the browser gave that page, so a page can't make the bar show another site. Without isolation, a malicious page can reach into the app and change the bar. |

Limits:

- No blocker catches everything. Sites change their ads to get around block lists, which is why the lists are refreshed daily. If an ad gets through, it's usually fixed in a list update within a day or two.
- Rules that hide elements by their link or image address don't apply, because the proxy rewrites those addresses.
- With isolation on, a frame from another site embedded *inside* a page (an ad, a video player) runs in that page's space, the way Safari partitions embedded frames. It can't see other sites' data, but it can see the page that embeds it.
- With isolation on, each site you visit costs a little more at first: its own service worker, its own proxy connection and its own copy of the block list in memory.
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

The shell itself has no outbound links. It draws its own browser chrome, because standalone mode has none:

- **Tabs**: open, close (× or middle click), switch (click or arrow keys). Open tabs come back when the app reopens; background ones load when you switch to them.
- **Address bar**: suggestions from bookmarks and history as you type, and commands (New tab, Close tab, History, Settings, Bookmark this page, Split view, Reload page, Clear history and site data). Arrow keys and Enter pick one; plain Enter always searches or opens what you typed. Ctrl/⌘+K or +L jumps to it.
- **Back and forward**: with one tab open they use the page's own history, so it comes back where it was scrolled. With more, the shell keeps each tab's history and reloads the address, because tab frames share one session history and the page's own "back" could move a different tab.
- **Bookmarks**: the star in the address bar, the bookmarks bar, and shortcuts on the new tab page.
- **Split view** (wide screens): two tabs side by side; click a pane to make it the active tab, or pick a tab from the strip to put it in the focused pane.
- **⋯ menu**: settings, history, and clearing data.

Not covered: the iOS keyboard and its autofill bar, and file downloads served as attachments (iOS asks before saving them).

## How it sits on Scramjet

Scramjet is used unmodified from npm. Everything app-specific is around it:

- `app/public/scramjet-sw.js`: the service worker (scope `/scramjet/`). `shield.js` checks each request before Scramjet fetches it, and after Scramjet rewrites an HTML page it adds `/bios/page.js`, the page's hiding rules and its scriptlets.
- `app/src/sw/shield.js`: the worker's blocker. It asks the server for fresh settings on every page load, so a switch in the shield menu applies to the next page. It also stores Scramjet's config itself (Scramjet normally expects a page to post it) with source maps off (with them on, YouTube's scripts froze the tab), clears Scramjet's in-memory cookies on "Clear all site data", and when the connection to the server has died (a deploy, a network change) asks an open page to reconnect and retries the request once.
- `app/src/client/page.js`: runs in every proxied page after Scramjet has hooked it: the no-popup layer, generic ad hiding, video-ad skipping, and reporting the address to the shell. It isn't rewritten by Scramjet, so it reads the site's address from Scramjet's client. Scramjet lets `mailto:` through unproxied, so this drops those navigations.
- `app/src/codec.js`: proxied URLs are `/scramjet/<encodeURIComponent(url)>` (Scramjet's default codec); the server's media fallback and the service worker decode them the same way.
- `app/public/register-sw.js`: registers the worker, waits for it to activate (`serviceWorker.ready` never settles because the shell is outside the worker's scope), removes the old Ultraviolet worker, and answers the worker's reconnect requests.
- `app/src/index.js`: serves Scramjet's files at `/scram/`, sends `Cache-Control: no-cache` because iOS PWAs cache aggressively, and has a recovery page that re-registers the service worker when iOS evicts it. It also runs the password gate (`auth.js`), the block lists (`filters.js`), the signed settings cookie, and the site-isolation host rules. At startup it bundles `shield.js`, `page.js` and `sitekey.js` with esbuild.
- `app/src/media.js`: iOS plays video with its own media engine, which skips the service worker and asks the server for the proxied URL directly. The server fetches the video itself and rewrites HLS playlists so every segment in them is proxied too.
- `app/src/wisp.js`: the wisp server (wisp-js) only connects to ports 80 and 443 over TCP, and refuses private, loopback and link-local addresses. wisp-js has its own check, but it misses IPv6 private addresses (`fc00::/7`) and IPv4-mapped ones, so ours runs in front of it.

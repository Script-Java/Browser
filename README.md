# browser-ios

[Scramjet](https://github.com/MercuryWorkshop/scramjet) packaged as an iOS home-screen app (PWA) where nothing pops out of the app.

```
app/           server (express + wisp-js) and the PWA shell; Scramjet comes from npm
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

1. In the Railway dashboard (`npx @railway/cli open`), open the service, go to **Settings → Networking → Custom Domain**, and add both `browse.example.com` and `*.browse.example.com` (use your own domain).
2. Add the DNS records Railway shows you at your domain registrar. The wildcard needs its `_acme-challenge` record too, so Railway can issue its certificate.
3. Set the domain and redeploy:

   ```sh
   npx @railway/cli variable set "ISOLATION_DOMAIN=browse.example.com"
   ./railway.sh
   ```

4. On the iPhone, open `https://browse.example.com` in Safari and add it to the home screen again. The old icon keeps working, but without isolation.

The shield menu says whether isolation is on.

## Run locally

```sh
pnpm run setup   # install the app
pnpm start       # http://localhost:8787  (PORT=... to change)
pnpm -C app test # unit tests (CI also runs lint, audit and a Docker build)
```

The iPhone needs HTTPS for the proxy's service worker, so a local `http://` address only works on this computer.

To try site isolation locally, run `ISOLATION_DOMAIN=app.localhost pnpm start` and open `http://app.localhost:8787` in Chrome. Chrome sends every `*.localhost` name to this computer.

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
| Clear site data on launch | On by default. Each fresh launch deletes every site's cookies, storage and logins. **Clear all site data now** does it on demand. |
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
| `alert` / `confirm` / `prompt` / `print` | silenced (`confirm` → true, `prompt` → null) |
| location, camera/mic, notifications, motion sensors, share sheet, passkeys, Apple Pay, clipboard paste, storage-access prompts | denied without showing a prompt |
| long-press link/image previews | disabled |
| a proxied page escaping to the top level | gets wrapped back into the shell |

The shell itself has no outbound links. It draws its own browser chrome, because standalone mode has none:

- **Tabs**: open, close (× or middle click), switch (click or arrow keys). Open tabs come back when the app reopens; background ones load when you switch to them.
- **Address bar**: suggestions from bookmarks and history as you type, and commands (New tab, Close tab, History, Settings, Bookmark this page, Split view, Reload page, Clear history and site data). Arrow keys and Enter pick one; plain Enter always searches or opens what you typed. Ctrl/⌘+K or +L jumps to it.
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

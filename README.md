# browser-ios

[Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet) packaged as an iOS home-screen app (PWA) where nothing pops out of the app.

```
Ultraviolet/   UV library, built from source (one small patch, see below)
app/           server (express + wisp) and the PWA shell
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

## Set a password

Without a password, anyone who finds your address can use your proxy. Set one (pick your own) and redeploy:

```sh
npx @railway/cli variable set "APP_PASSWORD=pick-a-long-password"
./railway.sh
```

The app then opens on a password screen. A sign-in lasts 180 days on that device. The home screen app keeps its own sign-in, separate from Safari's, so sign in from the home screen app. **Lock** in the shield menu signs out. Changing the password signs every device out. After 8 wrong tries from one address, sign-in is blocked for 15 minutes.

## Turn on site isolation (needs your own domain)

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
pnpm run setup   # build Ultraviolet, install the app
pnpm start       # http://localhost:8787  (PORT=... to change)
```

The iPhone needs HTTPS for the proxy's service worker, so a local `http://` address only works on this computer.

To try site isolation locally, run `ISOLATION_DOMAIN=app.localhost pnpm start` and open `http://app.localhost:8787` in Chrome. Chrome sends every `*.localhost` name to this computer.

| Variable | What it does |
| --- | --- |
| `APP_PASSWORD` | Turns on the password screen. |
| `ISOLATION_DOMAIN` | Turns on site isolation (see above). |
| `AUTH_SECRET` | Optional extra secret mixed into the sign-in and settings cookies. |
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

Most of this lives in `app/public/uv/uv.config.js` (`noPopups`). It runs inside every proxied page, including iframes that scripts create.

| Would normally… | Now |
| --- | --- |
| `target="_blank"` / `_top` / unknown named target links and forms open a Safari sheet or replace the app | open in the app's tab |
| `window.open(url)` opens a new window | navigates the tab; calls without a user gesture (pop-unders) are dropped |
| `mailto:`, `tel:`, `sms:`, `maps:`, app-store links hand off to another app | blocked |
| `alert` / `confirm` / `prompt` / `print` | silenced (`confirm` → true, `prompt` → null) |
| location, camera/mic, notifications, motion sensors, share sheet, passkeys, Apple Pay, clipboard paste, storage-access prompts | denied without showing a prompt |
| long-press link/image previews | disabled |
| a proxied page escaping to the top level | gets wrapped back into the shell |

The shell itself has no outbound links. Back, forward, address, reload, and home are in the bottom bar, because standalone mode has no browser chrome.

Not covered: the iOS keyboard and its autofill bar, and file downloads served as attachments (iOS asks before saving them).

## Changes to upstream

- `Ultraviolet/src/uv.handler.js`: at the end of `__uvHook`, it calls `__uv$config.construct(__uv, window, type)` when that is defined. This lets the config hook every window UV hooks.
- `app/public/uv/uv.config.js`: a `decodeUrl` that fixes GET form submissions. Upstream's xor decode garbles the `?query` that the browser appends.
- `app/public/register-sw.js`: waits for the worker to activate. `serviceWorker.ready` never settles because the shell page is outside the `/uv/` scope.
- `app/src/index.js`: serves the locally built UV, sends `Cache-Control: no-cache` because iOS PWAs cache aggressively, and has a recovery page that re-registers the service worker when iOS evicts it. It also runs the password gate (`auth.js`), the block lists (`filters.js`), the signed settings cookie, and the site-isolation host rules. At startup it bundles `src/sw/shield.js` (the service worker's blocker) and `src/client/sitekey.js` with esbuild.
- `app/src/media.js`: iOS plays video with its own media engine, which skips the service worker and asks the server for the proxied URL directly. The server fetches the video itself and rewrites HLS playlists so every segment in them is proxied too.
- `app/public/uv/sw.js`: replaces UV's stock service worker so `shield.js` checks each request before UV fetches it, and adds hiding rules and scriptlets to each page after UV rewrites it.
- `Ultraviolet/src/uv.handler.js`: the `construct` hook also receives UV's client, which holds the unhooked `fetch`.
- `app/patches/wisp-server-node@1.1.7.patch`: the wisp server refuses connections to private, loopback and link-local addresses.

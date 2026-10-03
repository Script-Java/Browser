# Badger for desktop

Badger as a Windows app: Chromium (through Electron) with Badger's tabs, bookmarks and history around it.

Unlike the web app, sites load directly, one native view per tab. There's no proxy server on your computer: on a desktop it couldn't hide your IP address anyway, and it was one more process that could crash and take the app down. Sites work like they do in Chrome, including Google sign-in.

## Run and build

```sh
pnpm install
pnpm start       # run from source
pnpm test        # rules.js tests
pnpm dist        # build dist/Badger-Setup-<version>.exe
pnpm release     # build and publish to GitHub Releases (needs GH_TOKEN)
```

`stage.js` copies the stylesheet, logos and icons from `../app/public` into `ui/shared/`, so the web and desktop apps share one copy.

## What it does

| | |
| --- | --- |
| Ads and trackers | Ghostery's blocker with its prebuilt ads-and-tracking lists (EasyList, EasyPrivacy, uBlock Origin and more), refreshed daily. It also hides ad boxes and skips video ads. It can be turned off everywhere, or per site from the site menu. |
| Malware and phishing | The same host lists as the web app, refreshed daily. A listed site is stopped before it loads, with **Go back** and **Continue anyway**. |
| Pop-ups | A new window opens as a tab, only right after a real click, tap or key press in that page. Other pop-ups are dropped. |
| Other apps | Pages can't open `mailto:`, `tel:` or other apps, or local files. |
| Permissions | Camera, microphone, location, notifications and the like are refused (there's no prompt yet). Fullscreen and copying to the clipboard work. |
| WebRTC | Hides your local network addresses from sites; calls still work. |
| Your data | History, bookmarks, open tabs and settings stay on this computer, in `%APPDATA%\Badger`. **Clear history and site data** removes cookies, logins, site storage, history and open tabs, and keeps bookmarks. |

Shortcuts: Ctrl+T new tab, Ctrl+W close, Ctrl+Shift+T reopen, Ctrl+Tab / Ctrl+Shift+Tab switch, Ctrl+L or Ctrl+K address bar, Ctrl+R or F5 reload (Ctrl+F5 without cache), Alt+Left / Alt+Right back and forward, Ctrl+D bookmark, Ctrl+H history, Ctrl+plus / minus / 0 zoom. Right-click a page for open in new tab, copy, search and back/forward.

## When something goes wrong

- A tab whose page crashes reloads once by itself. If it crashes again within 30 seconds, it shows a "This page crashed" page with **Try again** instead of looping.
- A page that can't load (no connection, unknown address) shows a page that says so, with **Try again**.
- If the browser's own UI crashes, it reloads and reopens your tabs.
- Bookmarks, history and open tabs are written to disk within a moment of every change, so a crash or a forced quit loses almost nothing.
- Problems are logged to `%APPDATA%\Badger\logs\badger.log`, and crash dumps are kept in `%APPDATA%\Badger\Crashpad`. Nothing is uploaded anywhere. Send these if you report a bug.

## Updates

The installed app checks GitHub Releases at launch and every 6 hours, downloads updates in the background and installs them when you quit. Chromium's security fixes reach people only this way, so publish a release whenever Electron ships one (Dependabot opens the pull requests).

The installer isn't code-signed yet, so Windows SmartScreen warns about it until it is.

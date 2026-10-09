# Open-source parts

What Badger is built from besides its own code, and under which license. Badger itself is AGPL-3.0; every license here allows that. The bundles the server builds keep each library's own license notice (`legalComments: "inline"` in `app/src/index.js`).

## In the app (run on the device)

| Part | What it does here | License |
| --- | --- | --- |
| [Scramjet](https://github.com/MercuryWorkshop/scramjet) | The proxy itself: rewrites every page, script and address | MIT |
| [epoxy-transport](https://github.com/MercuryWorkshop/epoxy-tls), [bare-mux](https://github.com/MercuryWorkshop/bare-mux) | TLS on the device, and the connection to the server | AGPL-3.0, MIT |
| [@ghostery/adblocker](https://github.com/ghostery/adblocker) | The blocking engine | MPL-2.0 |
| [@duckduckgo/autoconsent](https://github.com/duckduckgo/autoconsent) | Answers cookie notices with "no" (`client/consent.js`) | MPL-2.0 |
| [@mozilla/readability](https://github.com/mozilla/readability) | Finds a page's article for reader view (`client/reader.js`) | Apache-2.0 |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Cleans the article before the app shows it | Apache-2.0 or MPL-2.0 |
| [tldts](https://github.com/remusao/tldts) | Which site a name belongs to | MIT |

The fingerprinting protection (`client/fingerprint.js`) answers the battery and the storage allowance the way DuckDuckGo's [content-scope-scripts](https://github.com/duckduckgo/content-scope-scripts) (Apache-2.0) do, and blurs canvas and sound readouts as Brave's "farbling" does; the code is Badger's own.

## On the server

| Part | What it does here | License |
| --- | --- | --- |
| [wisp-js](https://github.com/MercuryWorkshop/wisp-js) | The proxy's connections out | AGPL-3.0 |
| [@peculiar/x509](https://github.com/PeculiarVentures/x509), [reflect-metadata](https://github.com/rbuckton/reflect-metadata) | Reads certificates for the viewer and the revocation check (`certs.js`) | MIT, Apache-2.0 |
| [socks](https://github.com/JoshGlazebrook/socks), [socks-proxy-agent](https://github.com/TooTallNate/proxy-agents) | Connections through Tor (`tor.js`) | MIT |
| [Tor](https://www.torproject.org/) | Tor tabs (installed in the Docker image) | BSD-3-Clause |
| [Express](https://expressjs.com/), [ws](https://github.com/websockets/ws), [esbuild](https://esbuild.github.io/) | The web server, WebSockets, building the bundles | MIT |

## Lists the server downloads

None of these are in the repository; the server fetches them (`filters.js`).

| List | Used for | License |
| --- | --- | --- |
| EasyList, EasyPrivacy, EasyList Cookie | Ads, trackers, cookie notices | GPL-3.0 or CC BY-SA 3.0 |
| uBlock Origin's lists and scriptlets | Ads, trackers, site fixes | GPL-3.0 |
| Peter Lowe's list | Ad and tracking servers | (free to use) |
| [Brave's lists](https://github.com/brave/adblock-lists): first-party CNAME trackers, debounce rules, query filter | Cloaked trackers, bounce tracking, tracking parameters | MPL-2.0 |
| [AdGuard's CNAME trackers](https://github.com/AdguardTeam/cname-trackers) | What cloaked trackers point to | MIT |
| [malware-filter](https://gitlab.com/malware-filter) (phishing, URLhaus) | Phishing and malware warnings | CC0 / MIT |
| [Google Web Risk](https://cloud.google.com/web-risk) (optional, `WEB_RISK_API_KEY`) | Fresher threat checks | Google's terms (paid) |

## Only in the tests

[Playwright](https://playwright.dev/) (Apache-2.0) and [SimpleWebAuthn](https://github.com/MasterKale/SimpleWebAuthn) (MIT), which checks that the passkeys the app makes are ones a site accepts.

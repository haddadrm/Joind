# Web reconnect smoke (Playwright)

A browser smoke for the web token prompt, the name lock and the reconnect
path (6 Oct 2026). It starts a real Joind in-process from `dist/` on
`127.0.0.1` port 0 (an ephemeral port, never 4200) with a temporary data dir,
a user-set web token and `agentAuth: "require"`, then drives a fresh,
phone-sized Chromium profile (Galaxy S9+ emulation) against it:

- **A.** A fresh profile shows the token prompt. After the token is entered,
  the rooms and the crew roster load, the page adopts the viewer name the
  desktop registered first (the name lock: the phone's default is `human`),
  every socket claims that name, the socket connects, and the page throws
  nothing.
- **B.** A mistyped token gets the visible banner and the prompt again, not a
  silent reconnect loop; the right token then connects.

It contacts no other server. The page's terminal scan (`/api/terminals`) is
answered by the browser with an empty list, so nothing on the machine is
scanned, and any other host (the icon CDN) is answered empty. Everything is
torn down at the end, and the exit code is non-zero on any failure.

## Run it

From the repo root:

```
npm run build
npm install --prefix tools/web-smoke     # playwright-core only, kept out of the root package
node tools/web-smoke/smoke.mjs
```

`playwright-core` is deliberately not a root dev dependency (it is large and
only this smoke uses it). Instead of installing it here you can point at any
installed copy: `JOIND_PLAYWRIGHT_CORE=<path to a playwright-core folder>`.

The browser: `JOIND_SMOKE_CHROME=<chromium or headless-shell executable>`.
Without it the script tries playwright-core's own browser, then the newest
headless shell (else Chromium) already in the Playwright browser cache
(`PLAYWRIGHT_BROWSERS_PATH`, or `ms-playwright` under the local app data
folder or `~/.cache`), so a cache holding another revision works without a
download. `npx playwright-core install chromium-headless-shell` fetches the
matching one if there is none.

Other switches: `JOIND_SMOKE_VERBOSE=1` keeps the server's start-up log;
`JOIND_SMOKE_REPO=<built checkout>` runs the smoke against another build's
`dist/` and `public/` (the fa913f5 client fails 10 of its checks: every socket
claims `human` and is refused, no rooms, no crew, and
`sessionTemplates.forEach is not a function`).

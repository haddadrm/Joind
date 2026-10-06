// Web reconnect smoke test (6 Oct 2026): a fresh phone-sized browser against
// a throwaway Joind on an ephemeral loopback port, with a user-set web token
// and agent-auth require (the RAMIY530 setup), proves that:
//   A. a fresh profile shows the token prompt; after the token is entered the
//      rooms and the crew roster load, the page adopts the registered viewer
//      name (the name lock) and the socket connects; no page errors.
//   B. a mistyped token gets the visible banner and the prompt again (no
//      silent loop), and the right token then connects.
//
// Never binds 4200 and contacts no other server: the server runs in this
// process on 127.0.0.1 port 0 with a temporary data dir, removed at the end.
// The page's terminal scan (/api/terminals) is answered by the browser route
// with an empty list, so nothing on this machine is scanned.
//
// Run from the repo root after `npm run build` (see README.md beside this file).
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// JOIND_SMOKE_REPO points at another built checkout (its dist/ and public/),
// for example an older commit, to see the smoke fail there.
const repo = process.env.JOIND_SMOKE_REPO || join(here, "..", "..");

async function loadPlaywright() {
  const override = process.env.JOIND_PLAYWRIGHT_CORE;
  if (override) {
    const req = createRequire(join(override, "package.json"));
    return req(override);
  }
  try {
    return await import("playwright-core");
  } catch {
    console.error("playwright-core not found: run `npm install --no-save playwright-core` in tools/web-smoke,");
    console.error("or set JOIND_PLAYWRIGHT_CORE to an installed playwright-core package folder.");
    process.exit(2);
  }
}

// JOIND_SMOKE_CHROME names a Chromium or headless-shell executable. Without
// it, playwright-core's own browser is tried, then the newest headless shell
// (else Chromium) already in the Playwright browser cache (PLAYWRIGHT_BROWSERS_PATH,
// or ms-playwright under the user's local app data or ~/.cache), so a cache
// that holds another revision still works without a download.
async function launchChromium(chromium) {
  if (process.env.JOIND_SMOKE_CHROME) return chromium.launch({ executablePath: process.env.JOIND_SMOKE_CHROME });
  try {
    return await chromium.launch();
  } catch (first) {
    const exe = cachedChromium();
    if (!exe) throw first;
    console.log(`using cached browser ${exe}`);
    return chromium.launch({ executablePath: exe });
  }
}

function cachedChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ms-playwright"),
    process.env.HOME && join(process.env.HOME, ".cache", "ms-playwright"),
    process.env.HOME && join(process.env.HOME, "Library", "Caches", "ms-playwright"),
  ].filter(Boolean);
  const layouts = [
    ["chromium_headless_shell-", ["chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell"]],
    ["chromium-", ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux64/chrome", "chrome-linux/chrome"]],
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const entries = readdirSync(root);
    for (const [prefix, rels] of layouts) {
      const revs = entries.filter((e) => e.startsWith(prefix) && /^\d+$/.test(e.slice(prefix.length)))
        .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
      for (const rev of revs) {
        for (const rel of rels) {
          const exe = join(root, rev, rel);
          if (existsSync(exe)) return exe;
        }
      }
    }
  }
  return null;
}

// The token prompt, found by its input (older builds gave the overlay no id).
const PROMPT = '.session-modal-overlay:has(input[placeholder="web token"])';

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  (${detail})` : ""}`);
}

const pw = await loadPlaywright();
const { chromium, devices } = pw.default ?? pw;
const { startJoind } = await import(pathToFileURL(join(repo, "dist", "index.js")).href);

const dir = mkdtempSync(join(tmpdir(), "joind-web-smoke-"));
const webToken = randomBytes(32).toString("base64url");
const agentKey = randomBytes(32).toString("base64url");
const quiet = process.env.JOIND_SMOKE_VERBOSE ? null : console.log;
if (quiet) console.log = () => undefined;
let server;
let browser;
try {
  server = await startJoind({
    port: 0, host: "127.0.0.1", dataDir: join(dir, "data"), instance: "smoke", crewHome: join(dir, "crew"),
    humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
    webToken, webTokenUserSet: true, links: [], agentAuth: "require", agentKey,
  });
  if (quiet) console.log = quiet;
  const base = server.baseUrl;
  console.log(`server on ${base} (ephemeral, temp data dir)`);

  // The desktop registered its name first; the phone's default is "human".
  const reg = await fetch(`${base}/api/web/register`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: webToken, name: "Rami" }),
  });
  check("desktop registers the viewer name", reg.status === 200, reg.status);
  const ops = server.manager.createConversation("ops");
  server.manager.createConversation("bridge");
  server.manager.setActive(ops.id);
  server.manager.getRoom(ops.id).send("Kira", "smoke hello");
  const crewDir = join(dir, "kira");
  mkdirSync(crewDir, { recursive: true });
  writeFileSync(join(crewDir, "AGENTS.md"), "# Kira\n");
  const crew = await fetch(`${base}/api/crew`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Joind-Token": webToken },
    body: JSON.stringify({ name: "Kira", path: crewDir, joinAs: "Kira" }),
  });
  check("crew member registered", crew.ok, crew.status);

  browser = await launchChromium(chromium);
  const phone = devices["Galaxy S9+"];

  async function freshPage() {
    const context = await browser.newContext({ ...phone }); // a fresh profile: no storage at all
    const page = await context.newPage();
    const errors = [];
    const sockets = [];
    page.on("pageerror", (e) => errors.push(String(e && e.message)));
    page.on("websocket", (ws) => sockets.push(ws.url()));
    await context.route("**/api/terminals*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
    // No other host: the page's optional CDN icon script is answered empty.
    await context.route((url) => !url.href.startsWith(base), (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
    return { context, page, errors, sockets };
  }

  const roomCount = (page) => page.evaluate(() => (typeof conversationList !== "undefined" ? conversationList.length : -1));
  const connected = (page) => page.evaluate(() => {
    const d = document.getElementById("connection-dot");
    return !!d && !d.classList.contains("disconnected");
  });

  // --- A: fresh phone, right token ---
  {
    const { context, page, errors, sockets } = await freshPage();
    await page.goto(base + "/");
    await page.waitForSelector(PROMPT, { timeout: 10_000 });
    check("A: fresh profile shows the token prompt", true);
    check("A: no rooms before the token", (await roomCount(page)) === 0);
    await page.fill(PROMPT + " input", webToken);
    await page.click(PROMPT + " button");
    await page.waitForFunction(() => conversationList.length >= 2, null, { timeout: 15_000 }).catch(() => undefined);
    const names = await page.evaluate(() => conversationList.map((c) => c.name).sort());
    check("A: rooms listed after the token", names.includes("ops") && names.includes("bridge"), names.join(","));
    const listed = await page.locator("#conversation-list li").count();
    check("A: room list rendered in the page", listed >= 2, listed);
    check("A: socket connected", await connected(page));
    const myName = await page.evaluate(() => localStorage.getItem("joind-sender-name"));
    check("A: name lock: the registered name was adopted", myName === "Rami", myName);
    const claimed = sockets.map((u) => new URL(u).searchParams.get("name"));
    check("A: every socket claimed the registered name", claimed.length >= 1 && claimed.every((n) => n === "Rami"), claimed.join(","));
    await page.waitForFunction(() => Array.isArray(crewRoster) && crewRoster.length >= 1, null, { timeout: 10_000 }).catch(() => undefined);
    const roster = await page.evaluate(() => crewRoster.map((c) => c.name));
    check("A: crew roster loaded after the token", roster.includes("Kira"), roster.join(","));
    check("A: no auth banner", (await page.locator("#auth-banner").count()) === 0);
    check("A: no page errors", errors.length === 0, errors.join(" | "));
    await page.screenshot({ path: join(dir, "a.png") }).catch(() => undefined);
    await context.close();
  }

  // --- B: fresh phone, mistyped token first ---
  {
    const { context, page, errors } = await freshPage();
    await page.goto(base + "/");
    await page.waitForSelector(PROMPT, { timeout: 10_000 });
    await page.fill(PROMPT + " input", "not-the-token");
    await page.click(PROMPT + " button");
    await page.waitForSelector("#auth-banner", { timeout: 10_000 }).catch(() => undefined);
    check("B: a refused token shows the banner", (await page.locator("#auth-banner").count()) === 1);
    check("B: and the prompt again", (await page.locator(PROMPT).count()) === 1);
    check("B: no rooms with a wrong token", (await roomCount(page)) === 0);
    await page.fill(PROMPT + " input", webToken);
    await page.click(PROMPT + " button");
    await page.waitForFunction(() => conversationList.length >= 2, null, { timeout: 15_000 }).catch(() => undefined);
    check("B: the right token then connects with rooms", (await roomCount(page)) >= 2 && (await connected(page)));
    check("B: the banner is gone", (await page.locator("#auth-banner").count()) === 0);
    check("B: no page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
} catch (err) {
  if (quiet) console.log = quiet;
  check("smoke ran to the end", false, err && err.stack ? err.stack : String(err));
} finally {
  if (quiet) console.log = quiet;
  await browser?.close().catch(() => undefined);
  if (quiet) console.log = () => undefined;
  await server?.close().catch(() => undefined);
  if (quiet) console.log = quiet;
  rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

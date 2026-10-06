/**
 * Web reconnect, page side (6 Oct 2026, mobile-crew diagnosis). The pure
 * decisions live in public/ui-helpers.js; the page's own functions are lifted
 * from public/app.js (the shipped source, as the composer test does) and run
 * in JSDOM against a fake WebSocket, a fake fetch, fake timers and a fake
 * location, so no server and no real socket is involved.
 *
 * 1. Name lock: a 409 naming the registered viewer is adopted before the
 *    socket opens, and the socket claims that name.
 * 2. Retry counter: reset on `init`, not on open, so repeated
 *    accept-then-close 4403s stop on a banner instead of looping.
 * 3. Stale injected token: a 4401 reloads the page once, then prompts.
 * 4. A 401/403 token refusal while a token is held shows the banner.
 * 5. The boot reads run again once a token is entered at the boot prompt,
 *    and a refused read is never used as a list.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { JSDOM } from "jsdom";

const PUB = join(__dirname, "..", "public");
const APP = readFileSync(join(PUB, "app.js"), "utf8").replace(/\r\n?/g, "\n");
const HELPERS = readFileSync(join(PUB, "ui-helpers.js"), "utf8");
const TOKEN = "a".repeat(64);

// --- pure helpers -------------------------------------------------------

type RegisterOutcome =
  | { kind: "ok"; name: string }
  | { kind: "adopt"; name: string }
  | { kind: "refused"; error: string }
  | { kind: "unauthorized" }
  | { kind: "error" };
type CloseAction = "retry" | "reload" | "prompt" | "reregister" | "banner";
interface CloseState { code: number; failures?: number; injected?: boolean; reloadedOnce?: boolean; limit?: number }
interface Helpers {
  registerOutcome(status: number, body: unknown, submitted: string): RegisterOutcome;
  wsAuthCloseAction(s: CloseState): CloseAction;
  tokenRefusedAnswer(status: number, body: unknown): boolean;
}

function loadHelpers(): Helpers {
  const mod: { exports: Helpers | Record<string, never> } = { exports: {} };
  new Function("module", HELPERS)(mod);
  return mod.exports as Helpers;
}
const ui = loadHelpers();

describe("registerOutcome", () => {
  it("ok keeps the server's name", () => {
    expect(ui.registerOutcome(200, { ok: true, name: "Rami" }, "Rami")).toEqual({ kind: "ok", name: "Rami" });
    expect(ui.registerOutcome(200, null, "Rami")).toEqual({ kind: "ok", name: "Rami" });
  });
  it("a 409 naming the registered viewer is adopted", () => {
    expect(ui.registerOutcome(409, { error: "x", registered: "Rami" }, "human")).toEqual({ kind: "adopt", name: "Rami" });
  });
  it("a 409 or 400 with nothing to adopt is a refusal: do not connect", () => {
    expect(ui.registerOutcome(409, { error: "Kira is a read-only seat's name" }, "Kira")).toEqual({ kind: "refused", error: "Kira is a read-only seat's name" });
    expect(ui.registerOutcome(409, { registered: "  " }, "x")).toEqual({ kind: "refused", error: "name refused" });
    expect(ui.registerOutcome(400, { error: "invalid name" }, "")).toEqual({ kind: "refused", error: "invalid name" });
  });
  it("a refused token and a failure are told apart", () => {
    expect(ui.registerOutcome(403, { error: "unauthorized" }, "human")).toEqual({ kind: "unauthorized" });
    expect(ui.registerOutcome(401, null, "human")).toEqual({ kind: "unauthorized" });
    expect(ui.registerOutcome(500, null, "human")).toEqual({ kind: "error" });
  });
});

describe("wsAuthCloseAction", () => {
  it("an ordinary close reconnects", () => {
    for (const code of [1000, 1001, 1006, 0]) expect(ui.wsAuthCloseAction({ code, failures: 9 })).toBe("retry");
  });
  it("4401 with an injected token reloads once, then prompts", () => {
    expect(ui.wsAuthCloseAction({ code: 4401, failures: 1, injected: true, reloadedOnce: false })).toBe("reload");
    expect(ui.wsAuthCloseAction({ code: 4401, failures: 1, injected: true, reloadedOnce: true })).toBe("prompt");
  });
  it("4401 with a typed token prompts at once (nothing to retry)", () => {
    expect(ui.wsAuthCloseAction({ code: 4401, failures: 1, injected: false })).toBe("prompt");
  });
  it("4403 re-registers until the limit, then stops on the banner", () => {
    expect(ui.wsAuthCloseAction({ code: 4403, failures: 1 })).toBe("reregister");
    expect(ui.wsAuthCloseAction({ code: 4403, failures: 2 })).toBe("reregister");
    expect(ui.wsAuthCloseAction({ code: 4403, failures: 3 })).toBe("banner");
    expect(ui.wsAuthCloseAction({ code: 4403, failures: 1, limit: 1 })).toBe("banner");
  });
});

describe("tokenRefusedAnswer", () => {
  it("any 401, and a 403 that refuses the token", () => {
    expect(ui.tokenRefusedAnswer(401, null)).toBe(true);
    expect(ui.tokenRefusedAnswer(401, { error: "Agent credential required" })).toBe(true);
    expect(ui.tokenRefusedAnswer(403, { error: "unauthorized" })).toBe(true);
  });
  it("not a permission 403 or any other status", () => {
    expect(ui.tokenRefusedAnswer(403, { error: "Only the original sender can edit" })).toBe(false);
    expect(ui.tokenRefusedAnswer(403, null)).toBe(false);
    expect(ui.tokenRefusedAnswer(409, { error: "unauthorized" })).toBe(false);
    expect(ui.tokenRefusedAnswer(200, null)).toBe(false);
  });
});

// --- the page's functions in JSDOM -------------------------------------

/** A top-level function from app.js, as shipped. */
function lift(name: string): string {
  const start = APP.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  const end = APP.indexOf("\n}\n", start + 1);
  if (end < 0) throw new Error(`end of ${name} not found in app.js`);
  return APP.slice(start + 1, end + 2);
}

/** A one-line top-level `var` from app.js, as shipped. */
function liftVar(name: string): string {
  const m = new RegExp(`^var ${name} = [^\n]*$`, "m").exec(APP);
  if (!m) throw new Error(`var ${name} not found in app.js`);
  return m[0];
}

/** The fetch wrapper (an anonymous IIFE right after webToken). */
function liftFetchWrapper(): string {
  const start = APP.indexOf("(function() {\n  var nativeFetch = window.fetch;");
  if (start < 0) throw new Error("fetch wrapper not found in app.js");
  const end = APP.indexOf("\n})();\n", start);
  return APP.slice(start, end + 6);
}

const LIFTED_FUNCTIONS = [
  "webToken", "injectedTokenInUse", "tokenReloadDone", "markTokenReload", "clearTokenReload",
  "noteRefusedAnswer", "showAuthBanner", "hideAuthBanner", "runBootReads", "reconnectWithToken",
  "promptWebToken", "ensureWebToken", "bootSession", "loadInstanceInfo", "registerWebName",
  "adoptRegisteredName", "startSession", "connect", "handleSocketClose", "myName", "setupYouPill",
  "loadCrewRoster", "loadTemplates", "refreshSessionStatus", "signOut",
  "forgetWebToken", "retireSocket", "closeTabSockets", "showSignedOut", "resumeSession", "tickMembers",
  "reconcileVisibleViews", "renderPage", "loadBoard", "loadTasks", "taskRoomIsCurrent",
];
const LIFTED_VARS = [
  "ws", "wsName", "pendingRename", "renameAttempt", "wsAuthFailures", "reconnectTimer",
  "injectedTokenStale", "TOKEN_RELOAD_KEY", "TOKEN_REFUSED_TEXT", "tokenPromptAfter",
  "bootTokenPrompted", "signedOut", "setMyName", "crewRoster", "sessionTemplates",
  "typedWebToken", "authEpoch", "sessionAttempt", "tabSockets", "sessionGeneration", "reconcileOnInit",
  "pageNow", "PAGES", "board", "tasks", "taskFilter", "taskPanelOpen",
];

// What the init handler and the rest touch, stubbed (counted where useful).
const STUBS = `
var calls = {};
function count(n) { calls[n] = (calls[n] || 0) + 1; }
var clockOffset = 0, agents = [], agentsConv = null, onlineNames = new Set(), allMessages = [];
var historyView = null, jumpSeq = 0, historyExitSeq = 0, activeConversation = null, conversationList = [];
var socketInitCount = 0, initTaskCount = 0, initHasUrgent = false, availableRoles = null, settingsOverlay = null;
var allReactions = [], activeDm = null, tasksConvId = null;
function bumpPendingGeneration() {}
function applyLinkPayload() {}
function initTurnGuard() {}
function refreshSettingsPart() {}
function renderRolesInto() {}
function renderPills() {}
function refreshDmThread() {}
function renderMessages() {}
function renderPendingForActive() {}
function renderTaskBadgeFromCount() {}
function resetRoomTasks() {}
function showNoConversation() {}
function renderConversationList() { count('renderConversationList'); }
function renderDmList() {}
function refreshSenderTags() {}
function renderTemplates() { count('renderTemplates'); }
function getSenderColor() { return '#888'; }
function syncUserMenuName() {}
function openUserMenu() {}
function loadNotifications() { count('loadNotifications'); }
function refreshDecisionsBadge() { count('refreshDecisionsBadge'); }
function fetchDmPartners() {}
function renderBoardSide() {}
function renderBoard() { count('renderBoard'); }
function renderTaskBadge() {}
function renderTaskPanel() { count('renderTaskPanel'); }
function renderCrewPage() { count('renderCrewPage'); }
function renderDecisionsPage() {}
function loadDecisionsPage() { count('loadDecisionsPage'); }
var notifyPanelOpen = false, decisionsPanelOpen = false, sessionStatusInterval = null, membersTick = null, autoScanInterval = null;
function closePopover() {}
function closeSettingsModal() {}
function closeSidePanel() {}
function closeNotifyPanel() {}
function closeDecisionsPanel() {}
function closeCrewPanel() {}
function closeLaunchDialog() {}
function closeMobileDrawer() {}
`;

interface FakeSocket {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  send(data: string): void;
  close(): void;
  sent: string[];
}

interface FakeAnswer { status: number; body?: unknown }
interface FetchCall { url: string; method: string; token: string | null; body: unknown }
interface Timer { id: number; fn: () => void; ms: number }
interface Interval { id: number; fn: () => void; ms: number }

interface PageApi { v(name: string): unknown; run(src: string): unknown }

interface Page {
  win: Window & typeof globalThis;
  api: PageApi;
  sockets: FakeSocket[];
  fetches: FetchCall[];
  timers: Timer[];
  intervals: Interval[];
  reloads: number;
  route: (url: string, method: string) => FakeAnswer | Promise<FakeAnswer>;
  flush(): Promise<void>;
  runTimers(): Promise<void>;
  last(): FakeSocket;
  open(s?: FakeSocket): void;
  init(s?: FakeSocket): void;
  close(code: number, s?: FakeSocket): void;
  banner(): HTMLElement | null;
  prompt(): HTMLElement | null;
}

type StorageFault = "throw-read" | "throw-write" | "throw-all";
interface PageOptions { injected?: string; sessionToken?: string; reloadFlag?: boolean; name?: string; storage?: StorageFault }

/** A sessionStorage whose reads, writes or both throw (storage blocked). */
function faultyStorage(fault: StorageFault): Storage {
  const data = new Map<string, string>();
  const readFails = fault !== "throw-write";
  const writeFails = fault !== "throw-read";
  const blocked = (): never => { throw new Error("storage blocked"); };
  return {
    get length(): number { return data.size; },
    key: (i: number): string | null => [...data.keys()][i] ?? null,
    getItem: (k: string): string | null => (readFails ? blocked() : data.get(k) ?? null),
    setItem: (k: string, v: string): void => { if (writeFails) blocked(); data.set(k, v); },
    removeItem: (k: string): void => { if (writeFails) blocked(); data.delete(k); },
    clear: (): void => { if (writeFails) blocked(); data.clear(); },
  };
}

function makePage(opts: PageOptions = {}): Page {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="connection-dot"></div><div id="you-pill"></div><span id="you-name-display"></span>' +
    '<span id="you-avatar"></span><input id="sender-name" type="hidden" value="human"><div id="template-list"></div>' +
    '<div id="session-status"></div><span id="instance-name"></span><div id="rail-brand"></div><div class="app"></div></body></html>',
    { runScripts: "outside-only", url: "http://joind.test/" },
  );
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
  if (opts.sessionToken) win.sessionStorage.setItem("joind-web-token", opts.sessionToken);
  if (opts.reloadFlag) win.sessionStorage.setItem("joind-token-reload", "1");
  if (opts.name) win.localStorage.setItem("joind-sender-name", opts.name);
  if (opts.injected) win.__JOIND_TOKEN = opts.injected;
  if (opts.storage) Object.defineProperty(win, "sessionStorage", { configurable: true, value: faultyStorage(opts.storage) });

  const page = {
    win, sockets: [] as FakeSocket[], fetches: [] as FetchCall[], timers: [] as Timer[], intervals: [] as Interval[], reloads: 0,
    route: (_url: string, _method: string): FakeAnswer | Promise<FakeAnswer> => ({ status: 200, body: [] }),
  } as Page;

  let timerId = 0;
  win.__fakeSetTimeout = (fn: () => void, ms: number): number => { timerId += 1; page.timers.push({ id: timerId, fn, ms }); return timerId; };
  win.__fakeClearTimeout = (id: number): void => { page.timers = page.timers.filter((t) => t.id !== id); };
  win.__fakeSetInterval = (fn: () => void, ms: number): number => { timerId += 1; page.intervals.push({ id: timerId, fn, ms }); return timerId; };
  win.__fakeClearInterval = (id: number): void => { page.intervals = page.intervals.filter((t) => t.id !== id); };
  win.__fakeLocation = { protocol: "http:", host: "joind.test", reload: (): void => { page.reloads += 1; } };

  class FakeWS implements FakeSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    sent: string[] = [];
    constructor(public url: string) { page.sockets.push(this); }
    send(data: string): void { this.sent.push(data); }
    close(): void { this.readyState = 3; }
  }
  win.__FakeWS = FakeWS;

  const answer = (a: FakeAnswer): unknown => {
    const make = (): unknown => ({
      status: a.status, ok: a.status >= 200 && a.status < 300,
      json: (): Promise<unknown> => (a.body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(JSON.parse(JSON.stringify(a.body)))),
      clone: (): unknown => make(),
    });
    return make();
  };
  win.Headers = Headers;
  win.fetch = ((input: string, init?: { method?: string; headers?: Headers; body?: string }): Promise<unknown> => {
    const method = init?.method ?? "GET";
    const token = init?.headers instanceof Headers ? init.headers.get("X-Joind-Token") : null;
    page.fetches.push({ url: input, method, token, body: init?.body ? JSON.parse(init.body) as unknown : undefined });
    return Promise.resolve(page.route(input, method)).then(answer);
  }) as unknown as typeof fetch;

  win.eval(HELPERS);
  const prelude = LIFTED_VARS.map(liftVar).join("\n");
  const body = LIFTED_FUNCTIONS.map(lift).join("\n");
  win.eval(
    "(function(location, setTimeout, clearTimeout, WebSocket, setInterval, clearInterval) {\n" +
    prelude + "\n" + STUBS + "\n" + liftFetchWrapper() + "\n" + body + "\n" +
    "window.__page = { v: function(n) { return eval(n); }, run: function(src) { return eval(src); } };\n" +
    "})(window.__fakeLocation, window.__fakeSetTimeout, window.__fakeClearTimeout, window.__FakeWS, window.__fakeSetInterval, window.__fakeClearInterval);",
  );
  page.api = win.__page as PageApi;
  page.api.run("setupYouPill()");

  page.flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };
  page.runTimers = async (): Promise<void> => {
    const due = page.timers.slice();
    page.timers = [];
    for (const t of due) t.fn();
    await page.flush();
  };
  page.last = (): FakeSocket => page.sockets[page.sockets.length - 1];
  page.open = (s?: FakeSocket): void => { const k = s ?? page.last(); k.readyState = 1; k.onopen?.(); };
  page.init = (s?: FakeSocket): void => {
    const k = s ?? page.last();
    k.onmessage?.({ data: JSON.stringify({ type: "init", data: { agents: [], messages: [], conversations: [{ id: "c1", name: "ops" }], activeConversation: null } }) });
  };
  page.close = (code: number, s?: FakeSocket): void => { const k = s ?? page.last(); k.readyState = 3; k.onclose?.({ code }); };
  page.banner = (): HTMLElement | null => win.document.getElementById("auth-banner");
  page.prompt = (): HTMLElement | null => win.document.getElementById("web-token-overlay");
  return page;
}

const nameOf = (s: FakeSocket): string | null => new URL(s.url).searchParams.get("name");
const tokenOf = (s: FakeSocket): string | null => new URL(s.url).searchParams.get("token");

describe("fix 1: the page adopts the registered name before it connects", () => {
  let page: Page;
  beforeEach(() => { page = makePage({ sessionToken: TOKEN }); });

  it("a fresh browser (name human) adopts the 409's name and the socket claims it", async () => {
    page.route = (url) => url === "/api/web/register" ? { status: 409, body: { error: "name already registered", registered: "Rami" } } : { status: 200, body: [] };
    page.api.run("bootSession()");
    await page.flush();
    const reg = page.fetches.find((f) => f.url === "/api/web/register");
    expect(reg?.body).toEqual({ token: TOKEN, name: "human" });
    expect(page.sockets).toHaveLength(1);
    expect(nameOf(page.last())).toBe("Rami");
    expect(page.win.localStorage.getItem("joind-sender-name")).toBe("Rami");
    expect((page.win.document.getElementById("sender-name") as HTMLInputElement).value).toBe("Rami");
    // No rename goes out on open: the server already holds the name.
    page.open();
    expect(page.last().sent).toEqual([]);
  });

  it("a name refused with nothing to adopt never opens a socket: the banner says so, Retry tries again", async () => {
    page.route = (url) => url === "/api/web/register" ? { status: 409, body: { error: "Kira is a read-only seat's name; pick another name" } } : { status: 200, body: [] };
    page.api.run("bootSession()");
    await page.flush();
    expect(page.sockets).toHaveLength(0);
    expect(page.banner()?.textContent).toContain("read-only seat");
    page.route = (url) => url === "/api/web/register" ? { status: 200, body: { ok: true, name: "human" } } : { status: 200, body: [] };
    (page.win.document.getElementById("auth-banner-retry") as HTMLButtonElement).click();
    await page.flush();
    expect(page.sockets).toHaveLength(1);
    expect(nameOf(page.last())).toBe("human");
  });
});

describe("fix 2: the auth counter resets on init, not on open", () => {
  let page: Page;
  beforeEach(() => {
    page = makePage({ sessionToken: TOKEN, name: "Rami" });
    page.route = (url) => url === "/api/web/register" ? { status: 200, body: { ok: true, name: "Rami" } } : { status: 200, body: [] };
  });

  it("accept-then-close 4403 three times in a row stops on a visible banner, not a silent loop", async () => {
    page.api.run("bootSession()");
    await page.flush();
    for (let round = 1; round <= 3; round++) {
      expect(page.sockets).toHaveLength(round);
      page.open(); // the server accepts the upgrade first, then refuses
      page.close(4403);
      await page.flush();
      expect(page.api.v("wsAuthFailures")).toBe(round);
      if (round < 3) {
        expect(page.timers).toHaveLength(1);
        expect(page.banner()).toBeNull();
        await page.runTimers(); // re-register, then connect again
      }
    }
    expect(page.timers).toHaveLength(0); // no further reconnect
    expect(page.banner()).not.toBeNull();
    expect(page.banner()?.textContent).toContain("refusing this tab's name");
    expect(page.win.document.getElementById("auth-banner-token")).not.toBeNull();
    expect(page.fetches.filter((f) => f.url === "/api/web/register")).toHaveLength(3);
  });

  it("an init between refusals resets the count and clears the banner", async () => {
    page.api.run("bootSession()");
    await page.flush();
    page.open(); page.close(4403); await page.flush();
    await page.runTimers();
    page.open(); page.close(4403); await page.flush();
    expect(page.api.v("wsAuthFailures")).toBe(2);
    await page.runTimers();
    page.open(); page.init();
    expect(page.api.v("wsAuthFailures")).toBe(0);
    page.close(4403); await page.flush();
    expect(page.api.v("wsAuthFailures")).toBe(1);
    expect(page.banner()).toBeNull();
  });

  it("a 4403 re-registers and adopts a name another tab set", async () => {
    page.api.run("bootSession()");
    await page.flush();
    expect(nameOf(page.last())).toBe("Rami");
    page.route = (url) => url === "/api/web/register" ? { status: 409, body: { error: "x", registered: "Admiral" } } : { status: 200, body: [] };
    page.open(); page.close(4403); await page.flush();
    await page.runTimers();
    expect(nameOf(page.last())).toBe("Admiral");
  });

  it("an ordinary close reconnects with the same name after the delay", async () => {
    page.api.run("bootSession()");
    await page.flush();
    page.open(); page.init(); page.close(1006); await page.flush();
    expect(page.timers).toHaveLength(1);
    expect(page.timers[0].ms).toBe(2000);
    await page.runTimers();
    expect(page.sockets).toHaveLength(2);
    expect(page.fetches.filter((f) => f.url === "/api/web/register")).toHaveLength(1);
  });
});

describe("fix 3: a stale injected token reloads the page once, then prompts", () => {
  it("the first 4401 reloads and sets the guard", async () => {
    const page = makePage({ injected: TOKEN, name: "Rami" });
    page.route = (url) => url === "/api/web/register" ? { status: 403, body: { error: "unauthorized" } } : { status: 200, body: [] };
    page.api.run("bootSession()");
    await page.flush();
    expect(page.sockets).toHaveLength(1); // a refused token still connects: the 4401 decides
    page.open(); page.close(4401); await page.flush();
    expect(page.reloads).toBe(1);
    expect(page.win.sessionStorage.getItem("joind-token-reload")).toBe("1");
    expect(page.prompt()).toBeNull();
  });

  it("a 4401 straight after that reload prompts instead, and the typed token replaces the injected one", async () => {
    const page = makePage({ injected: TOKEN, name: "Rami", reloadFlag: true });
    page.route = (url) => url === "/api/web/register" ? { status: 200, body: { ok: true, name: "Rami" } } : { status: 200, body: [] };
    page.api.run("bootSession()");
    await page.flush();
    page.open(); page.close(4401); await page.flush();
    expect(page.reloads).toBe(0);
    expect(page.prompt()).not.toBeNull();
    expect(page.banner()).not.toBeNull();
    expect(page.timers).toHaveLength(0);
    expect(page.api.run("webToken()")).toBe(""); // the stale injected token is no longer sent
    const fresh = "b".repeat(64);
    const input = page.prompt()!.querySelector("input") as HTMLInputElement;
    input.value = fresh;
    (page.prompt()!.querySelector("button") as HTMLButtonElement).click();
    await page.flush();
    expect(page.prompt()).toBeNull();
    expect(page.banner()).toBeNull();
    expect(page.sockets).toHaveLength(2);
    expect(tokenOf(page.last())).toBe(fresh);
    page.open(); page.init();
    expect(page.win.sessionStorage.getItem("joind-token-reload")).toBeNull();
  });

  it("an init clears the guard, so a later token change may reload once again", async () => {
    const page = makePage({ injected: TOKEN, name: "Rami", reloadFlag: true });
    page.route = (url) => url === "/api/web/register" ? { status: 200, body: { ok: true, name: "Rami" } } : { status: 200, body: [] };
    page.api.run("bootSession()");
    await page.flush();
    page.open(); page.init();
    expect(page.win.sessionStorage.getItem("joind-token-reload")).toBeNull();
    page.close(4401); await page.flush();
    expect(page.reloads).toBe(1);
  });

  it("a typed token refused (4401) is dropped and asked for again, once", async () => {
    const page = makePage({ sessionToken: TOKEN, name: "Rami" });
    page.route = (url) => url === "/api/web/register" ? { status: 403, body: { error: "unauthorized" } } : { status: 200, body: [] };
    page.api.run("bootSession()");
    await page.flush();
    page.open(); page.close(4401); await page.flush();
    expect(page.reloads).toBe(0);
    expect(page.win.sessionStorage.getItem("joind-web-token")).toBeNull();
    expect(page.win.document.querySelectorAll("#web-token-overlay")).toHaveLength(1);
    page.api.run("promptWebToken(function() {})"); // a second ask while one is open
    expect(page.win.document.querySelectorAll("#web-token-overlay")).toHaveLength(1);
  });
});

describe("fix 4: a refused token on any /api/ read shows the banner", () => {
  it("a 401 or a 403 'unauthorized' with a token held shows it once; a permission 403 does not", async () => {
    const page = makePage({ sessionToken: TOKEN, name: "Rami" });
    page.route = (url) => url === "/api/edit" ? { status: 403, body: { error: "Only the original sender can edit" } } : { status: 200, body: [] };
    await page.win.fetch("/api/edit");
    await page.flush();
    expect(page.banner()).toBeNull();
    page.route = () => ({ status: 401, body: { error: "Agent credential required" } });
    await page.win.fetch("/api/dms");
    await page.win.fetch("/api/sessions");
    await page.flush();
    expect(page.win.document.querySelectorAll("#auth-banner")).toHaveLength(1);
    expect(page.banner()?.textContent).toContain("refused the web token");
    expect(page.fetches.every((f) => f.token === TOKEN)).toBe(true);
  });

  it("no banner when no token is held (the prompt covers that case)", async () => {
    const page = makePage({ name: "Rami" });
    page.route = () => ({ status: 401, body: { error: "Agent credential required" } });
    await page.win.fetch("/api/crew");
    await page.flush();
    expect(page.banner()).toBeNull();
  });

  it("the banner's Enter token opens the prompt; a token entered reconnects at once, cancelling the pending retry", async () => {
    const page = makePage({ sessionToken: TOKEN, name: "Rami" });
    page.route = (url) => url === "/api/web/register" ? { status: 200, body: { ok: true, name: "Rami" } } : { status: 200, body: [] };
    page.api.run("bootSession()");
    await page.flush();
    page.open(); page.close(4403); await page.flush();
    expect(page.timers).toHaveLength(1);
    page.api.run("showAuthBanner('x', { token: true, retry: true })");
    (page.win.document.getElementById("auth-banner-token") as HTMLButtonElement).click();
    const input = page.prompt()!.querySelector("input") as HTMLInputElement;
    input.value = TOKEN;
    (page.prompt()!.querySelector("button") as HTMLButtonElement).click();
    await page.flush();
    expect(page.timers).toHaveLength(0);
    expect(page.sockets).toHaveLength(2);
  });
});

describe("fix 5: boot reads run again after the boot prompt, and refusals are not lists", () => {
  it("a refused crew, templates and sessions read keeps the lists and throws nothing", async () => {
    const page = makePage({ name: "Rami" });
    page.route = () => ({ status: 401, body: { error: "Agent credential required" } });
    page.api.run("crewRoster = [{ name: 'kept' }]; sessionTemplates = [{ name: 'kept' }];");
    page.api.run("loadCrewRoster(); loadTemplates(); refreshSessionStatus();");
    await page.flush();
    expect(page.api.v("crewRoster")).toEqual([{ name: "kept" }]);
    expect(page.api.v("sessionTemplates")).toEqual([{ name: "kept" }]);
  });

  it("with no token at boot, the prompt's token re-runs crew, templates, instance, notifications and decisions, then connects", async () => {
    const page = makePage({ name: "human" });
    let authed = false;
    page.route = (url) => {
      if (!authed) return { status: 401, body: { error: "Agent credential required" } };
      if (url === "/api/web/register") return { status: 409, body: { error: "x", registered: "Rami" } };
      if (url === "/api/crew") return { status: 200, body: [{ name: "Kira", joinAs: "Kira" }] };
      if (url === "/api/templates") return { status: 200, body: [{ name: "review" }] };
      if (url === "/api/instance") return { status: 200, body: { name: "Y530" } };
      return { status: 200, body: [] };
    };
    // The page's boot order: the prompt, then the one-shot reads (refused).
    page.api.run("bootSession(); loadTemplates(); loadCrewRoster(); loadInstanceInfo();");
    await page.flush();
    expect(page.prompt()).not.toBeNull();
    expect(page.api.v("crewRoster")).toEqual([]);
    authed = true;
    const input = page.prompt()!.querySelector("input") as HTMLInputElement;
    input.value = TOKEN;
    (page.prompt()!.querySelector("button") as HTMLButtonElement).click();
    await page.flush();
    expect(page.api.v("crewRoster")).toEqual([{ name: "Kira", joinAs: "Kira" }]);
    expect(page.api.v("sessionTemplates")).toEqual([{ name: "review" }]);
    expect(page.win.document.getElementById("instance-name")?.textContent).toBe("Y530");
    const calls = page.api.v("calls") as Record<string, number>;
    expect(calls.loadNotifications).toBe(1);
    expect(calls.refreshDecisionsBadge).toBe(1);
    expect(page.sockets).toHaveLength(1);
    expect(nameOf(page.last())).toBe("Rami");
    expect(tokenOf(page.last())).toBe(TOKEN);
  });
});

// --- round 2 (gate 1 findings) -------------------------------------------

function typeToken(page: Page, value: string): void {
  const input = page.prompt()!.querySelector("input") as HTMLInputElement;
  input.value = value;
  (page.prompt()!.querySelector("button") as HTMLButtonElement).click();
}
const registerOk = (url: string): FakeAnswer =>
  url === "/api/web/register" ? { status: 200, body: { ok: true, name: "Rami" } } : { status: 200, body: [] };
const live = (page: Page): FakeSocket[] => page.sockets.filter((s) => s.readyState !== 3);

describe("round 2, finding 1: sessionStorage is optional, a typed token lives in page memory", () => {
  it("storage blocked entirely: a stale injected token prompts, and the typed token is used", async () => {
    const page = makePage({ injected: "stale", name: "Rami", storage: "throw-all" });
    page.route = registerOk;
    page.api.run("bootSession()");
    await page.flush();
    page.open(); page.close(4401); await page.flush();
    expect(page.reloads).toBe(0); // no guard can be stored: never reload
    expect(page.prompt()).not.toBeNull();
    typeToken(page, "correct");
    await page.flush();
    expect(page.api.run("webToken()")).toBe("correct");
    expect(page.prompt()).toBeNull();
    expect(tokenOf(page.last())).toBe("correct");
    const reg = page.fetches.filter((f) => f.url === "/api/web/register").pop();
    expect(reg?.body).toEqual({ token: "correct", name: "Rami" });
  });

  it("writes throw: the boot prompt's token still connects (user-set mode)", async () => {
    const page = makePage({ name: "Rami", storage: "throw-write" });
    page.route = registerOk;
    page.api.run("bootSession()");
    await page.flush();
    expect(page.prompt()).not.toBeNull();
    typeToken(page, TOKEN);
    await page.flush();
    expect(page.prompt()).toBeNull();
    expect(page.sockets).toHaveLength(1);
    expect(tokenOf(page.last())).toBe(TOKEN);
  });

  it("reads throw: the boot prompt's token still connects (user-set mode)", async () => {
    const page = makePage({ name: "Rami", storage: "throw-read" });
    page.route = registerOk;
    page.api.run("bootSession()");
    await page.flush();
    typeToken(page, TOKEN);
    await page.flush();
    expect(page.sockets).toHaveLength(1);
    expect(tokenOf(page.last())).toBe(TOKEN);
    expect(page.fetches.filter((f) => f.url === "/api/web/register").every((f) => f.token === TOKEN)).toBe(true);
  });

  it("the memory copy is dropped on a 4401 refusal and on sign out", async () => {
    const page = makePage({ name: "Rami", storage: "throw-all" });
    page.route = registerOk;
    page.api.run("bootSession()");
    await page.flush();
    typeToken(page, TOKEN);
    await page.flush();
    page.open(); page.close(4401); await page.flush();
    expect(page.api.run("webToken()")).toBe("");
    expect(page.prompt()).not.toBeNull();
    typeToken(page, TOKEN);
    await page.flush();
    expect(page.api.run("webToken()")).toBe(TOKEN);
    page.api.run("signOut()");
    expect(page.api.run("webToken()")).toBe("");
  });
});

describe("round 2, finding 2: one registration and connection attempt at a time", () => {
  for (const order of ["in order", "in reverse"] as const) {
    it(`a double Retry with a delayed register (replies ${order}) ends with one live socket; sign out leaves none`, async () => {
      const page = makePage({ sessionToken: TOKEN, name: "Rami" });
      const held: Array<(a: FakeAnswer) => void> = [];
      page.route = (url) => url === "/api/web/register"
        ? new Promise<FakeAnswer>((resolve) => { held.push(resolve); })
        : { status: 200, body: [] };
      page.api.run("reconnectWithToken(); reconnectWithToken();");
      await page.flush();
      const replies = order === "in order" ? held.slice() : held.slice().reverse();
      for (const resolve of replies) { resolve({ status: 200, body: { ok: true, name: "Rami" } }); await page.flush(); }
      expect(live(page)).toHaveLength(1);
      page.open(live(page)[0]); page.init(live(page)[0]);
      page.api.run("signOut()");
      expect(live(page)).toHaveLength(0);
    });
  }

  it("a replaced socket is closed and its open, messages and close are ignored", () => {
    const page = makePage({ sessionToken: TOKEN, name: "Rami" });
    page.api.run("connect(); connect();");
    expect(page.sockets).toHaveLength(2);
    const [old, cur] = page.sockets;
    expect(old.readyState).toBe(3);
    old.readyState = 1; old.onopen?.();
    page.init(old);
    expect(page.api.v("socketInitCount")).toBe(0);
    expect((page.api.v("calls") as Record<string, number>).refreshDecisionsBadge).toBeUndefined();
    old.readyState = 3; old.onclose?.({ code: 4401 });
    expect(page.prompt()).toBeNull();
    expect(page.timers).toHaveLength(0);
    page.open(cur); page.init(cur);
    expect(page.api.v("socketInitCount")).toBe(1);
  });

  it("sign out closes every socket the tab opened and cancels the pending reconnect", async () => {
    const page = makePage({ sessionToken: TOKEN, name: "Rami" });
    page.route = registerOk;
    page.api.run("bootSession()");
    await page.flush();
    page.open(); page.init(); page.close(1006); await page.flush();
    expect(page.timers).toHaveLength(1);
    page.api.run("signOut()");
    expect(page.timers).toHaveLength(0);
    expect(live(page)).toHaveLength(0);
  });
});

describe("round 2, finding 3: a refusal from an earlier auth episode does not bring the banner back", () => {
  it("a 401 sent before recovery and answered after init is ignored", async () => {
    const page = makePage({ sessionToken: TOKEN, name: "Rami" });
    const late: Array<(a: FakeAnswer) => void> = [];
    page.route = (url) => url === "/api/dms"
      ? new Promise<FakeAnswer>((resolve) => { late.push(resolve); })
      : registerOk(url);
    const pending = page.win.fetch("/api/dms");
    page.api.run("showAuthBanner(TOKEN_REFUSED_TEXT, { token: true, retry: true })");
    page.api.run("bootSession()");
    await page.flush();
    page.open(); page.init();
    expect(page.banner()).toBeNull();
    late[0]({ status: 401, body: { error: "Agent credential required" } });
    await pending;
    await page.flush();
    expect(page.banner()).toBeNull();
  });

  it("a refusal whose body parses only after the banner cleared is ignored", async () => {
    const page = makePage({ sessionToken: TOKEN, name: "Rami" });
    const bodies: Array<(b: unknown) => void> = [];
    (page.api.run("noteRefusedAnswer") as (r: unknown) => void)({
      status: 401,
      clone: () => ({ json: () => new Promise((resolve) => { bodies.push(resolve); }) }),
    });
    page.api.run("hideAuthBanner()");
    bodies[0]({ error: "unauthorized" });
    await page.flush();
    expect(page.banner()).toBeNull();
  });

  it("a refusal of a request sent after recovery still shows the banner", async () => {
    const page = makePage({ sessionToken: TOKEN, name: "Rami" });
    page.route = registerOk;
    page.api.run("bootSession()");
    await page.flush();
    page.open(); page.init();
    page.route = () => ({ status: 401, body: { error: "Agent credential required" } });
    await page.win.fetch("/api/dms");
    await page.flush();
    expect(page.banner()).not.toBeNull();
  });

  it("the same banner state again keeps its buttons (and focus); a new state rebuilds", () => {
    const page = makePage({ sessionToken: TOKEN, name: "Rami" });
    page.api.run("showAuthBanner(TOKEN_REFUSED_TEXT, { token: true, retry: true })");
    const btn = page.win.document.getElementById("auth-banner-token") as HTMLButtonElement;
    btn.focus();
    page.api.run("showAuthBanner(TOKEN_REFUSED_TEXT, { token: true, retry: true })");
    expect(page.win.document.getElementById("auth-banner-token")).toBe(btn);
    expect(page.win.document.activeElement).toBe(btn);
    page.api.run("showAuthBanner('Name refused', { retry: true })");
    expect(page.win.document.getElementById("auth-banner-token")).toBeNull();
    expect(page.banner()?.textContent).toContain("Name refused");
  });
});

// The notification bell and the decisions badge: a refused read keeps what
// the page shows instead of parsing the error body as data.
function miniPage(src: string, ans: FakeAnswer): PageApi {
  const dom = new JSDOM('<!doctype html><body><span id="notify-badge"></span><span id="decisions-badge"></span></body>', { runScripts: "outside-only", url: "http://joind.test/" });
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
  win.fetch = ((): Promise<unknown> => Promise.resolve({
    status: ans.status, ok: ans.status >= 200 && ans.status < 300,
    json: (): Promise<unknown> => Promise.resolve(JSON.parse(JSON.stringify(ans.body ?? null))),
  })) as unknown as typeof fetch;
  win.eval("(function() {\nvar calls = {};\nfunction count(n) { calls[n] = (calls[n] || 0) + 1; }\n" + src +
    "\nwindow.__page = { v: function(n) { return eval(n); }, run: function(s) { return eval(s); } };\n})();");
  return win.__page as PageApi;
}
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };
const REFUSED: FakeAnswer = { status: 401, body: { error: "Agent credential required" } };

describe("round 2, gap: notifications and the decisions badge check r.ok", () => {
  const NOTIFY = `
var notifyEpoch = 0, notifyGeneration = 'g1', notifyItems = [{ id: 1, read: false }], notifyUnread = 1, notifyPanelOpen = false;
function adoptNotifyGeneration() { count('adoptNotifyGeneration'); }
function renderNotifyBadge() { count('renderNotifyBadge'); }
function renderNotifyPanel() {}
` + lift("loadNotifications");
  const DECISIONS = `
var decisionsSeq = 0, decisionsFetchId = 0, decisionsCache = [{ id: 'd1' }], decisionsPanelOpen = false, pageNow = '';
function webToken() { return 'x'; }
function renderDecisionsPanel() {}
function refreshPalette() { count('refreshPalette'); }
function loadDecisionsPage() {}
` + lift("refreshDecisionsBadge");

  it("a refused notifications read leaves the bell alone", async () => {
    const api = miniPage(NOTIFY, REFUSED);
    api.run("loadNotifications()");
    await settle();
    expect(api.v("notifyItems")).toEqual([{ id: 1, read: false }]);
    expect((api.v("calls") as Record<string, number>).renderNotifyBadge).toBeUndefined();
  });

  it("a refused decisions read keeps the cache and the badge", async () => {
    const api = miniPage(DECISIONS, REFUSED);
    api.run("refreshDecisionsBadge()");
    await settle();
    expect(api.v("decisionsCache")).toEqual([{ id: "d1" }]);
    expect((api.v("calls") as Record<string, number>).refreshPalette).toBeUndefined();
  });

  it("an accepted read still lands", async () => {
    const n = miniPage(NOTIFY, { status: 200, body: { generation: "g1", notifications: [{ id: 2, read: false }] } });
    n.run("loadNotifications()");
    await settle();
    expect((n.v("notifyItems") as Array<{ id: number }>).map((x) => x.id)).toEqual([2, 1]);
    const d = miniPage(DECISIONS, { status: 200, body: { decisions: [] } });
    d.run("refreshDecisionsBadge()");
    await settle();
    expect(d.v("decisionsCache")).toEqual([]);
  });
});

// --- follow-ups from the web-reconnect gate (round 2, Medium 1) ----------

/** Sign out, then press Sign in on the signed-out screen. */
function signOutAndPressSignIn(page: Page): void {
  page.api.run("signOut()");
  const btn = page.win.document.querySelector("#signed-out button") as HTMLButtonElement | null;
  expect(btn).not.toBeNull();
  btn!.click();
}

describe("follow-up 1: Sign in after sign out resumes in place, so a typed token is asked for once", () => {
  for (const storage of ["blocked", "working"] as const) {
    it(`storage ${storage}: one token entry, no reload, exactly one live socket`, async () => {
      const page = makePage(storage === "blocked" ? { name: "Rami", storage: "throw-all" } : { name: "Rami" });
      page.route = registerOk;
      page.api.run("bootSession()");
      await page.flush();
      typeToken(page, TOKEN);
      await page.flush();
      page.open(); page.init();
      const before = page.sockets.slice();
      expect(live(page)).toHaveLength(1);

      signOutAndPressSignIn(page);
      expect(live(page)).toHaveLength(0);
      expect(page.prompt()).not.toBeNull(); // the token was dropped on sign out: asked once
      let entries = 0;
      typeToken(page, TOKEN); entries += 1;
      await page.flush();

      expect(page.reloads).toBe(0);
      expect(page.prompt()).toBeNull(); // not asked a second time
      expect(entries).toBe(1);
      expect(page.api.v("signedOut")).toBe(false);
      expect(page.win.document.getElementById("signed-out")).toBeNull();
      expect((page.win.document.querySelector(".app") as HTMLElement & { inert?: boolean }).inert).toBe(false);
      expect(live(page)).toHaveLength(1);
      expect(tokenOf(page.last())).toBe(TOKEN);
      const reg = page.fetches.filter((f) => f.url === "/api/web/register").pop();
      expect(reg?.body).toEqual({ token: TOKEN, name: "Rami" });
      page.open(); page.init();
      expect(live(page)).toHaveLength(1);

      // A close event of a socket from before sign out arriving late opens nothing.
      for (const old of before) old.onclose?.({ code: 1006 });
      await page.flush();
      expect(page.timers).toHaveLength(0);
      expect(live(page)).toHaveLength(1);
      if (storage === "working") expect(page.win.sessionStorage.getItem("joind-web-token")).toBe(TOKEN);
    });
  }

  it("the boot reads run again and the polls that sign out stopped restart, once each", async () => {
    const page = makePage({ name: "Rami", storage: "throw-all" });
    page.route = registerOk;
    page.api.run("bootSession()");
    await page.flush();
    typeToken(page, TOKEN);
    await page.flush();
    page.open(); page.init();
    signOutAndPressSignIn(page);
    const reads = (page.api.v("calls") as Record<string, number>).loadNotifications ?? 0;
    expect(page.intervals).toHaveLength(0);
    typeToken(page, TOKEN);
    await page.flush();
    expect((page.api.v("calls") as Record<string, number>).loadNotifications).toBe(reads + 1);
    expect(page.intervals.map((i) => i.ms).sort((a, b) => a - b)).toEqual([3000, 60000]);
    // A second resume (a stray call) changes nothing: still one socket, two polls.
    page.api.run("resumeSession()");
    await page.flush();
    expect(live(page)).toHaveLength(1);
    expect(page.intervals).toHaveLength(2);
  });

  it("sign out again after a resume still closes everything", async () => {
    const page = makePage({ name: "Rami", storage: "throw-all" });
    page.route = registerOk;
    page.api.run("bootSession()");
    await page.flush();
    typeToken(page, TOKEN);
    await page.flush();
    page.open(); page.init();
    signOutAndPressSignIn(page);
    typeToken(page, TOKEN);
    await page.flush();
    page.open(); page.init();
    page.api.run("signOut()");
    expect(live(page)).toHaveLength(0);
    expect(page.intervals).toHaveLength(0);
    expect(page.api.run("webToken()")).toBe("");
  });

  it("a served (injected) token still reloads on Sign in: the server hands the token to the new page", () => {
    const page = makePage({ injected: TOKEN, name: "Rami" });
    signOutAndPressSignIn(page);
    expect(page.reloads).toBe(1);
    expect(page.prompt()).toBeNull();
  });
});

describe("round 2 (gate 1 finding 1): a resumed session reconciles the view left on screen", () => {
  interface Task { id: number; status: string }
  const BEFORE: Task[] = [{ id: 1, status: "open" }];
  const AFTER: Task[] = [{ id: 1, status: "done" }, { id: 2, status: "open" }];

  /** The server's task store, changed by the test while the tab is signed out. */
  function taskServer(page: Page, store: { list: Task[] }): void {
    page.route = (url: string): FakeAnswer => {
      if (url === "/api/web/register") return { status: 200, body: { ok: true, name: "Rami" } };
      if (url.indexOf("/api/tasks?") === 0) return { status: 200, body: store.list };
      return { status: 200, body: [] };
    };
  }
  /** An init that lands in room c1 (the room the task panel belongs to). */
  function initInRoom(page: Page): void {
    page.last().onmessage?.({ data: JSON.stringify({ type: "init", data: {
      agents: [], messages: [], conversations: [{ id: "c1", name: "ops" }], activeConversation: { id: "c1", name: "ops" },
    } }) });
  }
  async function signedIn(page: Page): Promise<void> {
    page.api.run("bootSession()");
    await page.flush();
    typeToken(page, TOKEN);
    await page.flush();
    page.open(); initInRoom(page);
    await page.flush();
  }
  async function signOutChangeSignIn(page: Page, store: { list: Task[] }): Promise<void> {
    signOutAndPressSignIn(page);
    store.list = AFTER; // an agent completes task 1 and adds task 2 meanwhile
    typeToken(page, TOKEN);
    await page.flush();
    page.open(); initInRoom(page);
    await page.flush();
  }
  const calls = (page: Page): Record<string, number> => page.api.v("calls") as Record<string, number>;

  for (const storage of ["blocked", "working"] as const) {
    it(`storage ${storage}: the Tasks board shows the tasks changed during sign out`, async () => {
      const page = makePage(storage === "blocked" ? { name: "Rami", storage: "throw-all" } : { name: "Rami" });
      const store = { list: BEFORE };
      taskServer(page, store);
      await signedIn(page);
      page.api.run("pageNow = 'tasks'; board.tasks = " + JSON.stringify(BEFORE));
      await signOutChangeSignIn(page, store);
      expect((page.api.v("board") as { tasks: Task[] }).tasks).toEqual(AFTER);
      expect(page.reloads).toBe(0);
    });
  }

  it("an open task panel shows the tasks changed during sign out (init keeps a same-room list)", async () => {
    const page = makePage({ name: "Rami", storage: "throw-all" });
    const store = { list: BEFORE };
    taskServer(page, store);
    await signedIn(page);
    page.api.run("taskPanelOpen = true; tasks = " + JSON.stringify(BEFORE) + "; tasksConvId = 'c1'");
    await signOutChangeSignIn(page, store);
    expect(page.api.v("tasks")).toEqual(AFTER);
    expect(page.api.v("taskPanelOpen")).toBe(true);
  });

  it("requests sent before sign out never paint after the resume", async () => {
    const page = makePage({ name: "Rami", storage: "throw-all" });
    const store = { list: BEFORE };
    taskServer(page, store);
    await signedIn(page);
    // A board reload and a panel reload go out, and stay unanswered, before sign out.
    let answerOld: (a: FakeAnswer) => void = () => undefined;
    const held: Array<(a: FakeAnswer) => void> = [];
    const route = page.route;
    page.route = (url: string, method: string): FakeAnswer | Promise<FakeAnswer> =>
      url.indexOf("/api/tasks?") === 0 ? new Promise<FakeAnswer>((r) => { held.push(r); }) : route(url, method);
    page.api.run("pageNow = 'tasks'; taskPanelOpen = true; tasksConvId = 'c1'; loadBoard(); loadTasks('c1')");
    expect(held).toHaveLength(2);
    answerOld = (a) => { for (const r of held) r(a); };
    page.route = route;
    await signOutChangeSignIn(page, store);
    expect((page.api.v("board") as { tasks: Task[] }).tasks).toEqual(AFTER);
    expect(page.api.v("tasks")).toEqual(AFTER);
    const boardPaints = calls(page).renderBoard ?? 0;
    const panelPaints = calls(page).renderTaskPanel ?? 0;
    answerOld({ status: 200, body: BEFORE }); // the old session's answers arrive late
    await page.flush();
    expect((page.api.v("board") as { tasks: Task[] }).tasks).toEqual(AFTER);
    expect(page.api.v("tasks")).toEqual(AFTER);
    expect(calls(page).renderBoard ?? 0).toBe(boardPaints);
    expect(calls(page).renderTaskPanel ?? 0).toBe(panelPaints);
  });

  it("a request sent before sign out that fails late is silent too", async () => {
    const page = makePage({ name: "Rami", storage: "throw-all" });
    taskServer(page, { list: BEFORE });
    await signedIn(page);
    let failOld: () => void = () => undefined;
    const route = page.route;
    page.route = (url: string, method: string): FakeAnswer | Promise<FakeAnswer> =>
      url.indexOf("/api/tasks?scope=all") === 0 ? new Promise<FakeAnswer>((_r, reject) => { failOld = () => reject(new TypeError("Failed to fetch")); }) : route(url, method);
    page.api.run("pageNow = 'tasks'; loadBoard()");
    page.route = route;
    await signOutChangeSignIn(page, { list: AFTER });
    const paints = calls(page).renderBoard ?? 0;
    failOld();
    await page.flush();
    expect(calls(page).renderBoard ?? 0).toBe(paints);
  });

  it("the Decisions page reloads, and the Crew page repaints once its roster and templates are back", async () => {
    for (const p of ["decisions", "crew"] as const) {
      const page = makePage({ name: "Rami", storage: "throw-all" });
      taskServer(page, { list: BEFORE });
      await signedIn(page);
      page.api.run(`pageNow = '${p}'`);
      const before = { ...calls(page) };
      await signOutChangeSignIn(page, { list: AFTER });
      if (p === "decisions") expect((calls(page).loadDecisionsPage ?? 0) - (before.loadDecisionsPage ?? 0)).toBe(1);
      else expect((calls(page).renderCrewPage ?? 0) - (before.renderCrewPage ?? 0)).toBeGreaterThanOrEqual(1);
    }
  });

  it("an ordinary reconnect init (no sign out) does not reload the board", async () => {
    const page = makePage({ name: "Rami", storage: "throw-all" });
    taskServer(page, { list: BEFORE });
    await signedIn(page);
    page.api.run("pageNow = 'tasks'");
    const n = page.fetches.filter((f) => f.url.indexOf("/api/tasks?scope=all") === 0).length;
    initInRoom(page);
    await page.flush();
    expect(page.fetches.filter((f) => f.url.indexOf("/api/tasks?scope=all") === 0).length).toBe(n);
  });
});

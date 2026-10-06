/**
 * Refused answers are never read as data (6 Oct 2026, follow-up from the
 * web-reconnect gate, round 2 "Remaining limits"). Older readers in
 * public/app.js parsed the body of a non-OK answer (an { error } object under
 * agent-auth require) as a list, which cleared cached data, filled a panel
 * with nothing, or threw. Each test lifts the shipped functions from app.js
 * into JSDOM, answers every fetch through a small router, and checks that a
 * refusal leaves the page's data and panels as they were (or shows the
 * function's existing error state), while an accepted answer still lands.
 *
 * Cited by the gate: loadConversations, the launch dialog and the crew panel.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { JSDOM } from "jsdom";

const APP = readFileSync(join(__dirname, "..", "public", "app.js"), "utf8").replace(/\r\n?/g, "\n");

/** A top-level function from app.js, as shipped. */
function lift(name: string): string {
  const start = APP.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  const end = APP.indexOf("\n}\n", start + 1);
  if (end < 0) throw new Error(`end of ${name} not found in app.js`);
  return APP.slice(start + 1, end + 2);
}

interface Answer { status: number; body?: unknown; text?: string }
type Route = (url: string, method: string) => Answer;
interface PageApi { v(name: string): unknown; run(src: string): unknown }

const REFUSED: Answer = { status: 401, body: { error: "Agent credential required" } };
const UNAUTHORIZED: Answer = { status: 403, body: { error: "unauthorized" } };
const HTML_500: Answer = { status: 500, text: "<html>Internal Server Error</html>" };

const BASE_STUBS = `
var calls = {};
var args = {};
function count(n, a) { calls[n] = (calls[n] || 0) + 1; if (a) args[n] = a; }
function webToken() { return 'tok'; }
function showRefNotice(t) { count('showRefNotice', [t]); }
`;

function makePage(html: string, src: string, route: Route): { api: PageApi; win: Window & typeof globalThis } {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: "outside-only", url: "http://joind.test/" });
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
  win.fetch = ((input: string, init?: { method?: string }): Promise<unknown> => {
    const a = route(input, init?.method ?? "GET");
    const parse = (): Promise<unknown> => {
      if (a.text !== undefined) return Promise.reject(new SyntaxError("Unexpected token <"));
      if (a.body === undefined) return Promise.reject(new SyntaxError("Unexpected end of JSON input"));
      return Promise.resolve(JSON.parse(JSON.stringify(a.body)));
    };
    return Promise.resolve({ status: a.status, ok: a.status >= 200 && a.status < 300, json: parse });
  }) as unknown as typeof fetch;
  win.eval("(function() {\n" + BASE_STUBS + src +
    "\nwindow.__page = { v: function(n) { return eval(n); }, run: function(s) { return eval(s); } };\n})();");
  return { api: win.__page as PageApi, win };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r)); };
const callsOf = (api: PageApi): Record<string, number> => api.v("calls") as Record<string, number>;
const argsOf = (api: PageApi): Record<string, unknown[]> => api.v("args") as Record<string, unknown[]>;
const HELPERS = lift("refusalBody") + "\n" + lift("okJson");

// --- cited by the gate ----------------------------------------------------

describe("loadConversations (gate citation app.js:6540 at ffa12a1)", () => {
  const SRC = `
var convFetchSeq = 0, convFetchApplied = 0, pendingGeneration = 0;
var activeConversation = { id: 'c1', name: 'ops' };
var conversationList = [{ id: 'c1', name: 'ops' }, { id: 'c2', name: 'bridge' }];
function nextPendingSeq() { return 0; }
function applyLinkPayload() { count('applyLinkPayload'); }
function renderConversationList() { count('renderConversationList'); }
` + HELPERS + "\n" + lift("loadConversations");

  for (const [label, answer] of [["a 401", REFUSED], ["a 403 unauthorized", UNAUTHORIZED], ["a 500 with an HTML body", HTML_500]] as const) {
    it(`${label} keeps the room list and the active room`, async () => {
      const { api } = makePage("", SRC, () => answer);
      api.run("loadConversations()");
      await settle();
      expect(api.v("conversationList")).toEqual([{ id: "c1", name: "ops" }, { id: "c2", name: "bridge" }]);
      expect(api.v("activeConversation")).toEqual({ id: "c1", name: "ops" });
      expect(callsOf(api).renderConversationList).toBeUndefined();
      expect(api.v("convFetchApplied")).toBe(0);
    });
  }

  it("an accepted list still lands", async () => {
    const { api } = makePage("", SRC, () => ({ status: 200, body: { active: { id: "c3", name: "new" }, conversations: [{ id: "c3", name: "new" }] } }));
    api.run("loadConversations()");
    await settle();
    expect(api.v("conversationList")).toEqual([{ id: "c3", name: "new" }]);
    expect(callsOf(api).renderConversationList).toBe(1);
  });
});

describe("the launch dialog's reads (gate citation app.js:8646 at ffa12a1)", () => {
  const SRC = `
var launchDialogOverlay = null, launchCancelledInject = false;
var crewRoster = [{ name: 'Kira', path: 'D:/crew/kira' }];
var conversationList = [{ id: 'c1', name: 'ops' }];
function closeLaunchDialog() {}
function buildLaunchLoading() { var d = document.createElement('div'); d.className = 'loading'; return d; }
function buildLaunchForm(content, footer, crew, harnesses, convs, terminals, pre) { count('buildLaunchForm', [crew, harnesses, convs, terminals, pre]); }
` + HELPERS + "\n" + lift("openLaunchDialog");

  it("refused reads build the form from the roster and room list the page holds, with no error and no error body as data", async () => {
    const { api, win } = makePage("", SRC, () => REFUSED);
    api.run("openLaunchDialog('Kira')");
    await settle();
    expect(callsOf(api).buildLaunchForm).toBe(1);
    const [crew, harnesses, convs, terminals, pre] = argsOf(api).buildLaunchForm;
    expect(crew).toEqual([{ name: "Kira", path: "D:/crew/kira" }]);
    expect(harnesses).toEqual([]);
    expect(convs).toEqual([{ id: "c1", name: "ops" }]);
    expect(terminals).toEqual({ wezterm: { available: false, running: false }, wt: { available: false }, manual: { available: true } });
    expect(pre).toBe("Kira");
    expect(win.document.querySelector(".launch-error")).toBeNull();
  });

  it("a 500 with an HTML body behaves the same", async () => {
    const { api, win } = makePage("", SRC, () => HTML_500);
    api.run("openLaunchDialog()");
    await settle();
    const [crew, , convs] = argsOf(api).buildLaunchForm;
    expect(crew).toEqual([{ name: "Kira", path: "D:/crew/kira" }]);
    expect(convs).toEqual([{ id: "c1", name: "ops" }]);
    expect(win.document.querySelector(".launch-error")).toBeNull();
  });

  it("accepted reads still land", async () => {
    const { api } = makePage("", SRC, (url) => {
      if (url === "/api/crew") return { status: 200, body: [{ name: "Nog" }] };
      if (url === "/api/harnesses") return { status: 200, body: [{ id: "claude" }] };
      if (url.indexOf("/api/conversations") === 0) return { status: 200, body: { conversations: [{ id: "c9", name: "x" }] } };
      return { status: 200, body: { wezterm: { available: true, running: true }, wt: { available: false }, manual: { available: true } } };
    });
    api.run("openLaunchDialog()");
    await settle();
    const [crew, harnesses, convs, terminals] = argsOf(api).buildLaunchForm;
    expect(crew).toEqual([{ name: "Nog" }]);
    expect(harnesses).toEqual([{ id: "claude" }]);
    expect(convs).toEqual([{ id: "c9", name: "x" }]);
    expect((terminals as { wezterm: { running: boolean } }).wezterm.running).toBe(true);
  });
});

describe("the crew panel's reads (gate citation app.js:9898 at ffa12a1)", () => {
  const SRC = `
var crewPanelOverlay = null;
var crewRoster = [{ name: 'Kira', path: 'D:/crew/kira' }];
function closeCrewPanel() {}
function buildLaunchLoading() { var d = document.createElement('div'); d.className = 'loading'; return d; }
function buildCrewPanel(content, crew, meta, harnesses) { count('buildCrewPanel', [crew, meta, harnesses]); }
` + HELPERS + "\n" + lift("openCrewPanel");

  for (const [label, answer] of [["refused reads", REFUSED], ["a 500 with an HTML body", HTML_500]] as const) {
    it(`${label} show the roster the page holds, not an empty or broken panel`, async () => {
      const { api, win } = makePage("", SRC, () => answer);
      api.run("openCrewPanel()");
      await settle();
      expect(argsOf(api).buildCrewPanel).toEqual([[{ name: "Kira", path: "D:/crew/kira" }], {}, []]);
      expect(win.document.querySelector(".launch-error")).toBeNull();
    });
  }

  it("accepted reads still land", async () => {
    const { api } = makePage("", SRC, (url) => {
      if (url === "/api/crew") return { status: 200, body: [{ name: "Nog" }] };
      if (url === "/api/crew/meta") return { status: 200, body: { crewHome: "D:/crew" } };
      return { status: 200, body: [{ id: "codex" }] };
    });
    api.run("openCrewPanel()");
    await settle();
    expect(argsOf(api).buildCrewPanel).toEqual([[{ name: "Nog" }], { crewHome: "D:/crew" }, [{ id: "codex" }]]);
  });
});

// --- the rest of the sweep ------------------------------------------------

describe("room tasks: the list and the badge", () => {
  const SRC = `
var activeConversation = { id: 'c1' }, taskFilter = 'open', tasksConvId = 'c1';
var tasks = [{ id: 7, title: 'kept' }];
function taskRoomIsCurrent(id) { return !!(activeConversation && activeConversation.id === id); }
function renderTaskBadge() { count('renderTaskBadge'); }
function renderTaskPanel() { count('renderTaskPanel'); }
function renderTaskBadgeFromCount(n, u) { count('renderTaskBadgeFromCount', [n, u]); }
` + lift("loadTasks") + "\n" + lift("loadTaskCount");

  it("a refused task list keeps the cards and the panel", async () => {
    const { api } = makePage("", SRC, () => REFUSED);
    api.run("loadTasks('c1')");
    await settle();
    expect(api.v("tasks")).toEqual([{ id: 7, title: "kept" }]);
    expect(callsOf(api).renderTaskPanel).toBeUndefined();
  });

  it("a refused count leaves the badge alone (it used to read 0)", async () => {
    const { api } = makePage("", SRC, () => REFUSED);
    api.run("loadTaskCount('c1')");
    await settle();
    expect(callsOf(api).renderTaskBadgeFromCount).toBeUndefined();
  });

  it("accepted answers still land", async () => {
    const { api } = makePage("", SRC, (url) => url.indexOf("/api/tasks/count") === 0
      ? { status: 200, body: { count: 2, hasUrgent: true } }
      : { status: 200, body: [{ id: 8, title: "new" }] });
    api.run("loadTasks('c1'); loadTaskCount('c1')");
    await settle();
    expect(api.v("tasks")).toEqual([{ id: 8, title: "new" }]);
    expect(argsOf(api).renderTaskBadgeFromCount).toEqual([2, true]);
  });
});

describe("mailbox partners", () => {
  const SRC = `
var dmPartnersCache = ['Kira', 'Nog'];
function renderDmList() { count('renderDmList'); }
` + lift("fetchDmPartners");

  it("a refused read keeps the partner list and does not repaint", async () => {
    const { api } = makePage("", SRC, () => REFUSED);
    api.run("fetchDmPartners()");
    await settle();
    expect(api.v("dmPartnersCache")).toEqual(["Kira", "Nog"]);
    expect(callsOf(api).renderDmList).toBeUndefined();
  });
});

describe("the terminal scan", () => {
  const SRC = `
var autoScanInterval = 1, autoScanRunning = false, signedOut = false;
var lastScanResults = [{ pid: 1, type: 'claude' }];
function renderTerminals(t) { count('renderTerminals', [t]); }
function startAutoScan() {}
` + lift("scanTerminals") + "\n" + lift("autoScanTerminals");

  it("a refused manual scan keeps the list and frees the button", async () => {
    const { api, win } = makePage('<button id="scan-btn">Scan</button>', SRC, () => REFUSED);
    api.run("scanTerminals()");
    await settle();
    expect(api.v("lastScanResults")).toEqual([{ pid: 1, type: "claude" }]);
    expect(callsOf(api).renderTerminals).toBeUndefined();
    const btn = win.document.getElementById("scan-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Scan");
  });

  it("a refused auto scan keeps the list and can run again", async () => {
    const { api } = makePage("", SRC, () => REFUSED);
    api.run("autoScanTerminals()");
    await settle();
    expect(api.v("lastScanResults")).toEqual([{ pid: 1, type: "claude" }]);
    expect(api.v("autoScanRunning")).toBe(false);
  });
});

describe("leaving the history window", () => {
  const SRC = `
var historyView = { conv: 'c1', anchor: 5 }, historyExitSeq = 0, activeDm = null;
var activeConversation = { id: 'c1' };
var allMessages = [{ id: 5, text: 'old' }];
function renderHistoryChrome() {}
function renderChannelView() { count('renderChannelView'); }
` + HELPERS + "\n" + lift("exitHistoryView");

  it("a refused read shows the existing notice instead of painting an empty room", async () => {
    const { api } = makePage("", SRC, () => REFUSED);
    api.run("exitHistoryView()");
    await settle();
    expect(callsOf(api).renderChannelView).toBeUndefined();
    expect(argsOf(api).showRefNotice).toEqual(["Could not load the latest messages"]);
  });

  it("an accepted page still lands", async () => {
    const { api } = makePage("", SRC, () => ({ status: 200, body: [{ id: 9, text: "latest", timestamp: 1 }] }));
    api.run("exitHistoryView()");
    await settle();
    expect(api.v("allMessages")).toEqual([{ id: 9, text: "latest", timestamp: 1 }]);
    expect(callsOf(api).renderChannelView).toBe(1);
  });
});

describe("the two shared helpers", () => {
  const { api } = makePage("", HELPERS, () => REFUSED);
  const run = async (src: string): Promise<unknown> => {
    let out: unknown;
    let err: unknown;
    await (api.run(src) as Promise<unknown>).then((v) => { out = v; }, (e: unknown) => { err = e; });
    return err === undefined ? { ok: out } : { error: (err as Error).message };
  };
  const resp = (status: number, body: string | null): string =>
    `({ status: ${status}, ok: ${status >= 200 && status < 300}, json: function() { return ${body === null ? "Promise.reject(new SyntaxError('x'))" : `Promise.resolve(${body})`}; } })`;

  it("refusalBody takes the server's error, else the status", async () => {
    expect(await run(`refusalBody(${resp(403, "{ error: 'unauthorized' }")})`)).toEqual({ ok: { error: "unauthorized" } });
    expect(await run(`refusalBody(${resp(502, null)})`)).toEqual({ ok: { error: "HTTP 502" } });
    expect(await run(`refusalBody(${resp(409, "{ error: 42 }")})`)).toEqual({ ok: { error: "HTTP 409" } });
  });

  it("okJson passes an accepted body and rejects a refusal with its reason", async () => {
    expect(await run(`okJson(${resp(200, "[1, 2]")})`)).toEqual({ ok: [1, 2] });
    expect(await run(`okJson(${resp(401, "{ error: 'Agent credential required' }")})`)).toEqual({ error: "Agent credential required" });
    expect(await run(`okJson(${resp(500, null)})`)).toEqual({ error: "HTTP 500" });
  });
});

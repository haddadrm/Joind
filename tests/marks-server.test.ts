/**
 * Marks, server side (logo variant B, member variant M1):
 *
 * - The server badge: /api/instance shows the effective badge and the
 *   favicon option; POST /api/instance/badge (web token only) validates,
 *   persists in the data dir and tells every open page.
 * - The badge over a link: a home sends its badge with its room list, the
 *   peer keeps it on the link (init `links`, `link` events); an older home
 *   that sends none, or a bad badge, leaves the peer on the default.
 * - Read-only seats in the member list: the socket (web token holders only)
 *   carries the unrevoked seats at init and on mint, revoke and a read
 *   (throttled), with no token, digest or fingerprint. Seats stay out of
 *   /api/who, the agent routes and the link.
 *
 * Real servers on loopback, each binding port 0 (linked pairs name each
 * other through PeerRoutes), with temp data dirs; never the live port.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";
import type { FetchLike } from "../src/link.js";
import { PeerRoutes } from "./peer-routes.js";
import { ReadonlySeatStore, SEAT_RECENT_READ_MS } from "../src/readonly-seats.js";
import { ServerBadgeStore, badgeSettingsPath, defaultBadge } from "../src/server-badge.js";

const WEB = "e".repeat(64);
const KEY = "marks-tests-agent-key-0123456789abcdef";
const LINK = "link-token-for-marks-tests-0123456789";


function config(dir: string, instance: string, port: number, extra: Partial<JoindConfig> = {}): JoindConfig {
  return {
    port, host: "127.0.0.1", dataDir: join(dir, "data"), instance, crewHome: join(dir, "crew"),
    humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
    webToken: WEB, webTokenUserSet: true, links: [], agentAuth: "warn", agentKey: KEY,
    ...extra,
  };
}

type Resp = { status: number; json: Record<string, unknown>; text: string };

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = {}; }
  return { status: res.status, json, text };
}
const webHdr = { "X-Joind-Token": WEB };
const keyHdr = { Authorization: `Bearer ${KEY}` };

async function sleep(ms: number): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

interface WsEvent { type: string; data?: Record<string, unknown> }
interface Sock { events: WsEvent[]; raw: string[]; closed: number | null; close(): void }

/** A web socket as the page opens it (register the name, then connect). */
async function socket(base: string, token = WEB, name = "Rami"): Promise<Sock> {
  if (token === WEB) await call(base, "POST", "/api/web/register", { token, name });
  const { default: WebSocket } = await import("ws");
  const url = `${base.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`;
  const ws = new WebSocket(url);
  const s: Sock = { events: [], raw: [], closed: null, close: () => ws.close() };
  ws.on("message", (raw) => { const t = String(raw); s.raw.push(t); s.events.push(JSON.parse(t) as WsEvent); });
  ws.on("close", (code) => { s.closed = code; });
  ws.on("error", () => undefined);
  return s;
}

const of = (s: Sock, type: string): WsEvent[] => s.events.filter((e) => e.type === type);

// ---------------------------------------------------------------------------

describe("server badge store", () => {
  it("defaults, validates, persists atomically, and survives a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-badge-unit-"));
    try {
      const lines: string[] = [];
      const store = new ServerBadgeStore(dir, "ramiy530", (l) => lines.push(l));
      expect(store.effective()).toEqual({ ...defaultBadge("ramiy530"), auto: true });
      expect(store.faviconBadge()).toBe(false);
      expect(() => store.update({ code: "ABC" })).toThrow();
      expect(() => store.update({ code: "<b" })).toThrow();
      expect(() => store.update({ color: "red" })).toThrow();
      expect(() => store.update({ color: "#12345" })).toThrow();
      expect(() => store.update({ faviconBadge: "yes" })).toThrow();
      expect(existsSync(badgeSettingsPath(dir))).toBe(false);
      store.update({ code: " y5 ", color: "#BE123C", faviconBadge: true });
      expect(store.effective()).toEqual({ code: "y5", color: "#be123c", auto: false });
      const again = new ServerBadgeStore(dir, "ramiy530", () => undefined);
      expect(again.effective()).toEqual({ code: "y5", color: "#be123c", auto: false });
      expect(again.faviconBadge()).toBe(true);
      // Clearing the code alone keeps the colour; the code falls back.
      again.update({ code: null });
      expect(again.effective()).toEqual({ code: defaultBadge("ramiy530").code, color: "#be123c", auto: false });
      again.update({ color: "" });
      expect(again.effective().auto).toBe(true);
      writeFileSync(badgeSettingsPath(dir), "{ not json");
      const broken = new ServerBadgeStore(dir, "ramiy530", (l) => lines.push(l));
      expect(broken.effective()).toEqual({ ...defaultBadge("ramiy530"), auto: true });
      expect(lines.join("\n")).toMatch(/server-badge/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the badge file is kept in the data dir, which git ignores", () => {
    const ignore = readFileSync(join(__dirname, "..", ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(ignore.some((l) => l === "data/" || l === "data" || l === "/data" || l === "/data/" || l === "**/server-badge.json")).toBe(true);
  });
});

describe("server badge on a server", { timeout: 30_000 }, () => {
  let dir: string;
  let S: JoindHandle;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "joind-marks-"));
    S = await startJoind(config(dir, "ramiy530", 0));
  }, 30_000);
  afterAll(async () => {
    await S?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("/api/instance shows the default badge and the favicon option", async () => {
    const r = await call(S.baseUrl, "GET", "/api/instance");
    expect(r.status).toBe(200);
    expect(r.json.name).toBe("ramiy530");
    expect(r.json.badge).toEqual({ ...defaultBadge("ramiy530"), auto: true });
    expect(r.json.faviconBadge).toBe(false);
    expect(r.json.badgeEditable).toBe(true);
  });

  it("only a web token holder sets it: no token and the agent key are refused", async () => {
    expect((await call(S.baseUrl, "POST", "/api/instance/badge", { code: "X", color: "#1d4ed8" })).status).toBe(403);
    expect((await call(S.baseUrl, "POST", "/api/instance/badge", { code: "X", color: "#1d4ed8" }, keyHdr)).status).toBe(403);
    expect((await call(S.baseUrl, "POST", "/api/instance/badge", { code: "X", color: "#1d4ed8" }, { "X-Joind-Token": "f".repeat(64) })).status).toBe(403);
    expect((await call(S.baseUrl, "GET", "/api/instance")).json.badge).toEqual({ ...defaultBadge("ramiy530"), auto: true });
    expect(existsSync(badgeSettingsPath(join(dir, "data")))).toBe(false);
  });

  it("validates the code and the colour (400, nothing saved)", async () => {
    for (const body of [{ code: "ABC" }, { code: "R!" }, { code: 7 }, { color: "#abc" }, { color: "blue" }, { color: "#1d4ed8;x" }, { faviconBadge: "on" }]) {
      const r = await call(S.baseUrl, "POST", "/api/instance/badge", body, webHdr);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(S.baseUrl, "GET", "/api/instance")).json.badge).toEqual({ ...defaultBadge("ramiy530"), auto: true });
  });

  it("sets, tells every open page, persists, and clears back to the default", async () => {
    const sock = await socket(S.baseUrl);
    await waitFor("init", () => of(sock, "init").length > 0);
    const r = await call(S.baseUrl, "POST", "/api/instance/badge", { code: "y5", color: "#BE123C", faviconBadge: true }, webHdr);
    expect(r.status, r.text).toBe(200);
    expect(r.json.badge).toEqual({ code: "y5", color: "#be123c", auto: false });
    expect(r.json.faviconBadge).toBe(true);
    const ev = await waitFor("instance event", () => of(sock, "instance")[0]);
    expect(ev.data).toEqual({ name: "ramiy530", badge: { code: "y5", color: "#be123c", auto: false }, faviconBadge: true, badgeEditable: true });
    const saved = JSON.parse(readFileSync(badgeSettingsPath(join(dir, "data")), "utf8")) as Record<string, unknown>;
    expect(saved).toEqual({ code: "y5", color: "#be123c", faviconBadge: true });
    // An absent field is kept.
    await call(S.baseUrl, "POST", "/api/instance/badge", { faviconBadge: false }, webHdr);
    expect((await call(S.baseUrl, "GET", "/api/instance")).json.badge).toEqual({ code: "y5", color: "#be123c", auto: false });
    const cleared = await call(S.baseUrl, "POST", "/api/instance/badge", { code: null, color: null }, webHdr);
    expect(cleared.json.badge).toEqual({ ...defaultBadge("ramiy530"), auto: true });
    sock.close();
  });

  it("a restart keeps the badge", async () => {
    await call(S.baseUrl, "POST", "/api/instance/badge", { code: "R5", color: "#0e7490" }, webHdr);
    await S.close();
    S = await startJoind(config(dir, "ramiy530", 0));
    expect((await call(S.baseUrl, "GET", "/api/instance")).json.badge).toEqual({ code: "R5", color: "#0e7490", auto: false });
  });
});

describe("server badge with a served (auto) web token", { timeout: 30_000 }, () => {
  let dir: string;
  let S: JoindHandle;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "joind-marks-served-"));
    S = await startJoind(config(dir, "ramiy530", 0, { webTokenUserSet: false }));
  }, 30_000);
  afterAll(async () => {
    await S?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("/api/instance says the badge is not editable", async () => {
    const r = await call(S.baseUrl, "GET", "/api/instance");
    expect(r.json.badgeEditable).toBe(false);
    expect(r.json.badge).toEqual({ ...defaultBadge("ramiy530"), auto: true });
  });

  it("the served token is refused (409, nothing saved, no event), as for minting a seat", async () => {
    const sock = await socket(S.baseUrl);
    await waitFor("init", () => of(sock, "init").length > 0);
    for (const body of [{ code: "X", color: "#1d4ed8" }, { code: null, color: null }, { faviconBadge: true }]) {
      const r = await call(S.baseUrl, "POST", "/api/instance/badge", body, webHdr);
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect(String(r.json.error)).toMatch(/JOIND_WEB_TOKEN/);
    }
    // The ordinary token rules still come first.
    expect((await call(S.baseUrl, "POST", "/api/instance/badge", { code: "X" })).status).toBe(403);
    expect(existsSync(badgeSettingsPath(join(dir, "data")))).toBe(false);
    expect((await call(S.baseUrl, "GET", "/api/instance")).json.badge).toEqual({ ...defaultBadge("ramiy530"), auto: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(of(sock, "instance")).toHaveLength(0);
    sock.close();
  });
});

/** A fetch that can rewrite the home's room list as an older or a hostile
 *  home would send it. */
function rewritingFetch(): { fetchImpl: FetchLike; mode: (m: "pass" | "strip" | "bad") => void } {
  let mode: "pass" | "strip" | "bad" = "pass";
  const fetchImpl: FetchLike = async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.text();
    if (mode === "pass" || !/\/api\/peer\/rooms(\?|$)/.test(url)) return { status: res.status, text: async () => text };
    const body = JSON.parse(text) as Record<string, unknown>;
    if (mode === "strip") delete body.badge;
    else body.badge = { code: "<img src=x>", color: "url(javascript:1)" };
    return { status: res.status, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, mode: (m) => { mode = m; } };
}

describe("the badge over a link", { timeout: 40_000 }, () => {
  let dirA: string, dirB: string;
  let A: JoindHandle, B: JoindHandle;
  let net: ReturnType<typeof rewritingFetch>;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    dirA = mkdtempSync(join(tmpdir(), "joind-marks-a-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-marks-b-"));
    const routes = new PeerRoutes();
    net = rewritingFetch();
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 300 };
    A = await startJoind(config(dirA, "alpha", 0, { links: [{ name: "bravo", url: routes.url("bravo"), token: LINK }] }), { link: { ...tuning, fetchImpl: routes.wrap() } });
    routes.set("alpha", A.baseUrl);
    B = await startJoind(config(dirB, "bravo", 0, { links: [{ name: "alpha", url: routes.url("alpha"), token: LINK }] }), { link: { ...tuning, fetchImpl: routes.wrap(net.fetchImpl) } });
    routes.set("bravo", B.baseUrl);
    A.manager.createConversation("ops");
  }, 30_000);
  afterAll(async () => {
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("the peer shows the home's own badge (default first, then the override) and tells its pages", async () => {
    const first = await waitFor("alpha's badge on bravo", () => B.links.get("alpha")?.info().badge);
    expect(first).toEqual(defaultBadge("alpha"));
    const sock = await socket(B.baseUrl);
    const init = await waitFor("init", () => of(sock, "init")[0]);
    const links = (init.data?.links ?? []) as Array<{ name: string; badge?: unknown }>;
    expect(links.find((l) => l.name === "alpha")?.badge).toEqual(defaultBadge("alpha"));
    expect((await call(A.baseUrl, "POST", "/api/instance/badge", { code: "AL", color: "#a21caf" }, webHdr)).status).toBe(200);
    const ev = await waitFor("a link event with the new badge", () =>
      of(sock, "link").find((e) => e.data?.name === "alpha" && JSON.stringify(e.data?.badge) === JSON.stringify({ code: "AL", color: "#a21caf" })));
    expect(ev.data?.state).toBe("up");
    // The `auto` flag is this server's business: the link carries code and colour only.
    expect(Object.keys(B.links.get("alpha")!.info().badge ?? {}).sort()).toEqual(["code", "color"]);
    sock.close();
  });

  it("an older home that sends no badge leaves the peer on the default (the page derives it)", async () => {
    net.mode("strip");
    await waitFor("the badge dropped", () => B.links.get("alpha")?.info().badge === undefined);
    expect(B.links.get("alpha")!.info().state).toBe("up");
    net.mode("pass");
    await waitFor("the badge back", () => B.links.get("alpha")?.info().badge?.code === "AL");
  });

  it("a bad badge from the home is dropped, never passed to the page", async () => {
    const sock = await socket(B.baseUrl);
    await waitFor("init", () => of(sock, "init").length > 0);
    net.mode("bad");
    await waitFor("the bad badge refused", () => B.links.get("alpha")?.info().badge === undefined);
    await sleep(700);
    expect(sock.raw.join("\n")).not.toContain("<img");
    expect(sock.raw.join("\n")).not.toContain("javascript:");
    net.mode("pass");
    sock.close();
  });
});

describe("read-only seats in the member list", { timeout: 40_000 }, () => {
  let dir: string;
  let S: JoindHandle;
  let room: string;
  let seatToken = "";
  let seatId = "";

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "joind-marks-seat-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    S = await startJoind(config(dir, "solo", 0));
    room = S.manager.createConversation("Ops").id;
    S.manager.setActive(room);
  }, 30_000);
  afterAll(async () => {
    await S?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const noSecrets = (s: Sock): void => {
    const all = s.raw.join("\n");
    if (seatToken) expect(all).not.toContain(seatToken);
    expect(all).not.toMatch(/tokenHash|fingerprint|jrs_/);
  };

  it("init carries the seats and the recent-read window; a mint is pushed at once", async () => {
    const sock = await socket(S.baseUrl);
    const init = await waitFor("init", () => of(sock, "init")[0]);
    expect(init.data?.readonlySeats).toEqual({ seats: [], recentReadMs: SEAT_RECENT_READ_MS });
    expect(SEAT_RECENT_READ_MS).toBe(10 * 60_000);
    const r = await call(S.baseUrl, "POST", "/api/readonly-seats", { name: "Watcher", conversation: room }, webHdr);
    expect(r.status, r.text).toBe(200);
    seatToken = r.json.token as string;
    seatId = (r.json.seat as { id: string }).id;
    const ev = await waitFor("seat event", () => of(sock, "readonly-seats")[0]);
    const seats = (ev.data?.seats ?? []) as Array<Record<string, unknown>>;
    expect(seats).toHaveLength(1);
    expect(Object.keys(seats[0]).sort()).toEqual(["conversationId", "createdAt", "id", "lastUsedAt", "name"]);
    expect(seats[0]).toMatchObject({ id: seatId, name: "Watcher", conversationId: room, lastUsedAt: null });
    noSecrets(sock);
    sock.close();
  });

  it("a read is pushed (last read), and a second read within a minute is not", async () => {
    const sock = await socket(S.baseUrl);
    await waitFor("init", () => of(sock, "init").length > 0);
    const before = of(sock, "readonly-seats").length;
    expect((await call(S.baseUrl, "GET", "/api/seat/read", undefined, { "X-Joind-Seat-Token": seatToken })).status).toBe(200);
    const ev = await waitFor("read event", () => of(sock, "readonly-seats")[before]);
    const seat = ((ev.data?.seats ?? []) as Array<{ lastUsedAt: number | null }>)[0];
    expect(typeof seat.lastUsedAt).toBe("number");
    expect((await call(S.baseUrl, "GET", "/api/seat/read", undefined, { "X-Joind-Seat-Token": seatToken })).status).toBe(200);
    await sleep(500);
    expect(of(sock, "readonly-seats")).toHaveLength(before + 1);
    noSecrets(sock);
    sock.close();
  });

  it("the seat is not a member: /api/who, the agent view and mentions never list it", async () => {
    const who = await call(S.baseUrl, "GET", `/api/who?conversation=${encodeURIComponent(room)}`, undefined, webHdr);
    expect(who.text).not.toContain("Watcher");
    expect(S.manager.getRoom(room)!.whoNames()).not.toContain("Watcher");
    // An agent cannot list seats.
    expect((await call(S.baseUrl, "GET", "/api/readonly-seats", undefined, keyHdr)).status).toBe(403);
    expect((await call(S.baseUrl, "GET", "/api/readonly-seats")).status).toBe(403);
  });

  it("a socket without the web token never opens, so it never hears a seat", async () => {
    const bad = await socket(S.baseUrl, "f".repeat(64), "Visitor");
    await waitFor("refusal", () => bad.closed !== null);
    expect(bad.raw.join("\n")).not.toContain("Watcher");
    expect(of(bad, "init")).toEqual([]);
  });

  it("a revoke is pushed and the seat leaves the list", async () => {
    const sock = await socket(S.baseUrl);
    const init = await waitFor("init", () => of(sock, "init")[0]);
    expect(((init.data?.readonlySeats as { seats: unknown[] }).seats)).toHaveLength(1);
    expect((await call(S.baseUrl, "POST", `/api/readonly-seats/${seatId}/revoke`, {}, webHdr)).status).toBe(200);
    const ev = await waitFor("revoke event", () => of(sock, "readonly-seats")[0]);
    expect(ev.data?.seats).toEqual([]);
    // Revoking again changes nothing and pushes nothing.
    expect((await call(S.baseUrl, "POST", `/api/readonly-seats/${seatId}/revoke`, {}, webHdr)).status).toBe(200);
    await sleep(400);
    expect(of(sock, "readonly-seats")).toHaveLength(1);
    noSecrets(sock);
    sock.close();
  });
});

describe("seat change events (unit)", () => {
  it("mint and revoke emit; a read emits at most once a minute per seat", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-seat-ev-"));
    try {
      const store = new ReadonlySeatStore(dir, { log: () => undefined });
      let n = 0;
      store.on("changed", () => { n += 1; });
      const a = store.mint("A", "r");
      const b = store.mint("B", "r");
      expect(n).toBe(2);
      store.noteUse(a.seat.id);
      store.noteUse(a.seat.id);
      store.noteUse(b.seat.id);
      expect(n).toBe(4);
      store.revoke(a.seat.id);
      store.revoke(a.seat.id);
      expect(n).toBe(5);
      expect(store.activeSeats().map((s) => s.name)).toEqual(["B"]);
      expect(JSON.stringify(store.activeSeats())).not.toMatch(/tokenHash|jrs_/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("seats are not mirrored over a link", { timeout: 40_000 }, () => {
  it("a peer's page hears no seat of the home, and the home's peer API lists none", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dirA = mkdtempSync(join(tmpdir(), "joind-marks-la-"));
    const dirB = mkdtempSync(join(tmpdir(), "joind-marks-lb-"));
    const routes = new PeerRoutes();
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 300 };
    const A = await startJoind(config(dirA, "alpha", 0, { links: [{ name: "bravo", url: routes.url("bravo"), token: LINK }] }), { link: { ...tuning, fetchImpl: routes.wrap() } });
    routes.set("alpha", A.baseUrl);
    const B = await startJoind(config(dirB, "bravo", 0, { links: [{ name: "alpha", url: routes.url("alpha"), token: LINK }] }), { link: { ...tuning, fetchImpl: routes.wrap() } });
    routes.set("bravo", B.baseUrl);
    try {
      const room = A.manager.createConversation("ops").id;
      const minted = await call(A.baseUrl, "POST", "/api/readonly-seats", { name: "Watcher", conversation: room }, webHdr);
      expect(minted.status, minted.text).toBe(200);
      const token = minted.json.token as string;
      await waitFor("alpha's room on bravo", () => B.links.get("alpha")?.info().state === "up");
      const sock = await socket(B.baseUrl);
      const init = await waitFor("init", () => of(sock, "init")[0]);
      expect(init.data?.readonlySeats).toEqual({ seats: [], recentReadMs: SEAT_RECENT_READ_MS });
      const link = { Authorization: `Bearer ${LINK}` };
      const rooms = await call(A.baseUrl, "GET", "/api/peer/rooms", undefined, link);
      expect(rooms.status).toBe(200);
      expect(rooms.text).not.toContain("Watcher");
      const who = await call(B.baseUrl, "GET", `/api/who?conversation=${encodeURIComponent("alpha:" + room)}`, undefined, webHdr);
      expect(who.text).not.toContain("Watcher");
      expect(sock.raw.join("\n")).not.toContain("Watcher");
      expect(sock.raw.join("\n")).not.toContain(token);
      sock.close();
    } finally {
      await B.close().catch(() => undefined);
      await A.close().catch(() => undefined);
      for (const d of [dirA, dirB]) rmSync(d, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});

/**
 * Read-only room seats (src/readonly-seats.ts; design note
 * docs/superpowers/specs/2026-10-05-readonly-seat-design.md).
 *
 * Real servers on loopback ports with temp data dirs. Every function the
 * terminal layer exports (injection, discovery, Orca, target classification,
 * the Codex queue) is wrapped in a spy that records its name, so a test can
 * prove a seat's minting and its mentions never reach that layer.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import { createServer } from "net";

const terminalCalls: string[] = [];
const injected: Array<{ pid: number; prompt: string }> = [];

/** Wrap every lowercase-named function export in a recorder (classes and
 *  constants pass through untouched). */
function recordAll<T extends Record<string, unknown>>(mod: string, actual: T, overrides: Record<string, unknown> = {}): T {
  const out: Record<string, unknown> = { ...actual };
  for (const [k, v] of Object.entries(actual)) {
    if (typeof v !== "function" || !/^[a-z]/.test(k)) continue;
    const impl = (overrides[k] ?? v) as (...a: unknown[]) => unknown;
    out[k] = (...args: unknown[]) => { terminalCalls.push(`${mod}.${k}`); return impl(...args); };
  }
  return out as T;
}

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/inject.js");
  return recordAll("inject", actual, {
    inject: async (pid: number, prompt: string) => { injected.push({ pid, prompt }); },
  });
});
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/terminals.js");
  return recordAll("terminals", actual, {
    processTreeOnce: () => () => Promise.resolve(new Map()),
    discoverTerminals: async () => [],
    discoverWezTerm: async () => [],
  });
});
vi.mock("../src/orca.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/orca.js");
  return recordAll("orca", actual, { listOrcaTerminals: async () => null });
});
vi.mock("../src/target.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/target.js");
  return recordAll("target", actual);
});
vi.mock("../src/codex-queue.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/codex-queue.js");
  return recordAll("codex-queue", actual);
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";
import type { AgentAuthMode } from "../src/agent-auth.js";
import { ReadonlySeatStore, SEAT_ALLOWLIST, seatCanSee, seatsPath, normalizeSeatPath } from "../src/readonly-seats.js";
import { ChatRoom, type ChatMessage } from "../src/room.js";

const WEB = "c".repeat(64);
const KEY = "seat-tests-agent-key-0123456789abcdef";
const LINK = "link-token-for-readonly-seat-tests";
const PID = 999_961;
const PID2 = 999_963;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function config(dir: string, port: number, mode: AgentAuthMode, extra: Partial<JoindConfig> = {}): JoindConfig {
  return {
    port, host: "127.0.0.1", dataDir: join(dir, "data"), instance: "solo", crewHome: join(dir, "crew"),
    humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
    webToken: WEB, webTokenUserSet: true, links: [], agentAuth: mode, agentKey: KEY,
    ...extra,
  };
}

type Resp = { status: number; json: Record<string, unknown>; text: string };

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = {}; }
  return { status: res.status, json, text };
}
const post = (b: string, p: string, body: unknown, h: Record<string, string> = {}) => call(b, "POST", p, body, h);
const get = (b: string, p: string, h: Record<string, string> = {}) => call(b, "GET", p, undefined, h);

const webHdr = { "X-Joind-Token": WEB };
const keyHdr = { Authorization: `Bearer ${KEY}` };
const seatHdr = (t: string) => ({ "X-Joind-Seat-Token": t });

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

/** Every route the server registers directly on the app, read from the source. */
function appRoutes(): Array<{ method: string; path: string }> {
  const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
  const out: Array<{ method: string; path: string }> = [];
  const re = /app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ method: m[1].toUpperCase(), path: m[2] });
  return out;
}
const concrete = (path: string): string => path.replace(/:id\b/g, "1").replace(/:[A-Za-z]+/g, "x");

interface Server { dir: string; h: JoindHandle; base: string }

async function start(mode: AgentAuthMode, extra: Partial<JoindConfig> = {}, dir?: string): Promise<Server> {
  const d = dir ?? mkdtempSync(join(tmpdir(), "joind-seat-"));
  const port = await freePort();
  const h = await startJoind(config(d, port, mode, extra), {
    link: { discoverEveryMs: 600_000, backoffMinMs: 600_000, backoffMaxMs: 600_000, requestTimeoutMs: 500 },
  });
  return { dir: d, h, base: `http://127.0.0.1:${port}` };
}

async function mint(base: string, name: string, conversation: string): Promise<{ token: string; id: string }> {
  const r = await post(base, "/api/readonly-seats", { name, conversation }, webHdr);
  expect(r.status, r.text).toBe(200);
  const seat = r.json.seat as { id: string };
  return { token: r.json.token as string, id: seat.id };
}

/** A human message through the web route (the token rides the body, as the page sends it). */
async function say(base: string, conversation: string, text: string, extra: Record<string, unknown> = {}): Promise<number> {
  const r = await post(base, "/api/send", { token: WEB, sender: "Rami", text, conversation, ...extra }, webHdr);
  expect(r.status, r.text).toBe(200);
  return r.json.id as number;
}

async function join_(base: string, name: string, conversation: string, pid: number): Promise<string> {
  const r = await post(base, "/api/agent/join", { name, pid, conversation }, keyHdr);
  expect(r.status, r.text).toBe(200);
  return r.json.registration as string;
}

// ---------------------------------------------------------------------------

describe("read-only seat units", () => {
  it("stores only a digest, shows the token once, and survives a reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-seat-unit-"));
    try {
      const store = new ReadonlySeatStore(dir, { log: () => undefined });
      const { seat, token } = store.mint("Watcher", "room-a");
      expect(token.startsWith("jrs_")).toBe(true);
      expect(token.length).toBeGreaterThan(40);
      const file = readFileSync(seatsPath(dir), "utf8");
      expect(file).not.toContain(token);
      expect(file).toContain("tokenHash");
      expect(JSON.stringify(store.list())).not.toContain(token);
      expect(JSON.stringify(store.list())).not.toContain("tokenHash");
      const again = new ReadonlySeatStore(dir, { log: () => undefined });
      expect(again.verify(token)?.id).toBe(seat.id);
      expect(again.verify(token + "x")).toBeUndefined();
      expect(again.verify(token.slice(4))).toBeUndefined();
      expect(again.reserves("room-a", "watcher")).toBe(true);
      expect(again.reserves("room-b", "Watcher")).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses bad names, a second seat for the same name and room, and a broken file", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-seat-unit-"));
    try {
      const store = new ReadonlySeatStore(dir, { log: () => undefined });
      for (const bad of ["", "all", "System", "has space", "-lead", "x".repeat(65), "a/b"]) {
        expect(() => store.mint(bad, "r"), bad).toThrow();
      }
      store.mint("Watcher", "r");
      expect(() => store.mint("watcher", "r")).toThrow(/already has a read-only seat/);
      store.mint("Watcher", "r2");
      writeFileSync(seatsPath(dir), "{ not json");
      const broken = new ReadonlySeatStore(dir, { log: () => undefined });
      expect(broken.broken).toBe(true);
      expect(broken.list()).toEqual([]);
      expect(() => broken.mint("Other", "r")).toThrow(/cannot be read/);
      // Nothing was written over the broken file.
      expect(readFileSync(seatsPath(dir), "utf8")).toBe("{ not json");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("revocation is per seat and idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-seat-unit-"));
    try {
      const store = new ReadonlySeatStore(dir, { log: () => undefined });
      const a = store.mint("A", "r"), b = store.mint("B", "r");
      expect(store.revoke(a.seat.id)?.revokedAt).not.toBeNull();
      expect(store.revoke(a.seat.id)?.revokedAt).not.toBeNull();
      expect(store.verify(a.token)).toBeUndefined();
      expect(store.isSeatToken(a.token)).toBe(true);
      expect(store.verify(b.token)?.name).toBe("B");
      expect(store.reserves("r", "A")).toBe(false);
      expect(store.revoke("seat-nope")).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("sees public messages only, never a DM, even one to its own name", () => {
    const m = (id: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, sender: "A", text: "t", timestamp: 0, ...extra });
    expect(seatCanSee(m(1))).toBe(true);
    expect(seatCanSee(m(11, { to: ["Watcher"] }))).toBe(false);
    expect(seatCanSee(m(12, { to: ["Other"] }))).toBe(false);
    expect(seatCanSee(m(13, { sender: "Watcher", to: ["Other"] }))).toBe(false);
    expect(seatCanSee(m(14, { to: [] }))).toBe(false);
    expect(seatCanSee(m(-1, { local: true }))).toBe(false);
  });

  it("knows a seat's name in any room, case-insensitive, until revoked", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-seat-unit-"));
    try {
      const store = new ReadonlySeatStore(dir, { log: () => undefined });
      const a = store.mint("Auditor", "r");
      expect(store.holdsAnywhere("auditor")).toBe(true);
      expect(store.holdsAnywhere("Other")).toBe(false);
      store.revoke(a.seat.id);
      expect(store.holdsAnywhere("Auditor")).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("normalizes paths as Express matches them", () => {
    expect(normalizeSeatPath("/API/Seat/Read/")).toBe("/api/seat/read");
    expect(normalizeSeatPath("//api//seat/read")).toBe("/api/seat/read");
  });

  it("the seat file is git-ignored by name", () => {
    const ignored = readFileSync(join(__dirname, "..", ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(ignored).toContain(`**/${basename(seatsPath("data"))}`);
  });
});

describe("read-only seat on a server (warn, the default mode)", () => {
  let s: Server;
  let roomA: string, roomB: string;
  let seat: { token: string; id: string };

  beforeAll(async () => {
    s = await start("warn");
    roomA = s.h.manager.createConversation("Ops").id;
    roomB = s.h.manager.createConversation("Other room").id;
    s.h.manager.setActive(roomA);
  }, 30_000);
  afterAll(async () => { await s.h.close(); rmSync(s.dir, { recursive: true, force: true }); });

  it("R2: minting and mentioning the seat never reach injection, discovery, Orca, classification or the Codex queue", async () => {
    await join_(s.base, "Member", roomA, PID);
    await say(s.base, roomA, "before the seat");
    // Let any wake from the join settle, then watch only what follows.
    await sleep(2_500);
    terminalCalls.length = 0;
    injected.length = 0;
    seat = await mint(s.base, "Watcher", roomA);
    await say(s.base, roomA, "@Watcher please read this");
    await say(s.base, roomA, "@Watcher and this one", { to: ["Watcher"] });
    await sleep(3_000);
    expect(terminalCalls).toEqual([]);
    expect(injected).toEqual([]);
    expect(s.h.manager.getRoom(roomA)!.whoNames()).not.toContain("Watcher");
    // Control: the same spies see a real member's mention.
    await say(s.base, roomA, "@Member over to you");
    await waitFor("the member's wake", () => injected.find((i) => i.pid === PID));
    expect(terminalCalls).toContain("inject.inject");
  }, 30_000);

  it("R1: reads its room's public messages (never a DM, even to its name) with since, limit, search and by id", async () => {
    const me = await get(s.base, "/api/seat/me", seatHdr(seat.token));
    expect(me.status).toBe(200);
    expect(me.json.conversation).toEqual({ id: roomA, name: "Ops" });
    expect(me.json.readOnly).toBe(true);
    const r = await get(s.base, "/api/seat/read?limit=500", seatHdr(seat.token));
    expect(r.status).toBe(200);
    const texts = (r.json.messages as ChatMessage[]).map((m) => m.text);
    expect(texts).toContain("before the seat");
    expect(texts).toContain("@Watcher please read this");
    expect(texts).not.toContain("@Watcher and this one");
    const lastId = r.json.lastId as number;
    const since = await get(s.base, `/api/seat/read?since=${lastId}`, seatHdr(seat.token));
    expect(since.json.messages).toEqual([]);
    expect(since.json.lastId).toBe(lastId);
    const one = await get(s.base, "/api/seat/read?limit=1", seatHdr(seat.token));
    expect((one.json.messages as ChatMessage[]).length).toBe(1);
    expect(one.json.more).toBe(true);
    const found = await get(s.base, "/api/seat/search?q=please", seatHdr(seat.token));
    expect(found.status).toBe(200);
    const hits = found.json.results as Array<{ message: ChatMessage }>;
    expect(hits.map((h) => h.message.text)).toEqual(["@Watcher please read this"]);
    const byId = await get(s.base, `/api/seat/message/${hits[0].message.id}`, seatHdr(seat.token));
    expect(byId.status).toBe(200);
    expect(byId.json.text).toBe("@Watcher please read this");
  });

  it("R1: never reads another room, a DM to someone else, or a DM to its name sent before or after minting", async () => {
    const elsewhere = await say(s.base, roomB, "secret of the other room");
    const dmOther = await say(s.base, roomA, "for Member only", { to: ["Member"] });
    // A fresh seat whose name received a DM before it existed.
    await say(s.base, roomA, "old DM to the name Lurker", { to: ["Lurker"] });
    const lurker = await mint(s.base, "Lurker", roomA);
    const r = await get(s.base, `/api/seat/read?limit=500&conversation=${roomB}`, seatHdr(lurker.token));
    const texts = (r.json.messages as ChatMessage[]).map((m) => m.text);
    expect(texts).not.toContain("secret of the other room");
    expect(texts).not.toContain("for Member only");
    expect(texts).not.toContain("old DM to the name Lurker");
    // Ids are per room: the same id here is this room's message, never the other's.
    expect((await get(s.base, `/api/seat/message/${elsewhere}?conversation=${roomB}`, seatHdr(lurker.token))).json.text).not.toBe("secret of the other room");
    expect((await get(s.base, `/api/seat/message/${dmOther}`, seatHdr(lurker.token))).status).toBe(404);
    expect(((await get(s.base, "/api/seat/search?q=secret", seatHdr(lurker.token))).json.results as unknown[]).length).toBe(0);
    await say(s.base, roomA, "new DM to Lurker", { to: ["Lurker"] });
    const after = await get(s.base, "/api/seat/read?limit=5", seatHdr(lurker.token));
    expect((after.json.messages as ChatMessage[]).map((m) => m.text)).not.toContain("new DM to Lurker");
  });

  it("R1: default deny, every route of the server refuses the seat token and nothing changes", async () => {
    const room = s.h.manager.getRoom(roomA)!;
    const before = { a: room.messageCount(), b: s.h.manager.getRoom(roomB)!.messageCount(), who: room.whoNames().join(","), convs: s.h.manager.listConversations().length };
    const routes = [
      ...appRoutes(),
      { method: "POST", path: "/mcp" }, { method: "GET", path: "/mcp" }, { method: "DELETE", path: "/mcp" },
      { method: "GET", path: "/api/peer/rooms" }, { method: "POST", path: "/api/peer/send" }, { method: "POST", path: "/api/peer/register" },
      { method: "GET", path: "/" }, { method: "GET", path: "/index.html" }, { method: "GET", path: "/data/files/x.png" },
      // Seat paths with a method or a name that is not on the allowlist.
      { method: "POST", path: "/api/seat/read" }, { method: "PUT", path: "/api/seat/me" }, { method: "DELETE", path: "/api/seat/message/1" },
      { method: "PATCH", path: "/api/seat/read" }, { method: "HEAD", path: "/api/seat/read" }, { method: "OPTIONS", path: "/api/seat/read" },
      { method: "GET", path: "/api/seat" }, { method: "GET", path: "/api/seat/send" }, { method: "GET", path: "/api/seat/read/x" },
      { method: "GET", path: "/api/seat/%2e%2e/agent/read" }, { method: "GET", path: "/api/seat/message/abc" },
    ];
    expect(routes.length).toBeGreaterThan(90);
    const served: string[] = [];
    for (const r of routes) {
      const body = r.method === "GET" || r.method === "HEAD" || r.method === "OPTIONS" ? undefined
        : { token: WEB, sender: "Watcher", name: "Watcher", text: "@Member written by a seat", conversation: roomA, title: "t", pid: PID2 };
      const res = await call(s.base, r.method, concrete(r.path), body, { ...seatHdr(seat.token), ...webHdr, ...keyHdr });
      if (res.status !== 403) served.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(served).toEqual([]);
    expect(room.messageCount()).toBe(before.a);
    expect(s.h.manager.getRoom(roomB)!.messageCount()).toBe(before.b);
    expect(room.whoNames().join(",")).toBe(before.who);
    expect(s.h.manager.listConversations().length).toBe(before.convs);
  }, 60_000);

  it("R1: an MCP session cannot be opened with the seat token", async () => {
    const r = await fetch(`${s.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...seatHdr(seat.token) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "seat", version: "1" } } }),
    });
    expect(r.status).toBe(403);
    expect(r.headers.get("mcp-session-id")).toBeNull();
  });

  it("R1: a seat token in any other credential slot is refused, never read as that credential", async () => {
    const before = s.h.manager.getRoom(roomA)!.messageCount();
    const slots: Array<{ h: Record<string, string>; q: string }> = [
      { h: { Authorization: `Bearer ${seat.token}` }, q: "" },
      { h: { "X-Joind-Agent-Key": seat.token }, q: "" },
      { h: { "X-Joind-Token": seat.token }, q: "" },
      { h: {}, q: `?token=${encodeURIComponent(seat.token)}` },
      { h: {}, q: `?agentKey=${encodeURIComponent(seat.token)}` },
    ];
    for (const slot of slots) {
      const send = await post(s.base, `/api/agent/send${slot.q}`, { sender: "Member", text: "via a slot" }, slot.h);
      expect(send.status, JSON.stringify(slot)).toBe(403);
      const read = await get(s.base, `/api/messages${slot.q}`, slot.h);
      expect(read.status, JSON.stringify(slot)).toBe(403);
    }
    expect(s.h.manager.getRoom(roomA)!.messageCount()).toBe(before);
  });

  it("R1, R2: no member can take the seat's name in its room (agent join, web invite, rename); the same name elsewhere is free", async () => {
    const j = await post(s.base, "/api/agent/join", { name: "Watcher", pid: PID2, conversation: roomA }, keyHdr);
    expect(j.status).toBe(409);
    expect(String(j.json.error)).toMatch(/read-only seat/);
    const jl = await post(s.base, "/api/agent/join", { name: "watcher", pid: PID2, conversation: roomA }, keyHdr);
    expect(jl.status).toBe(409);
    s.h.manager.setActive(roomA);
    const invite = await post(s.base, "/api/join", { token: WEB, name: "Watcher", pid: PID2 }, webHdr);
    expect(invite.status).toBe(409);
    const rename = await post(s.base, "/api/rename", { token: WEB, oldName: "Member", newName: "Watcher", conversation: roomA }, webHdr);
    expect(rename.status).toBe(409);
    expect(s.h.manager.getRoom(roomA)!.whoNames()).toContain("Member");
    const other = await post(s.base, "/api/agent/join", { name: "Watcher", pid: PID2, conversation: roomB }, keyHdr);
    expect(other.status).toBe(200);
    await post(s.base, "/api/agent/leave", { name: "Watcher", registration: other.json.registration }, keyHdr);
  });

  it("R3: reading moves no other seat's cursor, presence or activity record", async () => {
    const reg = await join_(s.base, "Reader", roomA, PID2);
    await say(s.base, roomA, "unread for Reader");
    const room = s.h.manager.getRoom(roomA)!;
    const unread = async () => (await get(s.base, `/api/agent/unread?sender=Reader&registration=${reg}`, keyHdr)).json;
    const before = { unread: await unread(), seenR: room.getAgent("Reader")!.lastSeen, seenM: room.getAgent("Member")!.lastSeen, notes: (await get(s.base, "/api/notifications", webHdr)).json.unread, high: room.highWaterId() };
    await sleep(30);
    for (let i = 0; i < 3; i++) {
      expect((await get(s.base, "/api/seat/read?limit=500", seatHdr(seat.token))).status).toBe(200);
      expect((await get(s.base, "/api/seat/search?q=unread", seatHdr(seat.token))).status).toBe(200);
      expect((await get(s.base, `/api/seat/message/${before.high}`, seatHdr(seat.token))).status).toBe(200);
    }
    expect(await unread()).toEqual(before.unread);
    expect(room.getAgent("Reader")!.lastSeen).toBe(before.seenR);
    expect(room.getAgent("Member")!.lastSeen).toBe(before.seenM);
    expect((await get(s.base, "/api/notifications", webHdr)).json.unread).toBe(before.notes);
    expect(room.highWaterId()).toBe(before.high);
    expect(room.getAgent("Watcher")).toBeUndefined();
  });

  it("R4: operator-only minting, listing and revoking; revoking one seat leaves the others and every member alone", async () => {
    expect((await post(s.base, "/api/readonly-seats", { name: "Nope", conversation: roomA })).status).toBe(403);
    expect((await post(s.base, "/api/readonly-seats", { name: "Nope", conversation: roomA }, keyHdr)).status).toBe(403);
    expect((await get(s.base, "/api/readonly-seats")).status).toBe(403);
    expect((await post(s.base, `/api/readonly-seats/${seat.id}/revoke`, {}, keyHdr)).status).toBe(403);
    // Taken names and rooms that are not here.
    expect((await post(s.base, "/api/readonly-seats", { name: "Member", conversation: roomA }, webHdr)).status).toBe(409);
    expect((await post(s.base, "/api/readonly-seats", { name: "Rami", conversation: roomA }, webHdr)).status).toBe(409);
    expect((await post(s.base, "/api/readonly-seats", { name: "Watcher", conversation: roomA }, webHdr)).status).toBe(409);
    expect((await post(s.base, "/api/readonly-seats", { name: "Ghost", conversation: "no-such-room" }, webHdr)).status).toBe(404);
    const second = await mint(s.base, "Second", "Ops");
    const list = await get(s.base, "/api/readonly-seats", webHdr);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(seat.token);
    expect(list.text).not.toContain("tokenHash");
    const memberReg = s.h.manager.bindingsOf("Member")[0].registration;
    const rv = await post(s.base, `/api/readonly-seats/${seat.id}/revoke`, {}, webHdr);
    expect(rv.status).toBe(200);
    expect((await get(s.base, "/api/seat/read", seatHdr(seat.token))).status).toBe(401);
    expect((await get(s.base, "/api/seat/read", seatHdr(second.token))).status).toBe(200);
    // The member still reads and sends with its registration.
    expect((await get(s.base, `/api/agent/read?sender=Member&registration=${memberReg}`)).status).toBe(200);
    expect((await post(s.base, "/api/agent/send", { sender: "Member", text: "still here", registration: memberReg })).status).toBe(200);
    // The revoked name is free again.
    const j = await post(s.base, "/api/agent/join", { name: "Watcher", pid: PID2, conversation: roomA }, keyHdr);
    expect(j.status).toBe(200);
    await post(s.base, "/api/agent/leave", { name: "Watcher", registration: j.json.registration }, keyHdr);
    expect((await post(s.base, "/api/readonly-seats/seat-missing/revoke", {}, webHdr)).status).toBe(404);
  });

  it("an unknown token, a missing token, or a token without the seat header is refused on the seat routes", async () => {
    expect((await get(s.base, "/api/seat/read")).status).toBe(401);
    expect((await get(s.base, "/api/seat/read", webHdr)).status).toBe(401);
    expect((await get(s.base, "/api/seat/read", keyHdr)).status).toBe(401);
    expect((await get(s.base, "/api/seat/read", seatHdr("jrs_" + "A".repeat(43)))).status).toBe(401);
    expect((await get(s.base, "/api/seat/read", seatHdr(""))).status).toBe(401);
  });
});

describe("read-only seat under require, and across a restart", () => {
  it("R5: a seat reads under require with no agent key; web token and registrations behave as before; the seat survives a restart", async () => {
    let s = await start("require");
    const dir = s.dir;
    try {
      const room = s.h.manager.createConversation("Ops").id;
      s.h.manager.setActive(room);
      const seat = await mint(s.base, "Watcher", room);
      await say(s.base, room, "hello");
      const read = await get(s.base, "/api/seat/read", seatHdr(seat.token));
      expect(read.status).toBe(200);
      // Existing flows, unchanged: the web token posts as any sender, an
      // unkeyed agent call is refused, a keyed join's registration works.
      const web = await post(s.base, "/api/send", { token: WEB, sender: "AnyName", text: "web token post", conversation: room }, webHdr);
      expect(web.status).toBe(200);
      expect((await post(s.base, "/api/agent/join", { name: "Member", pid: PID, conversation: room })).status).toBe(401);
      const reg = await join_(s.base, "Member", room, PID);
      expect((await get(s.base, `/api/agent/read?sender=Member&registration=${reg}`)).status).toBe(200);
      expect((await post(s.base, "/api/agent/send", { sender: "Member", text: "agent post", registration: reg })).status).toBe(200);
      expect((await get(s.base, "/api/messages", webHdr)).status).toBe(403); // the web read takes its token in the query
      expect((await get(s.base, `/api/messages?token=${WEB}`)).status).toBe(200);
      // A seat token on an agent route is refused even beside the agent key.
      expect((await post(s.base, "/api/agent/send", { sender: "Member", text: "x", registration: reg }, { ...keyHdr, ...seatHdr(seat.token) })).status).toBe(403);
      // A restart keeps the seat (and, below, its revocation).
      await s.h.close();
      s = await start("require", {}, dir);
      expect((await get(s.base, "/api/seat/read", seatHdr(seat.token))).status).toBe(200);
      const list = await get(s.base, "/api/readonly-seats", webHdr);
      expect((list.json.seats as Array<{ id: string; revokedAt: number | null }>).find((x) => x.id === seat.id)?.revokedAt).toBeNull();
      expect((await post(s.base, `/api/readonly-seats/${seat.id}/revoke`, {}, webHdr)).status).toBe(200);
      await s.h.close();
      s = await start("require", {}, dir);
      expect((await get(s.base, "/api/seat/read", seatHdr(seat.token))).status).toBe(401);
      expect(existsSync(seatsPath(join(dir, "data")))).toBe(true);
      expect(readFileSync(seatsPath(join(dir, "data")), "utf8")).not.toContain(seat.token);
    } finally {
      await s.h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("minting refuses a served (generated) web token; listing still works", async () => {
    const s = await start("warn", { webTokenUserSet: false });
    try {
      const room = s.h.manager.createConversation("Ops").id;
      expect((await post(s.base, "/api/readonly-seats", { name: "Watcher", conversation: room }, webHdr)).status).toBe(409);
      expect((await get(s.base, "/api/readonly-seats", webHdr)).status).toBe(200);
    } finally {
      await s.h.close();
      rmSync(s.dir, { recursive: true, force: true });
    }
  });
});

describe("read-only seat and human viewers (gate 1 on 6ab3e39)", () => {
  type Ev = { type: string; name?: string; error?: string };
  type Sock = { ws: import("ws").WebSocket; events: Ev[]; opened: Promise<"init" | number> };
  /** A browser socket; `opened` is "init" once the server greets it, or the
   *  HTTP status (or close code) it was refused with. */
  async function socket(s: Server, name: string, headers: Record<string, string> = {}, extraQuery = ""): Promise<Sock> {
    const { default: WebSocket } = await import("ws");
    const events: Ev[] = [];
    const ws = new WebSocket(`${s.base.replace("http:", "ws:")}/ws?token=${WEB}&name=${name}${extraQuery}`, { headers });
    const opened = new Promise<"init" | number>((resolve) => {
      ws.on("message", (raw) => {
        events.push(JSON.parse(String(raw)) as Ev);
        if (events.some((e) => e.type === "init")) resolve("init");
      });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => resolve(-1));
      ws.on("close", (code) => resolve(code));
    });
    return { ws, events, opened };
  }

  it("R1: a seat cannot be minted under a name a browser socket still holds", async () => {
    const s = await start("require");
    const open: Sock[] = [];
    try {
      const room = s.h.manager.createConversation("Ops").id;
      s.h.manager.setActive(room);
      expect((await post(s.base, "/api/web/register", { token: WEB, name: "Alice" })).status).toBe(200);
      const stale = await socket(s, "Alice"); open.push(stale);
      const renamed = await socket(s, "Alice"); open.push(renamed);
      expect(await stale.opened).toBe("init");
      expect(await renamed.opened).toBe("init");
      renamed.ws.send(JSON.stringify({ type: "web-rename", name: "Bob" }));
      await waitFor("rename", () => renamed.events.find((e) => e.type === "web-rename-ok"));
      // The other tab still holds Alice: the name is a human's, so no seat.
      const refused = await post(s.base, "/api/readonly-seats", { name: "alice", conversation: room }, webHdr);
      expect(refused.status, refused.text).toBe(409);
      // Once that tab is gone the name is free again.
      stale.ws.close();
      await waitFor("mint after the stale tab closed", async () => (await post(s.base, "/api/readonly-seats", { name: "Alice", conversation: room }, webHdr)).status === 200);
    } finally {
      for (const x of open) x.ws.terminate();
      await s.h.close();
      rmSync(s.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("R1: a human cannot register or rename onto a seat's name, and the seat reads no DM sent to that name", async () => {
    const s = await start("require");
    const open: Sock[] = [];
    try {
      const room = s.h.manager.createConversation("Ops").id;
      const other = s.h.manager.createConversation("Elsewhere").id;
      s.h.manager.setActive(room);
      const seat = await mint(s.base, "Auditor", room);
      await mint(s.base, "Lookout", other);
      expect((await post(s.base, "/api/web/register", { token: WEB, name: "Auditor" })).status).toBe(409);
      expect((await post(s.base, "/api/web/register", { token: WEB, name: "auditor" })).status).toBe(409);
      expect((await post(s.base, "/api/web/register", { token: WEB, name: "Carol" })).status).toBe(200);
      const tab = await socket(s, "Carol"); open.push(tab);
      expect(await tab.opened).toBe("init");
      // A seat in any room holds the name against the human: DMs route by name.
      for (const name of ["Auditor", "LOOKOUT"]) {
        tab.ws.send(JSON.stringify({ type: "web-rename", name }));
        const err = await waitFor(`rename to ${name} refused`, () => tab.events.find((e) => e.type === "web-rename-error" && /read-only seat/.test(e.error ?? "")));
        tab.events.splice(tab.events.indexOf(err), 1);
      }
      expect(tab.events.some((e) => e.type === "web-rename-ok")).toBe(false);
      // Backstop: even a DM addressed to the seat's own name is not read.
      await say(s.base, room, "private delivery to the name Auditor", { to: ["Auditor"] });
      await say(s.base, room, "public line");
      const read = await get(s.base, "/api/seat/read?limit=500", seatHdr(seat.token));
      const texts = (read.json.messages as ChatMessage[]).map((m) => m.text);
      expect(texts).toContain("public line");
      expect(texts).not.toContain("private delivery to the name Auditor");
      // After a revoke the human may take the name.
      expect((await post(s.base, `/api/readonly-seats/${seat.id}/revoke`, {}, webHdr)).status).toBe(200);
      tab.ws.send(JSON.stringify({ type: "web-rename", name: "Auditor" }));
      await waitFor("rename after revoke", () => tab.events.find((e) => e.type === "web-rename-ok" && e.name === "Auditor"));
    } finally {
      for (const x of open) x.ws.terminate();
      await s.h.close();
      rmSync(s.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("R1: a socket upgrade carrying a seat token is refused even beside a valid web token", async () => {
    const s = await start("require");
    const open: Sock[] = [];
    try {
      const room = s.h.manager.createConversation("Ops").id;
      s.h.manager.setActive(room);
      const seat = await mint(s.base, "Auditor", room);
      expect((await post(s.base, "/api/web/register", { token: WEB, name: "Bob" })).status).toBe(200);
      const tries = [
        await socket(s, "Bob", seatHdr(seat.token)),
        await socket(s, "Bob", seatHdr("jrs_not-a-real-token")),
        await socket(s, "Bob", {}, `&x=${seat.token}`),
        await socket(s, "Bob", { Authorization: `Bearer ${seat.token}` }),
      ];
      open.push(...tries);
      for (const t of tries) {
        expect(await t.opened).toBe(403);
        expect(t.events).toEqual([]);
      }
      // The plain web socket still opens.
      const plain = await socket(s, "Bob"); open.push(plain);
      expect(await plain.opened).toBe("init");
    } finally {
      for (const x of open) x.ws.terminate();
      await s.h.close();
      rmSync(s.dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("read-only seat and linked servers", () => {
  it("is minted only for a room whose home is this server, and a peer cannot register a member or human under the seat's name", async () => {
    const peerPort = await freePort();
    const s = await start("warn", { links: [{ name: "peerx", url: `http://127.0.0.1:${peerPort}`, token: LINK }] });
    try {
      const room = s.h.manager.createConversation("Ops").id;
      await mint(s.base, "Watcher", room);
      expect((await post(s.base, "/api/readonly-seats", { name: "W2", conversation: "peerx:abc" }, webHdr)).status).toBe(400);
      const link = { Authorization: `Bearer ${LINK}` };
      const reg = await post(s.base, "/api/peer/register", { room, name: "Watcher", registration: "reg-peerx-1", host: "peerx" }, link);
      expect(reg.status).toBe(409);
      const human = await post(s.base, "/api/peer/register", { room, name: "Watcher", registration: "reg-peerx-2", host: "peerx", human: true }, link);
      expect(human.status).toBe(409);
      const ok = await post(s.base, "/api/peer/register", { room, name: "Visitor", registration: "reg-peerx-3", host: "peerx" }, link);
      expect(ok.status).toBe(200);
      expect(s.h.manager.getRoom(room)!.whoNames()).not.toContain("Watcher");
    } finally {
      await s.h.close();
      rmSync(s.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("R5: minting ignores case when it checks owners, so a case variant cannot lock out an existing peer human, hosted or local member (gate 2 on cd313e8)", async () => {
    const peerPort = await freePort();
    const s = await start("warn", { links: [{ name: "peerx", url: `http://127.0.0.1:${peerPort}`, token: LINK }] });
    try {
      const room = s.h.manager.createConversation("Ops").id;
      const link = { Authorization: `Bearer ${LINK}` };
      const human = { room, name: "Reader", registration: "reg-peerx-human", host: "peerx", human: true };
      const hosted = { room, name: "Hosted", registration: "reg-peerx-hosted", host: "peerx" };
      expect((await post(s.base, "/api/peer/register", human, link)).status).toBe(200);
      expect((await post(s.base, "/api/peer/register", hosted, link)).status).toBe(200);
      await join_(s.base, "Member", room, PID2);
      for (const variant of ["reader", "READER", "hosted", "mEMBER"]) {
        const r = await post(s.base, "/api/readonly-seats", { name: variant, conversation: room }, webHdr);
        expect(r.status, `${variant}: ${r.text}`).toBe(409);
      }
      // The existing registrations still renew, exactly as before.
      expect((await post(s.base, "/api/peer/register", human, link)).status).toBe(200);
      expect((await post(s.base, "/api/peer/register", hosted, link)).status).toBe(200);
      expect((await get(s.base, "/api/readonly-seats", webHdr)).json.seats).toEqual([]);
    } finally {
      await s.h.close();
      rmSync(s.dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the room never wakes a seat's name (backstop)", () => {
  it("R2: even a member that somehow holds the name is not woken by @name or @all; the rename onto it is refused", async () => {
    const room = new ChatRoom();
    try {
      room.join("Watcher", 4242);
      room.join("Peer", 4343);
      room.seatReserved = (n) => n.toLowerCase() === "watcher";
      injected.length = 0;
      room.send("Rami", "@Watcher hello");
      room.send("Rami", "@all hello");
      await waitFor("Peer's wake", () => injected.find((i) => i.pid === 4343));
      await sleep(2_500);
      expect(injected.filter((i) => i.pid === 4242)).toEqual([]);
      expect(room.rename("Peer", "Watcher")).toBeNull();
      // Control: without the reservation the same mention wakes it.
      room.seatReserved = undefined;
      room.send("Rami", "@Watcher again");
      await waitFor("Watcher's wake", () => injected.find((i) => i.pid === 4242));
    } finally { room.destroy(); }
  }, 20_000);
});

describe("the allowlist", () => {
  it("is exactly four GET routes", () => {
    expect(SEAT_ALLOWLIST).toEqual(["GET /api/seat/me", "GET /api/seat/read", "GET /api/seat/search", "GET /api/seat/message/:id"]);
  });
});

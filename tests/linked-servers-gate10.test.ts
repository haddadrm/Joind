/**
 * Linked servers, Codex gate round 10: the member registration lifecycle as
 * one write-ahead record per member. One test per finding, each failing on
 * a99e988, through the production join and recovery paths.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "net";

const injected: Array<{ pid: number; prompt: string }> = [];
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: vi.fn(async (pid: number, prompt: string) => { injected.push({ pid, prompt }); }) };
});
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";
import { LinkRegistry, type FetchLike } from "../src/link.js";
import { MirrorRoom } from "../src/mirror.js";
import { ConversationManager } from "../src/manager.js";

async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 5_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A fake home over fetch that behaves like PeerHub for hosted members:
 *  register is idempotent for the same host id, replaces otherwise;
 *  leave takes the home id or the host's id. */
function fakeHome() {
  const members = new Map<string, { reg: string; hosted: string }>();
  const st = { n: 0, loseNextRegisterReply: false, refuseAll: false, holdRegister: null as null | ((hosted: string) => Promise<void> | null) };
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, string>;
    const ok = (o: unknown) => ({ status: 200, text: async () => JSON.stringify(o) });
    if (url.includes("/api/peer/rooms")) return ok({ server: "home", rooms: [{ id: "c-1", name: "ops", createdAt: 1, messageCount: 0, starred: false }] });
    if (url.includes("/api/peer/messages")) return ok({ server: "home", room: "c-1", name: "ops", messages: [], members: [], cursor: 0, complete: true });
    if (url.includes("/api/peer/register")) {
      if (st.refuseAll) return { status: 409, text: async () => JSON.stringify({ error: "taken", code: "name-conflict", candidates: [{ conversation: "c-1", host: "home", pid: 1 }] }) };
      const existing = members.get(body.name);
      const reg = existing && existing.hosted === body.registration ? existing.reg : `H${++st.n}`;
      members.set(body.name, { reg, hosted: body.registration });
      const hold = st.holdRegister?.(body.registration);
      if (hold) await hold;
      if (st.loseNextRegisterReply) { st.loseNextRegisterReply = false; throw new Error("connect ECONNRESET (the reply was lost)"); }
      return ok({ ok: true, registration: reg, online: [] });
    }
    if (url.includes("/api/peer/leave")) {
      const held = members.get(body.name);
      const match = body.hostedRegistration ? held?.hosted === body.hostedRegistration : held?.reg === body.registration;
      if (!held || !match) return { status: 404, text: async () => JSON.stringify({ error: "No such registration" }) };
      members.delete(body.name);
      return ok({ ok: true });
    }
    return ok({});
  };
  return { members, st, fetchImpl };
}

function registry(dir: string, fetchImpl: FetchLike) {
  const manager = new ConversationManager(join(dir, "data"));
  const reg = new LinkRegistry([{ name: "home", url: "http://127.0.0.1:1", token: "tok-12345678" }], {
    selfName: "here", linksDir: join(dir, "links"), manager, fetchImpl, backoffMinMs: 20, backoffMaxMs: 40, pollTimeoutMs: 50,
  });
  return { manager, reg, stop: () => { reg.stop(); for (const r of manager.listRemote()) r.room.destroy(); } };
}

describe("gate round 10, the member lifecycle (production join and recovery paths)", () => {
  it("finding 1: a room whose only state is an unconfirmed join (reply lost, caller got 503) is cleaned by recovery after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g10-a-"));
    const home = fakeHome();
    const first = registry(dir, home.fetchImpl);
    try {
      await first.reg.get("home")!.discover();
      home.st.loseNextRegisterReply = true;
      const out = await first.reg.registerMember("home:c-1", "Curzon", "reg-A", { pid: 999_001 });
      expect(out.ok).toBe(false);
      expect(home.members.get("Curzon")?.hosted).toBe("reg-A");      // the home accepted it
      first.stop();                                                   // restart
      const second = registry(dir, home.fetchImpl);
      try {
        await second.reg.get("home")!.discover();                     // production recovery
        await waitFor("the home member released", () => !home.members.has("Curzon"), 3_000);
        expect((second.manager.getRoom("home:c-1") as MirrorRoom).hasMemberRecords()).toBe(false);
      } finally { second.stop(); }
    } finally { first.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("finding 3: a restore reply that lands after the member departed becomes debt and is released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g10-c-"));
    const home = fakeHome();
    const r = registry(dir, home.fetchImpl);
    try {
      await r.reg.get("home")!.discover();
      const m = r.manager.getRoom("home:c-1") as MirrorRoom;
      // B is the member here.
      const b = await r.reg.registerMember("home:c-1", "Ezri", "reg-B", { pid: 999_003 });
      if (!b.ok) throw new Error("B");
      m.join("Ezri", 999_003, undefined, undefined, undefined, undefined, "reg-B");
      r.reg.commitMember("home:c-1", "Ezri", b);
      // A registers (the home now holds A) and is superseded; its restore of B pauses.
      const a = await r.reg.registerMember("home:c-1", "Ezri", "reg-A", { pid: 999_005 });
      if (!a.ok) throw new Error("A");
      let release!: () => void;
      const gate = new Promise<void>((res) => { release = res; });
      let held = false;
      home.st.holdRegister = (hosted) => (hosted === "reg-B" ? (held = true, gate) : null);
      const abandoning = r.reg.abandonMember("home:c-1", "Ezri", a);
      await waitFor("the restore in flight", () => held);
      m.leave("Ezri");                                                // B departs before the reply
      home.st.holdRegister = null;
      release();
      await abandoning;
      await waitFor("nothing held at the home", () => !home.members.has("Ezri"), 3_000);
      expect(m.memberRecord("Ezri")).toMatchObject({ live: null, unconfirmed: null, releasesOwed: [] });
    } finally { r.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("finding 4 (Low): 25 joins refused for good leave no record behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g10-d-"));
    const home = fakeHome();
    const r = registry(dir, home.fetchImpl);
    try {
      await r.reg.get("home")!.discover();
      home.st.refuseAll = true;
      for (let i = 0; i < 25; i++) {
        const out = await r.reg.registerMember("home:c-1", "Quark", `reg-q${i}`, { pid: 999_100 + i });
        expect(out.ok).toBe(false);
      }
      await r.reg.get("home")!.discover();                            // a healthy rediscovery
      const legacy = join(dir, "links", "home", "c-1.releases.json");
      const legacyIntents = existsSync(legacy) ? ((JSON.parse(readFileSync(legacy, "utf-8")) as { intents?: unknown[] }).intents ?? []).length : 0;
      expect(legacyIntents).toBe(0);
      const current = join(dir, "links", "home", "c-1.members.json");
      const members = existsSync(current) ? (JSON.parse(readFileSync(current, "utf-8")) as { members: unknown[] }).members : [];
      expect(members).toEqual([]);
    } finally { r.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
const TOKEN = "gate10-link-token-0123456789";
const WEB = "e".repeat(64);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); const port = typeof a === "object" && a ? a.port : 0; s.close(() => resolve(port)); });
  });
}

function config(dir: string, instance: string, port: number, peer: string, peerPort: number): JoindConfig {
  return {
    port, host: "127.0.0.1", dataDir: join(dir, "data"), instance, crewHome: join(dir, "crew"),
    humanNames: [], presenceGraceMs: 1_800_000, logFile: "none", webToken: WEB, webTokenUserSet: true,
    links: [{ name: peer, url: `http://127.0.0.1:${peerPort}`, token: TOKEN }],
  };
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { text }; }
  return { status: res.status, json };
}

describe("gate round 10, finding 2: recovery never puts an obsolete id over the live member (real servers, a real wake)", { timeout: 20_000 }, () => {
  let dirA: string, dirB: string;
  let A: JoindHandle, B: JoindHandle;
  let room: string;
  const net = { down: false, loseNextRegisterReply: false, holdRegisterReply: null as Promise<void> | null, heldRegister: false };

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), "joind-g10-A-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-g10-B-"));
    const [pa, pb] = [await freePort(), await freePort()];
    const fetchImpl: FetchLike = async (url, init) => {
      if (net.down) throw new Error("connect ECONNREFUSED (test)");
      const res = await fetch(url, init);
      const text = await res.text();
      if (url.includes("/api/peer/register")) {
        if (net.loseNextRegisterReply) { net.loseNextRegisterReply = false; throw new Error("connect ECONNRESET (the reply was lost)"); }
        if (net.holdRegisterReply) { net.heldRegister = true; await net.holdRegisterReply; }
      }
      return { status: res.status, text: async () => text };
    };
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 60_000 };
    A = await startJoind(config(dirA, "alpha", pa, "bravo", pb), { link: tuning });
    room = A.manager.createConversation("ops").id;
    B = await startJoind(config(dirB, "bravo", pb, "alpha", pa), { link: { ...tuning, fetchImpl } });
    await waitFor("B to mirror the room", () => B.manager.getRoom(`alpha:${room}`));
  }, 30_000);

  afterAll(async () => {
    net.down = false;
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
  });

  it("an OLD join's lost reply, then NEW joined; during recovery a mention wakes NEW", async () => {
    const remote = `alpha:${room}`;
    net.loseNextRegisterReply = true;
    const old = await post(B.baseUrl, "/api/agent/join", { name: "Kira", pid: 999_201, conversation: remote });
    expect(old.status).toBe(503);                                   // OLD reached A; its reply was lost
    const fresh = await post(B.baseUrl, "/api/agent/join", { name: "Kira", pid: 999_203, conversation: remote });
    expect(fresh.status).toBe(200);
    const mirror = B.manager.getRoom(remote) as MirrorRoom;
    const live = mirror.registrationOf("Kira")!;
    await waitFor("A holds NEW", () => A.manager.getRoom(room)!.hostedRegistrationOf("Kira") === live);
    // Recovery: the link drops and returns; the first registration reply of
    // the recovery pauses, and a mention lands meanwhile.
    net.down = true;
    await B.links.get("alpha")!.discover().catch(() => undefined);
    await waitFor("B down", () => B.links.get("alpha")!.info().state === "down");
    let release!: () => void;
    net.holdRegisterReply = new Promise<void>((r) => { release = r; });
    net.down = false;
    void B.links.get("alpha")!.discover().catch(() => undefined);
    await waitFor("a recovery registration in flight", () => net.heldRegister);
    expect(A.manager.getRoom(room)!.hostedRegistrationOf("Kira")).toBe(live);   // the home still holds NEW
    injected.length = 0;
    await post(A.baseUrl, "/api/send", { sender: "Sisko", text: "@Kira during recovery", token: WEB, conversation: room });
    const call = await waitFor("the wake reached NEW", () => injected.find((c) => /@Kira mentioned by Sisko/.test(c.prompt)), 8_000);
    expect(call.pid).toBe(999_203);
    net.holdRegisterReply = null;
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(A.manager.getRoom(room)!.read().some((m) => /Could not wake Kira/.test(m.text))).toBe(false);
    await waitFor("B's record: NEW live, nothing else", () => {
      const rec = mirror.memberRecord("Kira");
      return rec.live === live && rec.unconfirmed === null && rec.releasesOwed.length === 0;
    });
  });
});

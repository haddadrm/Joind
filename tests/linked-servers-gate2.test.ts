/**
 * Linked servers, Codex gate round 2: one test per server finding, each
 * failing on b73ea7e. Two real servers in one process where the finding
 * needs the routes; the mirror and the link registry directly with a fake
 * home where it is about ordering.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "net";

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: vi.fn(async () => undefined) };
});
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";
import { LinkRegistry, type FetchLike } from "../src/link.js";
import { MirrorRoom, type MirrorNotice, type MirrorTransport } from "../src/mirror.js";
import { ConversationManager } from "../src/manager.js";
import { PeerRefusedError, type PeerSendBody } from "../src/peer-types.js";
import type { ChatMessage, RoomEvent } from "../src/room.js";

const TOKEN = "gate2-link-token-0123456789";
const WEB = "c".repeat(64);
const auth = { Authorization: `Bearer ${TOKEN}` };

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

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 12_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { text }; }
  return { status: res.status, json };
}

describe("linked servers, gate round 2 (routes)", { timeout: 20_000 }, () => {
  let dirA: string, dirB: string;
  let A: JoindHandle, B: JoindHandle;
  let cut = false;
  let room: string;
  let remote: string;

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), "joind-g2-a-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-g2-b-"));
    const [pa, pb] = [await freePort(), await freePort()];
    const fetchImpl: FetchLike = async (url, init) => {
      if (cut) throw new Error("connect ECONNREFUSED (link cut by the test)");
      const res = await fetch(url, init);
      return { status: res.status, text: () => res.text() };
    };
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 60_000 };
    A = await startJoind(config(dirA, "alpha", pa, "bravo", pb), { link: tuning });
    room = A.manager.createConversation("ops").id;
    remote = `alpha:${room}`;
    B = await startJoind(config(dirB, "bravo", pb, "alpha", pa), { link: { ...tuning, fetchImpl } });
    await waitFor("B to mirror A's room", () => B.manager.getRoom(remote));
  }, 30_000);

  afterAll(async () => {
    cut = false;
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
  });

  it("finding 1: renaming a local member onto a peer human's name is refused with 409 and the candidates", async () => {
    expect((await post(A.baseUrl, "/api/peer/register", { room, name: "Worf", host: "bravo", registration: "human:bravo", human: true }, auth)).status).toBe(200);
    expect((await post(A.baseUrl, "/api/agent/join", { name: "Tom", pid: 999_921, conversation: room })).status).toBe(200);
    const r = await post(A.baseUrl, "/api/rename", { oldName: "Tom", newName: "Worf", conversation: room });
    expect(r.status).toBe(409);
    expect(r.json.candidates).toEqual([{ conversation: room, host: "bravo", human: true }]);
    const home = A.manager.getRoom(room)!;
    expect(home.getAgent("Tom")).toBeDefined();
    expect(home.getAgent("Worf")).toBeUndefined();
    expect(home.peerOwnerOf("Worf")).toEqual({ peer: "bravo", human: true });
  });

  it("finding 3: a new session of a name reusing an old clientId is a new message", async () => {
    const one = await post(A.baseUrl, "/api/peer/register", { room, name: "Nog", host: "bravo", registration: "nog-session-1" }, auth);
    const first = await post(A.baseUrl, "/api/peer/send", { room, sender: "Nog", text: "from the first session", clientId: "reused-1", registration: one.json.registration }, auth);
    expect(first.status).toBe(200);
    expect((await post(A.baseUrl, "/api/peer/leave", { room, name: "Nog", registration: one.json.registration }, auth)).status).toBe(200);
    const two = await post(A.baseUrl, "/api/peer/register", { room, name: "Nog", host: "bravo", registration: "nog-session-2" }, auth);
    const second = await post(A.baseUrl, "/api/peer/send", { room, sender: "Nog", text: "from the second session", clientId: "reused-1", registration: two.json.registration }, auth);
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBeUndefined();
    expect((second.json.message as ChatMessage).text).toBe("from the second session");
    expect(A.manager.getRoom(room)!.read().some((m) => m.text === "from the second session")).toBe(true);
  });

  it("finding 8: the viewer's first message in a remote room while offline is queued (202, waiting) and goes when the link returns", async () => {
    expect((await post(B.baseUrl, "/api/web/register", { token: WEB, name: "Rami" })).status).toBe(200);
    cut = true;
    try {
      await B.links.get("alpha")!.discover().catch(() => undefined);
      await waitFor("B to see the link down", () => B.links.get("alpha")!.info().state === "down");
      const r = await post(B.baseUrl, "/api/send", { sender: "Rami", text: "written offline before registering", token: WEB, conversation: remote });
      expect(r.status).toBe(202);
      expect(r.json.pending).toMatchObject({ clientId: r.json.clientId, sender: "Rami", state: "waiting" });
    } finally {
      cut = false;
    }
    const landed = await waitFor("the message on A", () => A.manager.getRoom(room)!.read().find((m) => m.text === "written offline before registering"));
    expect(landed.sender).toBe("Rami");
    await waitFor("the queue empty", () => (B.manager.getRoom(remote) as MirrorRoom).queuedCount() === 0);
  });

  it("finding 9: a new web viewer name releases the previous one at the home", async () => {
    await waitFor("the link up", async () => { await B.links.get("alpha")!.discover().catch(() => undefined); return B.links.get("alpha")!.info().state === "up"; });
    await B.links.ensureHuman(remote, "Rami");
    expect(A.manager.getRoom(room)!.peerOwnerOf("Rami")).toEqual({ peer: "bravo", human: true });
    await B.links.ensureHuman(remote, "Benjamin");
    const home = A.manager.getRoom(room)!;
    expect(home.peerOwnerOf("Benjamin")).toEqual({ peer: "bravo", human: true });
    expect(home.peerOwnerOf("Rami")).toBeUndefined();
    // The released name can be joined locally again.
    expect((await post(A.baseUrl, "/api/agent/join", { name: "Rami", pid: 999_923, conversation: room })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
function transport(): MirrorTransport & { sent: PeerSendBody[]; refuse: Set<string> } {
  const t = {
    sent: [] as PeerSendBody[],
    refuse: new Set<string>(),
    isUp: () => true,
    send: async (body: PeerSendBody): Promise<ChatMessage> => {
      if (!body.registration) throw new PeerRefusedError(403, `${body.sender} is not registered`, "not-registered");
      if (t.refuse.has(body.text)) throw new PeerRefusedError(400, "to must be an array of names");
      t.sent.push(body);
      return { id: 1 + t.sent.length, sender: body.sender, text: body.text, timestamp: Date.now() };
    },
    leave: async () => undefined,
    act: async () => undefined,
    register: async () => ({ ok: true, registration: "reg-home", online: [] }),
    failed: () => undefined,
  };
  return t;
}

function member(m: MirrorRoom, name: string): void {
  m.join(name, 999_931, undefined, undefined, undefined, undefined, `reg-local-${name}`);
  m.setShadow(name, { homeRegistration: `reg-home-${name}` });
}

describe("linked servers, gate round 2 (mirror and link)", { timeout: 20_000 }, () => {
  it("finding 2: a restore after a superseded join never lands after a newer join", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g2-lock-"));
    const manager = new ConversationManager(join(dir, "data"));
    // A fake home: registrations are recorded when the request is processed;
    // one request can be held (the slow restore).
    const home = new Map<string, string>();
    let holdNext = false;
    let releaseHeld: (() => void) | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes("/api/peer/rooms")) return { status: 200, text: async () => JSON.stringify({ server: "home", rooms: [{ id: "c-1", name: "ops", createdAt: 1, messageCount: 0, starred: false }] }) };
      if (url.includes("/api/peer/register")) {
        const body = JSON.parse(init.body ?? "{}") as { name: string; registration: string };
        if (holdNext) { holdNext = false; await new Promise<void>((r) => { releaseHeld = r; }); }
        home.set(body.name, body.registration);
        return { status: 200, text: async () => JSON.stringify({ ok: true, registration: `home-${body.registration}`, online: [] }) };
      }
      return { status: 200, text: async () => "{}" };
    };
    const reg = new LinkRegistry([{ name: "home", url: "http://127.0.0.1:1", token: "tok-12345678" }], { selfName: "here", linksDir: join(dir, "links"), manager, fetchImpl });
    try {
      await reg.get("home")!.discover();
      const id = "home:c-1";
      const m = manager.getRoom(id) as MirrorRoom;
      // B is the member here.
      const b = await reg.registerMember(id, "Ezri", "rB", { pid: 999_941 });
      if (!b.ok) throw new Error("register B");
      m.join("Ezri", 999_941, undefined, undefined, undefined, undefined, "rB");
      reg.commitMember(id, "Ezri", b);
      // A registered, then found superseded: its restore of B is slow.
      const a = await reg.registerMember(id, "Ezri", "rA", { pid: 999_943 });
      if (!a.ok) throw new Error("register A");
      holdNext = true;
      const abandoning = reg.abandonMember(id, "Ezri", a);
      await waitFor("the restore to be held", () => releaseHeld !== null);
      // C joins meanwhile.
      const joiningC = (async () => {
        const c = await reg.registerMember(id, "Ezri", "rC", { pid: 999_945 });
        if (!c.ok) throw new Error("register C");
        m.join("Ezri", 999_945, undefined, undefined, undefined, undefined, "rC");
        reg.commitMember(id, "Ezri", c);
      })();
      await new Promise((r) => setTimeout(r, 50));
      releaseHeld!();
      await abandoning;
      await joiningC;
      expect(m.registrationOf("Ezri")).toBe("rC");
      expect(home.get("Ezri")).toBe("rC");
      expect(m.homeRegistrationOf("Ezri")).toBe("home-rC");
    } finally {
      reg.stop();
      for (const r of manager.listRemote()) r.room.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finding 4: a refill never removes a message a send inserted after the snapshot was requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g2-snap-"));
    const manager = new ConversationManager(join(dir, "data"));
    let releaseSnapshot: (() => void) | null = null;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/api/peer/rooms")) return { status: 200, text: async () => JSON.stringify({ server: "home", rooms: [{ id: "c-1", name: "ops", createdAt: 1, messageCount: 1, starred: false }] }) };
      if (url.includes("/api/peer/messages")) {
        // Taken at cursor 1, before message 2 existed; answered late.
        await new Promise<void>((r) => { releaseSnapshot = r; });
        return { status: 200, text: async () => JSON.stringify({ server: "home", room: "c-1", name: "ops", messages: [{ id: 1, sender: "S", text: "one", timestamp: 1 }], members: [], cursor: 1, complete: true }) };
      }
      if (url.includes("/api/peer/send")) return { status: 200, text: async () => JSON.stringify({ ok: true, message: { id: 2, sender: "Curzon", text: "two", timestamp: 2 } }) };
      return { status: 200, text: async () => "{}" };
    };
    const reg = new LinkRegistry([{ name: "home", url: "http://127.0.0.1:1", token: "tok-12345678" }], { selfName: "here", linksDir: join(dir, "links"), manager, fetchImpl });
    try {
      const client = reg.get("home")!;
      await client.discover();
      const m = manager.getRoom("home:c-1") as MirrorRoom;
      member(m, "Curzon");
      const events: RoomEvent[] = [];
      m.on("room", (e: RoomEvent) => events.push(e));
      m.applyEvent({ seq: 1, type: "message", data: { id: 1, sender: "S", text: "one", timestamp: 1 } });
      const refill = client.fill(m, undefined, true);       // the recovery refill, requested now
      await waitFor("the snapshot request in flight", () => releaseSnapshot !== null);
      const sent = await m.writeThrough("Curzon", "two");   // the queue restoration sends meanwhile
      expect(sent.status).toBe("sent");
      releaseSnapshot!();
      await refill;
      expect(m.readAll().map((x) => x.id)).toEqual([1, 2]);
      expect(events.filter((e) => e.type === "message-deleted")).toEqual([]);
      expect(events.filter((e) => e.type === "message" && (e.data as ChatMessage).id === 2)).toHaveLength(1);
    } finally {
      reg.stop();
      for (const r of manager.listRemote()) r.room.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finding 5: deleting a held entry lets its author's later entries go", async () => {
    const t = transport();
    const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: null, transport: t, selfName: "here" });
    member(m, "Curzon");
    try {
      t.refuse.add("bad");
      t.isUp = () => false;
      await m.writeThrough("Curzon", "bad");
      await m.writeThrough("Curzon", "later");
      t.isUp = () => true;
      await m.drain();
      expect(t.sent).toEqual([]);
      const held = m.pendingFor(undefined).find((p) => p.text === "bad")!;
      expect(m.deleteUndelivered(held.clientId, "Curzon")).toEqual({ ok: true });
      await waitFor("the later entry sent", () => t.sent.some((b) => b.text === "later"));
    } finally { m.destroy(); }
  });

  it("finding 6: registering the human resumes its waiting messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g2-h-"));
    try {
      const file = join(dir, "q.jsonl");
      writeFileSync(file, JSON.stringify({ clientId: "h-1", sender: "Rami", text: "persisted human DM", to: ["Kira"], queuedAt: 1, attempts: 0 }) + "\n");
      const t = transport();
      const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: file, transport: t, selfName: "here" });
      try {
        await m.drain();
        expect(t.sent).toEqual([]);
        m.setHuman("Rami", "reg-human");
        await waitFor("the waiting DM sent", () => t.sent.some((b) => b.clientId === "h-1"));
      } finally { m.destroy(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("finding 7: after a restart a held entry says it is held, and why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g2-held-"));
    try {
      const file = join(dir, "q.jsonl");
      writeFileSync(file, JSON.stringify({ clientId: "held-1", sender: "Curzon", text: "refused before", queuedAt: 1, attempts: 1, state: "held", heldReason: "to must be an array of names" }) + "\n");
      const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: file, transport: transport(), selfName: "here" });
      const notices: MirrorNotice[] = [];
      m.on("mirror-notice", (n: MirrorNotice) => notices.push(n));
      try {
        expect(m.pendingFor(undefined)).toEqual([expect.objectContaining({ clientId: "held-1", state: "held", reason: "to must be an array of names" })]);
        expect(m.readForView(10, undefined).some((x) => x.local && x.text === "A queued message from Curzon was refused by home: to must be an array of names. It stays queued until its author deletes it.")).toBe(true);
        // A fresh queued entry says "queued".
        member(m, "Curzon");
        (m as unknown as { transport: MirrorTransport }).transport.isUp = () => false;
        await m.writeThrough("Curzon", "new one");
        expect(notices.find((n) => n.type === "pending")?.data).toMatchObject({ text: "new one", state: "queued" });
      } finally { m.destroy(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

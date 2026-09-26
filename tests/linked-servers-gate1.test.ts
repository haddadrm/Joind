/**
 * Linked servers, Codex gate round 1: one test per server finding, each
 * failing on 7753499. Two real servers in one process (A is the home of a
 * room, B hosts members of it), a fake injector, a switch that cuts B's
 * network, and a terminal-validation stub that a test can hold open so a
 * peer registration or a competing join lands in the middle of a join.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "net";

const injected: Array<{ pid: number; prompt: string }> = [];
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: vi.fn(async (pid: number, prompt: string) => { injected.push({ pid, prompt }); }) };
});

// Each join enumerates processes once (processTreeOnce). A test arms a hold
// to park the next join there; unarmed joins pass at once (fake pids).
const holds: Array<{ promise: Promise<Map<number, never>>; taken: boolean }> = [];
function arm(): { release: () => void; taken: () => boolean } {
  let release!: () => void;
  const h = { promise: new Promise<Map<number, never>>((r) => { release = () => r(new Map()); }), taken: false };
  holds.push(h);
  return { release, taken: () => h.taken };
}
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return {
    ...actual,
    processTreeOnce: () => {
      let p: Promise<Map<number, never>> | null = null;
      return () => (p ??= (() => { const h = holds.shift(); if (!h) return Promise.resolve(new Map()); h.taken = true; return h.promise; })());
    },
    // Validation parks a join in the process table; with no live WezTerm GUI
    // a join naming no pane would skip it (link-join-latency), so one is live here.
    anyLiveGuiSocket: () => true,
  };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";
import type { FetchLike } from "../src/link.js";
import { MirrorRoom, type MirrorNotice, type MirrorTransport } from "../src/mirror.js";
import { PeerRefusedError, type PeerSendBody } from "../src/peer-types.js";
import type { ChatMessage, RoomEvent } from "../src/room.js";

const TOKEN = "gate1-link-token-0123456789";
const WEB = "b".repeat(64);
const auth = { Authorization: `Bearer ${TOKEN}` };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); const port = typeof a === "object" && a ? a.port : 0; s.close(() => resolve(port)); });
  });
}

function switchableFetch(): { fetchImpl: FetchLike; cut: (v: boolean) => void } {
  let down = false;
  const fetchImpl: FetchLike = async (url, init) => {
    if (down) throw new Error("connect ECONNREFUSED (link cut by the test)");
    const res = await fetch(url, init);
    return { status: res.status, text: () => res.text() };
  };
  return { fetchImpl, cut: (v) => { down = v; } };
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

async function get(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

describe("linked servers, gate round 1 (server findings)", { timeout: 20_000 }, () => {
  let dirA: string, dirB: string;
  let A: JoindHandle, B: JoindHandle;
  let netB: ReturnType<typeof switchableFetch>;
  let room: string;
  let remote: string;

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), "joind-g1-a-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-g1-b-"));
    const [pa, pb] = [await freePort(), await freePort()];
    netB = switchableFetch();
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 60_000 };
    A = await startJoind(config(dirA, "alpha", pa, "bravo", pb), { link: tuning });
    B = await startJoind(config(dirB, "bravo", pb, "alpha", pa), { link: { ...tuning, fetchImpl: netB.fetchImpl } });
    room = A.manager.createConversation("ops").id;
    remote = `alpha:${room}`;
    // Kira on B keeps the remote room subscribed for the whole file.
    const k = await post(B.baseUrl, "/api/agent/join", { name: "Kira", pid: 999_901, conversation: remote });
    expect(k.status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
  });

  it("finding 1: a name a peer holds for its human refuses a local join (409 with the candidates), and a local name refuses a peer human", async () => {
    const h = await post(A.baseUrl, "/api/peer/register", { room, name: "Odo", host: "bravo", registration: "human:bravo", human: true }, auth);
    expect(h.status).toBe(200);
    const local = await post(A.baseUrl, "/api/agent/join", { name: "Odo", pid: 999_903, conversation: room });
    expect(local.status).toBe(409);
    expect(local.json.candidates).toEqual([{ conversation: room, host: "bravo", human: true }]);
    expect(A.manager.getRoom(room)!.getAgent("Odo")).toBeUndefined();
    const q = await post(A.baseUrl, "/api/agent/join", { name: "Quark", pid: 999_905, conversation: room });
    expect(q.status).toBe(200);
    const h2 = await post(A.baseUrl, "/api/peer/register", { room, name: "Quark", host: "bravo", registration: "human:bravo", human: true }, auth);
    expect(h2.status).toBe(409);
  });

  it("finding 2: a clientId retry is answered only to the sender that made it", async () => {
    const reg = await post(A.baseUrl, "/api/peer/register", { room, name: "Nog", host: "bravo", registration: "nog-local-reg" }, auth);
    expect(reg.status).toBe(200);
    const dm = await post(A.baseUrl, "/api/peer/send", { room, sender: "Nog", text: "private to Quark", to: ["Quark"], clientId: "c-private", registration: reg.json.registration }, auth);
    expect(dm.status).toBe(200);
    const probe = await post(A.baseUrl, "/api/peer/send", { room, sender: "Rom", text: "anything", clientId: "c-private" }, auth);
    expect(probe.status).toBe(403);
    expect(JSON.stringify(probe.json)).not.toContain("private to Quark");
    // The real retry still gets its first copy.
    const retry = await post(A.baseUrl, "/api/peer/send", { room, sender: "Nog", text: "private to Quark", to: ["Quark"], clientId: "c-private", registration: reg.json.registration }, auth);
    expect(retry.json.duplicate).toBe(true);
    expect((retry.json.message as ChatMessage).id).toBe((dm.json.message as ChatMessage).id);
  });

  it("finding 3: a superseded remote join leaves the home holding the newer member, whose wakes still land", async () => {
    const held = arm();
    const older = post(B.baseUrl, "/api/agent/join", { name: "Ezri", pid: 999_907, conversation: remote });
    await waitFor("the older join parked in validation", () => held.taken());
    const newer = await post(B.baseUrl, "/api/agent/join", { name: "Ezri", pid: 999_909, conversation: remote });
    expect(newer.status).toBe(200);
    held.release();
    expect((await older).status).toBe(409);
    const mirror = B.manager.getRoom(remote)!;
    await waitFor("the home to hold the newer registration", () =>
      A.manager.getRoom(room)!.hostedRegistrationOf("Ezri") === mirror.registrationOf("Ezri"));
    injected.length = 0;
    await post(A.baseUrl, "/api/send", { sender: "Sisko", text: "@Ezri status?", token: WEB, conversation: room });
    const call = await waitFor("a wake for Ezri", () => injected.find((c) => /@Ezri mentioned by Sisko/.test(c.prompt)));
    expect(call.pid).toBe(999_909);
  });

  it("finding 4: a peer registration made while a local join validates wins; the local join is refused", async () => {
    const held = arm();
    const local = post(A.baseUrl, "/api/agent/join", { name: "Garak", pid: 999_911, conversation: room });
    await waitFor("the local join parked in validation", () => held.taken());
    const peer = await post(A.baseUrl, "/api/peer/register", { room, name: "Garak", host: "bravo", registration: "garak-local-reg" }, auth);
    expect(peer.status).toBe(200);
    held.release();
    const r = await local;
    expect(r.status).toBe(409);
    const member = A.manager.getRoom(room)!.getAgent("Garak")!;
    expect(member.host).toBe("bravo");
    expect(member.pid).toBe(0);
  });

  it("finding 5: messages that arrived during an outage are emitted as room events on recovery", async () => {
    const events: Array<RoomEvent & { conversationId: string }> = [];
    const on = (e: RoomEvent & { conversationId: string }) => events.push(e);
    B.manager.on("room", on);
    try {
      netB.cut(true);
      await waitFor("B to see the link down", () => B.links.get("alpha")!.info().state === "down");
      A.manager.getRoom(room)!.send("Sisko", "said during the outage");
      netB.cut(false);
      const ev = await waitFor("the recovered message as an event", () =>
        events.find((e) => e.type === "message" && e.conversationId === remote && (e.data as ChatMessage).text === "said during the outage"));
      expect((ev.data as ChatMessage).id).toBe(A.manager.getRoom(room)!.read().find((m) => m.text === "said during the outage")!.id);
    } finally {
      netB.cut(false);
      B.manager.removeListener("room", on);
    }
  });

  it("finding 8: a web mailbox DM to a member of a remote room is written through", async () => {
    expect((await post(B.baseUrl, "/api/web/register", { token: WEB, name: "Rami" })).status).toBe(200);
    const r = await post(B.baseUrl, "/api/dm/send", { to: "Kira", text: "mailbox note for Kira", token: WEB });
    expect(r.status).toBe(200);
    expect(r.json.conversationId).toBe(remote);
    const home = A.manager.getRoom(room)!.read(undefined, 100, undefined, "Kira").find((m) => m.text === "mailbox note for Kira")!;
    expect(home.sender).toBe("Rami");
    expect(home.to).toEqual(["Kira"]);
    expect(r.json.id).toBe(home.id);
  });

  it("finding 9: the mailbox thread and partners include DMs in remote rooms", async () => {
    expect((await post(B.baseUrl, "/api/web/register", { token: WEB, name: "Rami" })).status).toBe(200);
    // A DM between Rami and Kira written on the home; B mirrors it for Kira.
    A.manager.getRoom(room)!.send("Kira", "remote DM for the mailbox", { to: ["Rami"] });
    await waitFor("the DM on B's mirror", () => B.manager.getRoom(remote)!.readAll().some((m) => m.text === "remote DM for the mailbox"));
    const thread = await get(B.baseUrl, `/api/dms?token=${WEB}&with=Kira`);
    expect((thread.json.messages as Array<ChatMessage & { conversationId: string }>).find((m) => m.text === "remote DM for the mailbox")?.conversationId).toBe(remote);
    const partners = await get(B.baseUrl, `/api/dms?token=${WEB}`);
    expect((partners.json.partners as Array<{ partner: string }>).map((p) => p.partner)).toContain("Kira");
  });

  it("finding 10: web edits and reactions in a remote room are refused before anything changes", async () => {
    expect((await post(B.baseUrl, "/api/web/register", { token: WEB, name: "Rami" })).status).toBe(200);
    A.manager.getRoom(room)!.send("Sisko", "a public line to react to");
    await waitFor("the line on B's mirror", () => B.manager.getRoom(remote)!.readAll().some((m) => m.text === "a public line to react to"));
    expect((await post(B.baseUrl, "/api/conversations/select", { id: remote, token: WEB })).status).toBe(200);
    const target = B.manager.getRoom(remote)!.readAll().find((m) => m.text === "a public line to react to")!;
    const react = await post(B.baseUrl, `/api/message/${target.id}/react`, { sender: "Rami", emoji: "+1" });
    expect(react.status).toBe(400);
    const edit = await post(B.baseUrl, `/api/message/${target.id}/edit`, { sender: "Rami", newText: "changed here only", token: WEB });
    expect(edit.status).toBe(400);
    expect(B.manager.getRoom(remote)!.getMessageById(target.id)!.text).toBe("a public line to react to");
  });
});

// ---------------------------------------------------------------------------
function transport(): MirrorTransport & { sent: PeerSendBody[]; notices?: MirrorNotice[] } {
  const t = {
    sent: [] as PeerSendBody[],
    isUp: () => true,
    // The home refuses a sender it does not know, as /api/peer/send does.
    send: async (body: PeerSendBody): Promise<ChatMessage> => {
      if (!body.registration) throw new PeerRefusedError(403, `${body.sender} is not registered`, "not-registered");
      t.sent.push(body);
      return { id: 50 + t.sent.length, sender: body.sender, text: body.text, timestamp: Date.now() };
    },
    leave: async () => undefined,
    act: async () => undefined,
    register: async () => ({ ok: true, registration: "reg-home", online: [] }),
    failed: () => undefined,
  };
  return t;
}

describe("gate round 1, mirror findings", () => {
  it("finding 6: a refill drops cached messages the home no longer has within the snapshot's range", () => {
    const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: null, transport: transport(), selfName: "host" });
    try {
      for (const id of [1, 2, 3]) m.applyEvent({ seq: id, type: "message", data: { id, sender: "S", text: `m${id}`, timestamp: id } });
      m.fill({ server: "home", room: "c-1", name: "ops", messages: [{ id: 2, sender: "S", text: "m2", timestamp: 2 }], members: [], cursor: 9, complete: true });
      expect(m.readAll().map((x) => x.id)).toEqual([2]);
      for (const id of [1, 3, 4]) m.applyEvent({ seq: id, type: "message", data: { id, sender: "S", text: `m${id}`, timestamp: id } });
      // A snapshot cut by its limit is authoritative from its oldest message on.
      m.fill({ server: "home", room: "c-1", name: "ops", messages: [{ id: 2, sender: "S", text: "m2", timestamp: 2 }, { id: 4, sender: "S", text: "m4", timestamp: 4 }], members: [], cursor: 10, complete: false });
      expect(m.readAll().map((x) => x.id)).toEqual([1, 2, 4]);
    } finally { m.destroy(); }
  });

  it("finding 7: a persisted entry whose author has not rejoined waits instead of being deleted, and goes when the author rejoins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g1-q-"));
    try {
      const file = join(dir, "c-1.queue.jsonl");
      writeFileSync(file, JSON.stringify({ clientId: "cold-1", sender: "Curzon", text: "written before both restarted", queuedAt: 1, attempts: 0 }) + "\n");
      const t = transport();
      const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: file, transport: t, selfName: "host" });
      const notices: MirrorNotice[] = [];
      m.on("mirror-notice", (n: MirrorNotice) => notices.push(n));
      try {
        expect(await m.drain()).toBe(0);
        expect(m.pendingFor(undefined).map((p) => p.clientId)).toEqual(["cold-1"]);
        expect(notices.some((n) => n.type === "pending-deleted")).toBe(false);
        m.join("Curzon", 999_913, undefined, undefined, undefined, undefined, "reg-local");
        m.setShadow("Curzon", { homeRegistration: "reg-home" });
        m.resumeAuthor("Curzon");
        await waitFor("the waiting entry sent", () => t.sent.length === 1);
        expect(t.sent[0]).toMatchObject({ clientId: "cold-1", sender: "Curzon", registration: "reg-home" });
        await waitFor("the queue empty", () => m.queuedCount() === 0);
      } finally { m.destroy(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

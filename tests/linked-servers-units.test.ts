/**
 * Linked servers, module by module: link config, the mirror (events, local
 * lines, write-through, the undelivered queue), the home-side hub (sequence,
 * visibility, long-poll, peer liveness), hosted members in the room (wake
 * routing, honest lines, the peer-side wake), hosted bindings and remote
 * rooms in the manager, and the link client's state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const injected: Array<{ pid: number; prompt: string }> = [];
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: vi.fn(async (pid: number, prompt: string) => { injected.push({ pid, prompt }); }) };
});

import { parseLinks, validLink, loadConfig } from "../src/config.js";
import { MirrorRoom, UndeliveredQueue, type MirrorNotice, type MirrorTransport } from "../src/mirror.js";
import { PeerHub } from "../src/peer.js";
import { ChatRoom, wakeFailureLine, type ChatMessage, type HostedWakeRequest, type HostedWakeResult, type RoomEvent } from "../src/room.js";
import { ConversationManager, isTerminalLess } from "../src/manager.js";
import { LinkClient, type FetchLike, type LinkInfo } from "../src/link.js";
import { LinkDownError, PeerRefusedError, parseRemoteRoomId, type PeerSendBody } from "../src/peer-types.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// ---------------------------------------------------------------------------
describe("link config", () => {
  it("reads JOIND_LINKS and repeatable --link flags; a later entry of the same name wins", () => {
    const env = JSON.stringify([{ name: "y530", url: "http://100.1.2.3:4200/", token: "tok-env-12345" }]);
    const links = parseLinks(["--link", "y530=http://100.1.2.3:4201=tok-flag-12345", "--link=laptop=http://h:1/x?a=b=tok-third-12345"], env);
    expect(links).toEqual([
      { name: "y530", url: "http://100.1.2.3:4201", token: "tok-flag-12345" },
      { name: "laptop", url: "http://h:1/x?a=b", token: "tok-third-12345" },
    ]);
  });

  it("refuses a bad name, url or short token, and a link named like the server itself", () => {
    expect(() => validLink({ name: "a:b", url: "http://h", token: "12345678" }, "t")).toThrow(/invalid link name/);
    expect(() => validLink({ name: "ok", url: "ftp://h", token: "12345678" }, "t")).toThrow(/http or https/);
    expect(() => validLink({ name: "ok", url: "http://h", token: "short" }, "t")).toThrow(/at least 8/);
    expect(() => parseLinks([], "{")).toThrow(/not valid JSON/);
    expect(() => parseLinks(["--link", "nourl"], undefined)).toThrow(/name=url=token/);
    const dir = tmp("joind-cfg-");
    try {
      expect(() => loadConfig(["--data-dir", join(dir, "d"), "--web-token", "x", "--name", "home", "--link", "home=http://h:1=12345678"])).toThrow(/own name/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("remote room ids split at the first colon; local ids have none", () => {
    expect(parseRemoteRoomId("y530:c-2026-09-25T10-00-00-abcd")).toEqual({ server: "y530", room: "c-2026-09-25T10-00-00-abcd" });
    expect(parseRemoteRoomId("c-2026-09-25T10-00-00-abcd")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
interface FakeTransport extends MirrorTransport {
  up: boolean;
  sent: PeerSendBody[];
  nextId: number;
  failWith?: Error;
  hold?: Promise<void>;
  failures: string[];
}

function fakeTransport(): FakeTransport {
  const t: FakeTransport = {
    up: true, sent: [], nextId: 100, failures: [],
    isUp: () => t.up,
    send: async (body) => {
      if (t.hold) await t.hold;
      if (t.failWith) { const e = t.failWith; t.failWith = undefined; throw e; }
      if (!t.up) throw new LinkDownError("down");
      t.sent.push(body);
      return { id: t.nextId++, sender: body.sender, text: body.text, timestamp: Date.now(), ...(body.to ? { to: body.to } : {}) };
    },
    leave: async () => undefined,
    act: async () => undefined,
    register: async () => ({ ok: true, registration: "reg-home", online: [] }),
    failed: (r) => { t.failures.push(r); t.up = false; },
  };
  return t;
}

function mirrorWith(t: MirrorTransport, queueFile: string | null = null): MirrorRoom {
  const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile, transport: t, selfName: "host" });
  m.join("Curzon", 999_991, undefined, undefined, undefined, undefined, "reg-local");
  m.setShadow("Curzon", { homeRegistration: "reg-home" });
  return m;
}

describe("MirrorRoom", () => {
  let rooms: ChatRoom[] = [];
  afterEach(() => { for (const r of rooms) r.destroy(); rooms = []; });

  it("applies home events by home id, keeps order, and re-emits only home events", () => {
    const m = mirrorWith(fakeTransport()); rooms.push(m);
    const seen: RoomEvent[] = [];
    m.on("room", (e: RoomEvent) => seen.push(e));
    m.touch("Curzon"); // a local member's presence is not a fact of the remote room
    m.applyEvent({ seq: 1, type: "message", data: { id: 5, sender: "Rami", text: "five", timestamp: 1 } });
    m.applyEvent({ seq: 2, type: "message", data: { id: 3, sender: "Rami", text: "three", timestamp: 1 } });
    m.applyEvent({ seq: 3, type: "message", data: { id: 5, sender: "Rami", text: "five again", timestamp: 1 } });
    m.applyEvent({ seq: 4, type: "join", data: { name: "Jadzia", pid: 0, joinedAt: 1, active: true, lastSeen: 1 } });
    expect(m.readAll().map((x) => x.id)).toEqual([3, 5]);
    expect(m.whoNames()).toEqual(["Jadzia"]);
    expect(seen.map((e) => e.type)).toEqual(["message", "message", "join"]);
  });

  it("says link state in local lines: negative ids, never in read(), shown to the viewer", () => {
    const m = mirrorWith(fakeTransport()); rooms.push(m);
    const notices: MirrorNotice[] = [];
    m.on("mirror-notice", (n: MirrorNotice) => notices.push(n));
    m.applyEvent({ seq: 1, type: "message", data: { id: 1, sender: "Rami", text: "hi", timestamp: 1 } });
    const line = m.addLocalLine("link to home down since now");
    expect(line.id).toBeLessThan(0);
    expect(line.local).toBe(true);
    expect(m.read().map((x) => x.id)).toEqual([1]);
    expect(m.readForView(10, undefined).map((x) => x.text)).toEqual(["hi", "link to home down since now"]);
    expect(notices[0]).toEqual({ type: "message", conversationId: "home:c-1", data: line });
  });

  it("writes through when up; queues when down, with a pending notice and a queue file", async () => {
    const dir = tmp("joind-mirror-");
    try {
      const t = fakeTransport();
      const file = join(dir, "q.jsonl");
      const m = mirrorWith(t, file); rooms.push(m);
      const notices: MirrorNotice[] = [];
      m.on("mirror-notice", (n: MirrorNotice) => notices.push(n));
      const sent = await m.writeThrough("Curzon", "online");
      expect(sent).toMatchObject({ status: "sent", message: { id: 100 } });
      expect(t.sent[0]).toMatchObject({ room: "c-1", sender: "Curzon", registration: "reg-home" });
      t.up = false;
      const q = await m.writeThrough("Curzon", "offline", { to: ["Rami"] });
      expect(q.status).toBe("queued");
      expect(notices.find((n) => n.type === "pending")?.data).toMatchObject({ conversationId: "home:c-1", sender: "Curzon", text: "offline", to: ["Rami"] });
      expect(new UndeliveredQueue(file).list().map((e) => e.text)).toEqual(["offline"]);
      // DM visibility of the pending list
      expect(m.pendingFor("Rami")).toHaveLength(1);
      expect(m.pendingFor("Jadzia")).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a send that finds the link down on the way is queued, and the link is told", async () => {
    const t = fakeTransport();
    const m = mirrorWith(t); rooms.push(m);
    t.failWith = new LinkDownError("refused");
    const r = await m.writeThrough("Curzon", "raced the drop");
    expect(r.status).toBe("queued");
    expect(t.failures).toEqual(["refused"]);
    expect(m.queuedCount()).toBe(1);
  });

  it("drains in order, reports each dispatch with the home id, and holds a refused one (with that author's later ones) until its author deletes it", async () => {
    const t = fakeTransport();
    const m = mirrorWith(t); rooms.push(m);
    const notices: MirrorNotice[] = [];
    m.on("mirror-notice", (n: MirrorNotice) => notices.push(n));
    t.up = false;
    await m.writeThrough("Curzon", "one");
    await m.writeThrough("Curzon", "two");
    await m.writeThrough("Curzon", "three");
    t.up = true;
    let calls = 0;
    const realSend = t.send;
    t.send = async (b) => { calls++; if (calls === 2) throw new PeerRefusedError(400, "to must be an array of names"); return realSend(b); };
    expect(await m.drain()).toBe(1);
    expect(t.sent.map((b) => b.text)).toEqual(["one"]);
    expect(notices.filter((n) => n.type === "pending-dispatched").map((n) => n.data)).toEqual([expect.objectContaining({ id: 100 })]);
    expect(notices.some((n) => n.type === "pending-deleted")).toBe(false);
    expect(m.pendingFor(undefined).map((p) => p.text)).toEqual(["two", "three"]);
    expect(m.readForView(10, undefined).some((x) => x.local && /A queued message from Curzon was refused by home: to must be an array of names\. It stays queued until its author deletes it\./.test(x.text))).toBe(true);
    // The author deletes the refused one; the next drain sends the rest.
    const two = m.pendingFor(undefined)[0].clientId;
    expect(m.deleteUndelivered(two, "Curzon")).toEqual({ ok: true });
    t.send = realSend;
    expect(await m.drain()).toBe(1);
    expect(m.readAll().map((x) => x.text)).toEqual(["one", "three"]);
  });

  it("a link failure mid-drain keeps the rest in order and counts the attempt", async () => {
    const t = fakeTransport();
    const m = mirrorWith(t); rooms.push(m);
    t.up = false;
    await m.writeThrough("Curzon", "a");
    await m.writeThrough("Curzon", "b");
    t.up = true;
    t.failWith = new LinkDownError("gone again");
    expect(await m.drain()).toBe(0);
    expect(m.pendingFor(undefined).map((p) => p.text)).toEqual(["a", "b"]);
  });

  it("only the author deletes an undelivered message, and not while it is being sent", async () => {
    const t = fakeTransport();
    const m = mirrorWith(t); rooms.push(m);
    t.up = false;
    const q = await m.writeThrough("Curzon", "draft");
    const id = q.status === "queued" ? q.clientId : "";
    expect(m.deleteUndelivered(id, "Jadzia")).toEqual({ ok: false, status: 403, error: "Only its author may delete an undelivered message" });
    expect(m.deleteUndelivered("nope", "Curzon")).toMatchObject({ ok: false, status: 404 });
    let release!: () => void;
    t.hold = new Promise<void>((r) => { release = r; });
    t.up = true;
    const draining = m.drain();
    await Promise.resolve();
    expect(m.deleteUndelivered(id, "Curzon")).toMatchObject({ ok: false, status: 409 });
    release();
    await draining;
    expect(m.deleteUndelivered(id, "Curzon")).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a sender that is not registered in the remote room", async () => {
    const m = mirrorWith(fakeTransport()); rooms.push(m);
    await expect(m.writeThrough("Stranger", "hi")).rejects.toMatchObject({ status: 403, code: "not-registered" });
  });

  it("the base class lines and a synchronous send never happen on a mirror", () => {
    const m = mirrorWith(fakeTransport()); rooms.push(m);
    expect(m.readAll()).toEqual([]); // "Curzon joined the chat" was the home's to say
    expect(() => m.send("Curzon", "x")).toThrow(/remote room/);
  });
});

// ---------------------------------------------------------------------------
describe("PeerHub (home side)", () => {
  let dir: string;
  let manager: ConversationManager;
  const links = [{ name: "host", url: "http://127.0.0.1:1", token: "tok-12345678" }];
  beforeEach(() => { dir = tmp("joind-hub-"); manager = new ConversationManager(join(dir, "data")); });
  afterEach(() => {
    for (const c of manager.listConversations()) manager.getRoom(c.id)?.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  const hub = (now?: () => number) => new PeerHub({ manager, selfName: "home", conversationsDir: join(dir, "data", "conversations"), links, peerGraceMs: 1_000, now });

  it("numbers events per room, persists the number, and a restart continues past it", () => {
    const h = hub();
    const id = manager.createConversation("ops").id;
    h.attach([]);
    manager.getRoom(id)!.send("Rami", "one");
    const afterOne = h.currentSeq(id);
    manager.getRoom(id)!.send("Rami", "two");
    const last = h.currentSeq(id);
    expect(afterOne).toBeGreaterThan(0);
    expect(last).toBe(afterOne * 2); // each send is the same events (message, typing)
    h.stop();
    expect(readFileSync(join(dir, "data", "conversations", `${id}.peerseq`), "utf-8")).toBe(String(last));
    const again = hub();
    expect(again.currentSeq(id)).toBeGreaterThan(last);
    again.stop();
  });

  it("filters for the peer's own hosted members, whatever viewers it asks for", async () => {
    const h = hub();
    h.attach([]);
    const id = manager.createConversation("ops").id;
    const room = manager.getRoom(id)!;
    room.joinHosted("Curzon", "host", "reg-h", "reg-p");
    room.join("Jadzia", 999_993);
    room.send("Rami", "to Jadzia", { to: ["Jadzia"] });
    room.send("Rami", "to Curzon", { to: ["Curzon"] });
    room.send("Rami", "public");
    expect(h.viewersFor("host", id, ["Jadzia", "Curzon"])).toEqual(["Curzon"]);
    const r = await h.subscribe("host", id, 0, ["Jadzia"], 10);
    const texts = r.events.filter((e) => e.type === "message").map((e) => (e.data as ChatMessage).text);
    expect(texts).toContain("public");
    expect(texts).not.toContain("to Jadzia");
    expect(texts).not.toContain("to Curzon"); // asked only for Jadzia: nothing of Curzon's either
    const all = await h.subscribe("host", id, 0, undefined, 10);
    const allTexts = all.events.filter((e) => e.type === "message").map((e) => (e.data as ChatMessage).text);
    expect(allTexts).toContain("to Curzon");
    expect(allTexts).not.toContain("to Jadzia");
    expect(all.cursor).toBe(h.currentSeq(id));
    h.stop();
  });

  it("resets a cursor it cannot replay, and a parked subscribe returns on the next event", async () => {
    const h = hub();
    h.attach([]);
    const id = manager.createConversation("ops").id;
    const room = manager.getRoom(id)!;
    room.send("Rami", "x");
    expect((await h.subscribe("host", id, 999, undefined, 10)).reset).toBe(true);
    const cur = h.currentSeq(id);
    const parked = h.subscribe("host", id, cur, undefined, 5_000);
    room.send("Rami", "later");
    const r = await parked;
    expect(r.events.filter((e) => e.type === "message").map((e) => (e.data as ChatMessage).text)).toEqual(["later"]);
    h.stop();
  });

  it("announces a silent peer once in rooms it hosts members of, and its return", () => {
    let now = 1_000_000;
    const h = hub(() => now);
    const id = manager.createConversation("ops").id;
    const room = manager.getRoom(id)!;
    room.joinHosted("Curzon", "host", "reg-h", "reg-p");
    now += 1_500;
    h.checkPeers();
    h.checkPeers();
    expect(room.read().filter((m) => m.text === "host unreachable; members hosted there cannot be woken until it returns")).toHaveLength(1);
    h.noteContact("host");
    expect(room.read().some((m) => m.text === "host is reachable again; members hosted there can be woken")).toBe(true);
    h.stop();
  });
});

// ---------------------------------------------------------------------------
describe("hosted members in a room", () => {
  let rooms: ChatRoom[] = [];
  beforeEach(() => { injected.length = 0; vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); for (const r of rooms) r.destroy(); rooms = []; });
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r)); };

  function home(result: () => HostedWakeResult): { room: ChatRoom; calls: HostedWakeRequest[] } {
    const room = new ChatRoom(); rooms.push(room);
    room.homeId = "c-home";
    const calls: HostedWakeRequest[] = [];
    room.hostedWaker = async (req) => { calls.push(req); return result(); };
    room.joinHosted("Curzon", "laptop", "reg-home", "reg-host");
    return { room, calls };
  }

  it("a mention is routed to the host and nothing is injected here", async () => {
    const { room, calls } = home(() => ({ ok: true, attempts: 1 }));
    room.send("Rami", "@Curzon hi");
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(calls).toEqual([{ host: "laptop", room: "c-home", name: "Curzon", hostedRegistration: "reg-host", sender: "Rami", prompt: "@Curzon mentioned by Rami" }]);
    expect(injected).toEqual([]);
    expect(room.read().some((m) => /Could not/.test(m.text))).toBe(false);
  });

  it("an unreachable host is said once per streak; a success clears it", async () => {
    let next: HostedWakeResult = { ok: false, kind: "unreachable", attempts: 1, reason: "refused" };
    const { room } = home(() => next);
    const mention = async (t: string) => { room.send("Rami", t); await vi.advanceTimersByTimeAsync(2000); await settle(); };
    await mention("@Curzon 1");
    await mention("@Curzon 2");
    const lines = () => room.read().filter((m) => /is unreachable/.test(m.text)).length;
    expect(lines()).toBe(1);
    next = { ok: true, attempts: 1 };
    await mention("@Curzon 3");
    next = { ok: false, kind: "unreachable", attempts: 1, reason: "refused" };
    await mention("@Curzon 4");
    expect(lines()).toBe(2);
  });

  it("a failure the host reports gets the local wording naming the host; warn=false stays quiet", async () => {
    let next: HostedWakeResult = { ok: false, kind: "no-console", attempts: 1, warn: false, reason: "error 87" };
    const { room } = home(() => next);
    room.send("Rami", "@Curzon a"); await vi.advanceTimersByTimeAsync(2000); await settle();
    expect(room.read().some((m) => /Could not wake/.test(m.text))).toBe(false);
    next = { ok: false, kind: "partial", attempts: 1, warn: true };
    room.send("Rami", "@Curzon b"); await vi.advanceTimersByTimeAsync(2000); await settle();
    expect(room.read().some((m) => m.text === "Could not submit the prompt to Curzon; the text is in their input box.")).toBe(true);
  });

  it("the local wording is unchanged", () => {
    expect(wakeFailureLine("X", "no-console", "error 87")).toBe("Could not wake X: no console reachable from this server (remote session, or joined without its real terminal pid). They will see mentions only when they read on their own schedule.");
    expect(wakeFailureLine("X", "transient", "busy")).toBe("Could not wake X just now (terminal injection failed after a retry). They will see this on their next read.");
    expect(wakeFailureLine("X", "no-console", "orca terminal term_1 unavailable (stale)")).toMatch(/^Could not wake X: their Orca terminal is not reachable from this server/);
  });

  it("a silent hosted member is dimmed, never removed here", () => {
    const { room } = home(() => ({ ok: true, attempts: 1 }));
    const events: string[] = [];
    room.on("room", (e: RoomEvent) => events.push(e.type));
    room.getAgent("Curzon")!.lastSeen = Date.now() - 10 * 3_600_000;
    (room as unknown as { sweepStale(): void }).sweepStale();
    expect(events).toEqual(["stale"]);
    expect(room.getAgent("Curzon")).toBeDefined();
  });

  it("the peer-side wake checks the registration and names the home room in the prompt", async () => {
    vi.useRealTimers();
    const room = new ChatRoom(); rooms.push(room);
    room.injectBaseUrl = "http://127.0.0.1:4555";
    room.join("Curzon", 999_991, undefined, undefined, undefined, undefined, "reg-local");
    const wrong = await room.wakeForPeer("Rami", "Curzon", "reg-other", `"ops" on y530`);
    expect(wrong).toMatchObject({ ok: false, kind: "no-console" });
    expect(injected).toEqual([]);
    const ok = await room.wakeForPeer("Rami", "Curzon", "reg-local", `"ops" on y530`);
    expect(ok).toMatchObject({ ok: true });
    expect(injected[0].pid).toBe(999_991);
    expect(injected[0].prompt).toMatch(/^\[joind\] @Curzon mentioned by Rami in "ops" on y530\. Read: curl -s "http:\/\/127\.0\.0\.1:4555\/api\/agent\/read\?sender=Curzon/);
  });
});

// ---------------------------------------------------------------------------
describe("manager: hosted bindings and remote rooms", () => {
  let dir: string;
  let manager: ConversationManager;
  beforeEach(() => { dir = tmp("joind-mgr-"); manager = new ConversationManager(join(dir, "data")); });
  afterEach(() => { for (const r of manager.listRemote()) r.room.destroy(); rmSync(dir, { recursive: true, force: true }); });

  it("a hosted binding answers its id only; a local binding of the name still resolves by name", () => {
    const a = manager.createConversation("a").id;
    const b = manager.createConversation("b").id;
    manager.bindHosted("Curzon", a, "reg-hosted", "laptop");
    expect(manager.getAgentBinding("Curzon")).toBeUndefined();
    expect(manager.getAgentBinding("Curzon", undefined, undefined, undefined, undefined, "reg-hosted")).toBe(a);
    manager.bindAgent("Curzon", b, 999_991);
    expect(manager.getAgentBinding("Curzon")).toBe(b);
    expect(isTerminalLess({ conversationId: a, registration: "r", host: "laptop" })).toBe(false);
    for (const c of manager.listConversations()) manager.getRoom(c.id)?.destroy();
  });

  it("a remote room resolves, can be active, forwards its events under its remote id, and is not listed as local", () => {
    const t = fakeTransport();
    const m = new MirrorRoom({ server: "y530", homeId: "c-9", name: "cpm", queueFile: null, transport: t, selfName: "here" });
    manager.registerRemoteRoom({ id: m.id, server: "y530", homeId: "c-9", room: m, meta: () => m.meta() });
    const events: Array<{ type: string; conversationId: string }> = [];
    manager.on("room", (e: { type: string; conversationId: string }) => events.push(e));
    expect(manager.getRoom("y530:c-9")).toBe(m);
    expect(manager.setActive("y530:c-9")).toBe(true);
    expect(manager.getActiveMeta()?.name).toBe("cpm");
    expect(manager.getMeta("y530:c-9")?.name).toBe("cpm");
    expect(manager.listConversations().some((c) => c.id === "y530:c-9")).toBe(false);
    m.applyEvent({ seq: 1, type: "message", data: { id: 1, sender: "Jadzia", text: "hi", timestamp: 1 } });
    expect(events).toEqual([expect.objectContaining({ type: "message", conversationId: "y530:c-9" })]);
    manager.bindAgent("Curzon", "y530:c-9", 999_991);
    manager.unregisterRemoteRoom("y530:c-9");
    expect(manager.getRoom("y530:c-9")).toBeUndefined();
    expect(manager.getAgentBinding("Curzon")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("LinkClient", () => {
  it("discovers rooms into mirrors, goes down on a failure and up on the next success, with link events", async () => {
    const dir = tmp("joind-linkc-");
    const manager = new ConversationManager(join(dir, "data"));
    let down = false;
    const fetchImpl: FetchLike = async (url) => {
      if (down) throw new Error("ECONNREFUSED");
      if (url.includes("/api/peer/rooms")) return { status: 200, text: async () => JSON.stringify({ server: "y530", rooms: [{ id: "c-9", name: "cpm", createdAt: 1, messageCount: 4, starred: false }] }) };
      return { status: 404, text: async () => JSON.stringify({ error: "nope" }) };
    };
    const c = new LinkClient({ link: { name: "y530", url: "http://127.0.0.1:1", token: "tok-12345678" }, selfName: "here", linksDir: join(dir, "data", "links"), manager, fetchImpl, backoffMinMs: 10, backoffMaxMs: 20 });
    const infos: LinkInfo[] = [];
    c.on("link", (i: LinkInfo) => infos.push(i));
    try {
      await c.discover();
      expect(manager.getRoom("y530:c-9")).toBeInstanceOf(MirrorRoom);
      expect(c.remoteConversations()).toEqual([{ id: "y530:c-9", server: "y530", name: "cpm", messageCount: 4, starred: false, state: "up" }]);
      down = true;
      await expect(c.discover()).rejects.toBeInstanceOf(LinkDownError);
      down = false;
      for (let i = 0; i < 50 && c.info().state !== "up"; i++) await new Promise((r) => setTimeout(r, 10));
      expect(infos.map((i) => i.state)).toEqual(["up", "down", "up"]);
      const wake = await new LinkClient({ link: { name: "y530", url: "http://127.0.0.1:1", token: "tok-12345678" }, selfName: "here", linksDir: join(dir, "l2"), manager, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } })
        .wake({ host: "y530", room: "c-9", name: "X", hostedRegistration: "r", sender: "S", prompt: "p" });
      expect(wake).toMatchObject({ ok: false, kind: "unreachable" });
    } finally {
      c.stop();
      for (const r of manager.listRemote()) r.room.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a reply to a request that started before the link went down does not bring it back up", async () => {
    const dir = tmp("joind-linkep-");
    const manager = new ConversationManager(join(dir, "data"));
    let release!: () => void;
    let hold: Promise<void> | null = new Promise<void>((r) => { release = r; });
    const fetchImpl: FetchLike = async () => {
      if (hold) await hold;
      return { status: 200, text: async () => JSON.stringify({ server: "y530", rooms: [] }) };
    };
    const c = new LinkClient({ link: { name: "y530", url: "http://127.0.0.1:1", token: "tok-12345678" }, selfName: "here", linksDir: join(dir, "links"), manager, fetchImpl, backoffMinMs: 60_000 });
    try {
      const old = c.discover();          // in flight
      c.markDown("dropped");             // the link drops meanwhile
      hold = null;
      release();
      await old;
      expect(c.info().state).toBe("down");
      await c.discover();                // a request started after the drop
      expect(c.info().state).toBe("up");
    } finally {
      c.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the subscription cursor on disk", async () => {
    const dir = tmp("joind-linkcur-");
    const manager = new ConversationManager(join(dir, "data"));
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/api/peer/rooms")) return { status: 200, text: async () => JSON.stringify({ server: "y530", rooms: [{ id: "c-9", name: "cpm", createdAt: 1, messageCount: 0, starred: false }] }) };
      if (url.includes("/api/peer/messages")) return { status: 200, text: async () => JSON.stringify({ server: "y530", room: "c-9", name: "cpm", messages: [{ id: 7, sender: "J", text: "t", timestamp: 1 }], members: [], cursor: 42 }) };
      return { status: 404, text: async () => "{}" };
    };
    const c = new LinkClient({ link: { name: "y530", url: "http://127.0.0.1:1", token: "tok-12345678" }, selfName: "here", linksDir: join(dir, "links"), manager, fetchImpl });
    try {
      await c.discover();
      const m = c.getMirror("c-9")!;
      expect(await c.fill(m)).toBe(42);
      expect(readFileSync(join(dir, "links", "y530", "c-9.cursor"), "utf-8")).toBe("42");
      expect(c.readCursor("c-9")).toBe(42);
      expect(m.readAll().map((x) => x.id)).toEqual([7]);
      writeFileSync(join(dir, "links", "y530", "c-9.cursor"), "garbage");
      expect(c.readCursor("c-9")).toBe(0);
      expect(existsSync(join(dir, "links", "y530"))).toBe(true);
    } finally {
      c.stop();
      for (const r of manager.listRemote()) r.room.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

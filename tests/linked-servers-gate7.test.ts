/**
 * Linked servers, Codex gate round 7: one test per server finding, each
 * failing on b21bdc1, plus the departure debt across a restart.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
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
import type { FetchLike } from "../src/link.js";
import { MirrorRoom, type MirrorTransport } from "../src/mirror.js";
import { LinkDownError, PeerRefusedError } from "../src/peer-types.js";
import type { ChatMessage } from "../src/room.js";

async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 5_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A fake home of members: register holds on demand; leave needs the current registration. */
function memberHome() {
  // The home keeps each member's home id and the peer's (hosted) id; a
  // release names either (round 10: the peer releases by its own id).
  const members = new Map<string, string>();
  const hostedOf = new Map<string, string>();
  const st = { down: false, n: 1, hold: null as Promise<void> | null, held: false };
  const transport: MirrorTransport = {
    isUp: () => !st.down,
    register: async (b) => {
      if (st.down) throw new LinkDownError("down");
      const reg = `H${++st.n}`;
      if (st.hold) { st.held = true; await st.hold; }
      members.set(b.name, reg);
      hostedOf.set(b.name, b.registration);
      return { ok: true, registration: reg, online: [] };
    },
    leave: async (b) => {
      if (st.down) throw new LinkDownError("down");
      const match = b.hostedRegistration ? hostedOf.get(b.name) === b.hostedRegistration : members.get(b.name) === b.registration;
      if (!members.has(b.name) || !match) throw new PeerRefusedError(404, "No such registration");
      members.delete(b.name);
      hostedOf.delete(b.name);
    },
    send: async (): Promise<ChatMessage> => { throw new Error("unused"); },
    act: async () => undefined,
    failed: () => undefined,
  };
  return { members, hostedOf, st, transport };
}

describe("gate round 7, finding 1: a departure during recovery releases what the home ends up holding", () => {
  it("recovery registers H2 after a home restart; the member leaves before the reply; H2 is released", async () => {
    const home = memberHome();
    const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: null, transport: home.transport, selfName: "here" });
    try {
      m.join("Curzon", 999_971, undefined, undefined, undefined, undefined, "reg-local");
      m.setShadow("Curzon", { homeRegistration: "H1" });
      home.members.set("Curzon", "H1");
      home.hostedOf.set("Curzon", "reg-local");
      home.members.clear();                               // the home restarts
      let release!: () => void;
      home.st.hold = new Promise<void>((r) => { release = r; });
      const recovering = m.reregisterAll();               // registers H2, reply held
      await waitFor("the registration in flight", () => home.st.held);
      m.leave("Curzon");                                  // the member leaves before the reply
      home.st.hold = null;
      release();
      await recovering;
      await waitFor("the home to hold nothing for Curzon", () => !home.members.has("Curzon"), 3_000);
      expect(m.pendingMemberReleases()).toEqual([]);
    } finally { m.destroy(); }
  });

  it("a release that cannot be made now is kept across a restart and made at recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g7-rel-"));
    const home = memberHome();
    const file = join(dir, "c-1.queue.jsonl");
    const m1 = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: file, transport: home.transport, selfName: "here" });
    let m2: MirrorRoom | null = null;
    try {
      m1.join("Curzon", 999_973, undefined, undefined, undefined, undefined, "reg-local");
      m1.setShadow("Curzon", { homeRegistration: "H1" });
      home.members.set("Curzon", "H1");
      home.hostedOf.set("Curzon", "reg-local");
      home.st.down = true;
      m1.leave("Curzon");
      await waitFor("the debt recorded", () => m1.pendingMemberReleases().length === 1);
      m1.destroy();
      home.st.down = false;
      m2 = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: file, transport: home.transport, selfName: "here" });
      expect(m2.pendingMemberReleases()).toEqual([{ name: "Curzon", registration: "reg-local" }]);
      await m2.reregisterAll();
      expect(home.members.has("Curzon")).toBe(false);
      expect(m2.pendingMemberReleases()).toEqual([]);
    } finally { m1.destroy(); m2?.destroy(); rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
const TOKEN = "gate7-link-token-0123456789";
const WEB = "d".repeat(64);

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

describe("gate round 7, routes", { timeout: 20_000 }, () => {
  let dirA: string, dirB: string;
  let A: JoindHandle, B: JoindHandle;
  let roomX: string, roomY: string;
  let holdFor: string | null = null;
  let releaseHold: (() => void) | null = null;

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), "joind-g7-a-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-g7-b-"));
    const [pa, pb] = [await freePort(), await freePort()];
    const fetchImpl: FetchLike = async (url, init) => {
      if (holdFor && url.includes("/api/peer/messages") && url.includes(holdFor)) {
        await new Promise<void>((r) => { releaseHold = r; });
      }
      const res = await fetch(url, init);
      return { status: res.status, text: () => res.text() };
    };
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 60_000 };
    A = await startJoind(config(dirA, "alpha", pa, "bravo", pb), { link: tuning });
    roomX = A.manager.createConversation("room X").id;
    roomY = A.manager.createConversation("room Y").id;
    A.manager.getRoom(roomX)!.send("Sisko", "said in X");
    A.manager.getRoom(roomY)!.send("Sisko", "said in Y");
    B = await startJoind(config(dirB, "bravo", pb, "alpha", pa), { link: { ...tuning, fetchImpl } });
    await waitFor("B to mirror both rooms", () => B.manager.getRoom(`alpha:${roomX}`) && B.manager.getRoom(`alpha:${roomY}`));
    expect((await post(B.baseUrl, "/api/web/register", { token: WEB, name: "Rami" })).status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    releaseHold?.();
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
  });

  it("finding 2: an image in a remote room is refused (400) before anything is queued or reported sent", async () => {
    const remote = `alpha:${roomX}`;
    const mirror = B.manager.getRoom(remote) as MirrorRoom;
    const before = A.manager.getRoom(roomX)!.messageCount();
    const send = await post(B.baseUrl, "/api/send", { sender: "Rami", text: "[image]", image: "/data/files/x.png", token: WEB, conversation: remote });
    expect(send.status).toBe(400);
    expect(send.json.error).toBe("Attachments are not supported in remote rooms");
    // A member of the remote room here, so the mailbox routes a DM into it.
    expect((await post(B.baseUrl, "/api/agent/join", { name: "Kira", pid: 999_975, conversation: remote })).status).toBe(200);
    const dm = await post(B.baseUrl, "/api/dm/send", { to: "Kira", text: "[image]", image: "/data/files/y.png", token: WEB });
    expect(dm.status).toBe(400);
    expect(mirror.queuedCount()).toBe(0);
    expect(A.manager.getRoom(roomX)!.messageCount()).toBe(before + 1); // only Kira's join line
  });

  it("finding 3: a selection answers with its own room's metadata and contents when another selection lands meanwhile", async () => {
    holdFor = roomX;
    const x = post(B.baseUrl, "/api/conversations/select", { id: `alpha:${roomX}`, token: WEB });
    await waitFor("X's fill held", () => releaseHold !== null);
    holdFor = null;
    const y = await post(B.baseUrl, "/api/conversations/select", { id: `alpha:${roomY}`, token: WEB });
    expect((y.json.conversation as { id: string }).id).toBe(`alpha:${roomY}`);
    releaseHold!();
    const rx = await x;
    expect((rx.json.conversation as { id: string; name: string })).toMatchObject({ id: `alpha:${roomX}`, name: "room X" });
    const texts = (rx.json.messages as ChatMessage[]).map((m) => m.text);
    expect(texts).toContain("said in X");
    expect(texts).not.toContain("said in Y");
  });
});

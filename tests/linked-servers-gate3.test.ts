/**
 * Linked servers, Codex gate round 3: one test per server finding, each
 * failing on 7e8b204. The link registry and its mirror run against a fake
 * home that records who holds which name, and whose network can fail.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: vi.fn(async () => undefined) };
});

import { LinkRegistry, type FetchLike } from "../src/link.js";
import { MirrorRoom, type MirrorTransport } from "../src/mirror.js";
import { ConversationManager } from "../src/manager.js";
import { PeerRefusedError, type PeerSendBody } from "../src/peer-types.js";
import type { ChatMessage } from "../src/room.js";

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A fake home: the names it holds for this peer's human, and what it was sent. */
function fakeHome() {
  const humans = new Map<string, string>(); // name -> registration
  const sent: Array<{ sender: string; text: string }> = [];
  const state = { down: false, failLeaveOnce: false, n: 0 };
  const fetchImpl: FetchLike = async (url, init) => {
    if (state.down) throw new Error("connect ECONNREFUSED (test)");
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    const ok = (o: unknown) => ({ status: 200, text: async () => JSON.stringify(o) });
    if (url.includes("/api/peer/rooms")) return ok({ server: "home", rooms: [{ id: "c-1", name: "ops", createdAt: 1, messageCount: 0, starred: false }] });
    if (url.includes("/api/peer/register")) {
      const reg = `home-${body.name as string}-${++state.n}`;
      humans.set(body.name as string, reg);
      return ok({ ok: true, registration: reg, online: [] });
    }
    if (url.includes("/api/peer/leave")) {
      if (state.failLeaveOnce) { state.failLeaveOnce = false; throw new Error("connect ECONNRESET (test)"); }
      if (humans.get(body.name as string) !== body.registration) return { status: 404, text: async () => JSON.stringify({ error: "No such registration" }) };
      humans.delete(body.name as string);
      return ok({ ok: true });
    }
    if (url.includes("/api/peer/send")) {
      if (humans.get(body.sender as string) !== body.registration) return { status: 403, text: async () => JSON.stringify({ error: "not registered", code: "not-registered" }) };
      sent.push({ sender: body.sender as string, text: body.text as string });
      return ok({ ok: true, message: { id: 100 + sent.length, sender: body.sender, text: body.text, timestamp: Date.now() } });
    }
    return ok({});
  };
  return { humans, sent, state, fetchImpl };
}

async function setup(home: ReturnType<typeof fakeHome>) {
  const dir = mkdtempSync(join(tmpdir(), "joind-g3-"));
  const manager = new ConversationManager(join(dir, "data"));
  const reg = new LinkRegistry([{ name: "home", url: "http://127.0.0.1:1", token: "tok-12345678" }], {
    selfName: "here", linksDir: join(dir, "links"), manager, fetchImpl: home.fetchImpl, backoffMinMs: 20, backoffMaxMs: 40,
  });
  await reg.get("home")!.discover();
  const mirror = manager.getRoom("home:c-1") as MirrorRoom;
  const done = () => { reg.stop(); for (const r of manager.listRemote()) r.room.destroy(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, reg, mirror, done };
}

describe("linked servers, gate round 3", { timeout: 20_000 }, () => {
  it("finding 1: a release that failed is kept and retried at recovery", async () => {
    const home = fakeHome();
    const { dir, reg, done } = await setup(home);
    try {
      await reg.ensureHuman("home:c-1", "Alice");
      expect([...home.humans.keys()]).toEqual(["Alice"]);
      home.state.failLeaveOnce = true;                 // the link drops while Alice is released
      await reg.ensureHuman("home:c-1", "Bob");
      expect([...home.humans.keys()].sort()).toEqual(["Alice", "Bob"]);
      await reg.get("home")!.discover();               // the link is back: recovery
      await waitFor("Alice released at the home", () => !home.humans.has("Alice"));
      expect([...home.humans.keys()]).toEqual(["Bob"]);
      // Nothing owed any more, and the record on disk says so.
      const saved = JSON.parse(readFileSync(join(dir, "links", "home", "c-1.human.json"), "utf-8")) as { human: { name: string }; releases: unknown[] };
      expect(saved.human.name).toBe("Bob");
      expect(saved.releases).toEqual([]);
    } finally { done(); }
  });

  it("finding 2: a viewer change made offline is carried out at recovery: the former released, the new one registered, its message sent", async () => {
    const home = fakeHome();
    const { reg, mirror, done } = await setup(home);
    try {
      await reg.ensureHuman("home:c-1", "Alice");
      home.state.down = true;
      await reg.get("home")!.discover().catch(() => undefined);
      await waitFor("the link down", () => reg.get("home")!.info().state === "down");
      const q = await mirror.writeThrough("Bob", "written by Bob offline", { to: ["Kira"] }, { asHuman: true });
      expect(q.status).toBe("queued");
      home.state.down = false;
      await waitFor("Bob's message sent", () => home.sent.find((s) => s.text === "written by Bob offline"));
      expect(home.sent.find((s) => s.text === "written by Bob offline")!.sender).toBe("Bob");
      await waitFor("Alice released", () => !home.humans.has("Alice"));
      expect([...home.humans.keys()]).toEqual(["Bob"]);
      expect(mirror.humanName()).toBe("Bob");
    } finally { done(); }
  });

  it("finding 3: deleting a held entry during a drain that then ends on another author's refusal still sends the author's later entry", async () => {
    let releaseB: (() => void) | null = null;
    const sent: PeerSendBody[] = [];
    const t: MirrorTransport = {
      isUp: () => true,
      send: async (b: PeerSendBody): Promise<ChatMessage> => {
        if (b.text === "a-bad") throw new PeerRefusedError(400, "refused a");
        if (b.text === "b-bad") { await new Promise<void>((r) => { releaseB = r; }); throw new PeerRefusedError(400, "refused b"); }
        sent.push(b);
        return { id: 10 + sent.length, sender: b.sender, text: b.text, timestamp: Date.now() };
      },
      leave: async () => undefined,
      act: async () => undefined,
      register: async () => ({ ok: true, registration: "reg-home", online: [] }),
      failed: () => undefined,
    };
    const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: null, transport: t, selfName: "here" });
    try {
      for (const n of ["A", "B"]) { m.join(n, 999_951, undefined, undefined, undefined, undefined, `reg-${n}`); m.setShadow(n, { homeRegistration: `home-${n}` }); }
      const up = t.isUp;
      t.isUp = () => false;
      await m.writeThrough("A", "a-bad");
      await m.writeThrough("B", "b-bad");
      await m.writeThrough("A", "a-later");
      t.isUp = up;
      const draining = m.drain();                                  // A's first is held; B's send is in flight
      await waitFor("B's send in flight", () => releaseB !== null);
      const held = m.pendingFor(undefined).find((p) => p.text === "a-bad")!;
      expect(m.deleteUndelivered(held.clientId, "A")).toEqual({ ok: true });
      releaseB!();                                                 // B is refused: the pass ends with no progress
      await draining;
      await waitFor("A's later entry sent", () => sent.some((b) => b.text === "a-later"));
    } finally { m.destroy(); }
  });
});

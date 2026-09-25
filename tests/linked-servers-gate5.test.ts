/**
 * Linked servers, Codex gate round 5: a stray (unconfirmed) viewer
 * registration that the home refuses for good (409 naming another owner, or
 * 404) is cleared, and the viewer's later choice goes through. Both tests
 * fail on 2cb76e4. The fake home answers conflicts as PeerHub does (409,
 * code name-conflict, candidates naming the owner).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: vi.fn(async () => undefined) };
});

import { MirrorRoom, type MirrorTransport } from "../src/mirror.js";
import { LinkDownError, PeerRefusedError, type PeerSendBody } from "../src/peer-types.js";
import type { ChatMessage } from "../src/room.js";

function fakeHome() {
  const humans = new Map<string, string>();
  /** Names a local member of the home holds (never ours). */
  const occupied = new Set<string>();
  const registered: string[] = [];
  const sent: Array<{ sender: string; text: string }> = [];
  const st = { down: false, loseRegisterReply: false, n: 0 };
  const transport: MirrorTransport = {
    isUp: () => !st.down,
    register: async (b) => {
      if (st.down) throw new LinkDownError("down");
      registered.push(b.name);
      if (occupied.has(b.name)) {
        throw new PeerRefusedError(409, `${b.name} is already registered in this room from another host`, "name-conflict",
          { error: "conflict", code: "name-conflict", candidates: [{ conversation: "c-1", host: "home", pid: 4242 }] });
      }
      const reg = humans.get(b.name) ?? `home-${b.name}-${++st.n}`;
      humans.set(b.name, reg);
      if (st.loseRegisterReply) { st.loseRegisterReply = false; throw new LinkDownError("the reply was lost"); }
      return { ok: true, registration: reg, online: [] };
    },
    leave: async (b) => {
      if (st.down) throw new LinkDownError("down");
      if (humans.get(b.name) !== b.registration) throw new PeerRefusedError(404, "No such registration");
      humans.delete(b.name);
    },
    send: async (b: PeerSendBody): Promise<ChatMessage> => {
      if (st.down) throw new LinkDownError("down");
      if (humans.get(b.sender) !== b.registration) throw new PeerRefusedError(403, "not registered", "not-registered");
      sent.push({ sender: b.sender, text: b.text });
      return { id: 100 + sent.length, sender: b.sender, text: b.text, timestamp: Date.now() };
    },
    act: async () => undefined,
    failed: () => undefined,
  };
  /** The home restarts: it forgets every registration. */
  const restart = (): void => { humans.clear(); };
  return { humans, occupied, registered, sent, st, transport, restart };
}

async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 3_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function withMirror(fn: (m: MirrorRoom, home: ReturnType<typeof fakeHome>) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g5-"));
    const home = fakeHome();
    const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: join(dir, "c-1.queue.jsonl"), transport: home.transport, selfName: "here" });
    try { await fn(m, home); } finally { m.destroy(); rmSync(dir, { recursive: true, force: true }); }
  };
}

describe("gate round 5: a stray the home refuses for good does not block the next choice", () => {
  it("Alice, then Bob (taken at the home: 409), then Carol: Carol is registered and her waiting message sent", withMirror(async (m, home) => {
    home.occupied.add("Bob");
    await m.settleHuman("Alice");
    await m.settleHuman("Bob");                          // refused: the name is a home member's
    expect(m.humanName()).toBe("Alice");
    expect(m.humanRecord().unconfirmed).toBeNull();
    // Carol writes before she is registered, then recovery settles.
    expect((await m.writeThrough("Carol", "from Carol", {}, { asHuman: true })).status).toBe("queued");
    await m.settleHuman();
    expect(m.humanName()).toBe("Carol");
    await waitFor("Carol's message sent", () => home.sent.find((s) => s.text === "from Carol"));
    expect([...home.humans.keys()]).toEqual(["Carol"]);
    expect(home.registered.filter((n) => n === "Bob")).toHaveLength(1);
  }));

  it("a lost reply for Bob, then the home restarts and Bob is taken there: choosing Carol still goes through", withMirror(async (m, home) => {
    await m.settleHuman("Alice");
    home.st.loseRegisterReply = true;
    await m.settleHuman("Bob");                          // the home held Bob; the reply was lost
    expect(m.humanRecord().unconfirmed).toBe("Bob");
    home.restart();                                      // the home forgets every registration
    home.occupied.add("Bob");                            // and a local member takes Bob there
    await m.settleHuman("Carol");
    expect(m.humanName()).toBe("Carol");
    expect(m.humanRecord()).toMatchObject({ unconfirmed: null, wanted: null, releasesOwed: [] });
    expect([...home.humans.keys()]).toEqual(["Carol"]);
  }));
});

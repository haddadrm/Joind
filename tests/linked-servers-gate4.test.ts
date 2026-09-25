/**
 * Linked servers, Codex gate round 4: the viewer as a write-ahead state
 * machine, and the drain's completion gap. One test per finding (each
 * failing on 933b439), then a restart in the middle of every persisted step
 * of a viewer change, and a record that cannot be written.
 *
 * A "restart" is a new MirrorRoom on the same files; the fake home keeps
 * its state across it, as a real home would.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: vi.fn(async () => undefined) };
});

import { MirrorRoom, type MirrorNotice, type MirrorTransport } from "../src/mirror.js";
import { LinkDownError, PeerRefusedError, type PeerSendBody } from "../src/peer-types.js";
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

/** The home's view of this peer's humans, and a transport to it. */
function fakeHome() {
  const humans = new Map<string, string>();
  const registered: string[] = [];
  const sent: Array<{ sender: string; text: string }> = [];
  const st = { down: false, loseRegisterReply: false, leaveLinkDownOnce: false, leaveStatus: 0, n: 0 };
  const transport: MirrorTransport = {
    isUp: () => !st.down,
    register: async (b) => {
      if (st.down) throw new LinkDownError("down");
      registered.push(b.name);
      // Idempotent for a name it holds, as the home's human registration is.
      const reg = humans.get(b.name) ?? `home-${b.name}-${++st.n}`;
      humans.set(b.name, reg);
      if (st.loseRegisterReply) { st.loseRegisterReply = false; throw new LinkDownError("the reply was lost"); }
      return { ok: true, registration: reg, online: [] };
    },
    leave: async (b) => {
      if (st.down) throw new LinkDownError("down");
      if (st.leaveLinkDownOnce) { st.leaveLinkDownOnce = false; throw new LinkDownError("dropped during the release"); }
      if (st.leaveStatus) throw new PeerRefusedError(st.leaveStatus, "unauthorized");
      if (humans.get(b.name) !== b.registration) throw new PeerRefusedError(404, "No such registration");
      humans.delete(b.name);
    },
    send: async (b: PeerSendBody): Promise<ChatMessage> => {
      if (st.down) throw new LinkDownError("down");
      const known = humans.get(b.sender) === b.registration || b.registration === `home-${b.sender}`;
      if (!known) throw new PeerRefusedError(403, "not registered", "not-registered");
      sent.push({ sender: b.sender, text: b.text });
      return { id: 100 + sent.length, sender: b.sender, text: b.text, timestamp: Date.now() };
    },
    act: async () => undefined,
    failed: () => undefined,
  };
  return { humans, registered, sent, st, transport };
}

function rooms(dir: string, home: ReturnType<typeof fakeHome>) {
  const open: MirrorRoom[] = [];
  const mk = (): MirrorRoom => {
    const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: join(dir, "c-1.queue.jsonl"), transport: home.transport, selfName: "here" });
    open.push(m);
    return m;
  };
  return { mk, close: () => { for (const m of open) m.destroy(); } };
}

function withDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g4-"));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

describe("gate round 4: the viewer's write-ahead record", () => {
  it("finding 1: the home registered Bob but the reply was lost; after a restart Bob is completed and Alice released", withDir(async (dir) => {
    const home = fakeHome();
    const r = rooms(dir, home);
    try {
      const m1 = r.mk();
      await m1.settleHuman("Alice");
      home.st.loseRegisterReply = true;
      await m1.settleHuman("Bob");
      expect([...home.humans.keys()].sort()).toEqual(["Alice", "Bob"]);
      const m2 = r.mk();                                   // restart
      await m2.settleHuman();                              // recovery
      expect([...home.humans.keys()]).toEqual(["Bob"]);
      expect(m2.humanName()).toBe("Bob");
    } finally { r.close(); }
  }));

  it("finding 2: after a completed change, a restart does not let an old queued entry make its author wanted again", withDir(async (dir) => {
    const home = fakeHome();
    const r = rooms(dir, home);
    try {
      const m1 = r.mk();
      home.st.down = true;
      expect((await m1.writeThrough("Alice", "Alice, before any registration", {}, { asHuman: true })).status).toBe("queued");
      await m1.settleHuman("Bob");                         // the viewer changes to Bob, offline
      home.st.down = false;
      await m1.settleHuman();                              // recovery: Bob registered
      expect([...home.humans.keys()]).toEqual(["Bob"]);
      const m2 = r.mk();                                   // restart
      await m2.settleHuman();
      expect(m2.humanName()).toBe("Bob");
      expect([...home.humans.keys()]).toEqual(["Bob"]);
      expect(home.sent.some((s) => s.sender === "Alice")).toBe(false);
    } finally { r.close(); }
  }));

  it("finding 3: changing back to the current viewer cancels a pending offline change", withDir(async (dir) => {
    const home = fakeHome();
    const r = rooms(dir, home);
    try {
      const m = r.mk();
      await m.settleHuman("Alice");
      home.st.down = true;
      await m.settleHuman("Bob");
      await m.settleHuman("Alice");
      home.st.down = false;
      await m.settleHuman();
      expect(home.registered.filter((n) => n === "Bob")).toEqual([]);
      expect([...home.humans.keys()]).toEqual(["Alice"]);
      expect(m.humanOwes()).toBe(false);
    } finally { r.close(); }
  }));

  it("finding 6 (Low): a release refused with 401 stays owed and is made at the next recovery", withDir(async (dir) => {
    const home = fakeHome();
    const r = rooms(dir, home);
    try {
      const m = r.mk();
      await m.settleHuman("Alice");
      home.st.leaveStatus = 401;
      await m.settleHuman("Bob");
      expect(m.pendingHumanReleases().map((x) => x.name)).toEqual(["Alice"]);
      expect([...home.humans.keys()].sort()).toEqual(["Alice", "Bob"]);
      home.st.leaveStatus = 0;
      await m.settleHuman();
      expect(m.pendingHumanReleases()).toEqual([]);
      expect([...home.humans.keys()]).toEqual(["Bob"]);
    } finally { r.close(); }
  }));
});

describe("gate round 4: the drain's completion gap", () => {
  it("finding 4: a rerun requested after the drain's last pass, before its cleanup, is serviced", async () => {
    const home = fakeHome();
    const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: null, transport: home.transport, selfName: "here" });
    try {
      m.join("A", 999_961, undefined, undefined, undefined, undefined, "reg-A");
      m.setShadow("A", { homeRegistration: "home-A" });
      home.st.down = true;
      await m.writeThrough("A", "a1");
      m.join("B", 999_963, undefined, undefined, undefined, undefined, "reg-B");
      m.setShadow("B", { homeRegistration: "home-B" });
      await m.writeThrough("B", "b1");
      m.leave("B");                                        // B has no registration here now: its entry will wait
      home.st.down = false;
      // When A's message is dispatched, B rejoins in a microtask: after the
      // drain's last check, before its cleanup (the completion gap).
      m.on("mirror-notice", (n: MirrorNotice) => {
        if (n.type !== "pending-dispatched") return;
        queueMicrotask(() => {
          m.join("B", 999_965, undefined, undefined, undefined, undefined, "reg-B2");
          m.setShadow("B", { homeRegistration: "home-B" });
          m.resumeAuthor("B");
        });
      });
      await m.drain();
      await waitFor("B's entry sent", () => home.sent.some((s) => s.text === "b1"), 3_000);
    } finally { m.destroy(); }
  });
});

describe("gate round 4: a restart in the middle of each persisted step", () => {
  it("the change is recorded, nothing was sent yet (offline): after a restart it is carried out", withDir(async (dir) => {
    const home = fakeHome();
    const r = rooms(dir, home);
    try {
      await r.mk().settleHuman("Alice");
      home.st.down = true;
      await r.mk().settleHuman("Bob");                     // recorded only
      home.st.down = false;
      const m = r.mk();                                    // restart
      await m.settleHuman();
      expect(m.humanName()).toBe("Bob");
      expect([...home.humans.keys()]).toEqual(["Bob"]);
    } finally { r.close(); }
  }));

  it("the registration was sent and its reply lost, then the viewer changed back: after a restart the stray is released", withDir(async (dir) => {
    const home = fakeHome();
    const r = rooms(dir, home);
    try {
      const m1 = r.mk();
      await m1.settleHuman("Alice");
      home.st.loseRegisterReply = true;
      await m1.settleHuman("Bob");                         // the home holds Bob; we do not know its id
      home.st.down = true;
      await m1.settleHuman("Alice");                       // back to Alice, offline
      home.st.down = false;
      const m2 = r.mk();                                   // restart
      await m2.settleHuman();
      expect(m2.humanName()).toBe("Alice");
      expect([...home.humans.keys()]).toEqual(["Alice"]);
      expect(m2.humanRecord()).toMatchObject({ unconfirmed: null, releasesOwed: [], wanted: null });
    } finally { r.close(); }
  }));

  it("Bob is current and Alice's release was cut off: after a restart Alice is released", withDir(async (dir) => {
    const home = fakeHome();
    const r = rooms(dir, home);
    try {
      const m1 = r.mk();
      await m1.settleHuman("Alice");
      home.st.leaveLinkDownOnce = true;
      await m1.settleHuman("Bob");
      expect(m1.humanRecord()).toMatchObject({ current: { name: "Bob" }, releasesOwed: [{ name: "Alice" }] });
      const m2 = r.mk();                                   // restart
      expect(m2.pendingHumanReleases().map((x) => x.name)).toEqual(["Alice"]);
      await m2.settleHuman();
      expect([...home.humans.keys()]).toEqual(["Bob"]);
    } finally { r.close(); }
  }));

  it("a record that cannot be written stops the change before anything is sent", withDir(async (dir) => {
    const home = fakeHome();
    const r = rooms(dir, home);
    try {
      const m = r.mk();
      await m.settleHuman("Alice");
      mkdirSync(join(dir, "c-1.human.json.tmp"));          // the next atomic write fails
      const before = home.registered.length;
      await expect(m.settleHuman("Bob")).rejects.toThrow(/could not be saved/);
      expect(home.registered.length).toBe(before);
      expect(m.humanName()).toBe("Alice");
      expect(m.humanRecord().wanted).toBeNull();
      // A viewer's send that needs the record is refused, not queued on a stale one.
      home.st.down = true;
      await expect(m.writeThrough("Carol", "not recorded", {}, { asHuman: true })).rejects.toThrow(/could not be saved/);
      expect(m.queuedCount()).toBe(0);
    } finally { r.close(); }
  }));
});

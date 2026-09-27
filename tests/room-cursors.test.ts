import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Field case, Y530, 27 Sep 2026: cursors were kept per agent NAME while
// message ids are per room. Scotty's cursor 10029 (read in a room of 10,044
// messages) went into every wake prompt of cpm-engine, whose latest id was
// about 1900, as since=10029: each successful wake read nothing.

const state = { prompts: [] as string[] };
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return {
    ...actual,
    inject: async (_pid: number, text: string) => { state.prompts.push(text); },
  };
});

import { CursorStore } from "../src/cursors.js";
import { ChatRoom } from "../src/room.js";

const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle(rounds = 30): Promise<void> { for (let i = 0; i < rounds; i++) await tick(); }
const sinceOf = (prompt: string): number => Number(/since=(\d+)/.exec(prompt)?.[1] ?? NaN);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "joind-cursors-")); state.prompts = []; });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

/** A room wired the way index.ts wires it: its own id, the shared store. */
function wiredRoom(store: CursorStore, id: string): ChatRoom {
  const room = new ChatRoom();
  room.getCursor = (name) => store.cursorFor(id, name, room.highWaterId());
  return room;
}

describe("CursorStore: one cursor per room and name", () => {
  it("two rooms, one name: advancing in one leaves the other alone", () => {
    const store = new CursorStore(dir, { log: () => undefined });
    store.advance("big", "Scotty", 10029);
    store.advance("small", "Scotty", 12);
    expect(store.get("big", "Scotty")).toBe(10029);
    expect(store.get("small", "Scotty")).toBe(12);
    expect(store.get("remote:c1", "Scotty")).toBe(0);
  });

  it("a cursor never moves backward, and never past the room's last id when that is given", () => {
    const store = new CursorStore(dir, { log: () => undefined });
    store.advance("r", "A", 10);
    store.advance("r", "A", 7);
    expect(store.get("r", "A")).toBe(10);
    store.advance("r", "A", 10029, 1900);
    expect(store.get("r", "A")).toBe(1900);
  });

  it("a stored cursor past the room's end is logged once per room and agent, read as the room's end, and left as stored (no rewrite on inference)", () => {
    const lines: string[] = [];
    const store = new CursorStore(dir, { log: (l) => lines.push(l) });
    store.advance("cpm", "Scotty", 10029);
    expect(store.cursorFor("cpm", "Scotty", 1900)).toBe(1900);
    expect(store.cursorFor("cpm", "Scotty", 1900)).toBe(1900);
    expect(lines).toEqual(["  [cursors] Scotty in cpm: stored cursor 10029 is past the room's last id 1900; left as stored, read as 1900"]);
    expect(store.get("cpm", "Scotty")).toBe(10029);
    store.flush();
    expect(JSON.parse(readFileSync(join(dir, "agent-cursors.json"), "utf-8")).rooms.cpm.Scotty).toBe(10029);
    // A cursor inside its room is returned as stored.
    store.advance("c-2", "Scotty", 1850);
    expect(store.cursorFor("c-2", "Scotty", 1900)).toBe(1850);
  });

  it("the file is { version: 2, rooms: { room: { name: id } } }, including remote room ids, and loads back", () => {
    const store = new CursorStore(dir, { log: () => undefined });
    store.advance("c-local", "Scotty", 12);
    store.advance("y530:c-home", "Scotty", 40);
    store.flush();
    const file = JSON.parse(readFileSync(join(dir, "agent-cursors.json"), "utf-8"));
    expect(file).toEqual({ version: 2, rooms: { "c-local": { Scotty: 12 }, "y530:c-home": { Scotty: 40 } } });
    const again = new CursorStore(dir, { log: () => undefined });
    expect(again.get("y530:c-home", "Scotty")).toBe(40);
  });

  it("legacy flat name-only entries are ignored (not migrated), logged, and kept in the file untouched by later saves", () => {
    writeFileSync(join(dir, "agent-cursors.json"), JSON.stringify({ Scotty: 10029, Kira: 55 }));
    const lines: string[] = [];
    const store = new CursorStore(dir, { log: (l) => lines.push(l) });
    expect(store.get("cpm", "Scotty")).toBe(0);
    expect(lines).toEqual(["  [cursors] agent-cursors.json holds 2 legacy name-only cursor(s); ignored and kept in the file untouched (cursors are per room now)"]);
    store.advance("cpm", "Scotty", 3);
    store.flush();
    expect(JSON.parse(readFileSync(join(dir, "agent-cursors.json"), "utf-8"))).toEqual({ Scotty: 10029, Kira: 55, version: 2, rooms: { cpm: { Scotty: 3 } } });
    // And they survive a reload and a second save unchanged.
    const again = new CursorStore(dir, { log: () => undefined });
    again.advance("cpm", "Scotty", 4);
    again.flush();
    const file = JSON.parse(readFileSync(join(dir, "agent-cursors.json"), "utf-8"));
    expect([file.Scotty, file.Kira, file.rooms.cpm.Scotty]).toEqual([10029, 55, 4]);
  });

  it("an unreadable file, a wrong shape, and bad values never stop startup", () => {
    for (const raw of ["{not json", "[]", "null", JSON.stringify({ version: 2, rooms: [] }), JSON.stringify({ version: 3, rooms: {} })]) {
      writeFileSync(join(dir, "agent-cursors.json"), raw);
      expect(() => new CursorStore(dir, { log: () => undefined })).not.toThrow();
    }
    writeFileSync(join(dir, "agent-cursors.json"), JSON.stringify({ version: 2, rooms: { r: { A: 5, B: -1, C: "7", D: 1.5 }, s: 9 } }));
    const store = new CursorStore(dir, { log: () => undefined });
    expect([store.get("r", "A"), store.get("r", "B"), store.get("r", "C"), store.get("r", "D"), store.get("s", "A")]).toEqual([5, 0, 0, 0, 0]);
  });

  it("a save that fails only logs; it never throws out of the timer", () => {
    const lines: string[] = [];
    const store = new CursorStore(join(dir, "missing-subdir"), { log: (l) => lines.push(l) });
    store.advance("r", "A", 1);
    expect(() => store.flush()).not.toThrow();
    expect(lines.some((l) => /could not save agent-cursors.json/.test(l))).toBe(true);
  });

  it("unread counts use the cursor they are given", () => {
    const store = new CursorStore(dir, { log: () => undefined });
    const msgs = [{ id: 1, sender: "Rami" }, { id: 2, sender: "Scotty" }, { id: 3, sender: "Kira" }];
    expect(store.getUnreadCount(1, "Scotty", msgs)).toEqual({ count: 1, senders: ["Kira"] });
  });
});

describe("gate round 1: the room's high-water mark, and keys the file must keep", () => {
  it("deleting the newest message does not make a cursor that read it foreign", () => {
    const lines: string[] = [];
    const store = new CursorStore(dir, { log: (l) => lines.push(l) });
    const room = wiredRoom(store, "c-1");
    try {
      room.send("Rami", "one");
      const newest = room.send("Rami", "two");
      store.advance("c-1", "Scotty", newest.id, room.highWaterId());
      room.deleteMessage(newest.id);
      expect(room.highWaterId()).toBe(newest.id);
      expect(store.cursorFor("c-1", "Scotty", room.highWaterId())).toBe(newest.id);
      expect(lines).toEqual([]);
    } finally {
      room.destroy();
    }
  });

  it("a mirror's mark is the highest home id it inserted, kept through a deletion; its negative local lines never count", () => {
    class TestMirror extends ChatRoom {
      insertHome(id: number): void { this.noteMessageId(id); }
    }
    const room = new TestMirror();
    try {
      room.insertHome(1900);
      room.insertHome(1850);
      room.insertHome(-3);
      expect(room.highWaterId()).toBe(1900);
    } finally {
      room.destroy();
    }
  });

  it("a room or agent called __proto__ survives a save and a reload", () => {
    const store = new CursorStore(dir, { log: () => undefined });
    store.advance("__proto__", "__proto__", 5);
    store.advance("c-1", "__proto__", 6);
    store.flush();
    const again = new CursorStore(dir, { log: () => undefined });
    expect(again.get("__proto__", "__proto__")).toBe(5);
    expect(again.get("c-1", "__proto__")).toBe(6);
  });
});

describe("wake prompts: the room's own cursor, never past the mention", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function fire(): Promise<void> {
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
  }

  it("the field case: a cursor from the big room does not reach the small room's prompt, and the prompt's read returns the mention", async () => {
    const store = new CursorStore(dir, { log: () => undefined });
    const big = wiredRoom(store, "c-big");
    const small = wiredRoom(store, "c-cpm");
    try {
      store.advance("c-big", "Scotty", 10029);
      small.join("Scotty", 4242);
      for (let i = 0; i < 5; i++) small.send("Rami", `note ${i}`);
      const mention = small.send("Rami", "@Scotty ping");
      await fire();
      expect(state.prompts).toHaveLength(1);
      const since = sinceOf(state.prompts[0]);
      expect(since).toBeLessThan(mention.id);
      expect(small.read(since, 50, undefined, "Scotty").map((m) => m.id)).toContain(mention.id);
    } finally {
      big.destroy();
      small.destroy();
    }
  });

  it("a foreign cursor stored for this very room is not sent: the prompt is clamped below the mention, and the entry is left alone", async () => {
    const store = new CursorStore(dir, { log: () => undefined });
    const small = wiredRoom(store, "c-cpm");
    try {
      store.advance("c-cpm", "Scotty", 10029); // uncapped: as if written by old code
      small.join("Scotty", 4242);
      const mention = small.send("Rami", "@Scotty ping");
      await fire();
      expect(sinceOf(state.prompts[0])).toBe(mention.id - 1);
      expect(store.get("c-cpm", "Scotty")).toBe(10029);
    } finally {
      small.destroy();
    }
  });

  it("the clamp: a cursor that moved past the mention before the wake fired is pulled back to just before it", async () => {
    const store = new CursorStore(dir, { log: () => undefined });
    const room = wiredRoom(store, "c-1");
    try {
      room.join("Scotty", 4242);
      room.send("Rami", "hello");
      const mention = room.send("Rami", "@Scotty ping");
      room.send("Kira", "after");
      store.advance("c-1", "Scotty", room.highWaterId()); // Scotty read everything meanwhile
      await fire();
      expect(sinceOf(state.prompts[0])).toBe(mention.id - 1);
    } finally {
      room.destroy();
    }
  });

  it("a cursor below the mention is used as it is (the clamp only ever lowers it)", async () => {
    const store = new CursorStore(dir, { log: () => undefined });
    const room = wiredRoom(store, "c-1");
    try {
      room.join("Scotty", 4242);
      room.send("Rami", "one");
      room.send("Rami", "two");
      store.advance("c-1", "Scotty", 1);
      room.send("Rami", "@Scotty ping");
      await fire();
      expect(sinceOf(state.prompts[0])).toBe(1);
    } finally {
      room.destroy();
    }
  });

  it("a later wake after a landed one clamps to the new mention, not the old one", async () => {
    const store = new CursorStore(dir, { log: () => undefined });
    const room = wiredRoom(store, "c-1");
    try {
      room.join("Scotty", 4242);
      room.send("Rami", "@Scotty first");
      await fire();
      room.send("Rami", "chatter");
      const second = room.send("Rami", "@Scotty second");
      store.advance("c-1", "Scotty", room.highWaterId());
      await fire();
      expect(state.prompts).toHaveLength(2);
      expect(sinceOf(state.prompts[1])).toBe(second.id - 1);
    } finally {
      room.destroy();
    }
  });

  it("gate round 2: a message naming the target thousands of times is one mention, and later wakes still run", async () => {
    const store = new CursorStore(dir, { log: () => undefined });
    const room = wiredRoom(store, "c-1");
    try {
      room.join("A", 4242);
      for (let i = 0; i < 6; i++) room.send("Rami", "@A ".repeat(30_000));
      await fire();
      room.send("Rami", "@A an ordinary mention");
      await fire();
      expect(state.prompts).toHaveLength(2);
    } finally {
      room.destroy();
    }
  });

  it("gate round 2: a host waits (bounded) for the home's mention to reach its room before typing, then clamps below it", async () => {
    const store = new CursorStore(dir, { log: () => undefined });
    const mirror = wiredRoom(store, "home:c-home");
    try {
      mirror.join("Scotty", 4242, undefined, undefined, undefined, undefined, "reg-1");
      mirror.send("Rami", "line 1");
      store.advance("home:c-home", "Scotty", mirror.highWaterId());
      const mentionId = mirror.highWaterId() + 2; // "line 2", then the mention
      const pending = mirror.wakeForPeer("Rami", "Scotty", "reg-1", "\"cpm\" on home", mentionId);
      await vi.advanceTimersByTimeAsync(500);
      expect(state.prompts).toHaveLength(0); // the mention has not arrived yet
      mirror.send("Rami", "line 2");
      const mention = mirror.send("Rami", "the replicated mention");
      expect(mention.id).toBe(mentionId);
      store.advance("home:c-home", "Scotty", mention.id); // read past it meanwhile
      await fire();
      expect((await pending).ok).toBe(true);
      expect(state.prompts).toHaveLength(1);
      expect(sinceOf(state.prompts[0])).toBe(mentionId - 1);
    } finally {
      mirror.destroy();
    }
  });

  it("gate round 2: a mention that never arrives does not block the wake past the bound", async () => {
    const store = new CursorStore(dir, { log: () => undefined });
    const mirror = wiredRoom(store, "home:c-home");
    try {
      mirror.join("Scotty", 4242, undefined, undefined, undefined, undefined, "reg-1");
      const pending = mirror.wakeForPeer("Rami", "Scotty", "reg-1", "\"cpm\" on home", 99);
      await vi.advanceTimersByTimeAsync(3100);
      await fire();
      expect((await pending).ok).toBe(true);
      expect(sinceOf(state.prompts[0])).toBe(0);
    } finally {
      mirror.destroy();
    }
  });

  it("a hosted member through the mirror: the host's prompt uses the mirror room's cursor, clamped below the home's mention id", async () => {
    const store = new CursorStore(dir, { log: () => undefined });
    // The host side: a room standing for the mirror "home:c-home", its ids the home's ids.
    const mirror = wiredRoom(store, "home:c-home");
    try {
      mirror.join("Scotty", 4242, undefined, undefined, undefined, undefined, "reg-1");
      for (let i = 0; i < 4; i++) mirror.send("Rami", `line ${i}`);
      store.advance("home:c-home", "Scotty", mirror.highWaterId());
      store.advance("elsewhere", "Scotty", 10029);
      const pending = mirror.wakeForPeer("Rami", "Scotty", "reg-1", "\"cpm\" on home", 3);
      await fire();
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(sinceOf(state.prompts[0])).toBe(2);
    } finally {
      mirror.destroy();
    }
  });
});

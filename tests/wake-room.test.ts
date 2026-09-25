import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Drive ChatRoom's wake path with the injector replaced: every call records
// how many injections are in flight at once, and can be held open.
const state = { inFlight: 0, maxInFlight: 0, calls: [] as number[], gates: [] as Array<() => void> };
vi.mock("../src/inject.js", () => ({
  inject: vi.fn(async (pid: number) => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    state.calls.push(pid);
    await new Promise<void>((r) => state.gates.push(r));
    state.inFlight--;
  }),
}));

import { ChatRoom } from "../src/room.js";

const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle(rounds = 20): Promise<void> { for (let i = 0; i < rounds; i++) await tick(); }
async function releaseOne(): Promise<void> { const g = state.gates.shift(); if (g) g(); await settle(); }

describe("ChatRoom wake path (mocked injector)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.inFlight = 0; state.maxInFlight = 0; state.calls = []; state.gates = [];
  });
  afterEach(() => { vi.useRealTimers(); });

  it("never injects into one terminal twice at once, even when equivalence is learned while wakes are queued", async () => {
    const a = new ChatRoom();
    const b = new ChatRoom();
    const c = new ChatRoom();
    try {
      // Round-5 gate scenario. A knows the full identity and holds an injection.
      a.join("Codex", 960, 60, undefined, undefined, 1);
      a.send("Rami", "@Codex first");
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      expect(state.calls).toEqual([960]);
      // A leaves; B (pid-only) and C (pane-only) queue behind A on disjoint keys.
      a.leave("Codex");
      b.join("Codex", 960);
      c.join("Codex", 0, 60, undefined, undefined, 1);
      b.send("Rami", "@Codex from b");
      c.send("Rami", "@Codex from c");
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      // A comes back with the pairing before its injection completes.
      a.join("Codex", 960, 60, undefined, undefined, 1);
      await releaseOne(); // A's injection finishes (plus its 300ms settle on win32)
      await vi.advanceTimersByTimeAsync(300);
      await settle();
      // B and C must now run one after the other.
      for (let i = 0; i < 6; i++) {
        await releaseOne();
        await vi.advanceTimersByTimeAsync(2300);
        await settle();
      }
      expect(state.maxInFlight).toBe(1);
      expect(state.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      // Drain anything still held so no timer or promise outlives the test.
      while (state.gates.length) state.gates.shift()!();
      await settle();
      a.destroy(); b.destroy(); c.destroy();
    }
  });

  it("does not inject after the room is destroyed", async () => {
    const room = new ChatRoom();
    room.join("Jadzia", 9);
    room.send("Rami", "@Jadzia hello");
    room.destroy();
    await vi.advanceTimersByTimeAsync(2500);
    await settle();
    expect(state.calls).toEqual([]);
  });
});

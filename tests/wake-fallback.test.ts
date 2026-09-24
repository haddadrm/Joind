import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The real inject() runs, with the WezTerm backend held open and failing on
// release, and a recording console backend. This exercises the room's
// fallback guard end to end.
const state = { console: [] as number[], gates: [] as Array<() => void> };
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return {
    ...actual,
    inject: (pid: number, text: string, pane?: number, exe?: string, env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) =>
      actual.inject(pid, text, pane, exe, env, {
        wezterm: async () => {
          await new Promise<void>((r) => state.gates.push(r));
          throw new Error("failed to connect to Socket(gui-sock-1)");
        },
        windows: async (p) => { state.console.push(p); },
        unix: async (p) => { state.console.push(p); },
        // "linux": the console path has no process-name lookup, so the test
        // needs no real subprocess and settles on microtasks alone.
        platform: "linux",
      }, options),
  };
});

import { ChatRoom } from "../src/room.js";

const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle(rounds = 20): Promise<void> { for (let i = 0; i < rounds; i++) await tick(); }
async function releaseOne(): Promise<void> { const g = state.gates.shift(); if (g) g(); await settle(); }

describe("console fallback after a WezTerm failure (real inject, fake backends)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.console = []; state.gates = [];
  });
  afterEach(() => { vi.useRealTimers(); });

  it("does not type into a session that left while WezTerm was being tried", async () => {
    const room = new ChatRoom();
    try {
      room.join("Claude", 100, 7);
      room.send("Rami", "@Claude ping");
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      expect(state.gates).toHaveLength(1); // WezTerm attempt in flight
      room.leave("Claude");
      await releaseOne();
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(state.console).toEqual([]);
    } finally {
      while (state.gates.length) state.gates.shift()!();
      await settle();
      room.destroy();
    }
  });

  it("does not fall back to the console while the terminal now needs locks this wake does not hold", async () => {
    const a = new ChatRoom();
    const b = new ChatRoom();
    const c = new ChatRoom();
    try {
      a.join("A", 100, 7);
      b.join("B", 200, 8);
      a.send("Rami", "@A ping");
      b.send("Rami", "@B ping");
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      expect(state.gates).toHaveLength(2); // both WezTerm attempts in flight, disjoint locks
      // A registration pairing pid 100 with pane 8 links A's and B's terminals.
      c.join("C", 100, 8);
      await releaseOne(); // A's WezTerm attempt fails while B is still in flight
      await settle();
      expect(state.console).toEqual([]); // A must not type now: it needs pane:8, which B holds
      await releaseOne(); // B's attempt fails; B falls back (its held set already covers pid:200|pane:8? no: needs pid:100 now)
      await vi.advanceTimersByTimeAsync(5000);
      await settle();
      for (let i = 0; i < 4; i++) { while (state.gates.length) state.gates.shift()!(); await vi.advanceTimersByTimeAsync(2500); await settle(); }
      // Both wakes are delivered in the end, one at a time, and nothing else was typed.
      expect([...state.console].sort()).toEqual([100, 200]);
    } finally {
      while (state.gates.length) state.gates.shift()!();
      await settle();
      a.destroy(); b.destroy(); c.destroy();
    }
  });

  it("re-queues for the replacement session instead of typing into the old pid", async () => {
    const room = new ChatRoom();
    try {
      room.join("Claude", 100, 7);
      room.send("Rami", "@Claude ping");
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      expect(state.gates).toHaveLength(1);
      room.join("Claude", 200, null); // rejoined from a new pid, pane cleared by the resolver
      await releaseOne();             // old WezTerm attempt fails: guard says moved
      await vi.advanceTimersByTimeAsync(2500);
      await settle();
      // The re-queued wake has no pane, so it goes straight to the console of the live pid.
      expect(state.console).toEqual([200]);
    } finally {
      while (state.gates.length) state.gates.shift()!();
      await settle();
      room.destroy();
    }
  });
});

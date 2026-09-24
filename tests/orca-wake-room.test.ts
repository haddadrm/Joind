import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The real inject() runs with a recording Orca backend (failing on demand)
// and a recording console backend: the room's wake path end to end.
const state = { orca: [] as string[], texts: [] as string[], console: [] as number[], failOrca: false };
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return {
    ...actual,
    inject: (pid: number, text: string, pane?: number, exe?: string, env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) =>
      actual.inject(pid, text, pane, exe, env, {
        orca: async (handle, text) => {
          state.orca.push(handle);
          state.texts.push(text);
          if (state.failOrca) throw new Error(`orca terminal ${handle} unavailable (terminal_handle_stale)`);
        },
        wezterm: async () => { throw new Error("wezterm must not be tried for an Orca agent"); },
        windows: async (p) => { state.console.push(p); },
        unix: async (p) => { state.console.push(p); },
        platform: "linux",
      }, options),
  };
});

import { ChatRoom } from "../src/room.js";

const H = "term_0816c47b-7bc3-4cbe-9903-f686a0b73b16";
const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle(rounds = 20): Promise<void> { for (let i = 0; i < rounds; i++) await tick(); }

describe("room wakes an Orca agent through Orca (real inject, fake backends)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.orca = []; state.texts = []; state.console = []; state.failOrca = false;
  });
  afterEach(() => { vi.useRealTimers(); });

  it("types the mention into the bound Orca terminal, not the console", async () => {
    const room = new ChatRoom();
    try {
      room.join("Claude", 100, undefined, undefined, H);
      room.send("Rami", "@Claude ping");
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      expect(state.orca).toEqual([H]);
      expect(state.console).toEqual([]);
    } finally {
      // Let the win32 settle delay after a delivery run out, so no lock outlives the test.
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      room.destroy();
    }
  });

  it("falls back to the console of the live pid when the handle went stale, and warns nothing", async () => {
    state.failOrca = true;
    const room = new ChatRoom();
    try {
      room.join("Claude", 100, undefined, undefined, H);
      room.send("Rami", "@Claude ping");
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      expect(state.orca).toEqual([H]);
      expect(state.console).toEqual([100]);
      expect(room.read(undefined, 50).some((m) => /Could not wake/.test(m.text))).toBe(false);
    } finally {
      // Let the win32 settle delay after a delivery run out, so no lock outlives the test.
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      room.destroy();
    }
  });

  it("an Orca-only agent (no pid) with a stale handle is reported once as unreachable, not retried", async () => {
    state.failOrca = true;
    const room = new ChatRoom();
    try {
      room.join("Kira", 0, undefined, undefined, H);
      room.send("Rami", "@Kira ping");
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(state.orca).toEqual([H]); // permanent: no retry
      expect(room.read(undefined, 50).filter((m) => /Could not wake Kira: their Orca terminal is not reachable from this server \(orca terminal term_\S+ unavailable \(terminal_handle_stale\)\)/.test(m.text))).toHaveLength(1);
    } finally {
      // Let the win32 settle delay after a delivery run out, so no lock outlives the test.
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      room.destroy();
    }
  });

  it("the wake prompt names the handle in the read URL and the reply body (gate round 1, finding 3)", async () => {
    const room = new ChatRoom();
    try {
      room.join("Kira", 0, undefined, undefined, H);
      room.send("Rami", "@Kira ping");
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      expect(state.texts).toHaveLength(1);
      expect(state.texts[0]).toContain(`&orcaTerminal=${H}"`);
      expect(state.texts[0]).toContain(`"orcaTerminal":"${H}"}'`);
      expect(state.texts[0]).not.toContain("&pid=");
    } finally {
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      room.destroy();
    }
  });
});

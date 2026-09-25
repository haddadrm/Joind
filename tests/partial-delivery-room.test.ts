import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Codex gate round 1 on feat/inject-fixes, finding 3, at room level: the real
// inject() with a WezTerm backend whose text arrives but whose Enter cannot be
// sent. The room must type the prompt once, never through the console, never
// again on a retry, and say what happened.
const state = { wezterm: 0, console: [] as number[] };
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  const { CODEX_PLAN } = await vi.importActual<typeof import("../src/target.js")>("../src/target.js");
  return {
    ...actual,
    inject: (pid: number, text: string, pane?: number, exe?: string, env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) =>
      actual.inject(pid, text, pane, exe, env, {
        wezterm: async () => {
          state.wezterm++;
          throw new actual.PartialDeliveryError(`wezterm pane ${pane}: text delivered, but the Enter that submits it failed twice (wezterm send-text exit 1)`);
        },
        windows: async (p) => { state.console.push(p); },
        unix: async (p) => { state.console.push(p); },
        platform: "linux",
        classify: async () => CODEX_PLAN,
        weztermSocket: (gui: number) => `/s/gui-sock-${gui}`,
      }, options),
  };
});

import { ChatRoom } from "../src/room.js";

const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle(rounds = 20): Promise<void> { for (let i = 0; i < rounds; i++) await tick(); }

describe("a partial delivery in the room", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.wezterm = 0; state.console = [];
  });
  afterEach(() => { vi.useRealTimers(); });

  it("is typed once, never replayed through the console or a retry, and reported honestly", async () => {
    const room = new ChatRoom();
    try {
      room.join("Codex", 100, 7, undefined, undefined, 1);
      room.send("Rami", "@Codex ping");
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      expect(state.wezterm).toBe(1);
      expect(state.console).toEqual([]);
      const lines = room.read(undefined, 50).map((m) => m.text);
      expect(lines).toContain("Could not submit the prompt to Codex; the text is in their input box.");
      expect(lines.some((t) => /Could not wake Codex/.test(t))).toBe(false);
    } finally {
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      room.destroy();
    }
  });
});

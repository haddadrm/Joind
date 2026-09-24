import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Codex gate round 2 on feat/inject-fixes: a guard abort AFTER the text was
// delivered must never replay the prompt into the same terminal. The real
// room, coordinator, inject() and injectWezTerm run; only the `wezterm cli
// send-text` process and the delay between the two Enters are faked, and the
// delay is where the test changes the room (another registration linking the
// terminal, or the agent rejoining).
type Send = { pane: string; payload: string };
const state = {
  sends: [] as Send[],
  orca: [] as string[],
  console: [] as number[],
  onFirstSleep: undefined as (() => void) | undefined,
};

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  const { CODEX_PLAN } = await vi.importActual<typeof import("../src/target.js")>("../src/target.js");
  const spawn: import("../src/inject.js").SpawnSendText = (_exe, argv) => {
    const pane = argv[argv.indexOf("--pane-id") + 1] ?? "?";
    let payload = "";
    const listeners: { close?: (c: number | null) => void } = {};
    return {
      stdin: {
        write: (chunk: string) => { payload += chunk; return true; },
        end: () => { state.sends.push({ pane, payload }); setImmediate(() => listeners.close?.(0)); return undefined; },
      },
      stderr: { on: () => undefined },
      on: (event: "close" | "error", listener: ((c: number | null) => void) | ((e: Error) => void)) => {
        if (event === "close") listeners.close = listener as (c: number | null) => void;
        return undefined;
      },
    };
  };
  const sleep = async (): Promise<void> => {
    const hook = state.onFirstSleep;
    state.onFirstSleep = undefined;
    hook?.();
  };
  return {
    ...actual,
    inject: (pid: number, text: string, pane?: number, exe?: string, env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) =>
      actual.inject(pid, text, pane, exe, env, {
        orca: async (handle) => { state.orca.push(handle); },
        wezterm: (paneId, t, e, en, opts) => actual.injectWezTerm(paneId, t, e, en, { ...opts, spawn, sleep }),
        windows: async (p) => { state.console.push(p); },
        unix: async (p) => { state.console.push(p); },
        platform: "linux",
        classify: async () => CODEX_PLAN,
      }, options),
  };
});

import { ChatRoom } from "../src/room.js";

const H = "term_5b1c0d2e-0000-4000-8000-000000000001";
const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle(rounds = 30): Promise<void> { for (let i = 0; i < rounds; i++) await tick(); }
async function run(): Promise<void> {
  for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(2000); await settle(); }
}
const prompts = (pane: string) => state.sends.filter((s) => s.pane === pane && s.payload.length > 1);
const loneEnters = (pane: string) => state.sends.filter((s) => s.pane === pane && s.payload === "\r");

describe("a wake interrupted after its text was delivered", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.sends = []; state.orca = []; state.console = []; state.onFirstSleep = undefined;
  });
  afterEach(() => { vi.useRealTimers(); });

  it("locks grew, same terminal: the text once, then exactly one carriage return, no second payload (the gate's sequence)", async () => {
    const room = new ChatRoom();
    try {
      room.join("Codex", 100, 7);
      // After the text arrives, another registration links this terminal to an
      // Orca handle: Codex's required locks expand, its identity does not change.
      state.onFirstSleep = () => { room.join("Linker", 100, undefined, undefined, H); };
      room.send("Rami", "@Codex ping");
      await run();
      expect(prompts("7")).toHaveLength(1);
      expect(prompts("7")[0].payload.endsWith("\r")).toBe(true);
      expect(loneEnters("7")).toHaveLength(1);
      expect(state.sends).toHaveLength(2);
      expect(state.orca).toEqual([]);
      expect(state.console).toEqual([]);
      expect(room.read(undefined, 50).some((m) => /Could not (submit|wake)/.test(m.text))).toBe(false);
    } finally {
      await run();
      room.destroy();
    }
  });

  it("the agent rejoined on a registration that may be the same terminal: no replay, no Enter, an honest line", async () => {
    const room = new ChatRoom();
    try {
      room.join("Codex", 100, 7);
      // Same pid and pane, now with an Orca handle: a new identity that may
      // still be the terminal holding the text.
      state.onFirstSleep = () => { room.join("Codex", 100, 7, undefined, H); };
      room.send("Rami", "@Codex ping");
      await run();
      expect(prompts("7")).toHaveLength(1);
      expect(loneEnters("7")).toHaveLength(0);
      expect(state.orca).toEqual([]);
      expect(state.console).toEqual([]);
      expect(room.read(undefined, 50).map((m) => m.text)).toContain("Could not submit the prompt to Codex; the text is in their input box.");
    } finally {
      await run();
      room.destroy();
    }
  });

  it("the agent moved to a disjoint terminal: the old pane is never typed into again, the new one gets a fresh wake", async () => {
    const room = new ChatRoom();
    try {
      room.join("Codex", 100, 7);
      state.onFirstSleep = () => { room.join("Codex", 200, 8); };
      room.send("Rami", "@Codex ping");
      await run();
      expect(prompts("7")).toHaveLength(1);
      expect(loneEnters("7")).toHaveLength(0);
      expect(prompts("8")).toHaveLength(1);
      expect(loneEnters("8")).toHaveLength(1);
      expect(prompts("8")[0].payload).toContain("pid=200");
    } finally {
      await run();
      room.destroy();
    }
  });

  it("the agent left after the text arrived: nothing more is typed anywhere", async () => {
    const room = new ChatRoom();
    try {
      room.join("Codex", 100, 7);
      state.onFirstSleep = () => { room.leave("Codex"); };
      room.send("Rami", "@Codex ping");
      await run();
      expect(state.sends).toHaveLength(1);
      expect(state.orca).toEqual([]);
      expect(state.console).toEqual([]);
    } finally {
      await run();
      room.destroy();
    }
  });
});

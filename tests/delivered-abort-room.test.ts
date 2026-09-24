import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Codex gate rounds 2 and 3 on feat/inject-fixes: once a prompt's text is in
// a terminal, the attempt that typed it finishes the submission in place,
// under the locks it holds, over the route that typed it; it never replays
// the prompt into that terminal. The real room, coordinator, inject(),
// injectWezTerm and injectUnix run; only the `wezterm cli send-text` process,
// tmux, and the delay between the two Enters are faked. The delay is where a
// test changes the room (a registration linking the terminal, a rejoin, a
// departure).
type Send = { via: "wezterm" | "tmux"; target: string; payload: string };
const state = {
  sends: [] as Send[],
  orca: [] as string[],
  onFirstSleep: undefined as (() => void) | undefined,
  /** How long the first delay lasts in (fake) time, so a mention sent inside
   *  it can be queued while the first attempt still holds its locks. */
  firstSleepMs: 0,
  failWezterm: false,
};

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  const { CODEX_PLAN } = await vi.importActual<typeof import("../src/target.js")>("../src/target.js");
  const spawn: import("../src/inject.js").SpawnSendText = (_exe, argv) => {
    const target = argv[argv.indexOf("--pane-id") + 1] ?? "?";
    let payload = "";
    const listeners: { close?: (c: number | null) => void } = {};
    return {
      stdin: {
        write: (chunk: string) => { payload += chunk; return true; },
        end: () => { state.sends.push({ via: "wezterm", target, payload }); setImmediate(() => listeners.close?.(0)); return undefined; },
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
    if (!hook) return;
    hook();
    const ms = state.firstSleepMs;
    state.firstSleepMs = 0;
    if (ms > 0) await new Promise<void>((r) => setTimeout(r, ms));
  };
  // tmux: one pane, main:0.0, running pid 100.
  let pendingText = "";
  const exec: import("../src/inject.js").UnixExec = async (cmd, args) => {
    if (cmd === "tmux" && args[0] === "list-panes") return { stdout: "100 main:0.0\n" };
    if (cmd === "pgrep") throw new Error("no children");
    if (args.includes("-l")) { pendingText = args[args.length - 1]; return { stdout: "" }; }
    if (args[args.length - 1] === "Enter") {
      state.sends.push({ via: "tmux", target: args[2], payload: pendingText + "\r" });
      pendingText = "";
    }
    return { stdout: "" };
  };
  return {
    ...actual,
    inject: (pid: number, text: string, pane?: number, exe?: string, env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) =>
      actual.inject(pid, text, pane, exe, env, {
        orca: async (handle) => { state.orca.push(handle); },
        wezterm: async (paneId, t, e, en, opts) => {
          if (state.failWezterm) throw new Error("failed to connect to Socket(gui-sock-1)");
          return actual.injectWezTerm(paneId, t, e, en, { ...opts, spawn, sleep });
        },
        windows: async () => { throw new Error("the Windows console must not be tried here"); },
        unix: (p, t, guard, plan, afterText) => actual.injectUnix(p, t, guard, plan, afterText, { exec, sleep }),
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
  for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(2000); await settle(); }
}
const isPrompt = (s: Send) => s.payload.length > 1;
const isEnter = (s: Send) => s.payload === "\r";
const lines = (room: ChatRoom) => room.read(undefined, 50).map((m) => m.text);

describe("a wake whose text is in the terminal finishes in place", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.sends = []; state.orca = []; state.onFirstSleep = undefined; state.firstSleepMs = 0; state.failWezterm = false;
  });
  afterEach(() => { vi.useRealTimers(); });

  it("locks grew after the text (the gate's sequence): the text once, then its Enter, nothing in between, no warning", async () => {
    const room = new ChatRoom();
    try {
      room.join("Codex", 100, 7);
      // After the text arrives, another registration links this terminal to an
      // Orca handle: the required locks grow, Codex's identity does not change.
      state.onFirstSleep = () => { room.join("Linker", 100, undefined, undefined, H); };
      room.send("Rami", "@Codex ping");
      await run();
      expect(state.sends).toHaveLength(2);
      expect(isPrompt(state.sends[0]) && state.sends[0].payload.endsWith("\r")).toBe(true);
      expect(isEnter(state.sends[1])).toBe(true);
      expect(state.sends.every((s) => s.target === "7")).toBe(true);
      expect(state.orca).toEqual([]);
      expect(lines(room).some((t) => /Could not (submit|wake)/.test(t))).toBe(false);
    } finally {
      await run();
      room.destroy();
    }
  });

  it("two agents on one pane: B's text arrives only after A's Enter, even when the locks grow during A's delay", async () => {
    const room = new ChatRoom();
    try {
      room.join("A", 100, 7);
      room.join("B", 101, 7);
      // The gate's interleave: during A's delay the locks grow and B is
      // mentioned; B's wake queues (with the grown lock set) while A still
      // holds the terminal. Round 2 released A there and let B type first.
      state.firstSleepMs = 2500;
      state.onFirstSleep = () => {
        room.join("Linker", 100, undefined, undefined, H);
        room.send("Rami", "@B ping");
      };
      room.send("Rami", "@A ping");
      await run();
      const order = state.sends.map((s) => (isEnter(s) ? "enter" : s.payload.includes("@A ") ? "A" : s.payload.includes("@B ") ? "B" : "?"));
      expect(order).toEqual(["A", "enter", "B", "enter"]);
    } finally {
      await run();
      room.destroy();
    }
  });

  it("the agent rejoined as a registration directly sharing the terminal: no replay, no Enter, the partial line", async () => {
    const room = new ChatRoom();
    try {
      room.join("Codex", 100, 7);
      state.onFirstSleep = () => { room.join("Codex", 100, 7, undefined, H); };
      room.send("Rami", "@Codex ping");
      await run();
      expect(state.sends.filter(isPrompt)).toHaveLength(1);
      expect(state.sends.filter(isEnter)).toHaveLength(0);
      expect(state.orca).toEqual([]);
      expect(lines(room)).toContain("Could not submit the prompt to Codex; the text is in their input box.");
    } finally {
      await run();
      room.destroy();
    }
  });

  it("the agent rejoined as a terminal linked only through another registration: the same terminal, so a warning, never a replay", async () => {
    const room = new ChatRoom();
    try {
      // Codex pane-only at pane 7; a live bridge registration carries pid 100
      // and pane 7; Codex then rejoins pid-only at 100. No direct overlap with
      // pane 7, but the same terminal through the bridge.
      room.join("Codex", 0, 7);
      room.join("Bridge", 100, 7);
      state.onFirstSleep = () => { room.join("Codex", 100, null); };
      room.send("Rami", "@Codex ping");
      await run();
      expect(state.sends.filter(isPrompt)).toHaveLength(1);
      expect(state.sends.filter(isEnter)).toHaveLength(0);
      expect(lines(room)).toContain("Could not submit the prompt to Codex; the text is in their input box.");
    } finally {
      await run();
      room.destroy();
    }
  });

  it("a bridge leaves and rejoins elsewhere with the same handle, then the agent follows: still the same terminal through the held locks (gate round 4)", async () => {
    const room = new ChatRoom();
    try {
      // A pane-only at pane 7; the bridge carries pid 100, pane 7 and handle H,
      // so A's wake holds pane:7, pid:100 and orca:H. During A's delay the
      // bridge leaves and rejoins as pid 200 with the same H, and A rejoins
      // pid-only at 200. A's closure now is {pid:200, orca:H}: linked to the
      // terminal holding the text only through H, a key the attempt holds.
      room.join("A", 0, 7);
      room.join("Bridge", 100, 7, undefined, H);
      state.onFirstSleep = () => {
        room.leave("Bridge");
        room.join("Bridge", 200, null, undefined, H);
        room.join("A", 200, null);
      };
      room.send("Rami", "@A ping");
      await run();
      expect(state.sends.filter(isPrompt)).toHaveLength(1);
      expect(state.sends.filter(isEnter)).toHaveLength(0);
      expect(state.orca).toEqual([]);
      expect(lines(room)).toContain("Could not submit the prompt to A; the text is in their input box.");
    } finally {
      await run();
      room.destroy();
    }
  });

  it("the agent moved to a disjoint terminal: the old one is never typed into again, the new one gets a fresh wake", async () => {
    const room = new ChatRoom();
    try {
      room.join("Codex", 100, 7);
      state.onFirstSleep = () => { room.join("Codex", 200, 8); };
      room.send("Rami", "@Codex ping");
      await run();
      const on7 = state.sends.filter((s) => s.target === "7");
      const on8 = state.sends.filter((s) => s.target === "8");
      expect(on7.map((s) => (isEnter(s) ? "enter" : "text"))).toEqual(["text"]);
      expect(on8.map((s) => (isEnter(s) ? "enter" : "text"))).toEqual(["text", "enter"]);
      expect(on8[0].payload).toContain("pid=200");
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
    } finally {
      await run();
      room.destroy();
    }
  });

  it("tmux delivered the text after WezTerm failed: the Enter goes through tmux, the backend that delivered it", async () => {
    state.failWezterm = true;
    const room = new ChatRoom();
    try {
      room.join("Codex", 100, 7);
      state.onFirstSleep = () => { room.join("Linker", 100, undefined, undefined, H); };
      room.send("Rami", "@Codex ping");
      await run();
      expect(state.sends.filter((s) => s.via === "wezterm")).toEqual([]);
      const viaTmux = state.sends.filter((s) => s.via === "tmux");
      expect(viaTmux.map((s) => (isEnter(s) ? "enter" : "text"))).toEqual(["text", "enter"]);
      expect(viaTmux.every((s) => s.target === "main:0.0")).toBe(true);
    } finally {
      await run();
      room.destroy();
    }
  });
});

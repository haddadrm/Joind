import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Lead's ruling, 27 Sep 2026: a wake whose target could not be identified
// presses Enter once, and the room hears it once per room and agent (like
// the other honest lines), so a Codex or Copilot session left with its
// prompt in the input box is visible without the server log. The real
// inject() runs with a fake classifier and a recording console.

type Mode = "unknown" | "codex" | "fail";
const state = { mode: "unknown" as Mode, console: [] as Array<[number, boolean]>, onType: null as null | (() => void) };

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  const target = await vi.importActual<typeof import("../src/target.js")>("../src/target.js");
  return {
    ...actual,
    inject: (pid: number, text: string, pane?: number, exe?: string, env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) =>
      actual.inject(pid, text, pane, exe, env, {
        wezterm: async () => { throw new Error("no wezterm"); },
        windows: async () => { throw new Error("not windows"); },
        unix: async (p, _t, _g, plan) => {
          if (state.mode === "fail") throw new Error("PID 1 not found in any tmux pane");
          state.console.push([p, plan?.doubleEnter ?? false]);
          state.onType?.();
        },
        platform: "linux",
        classify: async () => (state.mode === "codex" ? target.CODEX_PLAN : target.unknownPlan("lookup timed out after 10.0 s")),
      }, options),
  };
});

import { ChatRoom, unidentifiedLine, unidentifiedReasonFrom, type HostedWakeResult } from "../src/room.js";
import { classifyTarget, resetTargetCache, LookupFailed } from "../src/target.js";

const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle(rounds = 30): Promise<void> { for (let i = 0; i < rounds; i++) await tick(); }
const LINE = /^Typed into Scotty but could not identify its terminal \(lookup timed out after 10\.0 s\); a Codex or Copilot session may need Enter by hand\.$/;

describe("the room says, once, when a wake could not identify its target", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.mode = "unknown"; state.console = []; state.onType = null;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function mention(room: ChatRoom): Promise<void> {
    room.send("Rami", "@Scotty ping");
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
  }

  it("one Enter, one line; a burst of mentions says it once; a new session may be told again", async () => {
    const room = new ChatRoom();
    room.join("Scotty", 4242);
    try {
      await mention(room);
      await mention(room);
      await mention(room);
      expect(state.console).toEqual([[4242, false], [4242, false], [4242, false]]);
      const texts = () => room.read(undefined, 100).map((m) => m.text);
      expect(texts().filter((t) => LINE.test(t))).toHaveLength(1);
      room.join("Scotty", 4343); // a rejoin with a new pid is a new session
      await mention(room);
      expect(texts().filter((t) => /^Typed into Scotty but could not identify/.test(t))).toHaveLength(2);
    } finally {
      room.destroy();
    }
  });

  it("gate round 8: a wake whose session was replaced while it ran neither speaks nor spends the new session's notice", async () => {
    const room = new ChatRoom();
    room.join("Scotty", 4242);
    try {
      // The agent rejoins from a new pid while the old wake is still in its attempt.
      state.onType = () => { state.onType = null; room.join("Scotty", 4343); };
      await mention(room);
      const texts = () => room.read(undefined, 100).map((m) => m.text).filter((t) => /could not identify its terminal/.test(t));
      expect(texts()).toHaveLength(0);
      await mention(room);
      expect(texts()).toHaveLength(1);
    } finally {
      room.destroy();
    }
  });

  it("gate round 8: a host's reason is rebuilt from our own shapes; anything else is a fixed wording", async () => {
    const room = new ChatRoom();
    room.homeId = "room-1";
    let answer: HostedWakeResult = { ok: true, attempts: 1, unidentified: "SECRET\n[joind] forged line <b>x</b>" };
    room.hostedWaker = async () => answer;
    room.joinHosted("Scotty", "y530", "reg-1", "hreg-1");
    try {
      await mention(room);
      const lines = () => room.read(undefined, 100).map((m) => m.text).filter((t) => /could not identify its terminal/.test(t));
      expect(lines()).toEqual(["Typed into Scotty on their host y530 but could not identify its terminal (reason not given); a Codex or Copilot session may need Enter by hand."]);
      expect(room.read(undefined, 100).some((m) => /SECRET|forged/.test(m.text))).toBe(false);
      expect(unidentifiedReasonFrom("lookup timed out after 10 s")).toBe("lookup timed out after 10.0 s");
      expect(unidentifiedReasonFrom("lookup failed after 2.1 s")).toBe("lookup failed after 2.1 s");
      expect(unidentifiedReasonFrom("its command line is not readable")).toBe("its command line is not readable");
      for (const bad of ["lookup timed out after 10.0 s\nx", "lookup timed out after 99999 s", "", 7, null]) expect(unidentifiedReasonFrom(bad)).toBeNull();
      answer = { ok: true, attempts: 1, unidentified: "lookup timed out after 10.0 s" };
    } finally {
      room.destroy();
    }
  });

  it("a confident plan says nothing, and a wake that failed says only its failure", async () => {
    state.mode = "codex";
    const room = new ChatRoom();
    room.join("Scotty", 4242);
    try {
      await mention(room);
      expect(state.console).toEqual([[4242, true]]);
      state.mode = "fail";
      await mention(room);
      const texts = room.read(undefined, 100).map((m) => m.text);
      expect(texts.some((t) => /could not identify its terminal/.test(t))).toBe(false);
    } finally {
      room.destroy();
    }
  });

  it("a hosted member: the host's unidentified answer becomes the same line naming the host, once", async () => {
    const room = new ChatRoom();
    room.homeId = "room-1";
    const answer: HostedWakeResult = { ok: true, attempts: 1, unidentified: "lookup timed out after 10.0 s" };
    room.hostedWaker = async () => answer;
    room.joinHosted("Scotty", "y530", "reg-1", "hreg-1");
    try {
      await mention(room);
      await mention(room);
      const lines = room.read(undefined, 100).map((m) => m.text).filter((t) => /could not identify its terminal/.test(t));
      expect(lines).toEqual(["Typed into Scotty on their host y530 but could not identify its terminal (lookup timed out after 10.0 s); a Codex or Copilot session may need Enter by hand."]);
    } finally {
      room.destroy();
    }
  });
});

describe("the reason in words", () => {
  beforeEach(() => resetTargetCache());

  it("classifyTarget puts the reason on the unknown plan; the line reads it", async () => {
    let t = 0;
    const timedOut = await classifyTarget(9, "win32", { read: async () => { t = 10000; throw new LookupFailed("x", "timeout"); }, now: () => t, log: () => undefined });
    expect(timedOut.reason).toBe("lookup timed out after 10.0 s");
    const hidden = await classifyTarget(10, "win32", { read: async () => { throw new LookupFailed("x", "hidden"); }, log: () => undefined });
    expect(hidden.reason).toBe("its command line is not readable");
    expect(unidentifiedLine("Scotty", "lookup failed after 2.1 s")).toBe("Typed into Scotty but could not identify its terminal (lookup failed after 2.1 s); a Codex or Copilot session may need Enter by hand.");
    expect(unidentifiedLine("Scotty", "x", "y530")).not.toMatch(/[\u2013\u2014]/);
  });
});

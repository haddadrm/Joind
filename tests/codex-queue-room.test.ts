import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { tmpdir } from "os";

// The room's wake with a codexThread: the real inject() with a stubbed
// queue backend (never the real codex) and recording keystroke backends.
// The submit check reads a store that does not exist, so it can only log
// "not verifiable"; its log line is how a started check is seen here.

type QueueMode = "ok" | "enoent" | "unknown-thread" | "timeout" | "exit";
const state = {
  queueMode: "ok" as QueueMode,
  queue: [] as Array<{ thread: string; home?: string; text: string }>,
  console: [] as number[],
  options: [] as Array<import("../src/inject.js").InjectOptions>,
};

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  const target = await vi.importActual<typeof import("../src/target.js")>("../src/target.js");
  const cq = await vi.importActual<typeof import("../src/codex-queue.js")>("../src/codex-queue.js");
  return {
    ...actual,
    inject: (pid: number, text: string, pane?: number, exe?: string, env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) => {
      if (options) state.options.push(options);
      return actual.inject(pid, text, pane, exe, env, {
        codexQueue: async (thread, t, home) => {
          state.queue.push({ thread, home, text: t });
          const m = state.queueMode;
          const stderr = m === "unknown-thread"
            ? `Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id ${thread} (code -32603)\n`
            : "Error: boom\n";
          const run = m === "ok" ? { kind: "exit" as const, code: 0, stdout: "", stderr: "" }
            : m === "enoent" ? { kind: "not-started" as const, code: "ENOENT" }
            : m === "timeout" ? { kind: "timeout" as const }
            : { kind: "exit" as const, code: 1, stdout: "", stderr };
          const err = cq.classifyCodexQueue(run, thread);
          if (err) throw err;
        },
        orca: async () => { throw new Error("orca must not be tried"); },
        wezterm: async () => { throw new Error("no wezterm"); },
        windows: async (p) => { state.console.push(p); },
        unix: async (p) => { state.console.push(p); },
        platform: "linux",
        // Never the host's real target lookup (commit 50cf861).
        classify: async () => target.CODEX_PLAN,
      }, options);
    },
  };
});

import { ChatRoom, terminalKeys, wakeFailureLine } from "../src/room.js";

const THREAD = "01a0e156-de0a-7bb0-909e-32d39d9b172f";
const THREAD2 = "0199aa11-2222-7333-8444-555566667777";
const HOME = "C:\\Users\\x\\AppData\\Roaming\\orca\\codex-runtime-home\\home";
const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle(rounds = 40): Promise<void> { for (let i = 0; i < rounds; i++) await tick(); }

describe("a room wakes a member with a codexThread through codex queue", () => {
  let logs: string[];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.queueMode = "ok"; state.queue = []; state.console = []; state.options = [];
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function room(): ChatRoom {
    const r = new ChatRoom();
    let t = Date.now();
    r.submitCheckOptions = { sessionsDirs: [join(tmpdir(), `joind-no-store-${process.pid}`)], now: () => t, sleep: async (ms) => { t += ms; await tick(); } };
    return r;
  }
  async function mention(r: ChatRoom, text = "@Data ping"): Promise<void> {
    r.send("Rami", text);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle(200);
  }
  const systemLines = (r: ChatRoom) => r.read(undefined, 100).filter((m) => m.sender === "system").map((m) => m.text);
  const verifyLogs = () => logs.filter((l) => /\[verify\]/.test(l));

  it("accepted: queued once with thread and home, no keys, no submit check, nothing said", async () => {
    const r = room();
    r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD, HOME);
    try {
      await mention(r);
      expect(state.queue).toHaveLength(1);
      expect(state.queue[0]).toMatchObject({ thread: THREAD, home: HOME });
      expect(state.queue[0].text).toContain("@Data mentioned by Rami");
      expect(state.console).toEqual([]);
      expect(verifyLogs()).toEqual([]);
      expect(systemLines(r).filter((l) => !/joined the chat/.test(l))).toEqual([]);
    } finally {
      r.destroy();
    }
  });

  it("ENOENT: the keystroke fallback types into the pid, and that keystroke wake is submit-checked", async () => {
    state.queueMode = "enoent";
    const r = room();
    r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD);
    try {
      await mention(r);
      expect(state.queue).toHaveLength(1);
      expect(state.console).toEqual([4242]);
      for (let i = 0; i < 2000 && verifyLogs().length === 0; i++) await tick();
      expect(verifyLogs().some((l) => /\[verify\] Data: not verifiable/.test(l))).toBe(true);
      expect(systemLines(r).some((l) => /Could not wake|did not confirm/.test(l))).toBe(false);
    } finally {
      r.destroy();
    }
  });

  it("unknown thread (the observed answer): falls back to keys as well", async () => {
    state.queueMode = "unknown-thread";
    const r = room();
    r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD);
    try {
      await mention(r);
      expect(state.console).toEqual([4242]);
    } finally {
      r.destroy();
    }
  });

  it("timeout: one honest unconfirmed line, no keys, no retry, no submit check", async () => {
    state.queueMode = "timeout";
    const r = room();
    r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD);
    try {
      await mention(r);
      expect(state.queue).toHaveLength(1);
      expect(state.console).toEqual([]);
      expect(verifyLogs()).toEqual([]);
      const said = systemLines(r).filter((l) => /did not confirm/.test(l));
      expect(said).toEqual([
        "Codex did not confirm the queued prompt for Data within 20 s; not retried by keystrokes to avoid a double prompt. The prompt may or may not have arrived; Data will see this on their next read.",
      ]);
      // The thread id stays off room lines.
      expect(systemLines(r).some((l) => l.includes(THREAD))).toBe(false);
    } finally {
      r.destroy();
    }
  });

  it("a generic nonzero exit: unconfirmed too, without naming a limit", async () => {
    state.queueMode = "exit";
    const r = room();
    r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD);
    try {
      await mention(r);
      expect(state.console).toEqual([]);
      expect(systemLines(r).filter((l) => /did not confirm/.test(l))).toEqual([
        "Codex did not confirm the queued prompt for Data; not retried by keystrokes to avoid a double prompt. The prompt may or may not have arrived; Data will see this on their next read.",
      ]);
    } finally {
      r.destroy();
    }
  });

  it("thread-only member (Codex Desktop, no pid) with an unknown thread: one no-console line, no thread in it", async () => {
    state.queueMode = "unknown-thread";
    const r = room();
    r.join("Data", 0, undefined, undefined, undefined, undefined, "reg-1", THREAD);
    try {
      await mention(r);
      await mention(r, "@Data again");
      expect(state.console).toEqual([]);
      const said = systemLines(r).filter((l) => /Could not wake/.test(l));
      expect(said).toEqual([
        "Could not wake Data: their Codex session could not be reached from this server (codex queue unavailable: the thread has no rollout in this Codex home (exit 1)) and no terminal is known for them. They will see mentions only when they read on their own schedule, or after rejoining with a live codexThread.",
      ]);
      expect(said[0]).not.toContain(THREAD);
    } finally {
      r.destroy();
    }
  });

  it("the queue guard the room hands inject(): a rejoin that changes or drops the thread, a new registration, or a departure stops the queue", async () => {
    const r = room();
    r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD, HOME);
    try {
      await mention(r);
      const guard = state.options[0].queueGuard!;
      expect(guard()).toBe("proceed");
      r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-2", THREAD, HOME);
      expect(guard()).toBe("moved"); // a new registration
      r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD, HOME);
      expect(guard()).toBe("proceed");
      r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD2, HOME);
      expect(guard()).toBe("moved"); // another thread
      r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD, undefined);
      expect(guard()).toBe("moved"); // another home
      r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", null);
      expect(guard()).toBe("moved"); // the thread dropped
      r.leave("Data");
      expect(guard()).toBe("skip");
    } finally {
      r.destroy();
    }
  });

  it("a hosted wake runs the queue on the host, with the thread from the host's own registration", async () => {
    vi.useRealTimers();
    const r = room();
    r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-local", THREAD, HOME);
    try {
      const ok = await r.wakeForPeer("Rami", "Data", "reg-local", `"ops" on y530`);
      expect(ok).toEqual({ ok: true, attempts: 1 });
      expect(state.queue).toEqual([expect.objectContaining({ thread: THREAD, home: HOME })]);
      expect(state.console).toEqual([]);
      state.queueMode = "timeout";
      const bad = await r.wakeForPeer("Rami", "Data", "reg-local", `"ops" on y530`);
      expect(bad).toMatchObject({ ok: false, kind: "unconfirmed", attempts: 1, warn: true });
      expect(state.console).toEqual([]);
      // The home words it from the host's answer.
      expect(wakeFailureLine("Data", bad.kind, bad.reason, "y530")).toBe(
        "Codex did not confirm the queued prompt for Data on their host y530 within 20 s; not retried by keystrokes to avoid a double prompt. The prompt may or may not have arrived; Data will see this on their next read.",
      );
    } finally {
      r.destroy();
    }
  });
});

describe("registration: the thread is part of the member and of its terminal identity", () => {
  beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("shown by who(), never in a room line; a key of its own", () => {
    const r = new ChatRoom();
    try {
      r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD, HOME);
      expect(r.who().find((a) => a.name === "Data")).toMatchObject({ codexThread: THREAD, codexHome: HOME });
      expect(r.read(undefined, 50).some((m) => m.text.includes(THREAD))).toBe(false);
      expect(terminalKeys({ pid: 4242, codexThread: THREAD })).toEqual(["pid:4242", `codex:${THREAD}`]);
      expect(terminalKeys({ pid: 0, codexThread: THREAD })).toEqual([`codex:${THREAD}`]);
    } finally {
      r.destroy();
    }
  });

  it("a rejoin keeps the thread only for the same pid; null clears; another thread is a new session", () => {
    const r = new ChatRoom();
    try {
      r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD, HOME);
      r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1");
      expect(r.getAgent("Data")).toMatchObject({ codexThread: THREAD, codexHome: HOME });
      r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD2);
      expect(r.getAgent("Data")!.codexThread).toBe(THREAD2);
      expect(r.getAgent("Data")!.codexHome).toBeUndefined();
      expect(r.read(undefined, 50).filter((m) => /rejoined \(new session\)/.test(m.text))).toHaveLength(1);
      r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", null);
      expect(r.getAgent("Data")!.codexThread).toBeUndefined();
      r.join("Data", 4242, undefined, undefined, undefined, undefined, "reg-1", THREAD);
      r.join("Data", 5151, undefined, undefined, undefined, undefined, "reg-1");
      expect(r.getAgent("Data")!.codexThread).toBeUndefined();
    } finally {
      r.destroy();
    }
  });
});

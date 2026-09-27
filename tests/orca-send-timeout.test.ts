import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Field log, 27 Sep 2026: `orca terminal send` delivered the prompt but did
// not exit within its 15 s limit; the server called that a failure, typed
// the same prompt again through the console of the same pid, and the agent
// submitted it twice. These tests drive the real runOrca, injectOrca,
// inject() and the room's wake path, with a fake child process in place of
// orca.exe (the suite never starts a real Orca) and a recording console.

type Mode = "ok" | "killed-after-start" | "killed-before-start" | "no-json" | "empty-object" | "error-after-start" | "error-before-start" | "ambiguous";
const state = { mode: "ok" as Mode, orcaArgs: [] as string[][], console: [] as number[], onSend: null as null | ((n: number) => void) };

/** A child process that behaves like orca.exe under the spawn timeout. */
function fakeProc(mode: Mode) {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const emit = (ev: string, ...a: unknown[]) => { for (const h of handlers[ev] ?? []) h(...a); };
  const out = { on: (_ev: string, l: (c: string) => void) => { (handlers["out:data"] ??= []).push(l as (...a: unknown[]) => void); } };
  const err = { on: (_ev: string, _l: (c: string) => void) => undefined };
  setImmediate(() => {
    if (mode === "error-before-start") {
      emit("error", Object.assign(new Error("spawn EPERM"), { code: "EPERM" }));
      return;
    }
    if (mode !== "killed-before-start") emit("spawn");
    if (mode === "ok") {
      for (const h of handlers["out:data"] ?? []) h(JSON.stringify({ ok: true, result: { send: { accepted: true } } }));
      emit("close", 0, null);
    } else if (mode === "no-json") {
      for (const h of handlers["out:data"] ?? []) h("{\"ok\":tr");
      emit("close", 1, null);
    } else if (mode === "ambiguous") {
      for (const h of handlers["out:data"] ?? []) h(JSON.stringify({ ok: false, error: { code: "transport_error", message: "lost", data: { orchestrationRequestId: "req_1" } } }));
      emit("close", 1, null);
    } else if (mode === "empty-object") {
      for (const h of handlers["out:data"] ?? []) h("{}");
      emit("close", 0, null);
    } else if (mode === "error-after-start") {
      emit("error", Object.assign(new Error("read EPERM"), { code: "EPERM" }));
    } else {
      // Node's spawn timeout: SIGTERM, the process exits, then its streams close.
      emit("exit", null, "SIGTERM");
      emit("close", null, "SIGTERM");
    }
  });
  return {
    stdout: out,
    stderr: err,
    on: (ev: string, l: (...a: unknown[]) => void) => { (handlers[ev] ??= []).push(l); },
  };
}

/** A clock that has moved past the send limit by the time the process ends. */
function limitClock(): () => number {
  let calls = 0;
  return () => (calls++ === 0 ? 0 : 15000);
}

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  const orcaMod = await vi.importActual<typeof import("../src/orca.js")>("../src/orca.js");
  const { DEFAULT_PLAN } = await vi.importActual<typeof import("../src/target.js")>("../src/target.js");
  const spawnFake: import("../src/orca.js").SpawnOrca = (_exe, args) => {
    state.orcaArgs.push(args);
    state.onSend?.(state.orcaArgs.length);
    return fakeProc(state.mode) as unknown as import("../src/orca.js").OrcaProcess;
  };
  return {
    ...actual,
    inject: (pid: number, text: string, pane?: number, exe?: string, env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) =>
      actual.inject(pid, text, pane, exe, env, {
        orca: (handle, t, o) => orcaMod.injectOrca(handle, t, { ...o, run: (args, ms) => orcaMod.runOrca(args, ms, { spawnFn: spawnFake, now: limitClock() }) }),
        wezterm: async () => { throw new Error("wezterm must not be tried for an Orca agent"); },
        windows: async (p) => { state.console.push(p); },
        unix: async (p) => { state.console.push(p); },
        platform: "linux",
        classify: async () => DEFAULT_PLAN,
      }, options),
  };
});

import { ChatRoom, wakeFailureLine } from "../src/room.js";
import { WakeFallbackAborted, type InjectBackends } from "../src/inject.js";
const { inject } = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
import {
  runOrca, injectOrca, OrcaRunError, UnconfirmedDeliveryError, OrcaCliUnavailable, ORCA_SEND_TIMEOUT_MS,
  type OrcaResult, type OrcaEnvelope, type SpawnOrca, type OrcaProcess,
} from "../src/orca.js";
import { classifyWakeFailure, WakeCoordinator } from "../src/wake.js";

const H = "term_a0072f57-0000-4000-8000-000000000001";
const PID = 150184;
const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle(rounds = 30): Promise<void> { for (let i = 0; i < rounds; i++) await tick(); }
const DASHES = /[\u2013\u2014]/;

function spawnOf(mode: Mode): SpawnOrca {
  return () => fakeProc(mode) as unknown as OrcaProcess;
}
const res = (json: OrcaEnvelope): OrcaResult => ({ json, code: json.ok ? 0 : 1, stdout: JSON.stringify(json), stderr: "" });
const accepted: OrcaEnvelope = { ok: true, result: { send: { accepted: true } } };
const ambiguous: OrcaEnvelope = { ok: false, error: { code: "transport_error", message: "lost", data: { orchestrationRequestId: "req_1" } } };
const timedOutKill = () => new OrcaRunError("orca terminal send killed (SIGTERM) after 15000ms", true, "SIGTERM", true);

describe("runOrca: how a send ended, and whether it had started", () => {
  it("killed at the limit after the process started: started, timedOut, same message as before", async () => {
    const err = await runOrca(["terminal", "send"], 15000, { spawnFn: spawnOf("killed-after-start"), now: limitClock() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrcaRunError);
    expect(err).toMatchObject({ started: true, timedOut: true, signal: "SIGTERM" });
    expect((err as OrcaRunError).message).toBe("orca terminal send killed (SIGTERM) after 15000ms");
  });

  it("killed early by a signal: not a timeout, and the message says so", async () => {
    const err = await runOrca(["terminal", "send"], 15000, { spawnFn: spawnOf("killed-after-start"), now: () => 0 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ started: true, timedOut: false });
    expect((err as OrcaRunError).message).toMatch(/before its 15000ms limit/);
  });

  it("an early kill whose streams close only later is still not a timeout (timed at exit, not at close)", async () => {
    const times = [0, 20, 16000];
    let i = 0;
    const now = () => times[Math.min(i++, times.length - 1)];
    const err = await runOrca(["terminal", "send"], 15000, { spawnFn: spawnOf("killed-after-start"), now }).catch((e: unknown) => e);
    expect(err).toMatchObject({ started: true, timedOut: false });
    expect((err as OrcaRunError).message).toMatch(/after 20ms, before its 15000ms limit/);
  });

  it("killed before the process ever ran: started=false", async () => {
    const err = await runOrca(["terminal", "send"], 15000, { spawnFn: spawnOf("killed-before-start"), now: limitClock() }).catch((e: unknown) => e);
    expect(err).toMatchObject({ started: false });
  });

  it("a process error records whether the process had started", async () => {
    const after = await runOrca(["terminal", "send"], 15000, { spawnFn: spawnOf("error-after-start") }).catch((e: unknown) => e);
    expect(after).toMatchObject({ started: true, timedOut: false });
    const before = await runOrca(["terminal", "send"], 15000, { spawnFn: spawnOf("error-before-start") }).catch((e: unknown) => e);
    expect(before).toMatchObject({ started: false });
  });

  it("the send limit is the one constant the room line quotes", () => {
    expect(ORCA_SEND_TIMEOUT_MS).toBe(15000);
    expect(wakeFailureLine("Scotty", "unconfirmed", "orca terminal term_x: the send timed out without confirming delivery within 15 s")).toMatch(/within 15 s/);
  });
});

describe("injectOrca: a started send that did not answer is unconfirmed", () => {
  let logs: string[];
  beforeEach(() => { logs = []; vi.spyOn(console, "log").mockImplementation((l: unknown) => { logs.push(String(l)); }); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("a timeout: UnconfirmedDeliveryError (kind unconfirmed), one call, the classification logged, never the text", async () => {
    const run = vi.fn(async (): Promise<OrcaResult> => { throw timedOutKill(); });
    const err = await injectOrca(H, "SECRET PROMPT TEXT", { run }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnconfirmedDeliveryError);
    expect(classifyWakeFailure(err)).toBe("unconfirmed");
    expect((err as Error).message).toMatch(/timed out/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => /classified unconfirmed/.test(l))).toBe(true);
    expect(logs.join("\n")).not.toMatch(/SECRET PROMPT TEXT/);
    expect(logs.join("\n")).not.toMatch(DASHES);
  });

  it("an early signal kill, a process error after start, and an exit with no readable JSON are unconfirmed too, and not called timeouts", async () => {
    const endings: Array<() => Promise<OrcaResult>> = [
      async () => { throw new OrcaRunError("orca terminal send killed (SIGTERM) after 20ms, before its 15000ms limit", true, "SIGTERM", false); },
      async () => { throw new OrcaRunError("orca terminal send error (EPERM) after it started", true, null, false); },
      async () => ({ json: null, code: 1, stdout: "{\"ok\":tr", stderr: "" }),
      async () => ({ json: null, code: 0, stdout: "", stderr: "" }),
      // Parseable, but not an answer: nothing in these says the text was not typed.
      async () => ({ json: {} as OrcaEnvelope, code: 0, stdout: "{}", stderr: "" }),
      async () => ({ json: [] as unknown as OrcaEnvelope, code: 0, stdout: "[]", stderr: "" }),
      async () => ({ json: true as unknown as OrcaEnvelope, code: 0, stdout: "true", stderr: "" }),
      async () => res({ ok: true }),
      async () => res({ ok: true, result: { send: {} } }),
      async () => res({ ok: false }),
      async () => res({ ok: false, error: { message: "no code" } }),
      // Well-typed envelope, malformed field that the reader consumes.
      async () => res({ ok: false, error: { code: "transport_error", message: {} as unknown as string, data: { orchestrationRequestId: "req_1" } } }),
      async () => res({ ok: false, error: { code: "transport_error", message: "lost", data: [] as unknown as { orchestrationRequestId?: string } } }),
      async () => res({ ok: false, error: { code: "transport_error", message: "lost", data: { orchestrationRequestId: 7 as unknown as string } } }),
    ];
    for (const ending of endings) {
      const err = await injectOrca(H, "x", { run: ending }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnconfirmedDeliveryError);
      expect((err as Error).message).not.toMatch(/timed out/);
      expect(wakeFailureLine("Scotty", "unconfirmed", (err as Error).message)).not.toMatch(/within 15 s/);
    }
  });

  it("a process that never started stays an ordinary (transient) error", async () => {
    const run = vi.fn(async (): Promise<OrcaResult> => { throw new OrcaRunError("orca terminal send killed (SIGTERM) after 15000ms", false, "SIGTERM", true); });
    const err = await injectOrca(H, "x", { run }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnconfirmedDeliveryError);
    expect(classifyWakeFailure(err)).toBe("transient");
  });

  it("an explicit not-accepted answer is an answer: ordinary (transient), not unconfirmed", async () => {
    const err = await injectOrca(H, "x", { run: async () => res({ ok: true, result: { send: { accepted: false } } }) }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnconfirmedDeliveryError);
    expect(classifyWakeFailure(err)).toBe("transient");
  });

  it("an answer from Orca that it took no input stays an ordinary error", async () => {
    const err = await injectOrca(H, "x", { run: async () => res({ ok: false, error: { code: "runtime_unavailable", message: "no input was sent" } }) }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnconfirmedDeliveryError);
    expect(classifyWakeFailure(err)).toBe("transient");
  });

  it("after an ambiguous first send, a re-issue that times out, cannot start, or answers anything but accepted is unconfirmed", async () => {
    const second: Array<() => Promise<OrcaResult>> = [
      async () => { throw timedOutKill(); },
      async () => { throw new OrcaCliUnavailable("orca cli unavailable: orca.exe not found"); },
      async () => { throw new OrcaRunError("orca terminal send error (EPERM) before it started", false, null, false); },
      async () => res({ ok: false, error: { code: "runtime_unavailable", message: "no input was sent" } }),
      async () => res({ ok: false, error: { code: "terminal_handle_stale", message: "gone" } }),
      async () => res({ ok: false, error: { code: "transport_error", message: {} as unknown as string, data: { orchestrationRequestId: "req_1" } } }),
      async () => res({} as OrcaEnvelope),
    ];
    for (const next of second) {
      let n = 0;
      const run = vi.fn(async (): Promise<OrcaResult> => (++n === 1 ? res(ambiguous) : next()));
      const beforeRetry = vi.fn();
      const err = await injectOrca(H, "x", { run, beforeRetry }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnconfirmedDeliveryError);
      expect(beforeRetry).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(2);
    }
  });

  it("an Orca error message that echoes the prompt never reaches the error or the logs; only a well-formed code does", async () => {
    const echo = res({ ok: false, error: { code: "runtime_unavailable", message: "could not type SECRET PROMPT TEXT" } });
    const err = await injectOrca(H, "SECRET PROMPT TEXT", { run: async () => echo }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("orca send failed (runtime_unavailable)");
    let n = 0;
    const ambiguousEcho = res({ ok: false, error: { code: "transport_error", message: "SECRET PROMPT TEXT", data: { orchestrationRequestId: "req_1" } } });
    const err2 = await injectOrca(H, "SECRET PROMPT TEXT", { run: async () => (++n === 1 ? ambiguousEcho : res({ ok: false, error: { code: "SECRET PROMPT TEXT", message: "SECRET PROMPT TEXT" } })) }).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(UnconfirmedDeliveryError);
    expect((err2 as Error).message).not.toMatch(/SECRET/);
    expect(logs.join("\n")).not.toMatch(/SECRET/);
  });

  it("the retry id is never logged; a malformed one is ambiguous with no usable id: unconfirmed, no re-issue", async () => {
    let calls = 0;
    const bad = res({ ok: false, error: { code: "transport_error", message: "x", data: { orchestrationRequestId: "SECRET PROMPT TEXT" } } });
    const err = await injectOrca(H, "p", { run: async () => { calls++; return bad; } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnconfirmedDeliveryError);
    expect(calls).toBe(1);
    let n = 0;
    const args: string[][] = [];
    await injectOrca(H, "p", { run: async (a) => { args.push(a); return ++n === 1 ? res({ ok: false, error: { code: "transport_error", data: { orchestrationRequestId: "req_good-1" } } }) : res(accepted); } });
    expect(args[1]).toContain("req_good-1");
    expect(logs.join("\n")).not.toMatch(/SECRET|req_good-1/);
  });

  it("logs one line on success", async () => {
    await injectOrca(H, "x", { run: async () => res(accepted) });
    expect(logs.filter((l) => new RegExp(`terminal=${H} accepted in \\d+ms`).test(l))).toHaveLength(1);
  });
});

describe("inject(): no console fallback after an unconfirmed Orca send", () => {
  beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  function backends(orca: NonNullable<InjectBackends["orca"]>, consoleCalls: number[]): InjectBackends {
    return {
      orca,
      wezterm: async () => { throw new Error("no wezterm"); },
      windows: async (p) => { consoleCalls.push(p); },
      unix: async (p) => { consoleCalls.push(p); },
      platform: "win32",
      classify: async () => ({ kind: "codex", delayMs: 300, doubleEnter: true }) as Awaited<ReturnType<NonNullable<InjectBackends["classify"]>>>,
    };
  }
  const orcaWith = (run: () => Promise<OrcaResult>) => (handle: string, text: string, o?: { beforeRetry?: () => void }) => injectOrca(handle, text, { ...o, run });

  it("throws the unconfirmed error without asking the fallback guard or typing into the pid", async () => {
    const consoleCalls: number[] = [];
    const fallbackGuard = vi.fn(() => "proceed" as const);
    await expect(inject(PID, "p", undefined, undefined, undefined, backends(orcaWith(async () => { throw timedOutKill(); }), consoleCalls), { orcaTerminal: H, fallbackGuard })).rejects.toBeInstanceOf(UnconfirmedDeliveryError);
    expect(consoleCalls).toEqual([]);
    expect(fallbackGuard).not.toHaveBeenCalled();
  });

  it("before anything was sent (no Orca CLI, a process that never started) the console fallback still runs", async () => {
    const thrown = [
      new OrcaCliUnavailable("orca cli unavailable: orca.exe not found"),
      new OrcaRunError("orca terminal send killed (SIGTERM) after 15000ms", false, "SIGTERM", true),
      new OrcaRunError("orca terminal send error (EPERM) before it started", false, null, false),
    ];
    for (const t of thrown) {
      const consoleCalls: number[] = [];
      await inject(PID, "p", undefined, undefined, undefined, backends(orcaWith(async () => { throw t; }), consoleCalls), { orcaTerminal: H, fallbackGuard: () => "proceed" });
      expect(consoleCalls).toEqual([PID]);
    }
  });

  it("the re-issue after an ambiguous send asks the post-text guard: lock growth on the same terminal proceeds with the retry id, no fresh wake", async () => {
    const consoleCalls: number[] = [];
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<OrcaResult> => { calls.push(args); return res(calls.length === 1 ? ambiguous : accepted); };
    await inject(PID, "p", undefined, undefined, undefined, backends((h, t, o) => injectOrca(h, t, { ...o, run }), consoleCalls), {
      orcaTerminal: H,
      // The pre-type guard would say "moved" (a registration added a lock key)...
      fallbackGuard: () => "moved",
      // ...but the terminal holding the prompt is the same one.
      afterTextGuard: () => "proceed",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("req_1");
    expect(consoleCalls).toEqual([]);
  });

  it("the post-text guard is told the route: \"orca\" before the re-issue", async () => {
    const routes: string[] = [];
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<OrcaResult> => { calls.push(args); return res(calls.length === 1 ? ambiguous : accepted); };
    await inject(PID, "p", undefined, undefined, undefined, backends((h, t, o) => injectOrca(h, t, { ...o, run }), []), {
      orcaTerminal: H, fallbackGuard: () => "proceed", afterTextGuard: (route) => { routes.push(route); return "proceed"; },
    });
    expect(routes).toEqual(["orca"]);
  });

  it("the re-issue is stopped (no retry, no console) when the post-text guard says the agent moved to a different terminal", async () => {
    const consoleCalls: number[] = [];
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<OrcaResult> => { calls.push(args); return res(ambiguous); };
    const done = inject(PID, "p", undefined, undefined, undefined, backends((h, t, o) => injectOrca(h, t, { ...o, run }), consoleCalls), {
      orcaTerminal: H, fallbackGuard: () => "proceed", afterTextGuard: () => "moved",
    });
    await expect(done).rejects.toBeInstanceOf(WakeFallbackAborted);
    expect(calls).toHaveLength(1);
    expect(consoleCalls).toEqual([]);
  });
});

describe("WakeCoordinator: unconfirmed is never retried and always said", () => {
  it("one attempt, warn every time, kind unconfirmed", async () => {
    const wakes = new WakeCoordinator({ retryDelayMs: 0, sleep: async () => undefined });
    for (let round = 0; round < 2; round++) {
      let calls = 0;
      const out = await wakes.run(["pid:1"], "room:Scotty", async () => { calls++; throw new UnconfirmedDeliveryError("unconfirmed"); });
      expect(calls).toBe(1);
      expect(out).toMatchObject({ ok: false, kind: "unconfirmed", attempts: 1, warn: true });
    }
  });

  it("the room line is honest, names the host when hosted, and carries no dashes", () => {
    const reason = "orca terminal term_x: the send timed out without confirming delivery within 15 s (orca terminal send killed (SIGTERM) after 15000ms)";
    const local = wakeFailureLine("Scotty", "unconfirmed", reason);
    expect(local).toMatch(/^Orca did not confirm delivery to Scotty within 15 s; not retried through the console to avoid a double prompt\./);
    const hosted = wakeFailureLine("Scotty", "unconfirmed", reason, "ramiy530");
    expect(hosted).toMatch(/to Scotty on their host ramiy530 within 15 s/);
    expect(wakeFailureLine("Scotty", "unconfirmed", undefined)).toMatch(/^Orca did not confirm delivery to Scotty; not retried/);
    expect(local + hosted).not.toMatch(DASHES);
  });
});

describe("room: the 27 Sep double delivery (real runOrca, fake orca.exe)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.mode = "ok"; state.orcaArgs = []; state.console = [];
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function mention(room: ChatRoom, name: string): Promise<void> {
    room.send("Rami", `@${name} ping`);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    // Past the coordinator's retry delay and any settle delay: nothing more may happen.
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
  }
  function roomWith(name: string, pid: number): ChatRoom {
    const room = new ChatRoom();
    room.join(name, pid, undefined, undefined, H);
    return room;
  }

  it("a send killed at the limit after it started: one Orca send, no console injection, no retry, one honest line", async () => {
    state.mode = "killed-after-start";
    const room = roomWith("Scotty", PID);
    try {
      await mention(room, "Scotty");
      expect(state.orcaArgs).toHaveLength(1);
      expect(state.console).toEqual([]);
      const lines = room.read(undefined, 50).filter((m) => /Orca did not confirm delivery to Scotty within 15 s; not retried through the console to avoid a double prompt/.test(m.text));
      expect(lines).toHaveLength(1);
      expect(room.read(undefined, 50).some((m) => /Could not wake Scotty/.test(m.text))).toBe(false);
    } finally {
      room.destroy();
    }
  });

  it("a second mention after an unconfirmed one gets its own line (never folded into a cooldown)", async () => {
    state.mode = "killed-after-start";
    const room = roomWith("Scotty", PID);
    try {
      await mention(room, "Scotty");
      await mention(room, "Scotty");
      expect(state.orcaArgs).toHaveLength(2);
      expect(state.console).toEqual([]);
      expect(room.read(undefined, 50).filter((m) => /^Orca did not confirm delivery to Scotty/.test(m.text))).toHaveLength(2);
    } finally {
      room.destroy();
    }
  });

  it("a started send that exits with no readable answer, or errors after start: no console, one line without a 15 s claim", async () => {
    for (const mode of ["no-json", "empty-object", "error-after-start"] as const) {
      state.mode = mode; state.orcaArgs = []; state.console = [];
      const room = roomWith("Scotty", PID);
      try {
        await mention(room, "Scotty");
        expect(state.orcaArgs).toHaveLength(1);
        expect(state.console).toEqual([]);
        const lines = room.read(undefined, 50).filter((m) => /^Orca did not confirm delivery to Scotty; not retried/.test(m.text));
        expect(lines).toHaveLength(1);
      } finally {
        room.destroy();
      }
    }
  });

  it("a send that never started keeps today's behaviour: console fallback into the live pid", async () => {
    for (const mode of ["killed-before-start", "error-before-start"] as const) {
      state.mode = mode; state.orcaArgs = []; state.console = [];
      const room = roomWith("Scotty", PID);
      try {
        await mention(room, "Scotty");
        expect(state.orcaArgs).toHaveLength(1);
        expect(state.console).toEqual([PID]);
        expect(room.read(undefined, 50).some((m) => /Orca did not confirm/.test(m.text))).toBe(false);
      } finally {
        room.destroy();
      }
    }
  });

  it("an ambiguous Orca answer, then a registration change to the same terminal: no re-issue, no console, the unconfirmed line (not \"in their input box\")", async () => {
    state.mode = "ambiguous";
    const room = roomWith("Scotty", PID);
    // While the first send runs, Scotty re-registers the same pid with a pane:
    // a new identity, the same terminal.
    state.onSend = (n) => { if (n === 1) room.join("Scotty", PID, 7, undefined, H, 4242); };
    try {
      await mention(room, "Scotty");
      expect(state.orcaArgs).toHaveLength(1);
      expect(state.console).toEqual([]);
      const texts = room.read(undefined, 50).map((m) => m.text);
      expect(texts.filter((t) => /^Orca did not confirm delivery to Scotty; not retried/.test(t))).toHaveLength(1);
      expect(texts.some((t) => /in their input box/.test(t))).toBe(false);
    } finally {
      state.onSend = null;
      room.destroy();
    }
  });

  it("a send that answers in time is a plain delivery: no fallback, no line", async () => {
    const room = roomWith("Scotty", PID);
    try {
      await mention(room, "Scotty");
      expect(state.orcaArgs).toHaveLength(1);
      expect(state.console).toEqual([]);
      expect(room.read(undefined, 50).some((m) => /Orca did not confirm|Could not wake/.test(m.text))).toBe(false);
    } finally {
      room.destroy();
    }
  });
});

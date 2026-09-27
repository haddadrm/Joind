import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyTarget, resetTargetCache, CommandLineBatcher, makeBatchRunner, powerShellCandidates, parseCimLines, parsePsLines, cimCommand,
  LookupFailed, LOOKUP_TIMEOUT_MS, LOOKUP_WAIT_LIMIT_MS, CODEX_PLAN, DEFAULT_PLAN, UNKNOWN_PLAN,
  type BatchRunner, type ExecLookup,
} from "../src/target.js";
import { inject, type InjectBackends } from "../src/inject.js";

// Field log, Y530, 27 Sep 2026 (UTC). One Codex TUI pid was classified
// "codex" alone (2.6 to 2.8 s per lookup), but two wakes 0.7 s apart each
// started their own cold Windows PowerShell; both lookups ran past the 4 s
// limit, both fell back to the single-Enter default, and both prompts sat
// unsubmitted in the input box. These tests never start a real shell.

const CODEX = "node C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";

describe("a lookup that did not answer is the unknown plan, a confident one decides", () => {
  beforeEach(() => resetTargetCache());

  it("a timed-out lookup: UNKNOWN_PLAN (300 ms, one Enter, never a blind second one), and the log says so", async () => {
    const lines: string[] = [];
    let t = 0;
    const plan = await classifyTarget(150184, "win32", {
      read: async () => { t = 10000; throw new LookupFailed("pwsh did not answer within 10000 ms", "timeout"); },
      now: () => t,
      log: (l) => lines.push(l),
    });
    expect(plan).toMatchObject(UNKNOWN_PLAN);
    expect(plan).toMatchObject({ doubleEnter: false, delayMs: 300 });
    expect(lines).toEqual(["  [target] pid=150184 target lookup timed out after 10000 ms; target unidentified; pressing Enter once (a Codex or Copilot session may need Enter by hand)"]);
  });

  it("an errored lookup and a hidden command line are the unknown plan too", async () => {
    const lines: string[] = [];
    expect(await classifyTarget(1, "win32", { read: async () => { throw new LookupFailed("pwsh exited 1", "error"); }, log: (l) => lines.push(l) })).toMatchObject(UNKNOWN_PLAN);
    expect(await classifyTarget(2, "win32", { read: async () => { throw new LookupFailed("hidden", "hidden"); }, log: (l) => lines.push(l) })).toMatchObject(UNKNOWN_PLAN);
    expect(lines[0]).toMatch(/pid=1 target lookup failed after \d+ ms \(pwsh exited 1\); target unidentified; pressing Enter once/);
    expect(lines[1]).toMatch(/pid=2 target lookup could not see the command line/);
  });

  it("a confident non-target answer is still the single-Enter default, logged with its duration", async () => {
    const lines: string[] = [];
    let t = 0;
    const plan = await classifyTarget(7, "win32", { read: async () => { t = 231; return "\"C:\\Users\\u\\.local\\bin\\claude.exe\" --resume"; }, now: () => t, log: (l) => lines.push(l) });
    expect(plan).toEqual(DEFAULT_PLAN);
    expect(lines).toEqual(["  [target] pid=7 lookup 231 ms via reader: default"]);
    expect(await classifyTarget(8, "win32", { read: async () => "pwsh.exe -NoLogo", log: () => undefined })).toEqual(DEFAULT_PLAN);
    // No such process: an answer, not a failure.
    expect(await classifyTarget(9, "win32", { read: async () => null, log: () => undefined })).toEqual(DEFAULT_PLAN);
  });

  it("the budget is ten seconds per shell start, with a bound on the whole wait", () => {
    expect(LOOKUP_TIMEOUT_MS).toBe(10000);
    expect(LOOKUP_WAIT_LIMIT_MS).toBeGreaterThan(2 * LOOKUP_TIMEOUT_MS);
  });

  it("a read that never settles is the unknown plan once the wait limit passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const lines: string[] = [];
      const p = classifyTarget(3, "win32", { read: () => new Promise<string | null>(() => undefined), log: (l) => lines.push(l) });
      await vi.advanceTimersByTimeAsync(LOOKUP_WAIT_LIMIT_MS);
      expect(await p).toMatchObject(UNKNOWN_PLAN);
      expect(lines[0]).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("coalesced lookups: N simultaneous wakes cost one shell start", () => {
  beforeEach(() => resetTargetCache());

  function recordingRunner(answer: (pid: number) => string | null | undefined) {
    const calls: number[][] = [];
    const gates: Array<() => void> = [];
    const run: BatchRunner = (pids) => {
      calls.push([...pids]);
      return new Promise((resolve) => {
        gates.push(() => resolve({ lines: new Map(pids.map((p) => [p, answer(p)])), via: "pwsh" }));
      });
    };
    return { run, calls, open: () => { for (const g of gates.splice(0)) g(); } };
  }
  const tick = () => new Promise<void>((r) => setImmediate(r));

  it("the field case: two wakes at once share one query, and both get the Codex plan", async () => {
    const r = recordingRunner(() => CODEX);
    const batcher = new CommandLineBatcher(r.run, "win32");
    const lines: string[] = [];
    const a = classifyTarget(30448, "win32", { batcher, log: (l) => lines.push(l) });
    const b = classifyTarget(23072, "win32", { batcher, log: (l) => lines.push(l) });
    await tick();
    r.open();
    expect(await a).toEqual(CODEX_PLAN);
    expect(await b).toEqual(CODEX_PLAN);
    expect(r.calls).toEqual([[30448, 23072]]);
    expect(lines.every((l) => /via pwsh, one query for 2 pids: codex$/.test(l))).toBe(true);
  });

  it("a read asked for while a query runs waits for the next one (never answered by a query that began before it)", async () => {
    const r = recordingRunner(() => CODEX);
    const batcher = new CommandLineBatcher(r.run, "win32");
    const first = batcher.read(1);
    await tick();
    expect(r.calls).toEqual([[1]]);
    const second = batcher.read(1);
    const third = batcher.read(2);
    await tick();
    expect(r.calls).toEqual([[1]]); // still one query running
    r.open();
    await first;
    await tick();
    expect(r.calls).toEqual([[1], [1, 2]]);
    r.open();
    expect((await second).line).toBe(CODEX);
    expect((await third).batch).toBe(2);
  });

  it("a failed query fails every read in it, and the next query still runs", async () => {
    let n = 0;
    const run: BatchRunner = async (pids) => {
      n++;
      if (n === 1) throw new LookupFailed("pwsh did not answer within 10000 ms", "timeout");
      return { lines: new Map(pids.map((p) => [p, null])), via: "pwsh" };
    };
    const batcher = new CommandLineBatcher(run, "win32");
    const [a, b] = [batcher.read(1), batcher.read(2)];
    await expect(a).rejects.toMatchObject({ reason: "timeout" });
    await expect(b).rejects.toMatchObject({ reason: "timeout" });
    expect((await batcher.read(3)).line).toBeNull();
  });

  it("a process listed without a readable command line is a hidden (failed) read, not an answer", async () => {
    const r = recordingRunner((p) => (p === 1 ? undefined : null));
    const batcher = new CommandLineBatcher(r.run, "win32");
    const hidden = batcher.read(1);
    const gone = batcher.read(2);
    await tick();
    r.open();
    await expect(hidden).rejects.toMatchObject({ reason: "hidden" });
    expect((await gone).line).toBeNull();
  });
});

describe("the shell: pwsh preferred, Windows PowerShell as the fallback", () => {
  beforeEach(() => resetTargetCache());

  it("pwsh on PATH first, else its default install folder, always ending with powershell", () => {
    const has = (set: string[]) => (p: string) => set.includes(p.replace(/\\/g, "/"));
    expect(powerShellCandidates({ PATH: "C:/a;C:/tools/ps7" }, has(["C:/tools/ps7/pwsh.exe"]))[0].replace(/\\/g, "/")).toBe("C:/tools/ps7/pwsh.exe");
    expect(powerShellCandidates({ PATH: "C:/a", ProgramFiles: "C:/PF" }, has(["C:/PF/PowerShell/7/pwsh.exe"])).map((p) => p.replace(/\\/g, "/"))).toEqual(["C:/PF/PowerShell/7/pwsh.exe", "powershell"]);
    expect(powerShellCandidates({ PATH: "C:/a" }, has([]))).toEqual(["powershell"]);
  });

  it("a missing pwsh falls back to powershell once and remembers it; one query names every pid", async () => {
    const tried: string[] = [];
    const commands: string[] = [];
    const exec: ExecLookup = async (cmd, args) => {
      tried.push(cmd);
      if (cmd === "pwsh.exe") return { stdout: "", exitCode: -1, missing: true };
      commands.push(args[args.length - 1]);
      return { stdout: JSON.stringify([{ p: 11, c: CODEX }]), exitCode: 0 };
    };
    const run = makeBatchRunner({ exec, candidates: () => ["pwsh.exe", "powershell"] });
    const r1 = await run([11, 12], "win32");
    expect(r1.via).toBe("powershell");
    expect(r1.lines.get(11)).toBe(CODEX);
    expect(r1.lines.get(12)).toBeNull();
    expect(commands[0]).toMatch(/ProcessId=11 OR ProcessId=12/);
    await run([11], "win32");
    expect(tried).toEqual(["pwsh.exe", "powershell", "powershell"]);
  });

  it("a pwsh that times out is a failed read, not a second shell start", async () => {
    const tried: string[] = [];
    const exec: ExecLookup = async (cmd) => { tried.push(cmd); throw new LookupFailed(`${cmd} did not answer within 10000 ms`, "timeout"); };
    const run = makeBatchRunner({ exec, candidates: () => ["pwsh.exe", "powershell"] });
    await expect(run([1], "win32")).rejects.toMatchObject({ reason: "timeout" });
    expect(tried).toEqual(["pwsh.exe"]);
  });

  it("parses the CIM JSON (one object or an array) and ps output; unreadable CIM output is an error", () => {
    expect(parseCimLines("{\"p\":5,\"c\":\"codex.exe\"}", [5]).get(5)).toBe("codex.exe");
    const m = parseCimLines("[{\"p\":5,\"c\":null},{\"p\":6,\"c\":\"x\"}]", [5, 6, 7]);
    expect([m.get(5), m.get(6), m.get(7)]).toEqual([undefined, "x", null]);
    expect(() => parseCimLines("not json", [5])).toThrow(LookupFailed);
    const ps = parsePsLines("  5 node /x/codex.js --a\n 6 bash\n", [5, 6, 7]);
    expect([ps.get(5), ps.get(6), ps.get(7)]).toEqual(["node /x/codex.js --a", "bash", null]);
  });

  it("ps selecting no process (exit 1, no output) is an answer: none of them exist", async () => {
    const run = makeBatchRunner({ exec: async () => ({ stdout: "", exitCode: 1 }) });
    const r = await run([4, 5], "linux");
    expect([r.lines.get(4), r.lines.get(5)]).toEqual([null, null]);
  });
});

describe("gate round 5: a query that did not answer never reads as \"no such process\"", () => {
  beforeEach(() => resetTargetCache());
  const win = (r: Awaited<ReturnType<ExecLookup>>) => makeBatchRunner({ exec: async () => r, candidates: () => ["pwsh.exe"] });

  it("the CIM query makes every error terminating", () => {
    expect(cimCommand([5, 6])).toMatch(/^\$ErrorActionPreference='Stop'; /);
    expect(cimCommand([5, 6])).toMatch(/ProcessId=5 OR ProcessId=6/);
  });

  it("access denied (stderr, even with exit 0 and []), a nonzero exit, empty output, {} and malformed rows are failed reads", async () => {
    const failing: Array<Awaited<ReturnType<ExecLookup>>> = [
      { stdout: "[]", stderr: "Get-CimInstance: Access denied", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 1 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "{}", stderr: "", exitCode: 0 },
      { stdout: "[{\"p\":\"5\",\"c\":\"x\"}]", stderr: "", exitCode: 0 },
      { stdout: "[{\"p\":5,\"c\":7}]", stderr: "", exitCode: 0 },
      { stdout: "[[1]]", stderr: "", exitCode: 0 },
    ];
    for (const r of failing) await expect(win(r)([5], "win32")).rejects.toMatchObject({ reason: "error" });
    // Through classifyTarget: the unknown plan, not the default.
    const batcher = new CommandLineBatcher(win(failing[0]), "win32");
    expect(await classifyTarget(5, "win32", { batcher, log: () => undefined })).toMatchObject(UNKNOWN_PLAN);
    // An answered empty list is an answer: no such process.
    expect((await win({ stdout: "[]", stderr: "", exitCode: 0 })([5], "win32")).lines.get(5)).toBeNull();
  });

  it("ps: only a silent exit 1 means none exist; other codes and diagnostics are failed reads", async () => {
    const unix = (r: Awaited<ReturnType<ExecLookup>>) => makeBatchRunner({ exec: async () => r });
    expect((await unix({ stdout: "", stderr: "", exitCode: 1 })([4], "linux")).lines.get(4)).toBeNull();
    for (const r of [
      { stdout: "", stderr: "", exitCode: 2 },
      { stdout: "", stderr: "", exitCode: 127 },
      { stdout: "", stderr: "ps: unknown option -- o", exitCode: 1 },
    ]) {
      await expect(unix(r)([4], "linux")).rejects.toMatchObject({ reason: "error" });
    }
  });
});

describe("gate round 6: a ps diagnostic fails the read whatever the exit code", () => {
  it("exit 0 with stderr, empty or with a Codex row, is a failed read, not default and not Codex", async () => {
    for (const stdout of ["", "  5 node /x/node_modules/@openai/codex/bin/codex.js\n"]) {
      const run = makeBatchRunner({ exec: async () => ({ stdout, stderr: "ps: warning", exitCode: 0 }) });
      await expect(run([5], "linux")).rejects.toMatchObject({ reason: "error" });
    }
  });
});

describe("inject(): the target line names the pid", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("[inject] pid=<pid> target=... so concurrent wakes can be told apart", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => { logs.push(String(l)); });
    const backends: InjectBackends = {
      wezterm: async () => undefined,
      windows: async () => undefined,
      unix: async () => undefined,
      platform: "win32",
      classify: async () => CODEX_PLAN,
    };
    await inject(30448, "ping", undefined, undefined, undefined, backends);
    expect(logs).toContain("  [inject] pid=30448 target=codex delay=300ms doubleEnter=true");
  });
});

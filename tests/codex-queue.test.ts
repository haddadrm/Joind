import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";

// The Codex queue route (src/codex-queue.ts) and its place in inject().
// Nothing here runs the real codex binary: the runner is stubbed, and the
// one test of the real runner starts this Node binary with a script instead.

import {
  CODEX_QUEUE_TIMEOUT_MS, CodexQueueNotHandedOff, classifyCodexQueue, injectCodexQueue, isCodexThread,
  parseCodexHome, parseCodexThread, resolveCodexCli, runCodexQueue, type CodexQueueRun, type CodexQueueRunner,
} from "../src/codex-queue.js";
import { inject, WakeFallbackAborted, type InjectBackends, type InjectOptions } from "../src/inject.js";
import { UnconfirmedDeliveryError } from "../src/orca.js";
import { CODEX_PLAN } from "../src/target.js";
import { classifyWakeFailure } from "../src/wake.js";

const THREAD = "01a0e156-de0a-7bb0-909e-32d39d9b172f";
const OTHER = "5aea879b-51c2-4e0b-95d4-680ec96b4ecc";
/** The stderr codex-cli 0.158.0 printed for a UUID with no session (28 Sep 2026). */
const noRollout = (id: string) =>
  `Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id ${id} (code -32603)\n`;
const exit = (code: number, stderr = "", stdout = ""): CodexQueueRun => ({ kind: "exit", code, stdout, stderr });

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe("codexThread is a session UUID and nothing else", () => {
  it("accepts a UUID, lower-cased; blank and absent are no thread; null clears", () => {
    expect(parseCodexThread(THREAD)).toEqual({ ok: true, value: THREAD });
    expect(parseCodexThread(THREAD.toUpperCase())).toEqual({ ok: true, value: THREAD });
    expect(parseCodexThread(`  ${THREAD}  `)).toEqual({ ok: true, value: THREAD });
    expect(parseCodexThread(undefined)).toEqual({ ok: true, value: undefined });
    // null is the explicit clear, not "absent" (review of b6da6f6, finding 2).
    expect(parseCodexThread(null)).toEqual({ ok: true, value: null });
    expect(parseCodexThread("")).toEqual({ ok: true, value: undefined });
    expect(parseCodexThread("   ")).toEqual({ ok: true, value: undefined });
  });

  it("refuses a session name, although codex queue would take one: a name is a mutable selector", () => {
    for (const name of ["my-session", "codex_main", "Data", "a.b"]) {
      const r = parseCodexThread(name);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/session names are not accepted/);
    }
    expect(isCodexThread("my-session")).toBe(false);
  });

  it("refuses injection attempts and malformed ids", () => {
    const bad: unknown[] = [
      `${THREAD} --message=evil`, `${THREAD}&calc`, `${THREAD};rm -rf /`, `$(calc)`, "`calc`",
      `--thread=${THREAD}`, `-${THREAD}`, `${THREAD}\n`, `${THREAD}x`, THREAD.slice(0, 35),
      THREAD.replace(/-/g, ""), `{${THREAD}}`, "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", "x".repeat(4096),
      42, { thread: THREAD }, [THREAD], true,
    ];
    for (const b of bad) {
      // A trailing newline alone is trimmed like other whitespace; the rest must fail.
      if (b === `${THREAD}\n`) { expect(parseCodexThread(b)).toEqual({ ok: true, value: THREAD }); continue; }
      expect(parseCodexThread(b).ok, JSON.stringify(b).slice(0, 60)).toBe(false);
    }
  });
});

describe("codexHome is an absolute path to an existing Codex home", () => {
  const isHome = (p: string) => p === join("C:\\Users\\x\\.codex", "sessions") || p === join("/home/x/.codex", "sessions");

  it("accepts an absolute home that has a sessions directory", () => {
    expect(parseCodexHome("C:\\Users\\x\\.codex", "win32", isHome)).toEqual({ ok: true, value: "C:\\Users\\x\\.codex" });
    expect(parseCodexHome("/home/x/.codex", "linux", isHome)).toEqual({ ok: true, value: "/home/x/.codex" });
    expect(parseCodexHome(undefined, "win32", isHome)).toEqual({ ok: true, value: undefined });
    expect(parseCodexHome("", "win32", isHome)).toEqual({ ok: true, value: undefined });
  });

  it("refuses relative, root-relative, parent-segment, control-character and non-home paths", () => {
    const bad: Array<[unknown, NodeJS.Platform]> = [
      [".codex", "win32"], ["\\Users\\x\\.codex", "win32"], ["C:\\Users\\x\\..\\y\\.codex", "win32"],
      ["C:\\Users\\x\\.codex\u0000", "win32"], ["C:\\Users\\x\\.codex\nC:\\evil", "win32"],
      ["C:\\Users\\nobody\\.codex", "win32"], ["home/x/.codex", "linux"], ["/home/x/../.codex", "linux"],
      [42, "linux"], ["/" + "a".repeat(2000), "linux"],
    ];
    for (const [v, platform] of bad) expect(parseCodexHome(v, platform, isHome).ok, String(v).slice(0, 40)).toBe(false);
  });
});

describe("classification: only a proven pre-handoff failure may fall back", () => {
  it("exit 0 is accepted", () => {
    expect(classifyCodexQueue(exit(0), THREAD)).toBeNull();
  });

  it("proven: spawn ENOENT, and exit 1 with the observed no-rollout answer for this very thread", () => {
    const enoent = classifyCodexQueue({ kind: "not-started", code: "ENOENT" }, THREAD);
    expect(enoent).toBeInstanceOf(CodexQueueNotHandedOff);
    const unknown = classifyCodexQueue(exit(1, noRollout(THREAD)), THREAD);
    expect(unknown).toBeInstanceOf(CodexQueueNotHandedOff);
    // Upper-case in the answer is the same id; a warning line before it changes nothing.
    expect(classifyCodexQueue(exit(1, "WARNING: proceeding, even though we could not create PATH aliases\n" + noRollout(THREAD.toUpperCase())), THREAD)).toBeInstanceOf(CodexQueueNotHandedOff);
    // Neither message names the thread: it can reach a room line.
    expect(enoent!.message).not.toContain(THREAD);
    expect(unknown!.message).not.toContain(THREAD);
  });

  it("unconfirmed: a timeout, a kill, a spawn error other than ENOENT", () => {
    expect(classifyCodexQueue({ kind: "timeout" }, THREAD)).toBeInstanceOf(UnconfirmedDeliveryError);
    expect(classifyCodexQueue({ kind: "timeout" }, THREAD)!.message).toMatch(/timed out without confirming delivery within 20 s/);
    expect(classifyCodexQueue({ kind: "killed", why: "signal SIGKILL" }, THREAD)).toBeInstanceOf(UnconfirmedDeliveryError);
    expect(classifyCodexQueue({ kind: "not-started", code: "EACCES" }, THREAD)).toBeInstanceOf(UnconfirmedDeliveryError);
  });

  it("unconfirmed: any other nonzero exit, including look-alikes of the proven answer", () => {
    const cases: CodexQueueRun[] = [
      exit(1),                                                        // generic, silent
      exit(1, "Error: something else went wrong\n"),                  // generic
      exit(1, noRollout(OTHER)),                                      // another thread's answer
      exit(2, noRollout(THREAD)),                                     // right words, wrong exit code
      exit(1, "", noRollout(THREAD)),                                 // on stdout, not stderr
      exit(1, "prefix " + noRollout(THREAD)),                         // not the whole line
      exit(1, noRollout(THREAD).replace(" (code -32603)", "")),       // not the whole answer
      exit(1, "Error: No active session found matching 'x'.\n"),      // the name answer: names are not used
      exit(1, "Error: connect ECONNREFUSED 127.0.0.1:1234\n"),        // a connection loss
      exit(1, "Error: app server not running\n"),                     // never observed: not proof
      exit(2, "error: unexpected argument '--thread' found\n"),       // an older Codex: not observed on queue
      exit(101, "thread 'main' panicked\n"),
    ];
    for (const c of cases) expect(classifyCodexQueue(c, THREAD), JSON.stringify(c).slice(0, 120)).toBeInstanceOf(UnconfirmedDeliveryError);
  });

  it("the wake layer: not handed off is no-console (said once), unconfirmed is never retried", () => {
    expect(classifyWakeFailure(classifyCodexQueue({ kind: "not-started", code: "ENOENT" }, THREAD))).toBe("no-console");
    expect(classifyWakeFailure(classifyCodexQueue(exit(1, noRollout(THREAD)), THREAD))).toBe("no-console");
    expect(classifyWakeFailure(classifyCodexQueue({ kind: "timeout" }, THREAD))).toBe("unconfirmed");
    expect(classifyWakeFailure(classifyCodexQueue(exit(1), THREAD))).toBe("unconfirmed");
  });
});

describe("injectCodexQueue: argv, home and no shell", () => {
  function recorder(result: CodexQueueRun) {
    const calls: Array<{ file: string; args: string[]; timeoutMs: number; env: NodeJS.ProcessEnv }> = [];
    const run: CodexQueueRunner = async (inv, args, opts) => { calls.push({ file: inv.file, args, timeoutMs: opts.timeoutMs, env: opts.env }); return result; };
    return { calls, run };
  }
  const resolve = () => ({ file: "C:\\codex\\codex.exe", args: [] });
  const prompt = `[joind] @Data mentioned by Rami. Reply: curl -s -X POST http://x/api/agent/send -d '{"sender":"Data","text":"YOUR_REPLY"}' & | %PATH% ^ "q"`;

  it("passes the thread and the prompt as single = arguments, with the time limit", async () => {
    const r = recorder(exit(0));
    await injectCodexQueue(THREAD, prompt, undefined, { run: r.run, resolve, env: { PATH: "p", CODEX_HOME: "C:\\server-home" } });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].file).toBe("C:\\codex\\codex.exe");
    expect(r.calls[0].args).toEqual(["queue", `--thread=${THREAD}`, `--message=${prompt}`]);
    expect(r.calls[0].timeoutMs).toBe(CODEX_QUEUE_TIMEOUT_MS);
    // No home given: the server's own environment, CODEX_HOME included.
    expect(r.calls[0].env.CODEX_HOME).toBe("C:\\server-home");
  });

  it("runs in the member's CODEX_HOME when it gave one", async () => {
    const r = recorder(exit(0));
    await injectCodexQueue(THREAD, "hi", "C:\\orca\\home", { run: r.run, resolve, env: { PATH: "p", CODEX_HOME: "C:\\server-home" }, exists: () => true });
    expect(r.calls[0].env).toEqual({ PATH: "p", CODEX_HOME: "C:\\orca\\home" });
  });

  it("a home that is gone is not run at all, and may fall back", async () => {
    const r = recorder(exit(0));
    await expect(injectCodexQueue(THREAD, "hi", "C:\\gone", { run: r.run, resolve, exists: () => false })).rejects.toBeInstanceOf(CodexQueueNotHandedOff);
    expect(r.calls).toEqual([]);
  });

  it("a malformed thread is never run", async () => {
    const r = recorder(exit(0));
    await expect(injectCodexQueue("my-session", "hi", undefined, { run: r.run, resolve })).rejects.toBeInstanceOf(CodexQueueNotHandedOff);
    expect(r.calls).toEqual([]);
  });

  it("logs the accepted line with the thread and the time taken", async () => {
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    await injectCodexQueue(THREAD, "hi", undefined, recorder(exit(0)));
    expect(logs.some((l) => new RegExp(`^ {2}\\[inject:codex-queue\\] thread=${THREAD} accepted in \\d+ ms$`).test(l))).toBe(true);
  });
});

describe("the real runner: execFile, no shell, no stdin, a time limit (this Node binary, never codex)", () => {
  // A script that prints its argv and whatever stdin holds until it closes.
  const echo = "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(1),stdin:s,home:process.env.CODEX_HOME??null}));});";

  it("hands every argument over unchanged and closes stdin at once", async () => {
    const hostile = `--message=a & b | c "d" %PATH% ^e $(f) \`g\` 'h'`;
    const r = await runCodexQueue({ file: process.execPath, args: ["-e", echo] }, ["queue", hostile], { timeoutMs: 10_000, env: { ...process.env, CODEX_HOME: "X:\\home" } });
    expect(r.kind).toBe("exit");
    if (r.kind !== "exit") return;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ argv: ["queue", hostile], stdin: "", home: "X:\\home" });
  });

  it("a missing binary is not-started ENOENT", async () => {
    const r = await runCodexQueue({ file: join(process.cwd(), "no-such-codex-binary.exe"), args: [] }, ["queue"], { timeoutMs: 5_000, env: process.env });
    expect(r).toEqual({ kind: "not-started", code: "ENOENT" });
  });

  it("a process that outlives the limit is a timeout", async () => {
    const r = await runCodexQueue({ file: process.execPath, args: ["-e", "setTimeout(()=>{},30000)"] }, [], { timeoutMs: 400, env: process.env });
    expect(r).toEqual({ kind: "timeout" });
  }, 15_000);

  it("a nonzero exit carries its code and output", async () => {
    const r = await runCodexQueue({ file: process.execPath, args: ["-e", "process.stderr.write('boom');process.exit(3)"] }, [], { timeoutMs: 10_000, env: process.env });
    expect(r).toMatchObject({ kind: "exit", code: 3, stderr: "boom" });
  });
});

describe("which codex runs on Windows", () => {
  const dir = "C:\\Users\\x\\AppData\\Roaming\\npm";
  const native = join(dir, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");

  it("never the .cmd shim: JOIND_CODEX_BIN naming codex.cmd resolves to the native codex.exe of its package", () => {
    const exists = (p: string) => p === native;
    expect(resolveCodexCli({ JOIND_CODEX_BIN: join(dir, "codex.cmd") }, "win32", exists)).toEqual({ file: native, args: [] });
  });

  it("codex.exe on PATH first, else the native binary behind the first codex.cmd on PATH", () => {
    expect(resolveCodexCli({ PATH: `C:\\a;C:\\winget;${dir}` }, "win32", (p) => p === join("C:\\winget", "codex.exe") || p === join(dir, "codex.cmd") || p === native).file).toBe(join("C:\\winget", "codex.exe"));
    if (process.platform === "win32") {
      expect(resolveCodexCli({ PATH: `C:\\a;${dir}` }, "win32", (p) => p === join(dir, "codex.cmd") || p === native).file).toBe(native);
    }
  });

  it("nothing found: a bare codex.exe, which fails with ENOENT (a proven pre-handoff failure)", () => {
    expect(resolveCodexCli({ PATH: "C:\\a" }, "win32", () => false)).toEqual({ file: "codex.exe", args: [] });
  });

  it("elsewhere: JOIND_CODEX_BIN or codex", () => {
    expect(resolveCodexCli({}, "linux", () => false)).toEqual({ file: "codex", args: [] });
    expect(resolveCodexCli({ JOIND_CODEX_BIN: "/opt/codex/bin/codex" }, "linux", () => false)).toEqual({ file: "/opt/codex/bin/codex", args: [] });
  });
});

describe("inject(): the queue route first, keys only after a proven pre-handoff failure", () => {
  type Rec = { queue: Array<{ thread: string; home?: string }>; console: number[]; keysTyping: number; classify: number; order: string[] };
  function backends(rec: Rec, queue: () => Promise<void>): InjectBackends {
    return {
      codexQueue: async (thread, _text, home) => { rec.order.push("queue"); rec.queue.push({ thread, home }); await queue(); },
      orca: async () => { rec.order.push("orca"); },
      wezterm: async () => { rec.order.push("wezterm"); },
      windows: async (p) => { rec.order.push("console"); rec.console.push(p); },
      unix: async (p) => { rec.order.push("console"); rec.console.push(p); },
      platform: "linux",
      // Never the host's real target lookup (commit 50cf861).
      classify: async () => { rec.classify++; return CODEX_PLAN; },
    };
  }
  const fresh = (): Rec => ({ queue: [], console: [], keysTyping: 0, classify: 0, order: [] });
  const opts = (rec: Rec, extra: Partial<InjectOptions> = {}): InjectOptions => ({
    codexThread: THREAD, codexHome: "C:\\home", onKeysTyping: () => { rec.keysTyping++; }, ...extra,
  });

  it("accepted: no keys, no plan lookup, no onKeysTyping (so no submit check)", async () => {
    const rec = fresh();
    await inject(4242, "hi", undefined, undefined, undefined, backends(rec, async () => undefined), opts(rec));
    expect(rec.queue).toEqual([{ thread: THREAD, home: "C:\\home" }]);
    expect(rec.order).toEqual(["queue"]);
    expect(rec.keysTyping).toBe(0);
    expect(rec.classify).toBe(0);
  });

  it("ENOENT: falls back to the console through the fallback guard, and the keys start the submit check", async () => {
    const rec = fresh();
    const guard = vi.fn(() => "proceed" as const);
    await inject(4242, "hi", undefined, undefined, undefined, backends(rec, async () => { throw classifyCodexQueue({ kind: "not-started", code: "ENOENT" }, THREAD)!; }), opts(rec, { fallbackGuard: guard }));
    expect(rec.order).toEqual(["queue", "console"]);
    expect(rec.console).toEqual([4242]);
    expect(rec.keysTyping).toBe(1);
    expect(guard).toHaveBeenCalled();
  });

  it("unknown thread (the observed answer): falls back the same way, to the Orca route first when bound", async () => {
    const rec = fresh();
    await inject(4242, "hi", undefined, undefined, undefined, backends(rec, async () => { throw classifyCodexQueue(exit(1, noRollout(THREAD)), THREAD)!; }), opts(rec, { orcaTerminal: "term_abc" }));
    expect(rec.order).toEqual(["queue", "orca"]);
  });

  it("a pre-handoff failure with the target gone or moved: no keys, the wake aborts", async () => {
    for (const verdict of ["skip", "moved"] as const) {
      const rec = fresh();
      let asked = 0;
      // The queue guard proceeds; the fallback guard, asked after the failure, does not.
      const p = inject(4242, "hi", undefined, undefined, undefined, backends(rec, async () => { throw classifyCodexQueue({ kind: "not-started", code: "ENOENT" }, THREAD)!; }),
        opts(rec, { queueGuard: () => "proceed", fallbackGuard: () => { asked++; return verdict; } }));
      await expect(p).rejects.toBeInstanceOf(WakeFallbackAborted);
      expect(rec.order).toEqual(["queue"]);
      expect(asked).toBe(1);
    }
  });

  it("timeout: unconfirmed, thrown as is, no keystroke fallback and no guard asked", async () => {
    const rec = fresh();
    const guard = vi.fn(() => "proceed" as const);
    const p = inject(4242, "hi", 7, undefined, undefined, backends(rec, async () => { throw classifyCodexQueue({ kind: "timeout" }, THREAD)!; }), opts(rec, { queueGuard: () => "proceed", fallbackGuard: guard, orcaTerminal: "term_abc" }));
    await expect(p).rejects.toBeInstanceOf(UnconfirmedDeliveryError);
    expect(rec.order).toEqual(["queue"]);
    expect(guard).not.toHaveBeenCalled();
    expect(rec.keysTyping).toBe(0);
  });

  it("a generic nonzero exit: unconfirmed the same way", async () => {
    const rec = fresh();
    const p = inject(4242, "hi", undefined, undefined, undefined, backends(rec, async () => { throw classifyCodexQueue(exit(1, "Error: boom\n"), THREAD)!; }), opts(rec));
    await expect(p).rejects.toBeInstanceOf(UnconfirmedDeliveryError);
    expect(rec.order).toEqual(["queue"]);
  });

  it("the queue guard is asked before the command: a changed registration sends nothing and falls back to nothing", async () => {
    for (const verdict of ["skip", "moved"] as const) {
      const rec = fresh();
      const p = inject(4242, "hi", undefined, undefined, undefined, backends(rec, async () => undefined), opts(rec, { queueGuard: () => verdict }));
      await expect(p).rejects.toMatchObject({ result: verdict });
      expect(rec.order).toEqual([]);
    }
  });

  it("no terminal known and not handed off: the queue's own error, classed no-console", async () => {
    const rec = fresh();
    const err = classifyCodexQueue(exit(1, noRollout(THREAD)), THREAD)!;
    const p = inject(0, "hi", undefined, undefined, undefined, backends(rec, async () => { throw err; }), opts(rec));
    await expect(p).rejects.toBe(err);
    expect(classifyWakeFailure(err)).toBe("no-console");
    expect(rec.order).toEqual(["queue"]);
  });

  it("no codexThread: the queue backend is never called", async () => {
    const rec = fresh();
    await inject(4242, "hi", undefined, undefined, undefined, backends(rec, async () => undefined), { onKeysTyping: () => { rec.keysTyping++; } });
    expect(rec.order).toEqual(["console"]);
  });
});

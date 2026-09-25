import { describe, it, expect, beforeEach } from "vitest";
import {
  inject, injectWezTerm, injectUnix, PartialDeliveryError, WakeFallbackAborted,
  type InjectBackends, type SendTextProcess, type SpawnSendText, type UnixExec,
} from "../src/inject.js";
import { classifyCommandLine, classifyCommandLineResolved, classifyTarget, forgetTarget, resetTargetCache, CODEX_PLAN, COPILOT_PLAN, DEFAULT_PLAN, type SubmitPlan } from "../src/target.js";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { classifyWakeFailure, WakeCoordinator } from "../src/wake.js";

// Codex gate round 1 on feat/inject-fixes (92603bb): one test (or group) per
// finding, each failing on that commit and passing now.

/** A fake `wezterm cli send-text`: records each payload; `codes` gives the
 *  exit code per call in order (default 0). */
function fakeSpawn(log: string[], codes: number[] = []): SpawnSendText {
  let call = 0;
  return (_exe, _argv) => {
    const code = codes[call++] ?? 0;
    let payload = "";
    const listeners: { close?: (c: number | null) => void } = {};
    const proc: SendTextProcess = {
      stdin: {
        write: (chunk: string) => { payload += chunk; return true; },
        end: () => { log.push(JSON.stringify(payload)); setImmediate(() => listeners.close?.(code)); return undefined; },
      },
      stderr: { on: () => undefined },
      on: (event: "close" | "error", listener: ((c: number | null) => void) | ((e: Error) => void)) => {
        if (event === "close") listeners.close = listener as (c: number | null) => void;
        return undefined;
      },
    };
    return proc;
  };
}
const CR = JSON.stringify("\r");
const noSleep = async (): Promise<void> => {};

describe("finding 1: the guard is re-asked after classification, before WezTerm types", () => {
  it("a target that left while the plan was being worked out gets nothing", async () => {
    let verdict: "proceed" | "skip" | "moved" = "proceed";
    const sent: number[] = [];
    const backends: InjectBackends = {
      wezterm: async (pane) => { sent.push(pane); },
      windows: async () => { sent.push(-1); },
      unix: async () => { sent.push(-2); },
      platform: "win32",
      classify: async (): Promise<SubmitPlan> => { verdict = "skip"; return DEFAULT_PLAN; },
    };
    await expect(inject(100, "ping", 7, undefined, undefined, backends, { fallbackGuard: () => verdict }))
      .rejects.toBeInstanceOf(WakeFallbackAborted);
    expect(sent).toEqual([]);
  });

  it("a target replaced during classification is reported as moved, the old pane untouched", async () => {
    let verdict: "proceed" | "skip" | "moved" = "proceed";
    const sent: number[] = [];
    const backends: InjectBackends = {
      wezterm: async (pane) => { sent.push(pane); },
      windows: async () => {},
      unix: async () => {},
      platform: "win32",
      classify: async (): Promise<SubmitPlan> => { verdict = "moved"; return CODEX_PLAN; },
    };
    const err = await inject(100, "ping", 7, undefined, undefined, backends, { fallbackGuard: () => verdict }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WakeFallbackAborted);
    expect((err as WakeFallbackAborted).result).toBe("moved");
    expect(sent).toEqual([]);
  });
});

describe("finding 2: the delayed second Enter re-asks the guard", () => {
  it("WezTerm: a target that left during the delay gets no second carriage return", async () => {
    const log: string[] = [];
    let left = false;
    const sleep = async (): Promise<void> => { left = true; };
    const guard = (): void => { if (left) throw new WakeFallbackAborted("skip"); };
    await expect(injectWezTerm(3, "hello", "wezterm", undefined, { spawn: fakeSpawn(log), sleep, plan: CODEX_PLAN, guard }))
      .rejects.toBeInstanceOf(WakeFallbackAborted);
    expect(log).toEqual([JSON.stringify("hello")]);
  });

  it("inject() hands the guard to the WezTerm backend", async () => {
    let received: (() => void) | undefined;
    const backends: InjectBackends = {
      wezterm: async (_p, _t, _e, _env, opts) => { received = opts?.guard; },
      windows: async () => {},
      unix: async () => {},
      platform: "win32",
      classify: async () => CODEX_PLAN,
    };
    let verdict: "proceed" | "skip" = "proceed";
    await inject(100, "ping", 7, undefined, undefined, backends, { fallbackGuard: () => verdict });
    expect(typeof received).toBe("function");
    verdict = "skip";
    expect(() => received?.()).toThrow(WakeFallbackAborted);
  });

  it("tmux: a target that left during the delay gets no second Enter", async () => {
    const calls: string[][] = [];
    const exec: UnixExec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "list-panes") return { stdout: "100 main:0.0" };
      return { stdout: "" };
    };
    let left = false;
    const sleep = async (): Promise<void> => { left = true; };
    const guard = (): void => { if (left) throw new WakeFallbackAborted("skip"); };
    await expect(injectUnix(100, "hello", guard, CODEX_PLAN, undefined, { exec, sleep })).rejects.toBeInstanceOf(WakeFallbackAborted);
    const enters = calls.filter((c) => c[0] === "tmux" && c[1] === "send-keys" && c[c.length - 1] === "Enter");
    expect(enters).toHaveLength(1);
  });
});

describe("finding 3: a failed second Enter recovers only the Enter, never the prompt", () => {
  it("WezTerm: one more lone carriage return, and the wake succeeds", async () => {
    const log: string[] = [];
    await injectWezTerm(3, "hello", "wezterm", undefined, { spawn: fakeSpawn(log, [0, 1, 0]), sleep: noSleep, plan: CODEX_PLAN });
    expect(log).toEqual([JSON.stringify("hello"), CR, CR, CR]); // text, failed first Enter, its retry, the second Enter
  });

  it("WezTerm: both Enter sends fail: a PartialDeliveryError, and the text is never sent again", async () => {
    const log: string[] = [];
    const err = await injectWezTerm(3, "hello", "wezterm", undefined, { spawn: fakeSpawn(log, [0, 1, 1]), sleep: noSleep, plan: CODEX_PLAN }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialDeliveryError);
    expect((err as PartialDeliveryError).phase).toBe("text-delivered");
    expect(log).toEqual([JSON.stringify("hello"), CR, CR]);
  });

  it("WezTerm: the recovery send re-asks the guard too", async () => {
    const log: string[] = [];
    let guardCalls = 0;
    const guard = (): void => { guardCalls++; if (guardCalls === 2) throw new WakeFallbackAborted("moved"); };
    await expect(injectWezTerm(3, "hello", "wezterm", undefined, { spawn: fakeSpawn(log, [0, 1]), sleep: noSleep, plan: CODEX_PLAN, guard }))
      .rejects.toBeInstanceOf(WakeFallbackAborted);
    expect(log).toEqual([JSON.stringify("hello"), CR]);
  });

  it("inject() never falls back to the console with the full prompt after a partial delivery", async () => {
    const consoleCalls: number[] = [];
    const backends: InjectBackends = {
      wezterm: async () => { throw new PartialDeliveryError("wezterm pane 7: text delivered, but the Enter that submits it failed twice"); },
      windows: async (pid) => { consoleCalls.push(pid); },
      unix: async (pid) => { consoleCalls.push(pid); },
      platform: "win32",
      classify: async () => CODEX_PLAN,
    };
    await expect(inject(100, "ping", 7, undefined, undefined, backends, { fallbackGuard: () => "proceed" }))
      .rejects.toBeInstanceOf(PartialDeliveryError);
    expect(consoleCalls).toEqual([]);
  });

  it("tmux: both Enter sends fail: a PartialDeliveryError passes the backend's error wrapper untouched", async () => {
    let enters = 0;
    const exec: UnixExec = async (_cmd, args) => {
      if (args[0] === "list-panes") return { stdout: "100 main:0.0" };
      if (args[args.length - 1] === "Enter" && ++enters > 1) throw new Error("tmux: server exited");
      return { stdout: "" };
    };
    const err = await injectUnix(100, "hello", undefined, CODEX_PLAN, undefined, { exec, sleep: noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialDeliveryError);
    expect(enters).toBe(3);
  });

  it("the coordinator classifies it as partial, does not retry, and warns", async () => {
    expect(classifyWakeFailure(new PartialDeliveryError("x"))).toBe("partial");
    let attempts = 0;
    const coordinator = new WakeCoordinator({ retryDelayMs: 0, sleep: noSleep });
    const outcome = await coordinator.run(["pid:100"], "room:Codex", async () => {
      attempts++;
      throw new PartialDeliveryError("wezterm pane 7: text delivered, but the Enter that submits it failed twice");
    });
    expect(attempts).toBe(1);
    expect(outcome).toMatchObject({ ok: false, kind: "partial", attempts: 1, warn: true });
  });
});

describe("finding 4: a reused pid never inherits the previous process's plan", () => {
  beforeEach(() => resetTargetCache());

  it("the same pid read twice, first Claude then Codex, gives each its own plan", async () => {
    const lines = ["\"C:\\Users\\u\\.local\\bin\\claude.exe\" --dangerously-skip-permissions", "node /x/node_modules/@openai/codex/bin/codex.js"];
    let reads = 0;
    const read = async (): Promise<string | null> => lines[reads++] ?? null;
    expect(await classifyTarget(42, "win32", { read })).toEqual(DEFAULT_PLAN);
    expect(await classifyTarget(42, "win32", { read })).toEqual(CODEX_PLAN);
    expect(reads).toBe(2);
  });

  it("a lifecycle signal drops a read in flight, so a later wake reads again", async () => {
    let reads = 0;
    const resolvers: Array<(v: string) => void> = [];
    const release = (v: string): void => { for (const r of resolvers) r(v); };
    const read = (): Promise<string | null> => { reads++; return new Promise<string | null>((r) => { resolvers.push(r); }); };
    const first = classifyTarget(42, "win32", { read });
    forgetTarget(42);
    const second = classifyTarget(42, "win32", { read });
    release("codex.exe");
    await Promise.all([first, second]);
    expect(reads).toBe(2);
  });

  it("inject() drops the read when its guard says the target left", async () => {
    resetTargetCache();
    let reads = 0;
    const resolvers: Array<(v: string) => void> = [];
    const release = (v: string): void => { for (const r of resolvers) r(v); };
    const read = (): Promise<string | null> => { reads++; return new Promise<string | null>((r) => { resolvers.push(r); }); };
    // A wake whose classification is still in flight elsewhere (another wake
    // to the same pid) must not keep serving a target the guard says left.
    const pending = classifyTarget(42, "win32", { read });
    const backends: InjectBackends = {
      wezterm: async () => {},
      windows: async () => {},
      unix: async () => {},
      platform: "win32",
      classify: async () => DEFAULT_PLAN,
    };
    await expect(inject(42, "ping", 7, undefined, undefined, backends, { fallbackGuard: () => "skip" })).rejects.toBeInstanceOf(WakeFallbackAborted);
    const after = classifyTarget(42, "win32", { read });
    release("codex.exe");
    await Promise.all([pending, after]);
    expect(reads).toBe(2);
  });
});

describe("application identity (gate round 7): a known executable name or a known package path, never argv parsing", () => {
  const NPM_CODEX = "/usr/lib/node_modules/@openai/codex/bin/codex.js";
  const cases: Array<[string, string | null, SubmitPlan]> = [
    // 1. The executable names the application; its arguments are never read.
    ["codex.exe", "codex.exe", CODEX_PLAN],
    ["a quoted Windows path to codex.exe, with arguments", "\"C:\\Program Files\\Codex\\codex.exe\" -c features.x=true", CODEX_PLAN],
    ["claude.exe resuming a session named after Codex", "claude.exe --resume codex-notes", DEFAULT_PLAN],
    ["claude.exe with a codex path in its arguments", `claude.exe --add-dir ${NPM_CODEX}`, DEFAULT_PLAN],
    // 2. gh copilot.
    ["gh copilot", "gh copilot suggest", COPILOT_PLAN],
    // 3. A runtime: the first argument carrying a known package path decides.
    ["node with the npm Codex path, Unix separators", `node ${NPM_CODEX}`, CODEX_PLAN],
    ["node with the npm Codex path, Windows separators (the field case)", "\"C:\\nvm4w\\nodejs\\node.exe\" C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js --dangerously-bypass-approvals-and-sandbox", CODEX_PLAN],
    ["node --require x before the path", `node --require /opt/tracing/register.cjs ${NPM_CODEX}`, CODEX_PLAN],
    ["node --experimental-config-file ./node.config.json before the path (round 7)", `node --experimental-config-file ./node.config.json ${NPM_CODEX}`, CODEX_PLAN],
    ["node --disable-warning ExperimentalWarning before the path", `node --disable-warning ExperimentalWarning ${NPM_CODEX}`, CODEX_PLAN],
    ["node --env_file_if_exists .env before the path", `node --env_file_if_exists .env ${NPM_CODEX}`, CODEX_PLAN],
    ["node --allow-fs-read ./node_modules before the path", `node --allow-fs-read ./node_modules ${NPM_CODEX}`, CODEX_PLAN],
    ["bun with the package path", `bun ${NPM_CODEX}`, CODEX_PLAN],
    ["deno run with the package path", `deno run --allow-all ${NPM_CODEX}`, CODEX_PLAN],
    ["node with the @github/copilot path", "node /usr/lib/node_modules/@github/copilot/index.js", COPILOT_PLAN],
    ["node with the Claude package path and --resume codex-notes", "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume codex-notes", DEFAULT_PLAN],
    ["node --trace-warnings server codex.js (round 7: application arguments are never read)", "node --trace-warnings server codex.js", DEFAULT_PLAN],
    ["node --trace-warnings server", "node --trace-warnings server", DEFAULT_PLAN],
    // Documented behaviour, both directions.
    ["a Codex source checkout without node_modules gets the default plan (documented loss)", "node /home/u/src/codex-cli/dist/cli.js", DEFAULT_PLAN],
    ["a package path in an option value still counts (documented, absurd)", "node --require /x/node_modules/@openai/codex/register.js app.js", CODEX_PLAN],
    // 4. Nothing to go on.
    ["empty", "", DEFAULT_PLAN],
    ["unreadable", null, DEFAULT_PLAN],
  ];
  for (const [label, line, plan] of cases) {
    it(label, () => { expect(classifyCommandLine(line)).toEqual(plan); });
  }
});

describe("tmux pane discovery splits on real newlines (addendum)", () => {
  /** tmux and pgrep as a two-pane host would answer them. */
  function twoPaneExec(sent: string[][], children: Record<string, string> = {}): UnixExec {
    return async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "list-panes") return { stdout: "11 main:0.0\n12 main:0.1\n" };
      if (cmd === "pgrep") {
        const out = children[args[1]];
        if (out === undefined) throw new Error("pgrep: no children");
        return { stdout: out };
      }
      sent.push(args);
      return { stdout: "" };
    };
  }

  it("finds a pane whose own pid is not on the first line", async () => {
    const sent: string[][] = [];
    await injectUnix(12, "hello", undefined, DEFAULT_PLAN, undefined, { exec: twoPaneExec(sent), sleep: noSleep });
    expect(sent.map((a) => a[2])).toEqual(["main:0.1", "main:0.1"]);
  });

  it("finds a pane through a child pid when pgrep lists several children", async () => {
    const sent: string[][] = [];
    await injectUnix(300, "hello", undefined, DEFAULT_PLAN, undefined, { exec: twoPaneExec(sent, { "12": "299\n300\n" }), sleep: noSleep });
    expect(sent.map((a) => a[2])).toEqual(["main:0.1", "main:0.1"]);
  });
});

describe("gate round 3: once the text is in, the same attempt finishes in place", () => {
  it("WezTerm through inject(): lock growth after the text (fallbackGuard says moved) does not stop the Enter", async () => {
    const log: string[] = [];
    let grown = false;
    const backends: InjectBackends = {
      wezterm: (pane, text, exe, env, opts) => injectWezTerm(pane, text, exe, env, { ...opts, spawn: fakeSpawn(log), sleep: async () => { grown = true; } }),
      windows: async () => { throw new Error("console must not be tried"); },
      unix: async () => { throw new Error("console must not be tried"); },
      platform: "win32",
      classify: async () => CODEX_PLAN,
    };
    await inject(100, "hello", 7, undefined, undefined, backends, {
      fallbackGuard: () => (grown ? "moved" : "proceed"),
      afterTextGuard: () => "proceed",
    });
    expect(log).toEqual([JSON.stringify("hello"), CR, CR]);
  });

  it("WezTerm through inject(): the post-text guard saying the agent left stops the Enter, nothing more is sent", async () => {
    const log: string[] = [];
    let left = false;
    const backends: InjectBackends = {
      wezterm: (pane, text, exe, env, opts) => injectWezTerm(pane, text, exe, env, { ...opts, spawn: fakeSpawn(log), sleep: async () => { left = true; } }),
      windows: async () => { throw new Error("console must not be tried"); },
      unix: async () => { throw new Error("console must not be tried"); },
      platform: "win32",
      classify: async () => CODEX_PLAN,
    };
    const err = await inject(100, "hello", 7, undefined, undefined, backends, {
      fallbackGuard: () => "proceed",
      afterTextGuard: () => (left ? "skip" : "proceed"),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WakeFallbackAborted);
    expect(log).toEqual([JSON.stringify("hello")]);
  });

  it("tmux: the second Enter asks the post-text guard, not the pre-text one", async () => {
    const enters: string[] = [];
    const exec: UnixExec = async (_cmd, args) => {
      if (args[0] === "list-panes") return { stdout: "100 main:0.0" };
      if (args[args.length - 1] === "Enter") enters.push(args[2]);
      return { stdout: "" };
    };
    let grown = false;
    const before = (): void => { if (grown) throw new WakeFallbackAborted("moved"); };
    const afterText = (): void => {};
    await injectUnix(100, "hello", before, CODEX_PLAN, afterText, { exec, sleep: async () => { grown = true; } });
    expect(enters).toEqual(["main:0.0", "main:0.0"]);
  });

  it("without an afterTextGuard, inject() keeps asking fallbackGuard after the text (callers outside the room)", async () => {
    const log: string[] = [];
    let left = false;
    const backends: InjectBackends = {
      wezterm: (pane, text, exe, env, opts) => injectWezTerm(pane, text, exe, env, { ...opts, spawn: fakeSpawn(log), sleep: async () => { left = true; } }),
      windows: async () => {},
      unix: async () => {},
      platform: "win32",
      classify: async () => CODEX_PLAN,
    };
    await expect(inject(100, "hello", 7, undefined, undefined, backends, { fallbackGuard: () => (left ? "skip" : "proceed") }))
      .rejects.toBeInstanceOf(WakeFallbackAborted);
    expect(log).toEqual([JSON.stringify("hello")]);
  });
});

describe("gate round 8: a runtime's first-argument script alone decides, through its symlink when needed", () => {
  const pure: Array<[string, string, SubmitPlan]> = [
    ["a global bin link named copilot", "node /usr/local/bin/copilot", COPILOT_PLAN],
    ["a bun global bin link named copilot", "node /home/u/.bun/bin/copilot", COPILOT_PLAN],
    ["a project node_modules/.bin link named copilot", "node /p/node_modules/.bin/copilot", COPILOT_PLAN],
    ["claude as the script, a codex package path later in its arguments (the gate's false positive)", "node /usr/local/bin/claude --add-dir /project/node_modules/@openai/codex", DEFAULT_PLAN],
    ["claude as the script", "node /usr/local/bin/claude", DEFAULT_PLAN],
    ["a bin link under another name is not resolved by the pure classifier", "node /usr/local/bin/cx", DEFAULT_PLAN],
  ];
  for (const [label, line, plan] of pure) {
    it(`pure: ${label}`, () => { expect(classifyCommandLine(line)).toEqual(plan); });
  }

  const links: Record<string, string> = {
    "/usr/local/bin/cx": "/usr/lib/node_modules/@openai/codex/bin/codex.js",
    "/home/u/.bun/bin/ghcp": "/home/u/.bun/install/global/node_modules/@github/copilot/index.js",
    "/p/node_modules/.bin/agent": "/p/node_modules/@openai/codex/bin/codex.js",
  };
  const fakeRealpath = async (path: string): Promise<string> => {
    const target = links[path];
    if (target === undefined) throw new Error(`ENOENT: ${path}`);
    return target;
  };
  const resolved: Array<[string, string, SubmitPlan]> = [
    ["a global bin symlink into @openai/codex", "node /usr/local/bin/cx", CODEX_PLAN],
    ["a bun global bin symlink into @github/copilot", "node /home/u/.bun/bin/ghcp", COPILOT_PLAN],
    ["a node_modules/.bin symlink into @openai/codex", "node /p/node_modules/.bin/agent", CODEX_PLAN],
    ["a script realpath cannot resolve", "node /usr/local/bin/missing", DEFAULT_PLAN],
  ];
  for (const [label, line, plan] of resolved) {
    it(`resolved: ${label}`, async () => { expect(await classifyCommandLineResolved(line, { realpath: fakeRealpath })).toEqual(plan); });
  }

  it("a realpath that never answers is the default plan once the deadline passes", async () => {
    const never = (): Promise<string> => new Promise<string>(() => {});
    expect(await classifyCommandLineResolved("node /usr/local/bin/cx", { realpath: never, deadlineMs: 20 })).toEqual(DEFAULT_PLAN);
  });

  it("realpath is never asked for a relative script, a script already identified, or an options-first line", async () => {
    const asked: string[] = [];
    const spy = async (path: string): Promise<string> => { asked.push(path); return path; };
    await classifyCommandLineResolved("node bin/cx", { realpath: spy });
    await classifyCommandLineResolved("node /usr/local/bin/copilot", { realpath: spy });
    await classifyCommandLineResolved("node --trace-warnings server codex.js", { realpath: spy });
    expect(asked).toEqual([]);
  });

  it("classifyTarget resolves the script on the per-wake read", async () => {
    resetTargetCache();
    const read = async (): Promise<string | null> => "node /usr/local/bin/cx";
    expect(await classifyTarget(4242, "linux", { read, realpath: fakeRealpath })).toEqual(CODEX_PLAN);
  });

  it("a real symlink into node_modules/@openai/codex resolves to Codex (skipped where symlinks need privilege)", async (ctx) => {
    const root = mkdtempSync(join(tmpdir(), "joind-symlink-"));
    try {
      const pkgBin = join(root, "lib", "node_modules", "@openai", "codex", "bin");
      mkdirSync(pkgBin, { recursive: true });
      const target = join(pkgBin, "codex.js");
      writeFileSync(target, "");
      mkdirSync(join(root, "bin"));
      const link = join(root, "bin", "cx");
      try {
        symlinkSync(target, link, "file");
      } catch {
        ctx.skip();
        return;
      }
      expect(classifyCommandLine(`node "${link}"`)).toEqual(DEFAULT_PLAN);
      expect(await classifyCommandLineResolved(`node "${link}"`)).toEqual(CODEX_PLAN);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

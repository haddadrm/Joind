import { describe, it, expect, beforeEach } from "vitest";
import {
  inject, injectWezTerm, injectUnix, PartialDeliveryError, WakeFallbackAborted,
  type InjectBackends, type SendTextProcess, type SpawnSendText, type UnixExec,
} from "../src/inject.js";
import { classifyCommandLine, classifyTarget, forgetTarget, resetTargetCache, CODEX_PLAN, DEFAULT_PLAN, type SubmitPlan } from "../src/target.js";
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
    expect(log).toEqual([JSON.stringify("hello\r")]);
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
    await expect(injectUnix(100, "hello", guard, CODEX_PLAN, { exec, sleep })).rejects.toBeInstanceOf(WakeFallbackAborted);
    const enters = calls.filter((c) => c[0] === "tmux" && c[1] === "send-keys" && c[c.length - 1] === "Enter");
    expect(enters).toHaveLength(1);
  });
});

describe("finding 3: a failed second Enter recovers only the Enter, never the prompt", () => {
  it("WezTerm: one more lone carriage return, and the wake succeeds", async () => {
    const log: string[] = [];
    await injectWezTerm(3, "hello", "wezterm", undefined, { spawn: fakeSpawn(log, [0, 1, 0]), sleep: noSleep, plan: CODEX_PLAN });
    expect(log).toEqual([JSON.stringify("hello\r"), CR, CR]);
  });

  it("WezTerm: both Enter sends fail: a PartialDeliveryError, and the text is never sent again", async () => {
    const log: string[] = [];
    const err = await injectWezTerm(3, "hello", "wezterm", undefined, { spawn: fakeSpawn(log, [0, 1, 1]), sleep: noSleep, plan: CODEX_PLAN }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialDeliveryError);
    expect((err as PartialDeliveryError).phase).toBe("text-delivered");
    expect(log).toEqual([JSON.stringify("hello\r"), CR, CR]);
  });

  it("WezTerm: the recovery send re-asks the guard too", async () => {
    const log: string[] = [];
    let guardCalls = 0;
    const guard = (): void => { guardCalls++; if (guardCalls === 2) throw new WakeFallbackAborted("moved"); };
    await expect(injectWezTerm(3, "hello", "wezterm", undefined, { spawn: fakeSpawn(log, [0, 1]), sleep: noSleep, plan: CODEX_PLAN, guard }))
      .rejects.toBeInstanceOf(WakeFallbackAborted);
    expect(log).toEqual([JSON.stringify("hello\r"), CR]);
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
    const err = await injectUnix(100, "hello", undefined, CODEX_PLAN, { exec, sleep: noSleep }).catch((e: unknown) => e);
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

describe("finding 5: node options that take a value are not the entry script", () => {
  const cases: Array<[string, string, SubmitPlan]> = [
    ["--require with a separate value (the gate's case)", "node --require /opt/tracing/register.cjs /usr/lib/node_modules/@openai/codex/bin/codex.js", CODEX_PLAN],
    ["-r", "node -r /opt/tracing/register.cjs /usr/lib/node_modules/@openai/codex/bin/codex.js", CODEX_PLAN],
    ["--import", "node --import ./otel.mjs /x/node_modules/@openai/codex/bin/codex.js", CODEX_PLAN],
    ["--loader and --experimental-loader", "node --loader ts-node/esm --experimental-loader ./l.mjs /x/node_modules/@openai/codex/bin/codex.js", CODEX_PLAN],
    ["= forms are one token", "node --inspect=9229 --max-old-space-size=4096 /x/node_modules/@openai/codex/bin/codex.js", CODEX_PLAN],
    ["-C takes a value, case-sensitive", "node -C development /x/node_modules/@openai/codex/bin/codex.js", CODEX_PLAN],
    ["-- ends the options", "node --trace-warnings -- /x/node_modules/@openai/codex/bin/codex.js", CODEX_PLAN],
    ["an inline -e program has no entry script", "node -e \"require('/x/node_modules/@openai/codex/bin/codex.js')\"", DEFAULT_PLAN],
    ["--eval likewise", "node --eval 1 /x/node_modules/@openai/codex/bin/codex.js", DEFAULT_PLAN],
    ["bun run", "bun run /x/node_modules/@openai/codex/bin/codex.js", CODEX_PLAN],
    ["deno run with options", "deno run --allow-all --config deno.json /x/node_modules/@openai/codex/bin/codex.js", CODEX_PLAN],
    ["node's run is a file name, not a subcommand", "node run /x/node_modules/@openai/codex/bin/codex.js", DEFAULT_PLAN],
  ];
  for (const [label, line, plan] of cases) {
    it(label, () => { expect(classifyCommandLine(line)).toEqual(plan); });
  }
});

describe("finding 6: application identity beats ancestor folder names", () => {
  const cases: Array<[string, string, SubmitPlan]> = [
    ["Claude's package inside a codex-cli folder (the gate's case)", "node /home/u/codex-cli/node_modules/@anthropic-ai/claude-code/cli.js", DEFAULT_PLAN],
    ["a claude executable inside a codex-cli folder (the gate's case)", "/home/u/codex-cli/.tools/claude", DEFAULT_PLAN],
    ["Codex's package inside a claude-code folder", "node /home/u/claude-code/node_modules/@openai/codex/bin/codex.js", CODEX_PLAN],
    ["the last package wins when packages nest", "node /x/node_modules/@openai/codex/node_modules/@anthropic-ai/claude-code/cli.js", DEFAULT_PLAN],
    ["a generic entry is named by its application root, past build folders", "node /home/u/src/codex-cli/dist/cli.js", CODEX_PLAN],
    ["but not by folders above that root", "node /home/u/codex-cli/tools/runner/index.js", DEFAULT_PLAN],
    ["an unrelated tool in a codex folder", "/opt/codex/bin/rg", DEFAULT_PLAN],
  ];
  for (const [label, line, plan] of cases) {
    it(label, () => { expect(classifyCommandLine(line)).toEqual(plan); });
  }
});

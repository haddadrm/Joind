import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyCommandLine, classifyTarget, resetTargetCache,
  CODEX_PLAN, COPILOT_PLAN, DEFAULT_PLAN, type SubmitPlan,
} from "../src/target.js";
import { inject, injectWezTerm, type InjectBackends, type SendTextProcess, type SpawnSendText } from "../src/inject.js";

// Evidence for all of this: tools/inject-matrix, 24 Sep 2026. One Enter left
// every prompt unsent in a real Codex CLI; an npm Codex runs as node.exe, so
// the old name test never fired; a WezTerm line feed never submitted.

describe("classifyCommandLine", () => {
  const codex: Array<[string, string]> = [
    ["native Windows build", "C:\\Users\\u\\AppData\\Local\\OpenAI\\Codex\\bin\\80f7\\codex.exe -c features.x=true"],
    ["npm install under node on Windows (the field case)", "\"C:\\nvm4w\\nodejs\\node.exe\" C:\\Users\\u\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js --dangerously-bypass-approvals-and-sandbox"],
    ["node codex.js, relative", "node codex.js"],
    ["@openai/codex bin under node on Unix", "node /usr/lib/node_modules/@openai/codex/bin/codex.js"],
    ["a codex-cli checkout", "node /home/u/src/codex-cli/dist/cli.js"],
    ["bare codex on PATH", "/usr/local/bin/codex"],
    ["quoted path with spaces", "\"C:\\Program Files\\Codex\\codex.exe\""],
  ];
  for (const [label, line] of codex) {
    it(`codex: ${label}`, () => { expect(classifyCommandLine(line)).toEqual(CODEX_PLAN); });
  }

  const copilot: Array<[string, string]> = [
    ["copilot.exe", "C:\\tools\\copilot.exe"],
    ["@github/copilot under node", "node /usr/lib/node_modules/@github/copilot/index.js"],
    ["gh copilot", "gh copilot suggest"],
    ["copilot-language-server style binary", "/opt/copilot-cli/bin/copilot"],
  ];
  for (const [label, line] of copilot) {
    it(`copilot: ${label}`, () => { expect(classifyCommandLine(line)).toEqual(COPILOT_PLAN); });
  }

  const plain: Array<[string, string | null]> = [
    ["claude.exe", "\"C:\\Users\\u\\.local\\bin\\claude.exe\" --dangerously-skip-permissions"],
    ["claude resuming a session whose name mentions codex", "claude.exe --resume codex-notes"],
    ["node running something else", "node server.js --codex"],
    ["a shell", "C:\\Program Files\\PowerShell\\7\\pwsh.exe -NoProfile"],
    ["empty", ""],
    ["unreadable", null],
  ];
  for (const [label, line] of plain) {
    it(`default: ${label}`, () => { expect(classifyCommandLine(line)).toEqual(DEFAULT_PLAN); });
  }

  it("plans carry the timing the backends apply", () => {
    expect(CODEX_PLAN).toMatchObject({ doubleEnter: true, delayMs: 300 });
    expect(COPILOT_PLAN).toMatchObject({ doubleEnter: true, delayMs: 300 });
    expect(DEFAULT_PLAN).toMatchObject({ doubleEnter: false, delayMs: 50 });
  });
});

describe("classifyTarget: one read per wake, never a failed wake", () => {
  beforeEach(() => resetTargetCache());

  // Gate round 1, finding 4: a plan cached by pid would be inherited by the
  // next process to reuse that pid, so every wake reads the process it is
  // about to type into (was: one read per pid per minute).
  it("every wake reads the current process; nothing carries over", async () => {
    const reads: number[] = [];
    const read = async (pid: number) => { reads.push(pid); return "node /x/@openai/codex/bin/codex.js"; };
    expect(await classifyTarget(42, "win32", { read })).toEqual(CODEX_PLAN);
    expect(await classifyTarget(42, "win32", { read })).toEqual(CODEX_PLAN);
    expect(reads).toEqual([42, 42]);
  });

  it("concurrent wakes share the lookup in flight", async () => {
    let release: (v: string) => void = () => {};
    let calls = 0;
    const read = () => { calls++; return new Promise<string>((r) => { release = r; }); };
    const a = classifyTarget(7, "linux", { read });
    const b = classifyTarget(7, "linux", { read });
    release("codex");
    expect(await a).toEqual(CODEX_PLAN);
    expect(await b).toEqual(CODEX_PLAN);
    expect(calls).toBe(1);
  });

  it("a failed lookup is the default plan and is not cached", async () => {
    let calls = 0;
    const failing = async (): Promise<string | null> => { calls++; throw new Error("powershell timed out"); };
    expect(await classifyTarget(9, "win32", { read: failing })).toEqual(DEFAULT_PLAN);
    const unreadable = async (): Promise<string | null> => { calls++; return null; };
    expect(await classifyTarget(9, "win32", { read: unreadable })).toEqual(DEFAULT_PLAN);
    expect(await classifyTarget(9, "win32", { read: async () => { calls++; return "codex.exe"; } })).toEqual(CODEX_PLAN);
    expect(calls).toBe(3);
  });

  it("no pid, no lookup", async () => {
    let calls = 0;
    const read = async () => { calls++; return "codex.exe"; };
    expect(await classifyTarget(0, "win32", { read })).toEqual(DEFAULT_PLAN);
    expect(await classifyTarget(-1, "win32", { read })).toEqual(DEFAULT_PLAN);
    expect(calls).toBe(0);
  });
});

/** A fake `wezterm cli send-text`: records argv and stdin, exits with `code`. */
function fakeSpawn(log: string[], code = 0): { spawn: SpawnSendText; args: string[][] } {
  const args: string[][] = [];
  const spawn: SpawnSendText = (_exe, argv) => {
    args.push(argv);
    let payload = "";
    const listeners: { close?: (c: number | null) => void } = {};
    const proc: SendTextProcess = {
      stdin: {
        write: (chunk: string) => { payload += chunk; return true; },
        end: () => { log.push(`send:${JSON.stringify(payload)}`); setImmediate(() => listeners.close?.(code)); return undefined; },
      },
      stderr: { on: () => undefined },
      on: (event: "close" | "error", listener: ((c: number | null) => void) | ((e: Error) => void)) => {
        if (event === "close") listeners.close = listener as (c: number | null) => void;
        return undefined;
      },
    };
    return proc;
  };
  return { spawn, args };
}

describe("injectWezTerm: carriage return, and a second one for Codex and Copilot", () => {
  it("ends the text with a carriage return, not a line feed, as typed keys", async () => {
    const log: string[] = [];
    const { spawn, args } = fakeSpawn(log);
    await injectWezTerm(3, "hello", "wezterm", undefined, { spawn, sleep: async () => {} });
    expect(log).toEqual([`send:${JSON.stringify("hello\r")}`]);
    expect(args[0]).toEqual(["cli", "--no-auto-start", "send-text", "--pane-id", "3", "--no-paste"]);
  });

  it("Codex: text and CR, the plan's delay, then a lone CR in a second call", async () => {
    const log: string[] = [];
    const { spawn, args } = fakeSpawn(log);
    const sleep = async (ms: number) => { log.push(`sleep:${ms}`); };
    await injectWezTerm(3, "hello", "wezterm", undefined, { spawn, sleep, plan: CODEX_PLAN });
    expect(log).toEqual([`send:${JSON.stringify("hello\r")}`, "sleep:300", `send:${JSON.stringify("\r")}`]);
    expect(args).toHaveLength(2);
    for (const a of args) expect(a).toContain("--no-auto-start");
  });

  it("a failed first send rejects and sends no second Enter", async () => {
    const log: string[] = [];
    const { spawn } = fakeSpawn(log, 1);
    await expect(injectWezTerm(3, "hello", "wezterm", undefined, { spawn, sleep: async () => {}, plan: CODEX_PLAN })).rejects.toThrow(/send-text exit 1/);
    expect(log).toHaveLength(1);
  });
});

describe("inject(): the plan is worked out once per wake and reaches every backend that presses Enter", () => {
  const codexTarget = async (): Promise<SubmitPlan> => CODEX_PLAN;

  it("WezTerm gets the Codex plan", async () => {
    const seen: Array<SubmitPlan | undefined> = [];
    const backends: InjectBackends = {
      wezterm: async (_pane, _text, _exe, _env, opts) => { seen.push(opts?.plan); },
      windows: async () => { throw new Error("console must not be tried"); },
      unix: async () => { throw new Error("console must not be tried"); },
      platform: "win32",
      classify: codexTarget,
    };
    await inject(100, "ping", 5, undefined, undefined, backends);
    expect(seen).toEqual([CODEX_PLAN]);
  });

  it("a WezTerm failure falls back to the console with the same plan and no second lookup", async () => {
    let lookups = 0;
    const consoleCalls: Array<[number, boolean]> = [];
    const backends: InjectBackends = {
      wezterm: async () => { throw new Error("failed to connect to Socket(gui-sock-1)"); },
      windows: async (_pid, _text, delayMs, doubleEnter) => { consoleCalls.push([delayMs, doubleEnter]); },
      unix: async () => {},
      platform: "win32",
      classify: async () => { lookups++; return CODEX_PLAN; },
    };
    await inject(100, "ping", 5, undefined, undefined, backends);
    expect(lookups).toBe(1);
    expect(consoleCalls).toEqual([[300, true]]);
  });

  it("the Unix console backend gets the plan too", async () => {
    const plans: Array<SubmitPlan | undefined> = [];
    const backends: InjectBackends = {
      wezterm: async () => {},
      windows: async () => {},
      unix: async (_pid, _text, _guard, plan) => { plans.push(plan); },
      platform: "linux",
      classify: codexTarget,
    };
    await inject(100, "ping", undefined, undefined, undefined, backends);
    expect(plans).toEqual([CODEX_PLAN]);
  });

  it("Orca presses Enter itself: no lookup at all", async () => {
    let lookups = 0;
    const backends: InjectBackends = {
      orca: async () => {},
      wezterm: async () => {},
      windows: async () => {},
      unix: async () => {},
      platform: "win32",
      classify: async () => { lookups++; return CODEX_PLAN; },
    };
    await inject(100, "ping", undefined, undefined, undefined, backends, { orcaTerminal: "term_abc" });
    expect(lookups).toBe(0);
  });

  it("a classifier that throws is a single-Enter wake, not a failed one", async () => {
    const consoleCalls: Array<[number, boolean]> = [];
    const backends: InjectBackends = {
      wezterm: async () => {},
      windows: async (_pid, _text, delayMs, doubleEnter) => { consoleCalls.push([delayMs, doubleEnter]); },
      unix: async () => {},
      platform: "win32",
      classify: async () => { throw new Error("boom"); },
    };
    await inject(100, "ping", undefined, undefined, undefined, backends);
    expect(consoleCalls).toEqual([[50, false]]);
  });
});

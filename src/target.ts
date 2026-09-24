/**
 * What kind of agent a wake is typing into, and therefore how to submit.
 *
 * Codex and Copilot need a second Enter: the injection matrix
 * (tools/inject-matrix, 24 Sep 2026) typed one prompt through every route
 * into a real Codex CLI 0.154.0, and every route that pressed Enter once
 * left the prompt sitting in the input box; a second Enter submitted it.
 *
 * The old check compared the process NAME with "codex.exe". An npm install
 * of Codex runs as node.exe with codex.js on its command line, so the check
 * never matched and the double Enter never fired. This reads the command
 * line instead (CIM Win32_Process.CommandLine on Windows, `ps -o args=` on
 * Unix) and matches the executable or the script it runs.
 *
 * Cheap and never blocking: at most one lookup per pid per minute (cached,
 * and concurrent wakes share the lookup in flight), a hard timeout, and on
 * any failure the plain single-Enter plan, which is what every agent but
 * these two needs.
 */

import { execFile } from "child_process";

export type AgentKind = "codex" | "copilot" | "default";

export interface SubmitPlan {
  kind: AgentKind;
  /** Press Enter a second time, delayMs after the first. */
  doubleEnter: boolean;
  /** Pause between the text and the Enter, and between the two Enters. */
  delayMs: number;
}

export const DEFAULT_PLAN: SubmitPlan = Object.freeze({ kind: "default", doubleEnter: false, delayMs: 50 });
export const CODEX_PLAN: SubmitPlan = Object.freeze({ kind: "codex", doubleEnter: true, delayMs: 300 });
export const COPILOT_PLAN: SubmitPlan = Object.freeze({ kind: "copilot", doubleEnter: true, delayMs: 300 });

/** Split a command line into tokens, honouring double quotes (Windows
 *  quotes paths with spaces; Unix `ps` prints args space-joined). */
function tokens(commandLine: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(commandLine)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

function basename(token: string): string {
  const parts = token.replace(/\\/g, "/").split("/");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/** The executable plus the first non-flag argument (the script a runtime
 *  such as node runs). Later arguments are data, not identity: a Claude
 *  session started with `--resume codex-notes` is still Claude. */
function identityTokens(commandLine: string): string[] {
  const t = tokens(commandLine);
  if (t.length === 0) return [];
  const exe = t[0];
  const script = t.slice(1).find((a) => !a.startsWith("-"));
  return script === undefined ? [exe] : [exe, script];
}

const RUNTIMES = new Set(["node", "node.exe", "nodejs", "bun", "bun.exe", "deno", "deno.exe"]);

/** Classify a process command line. Pure; null or empty is the default plan. */
export function classifyCommandLine(commandLine: string | null | undefined): SubmitPlan {
  if (!commandLine || !commandLine.trim()) return DEFAULT_PLAN;
  const [exe, script] = identityTokens(commandLine);
  const exeBase = basename(exe);
  // A runtime's identity is the script it runs; anything else is its own.
  const subject = RUNTIMES.has(exeBase) && script !== undefined ? script : exe;
  const path = subject.replace(/\\/g, "/").toLowerCase();
  const base = basename(subject).replace(/\.(exe|js|cjs|mjs)$/, "");

  if (base === "codex" || /(^|\/)@openai\/codex(\/|$)/.test(path) || /(^|\/)codex-cli(\/|$)/.test(path)) {
    return CODEX_PLAN;
  }
  if (base === "copilot" || base.startsWith("copilot-") || /(^|\/)@github\/copilot(\/|$)/.test(path) || /(^|\/)copilot-cli(\/|$)/.test(path)) {
    return COPILOT_PLAN;
  }
  // `gh copilot ...`: the extension runs under gh with "copilot" as its verb.
  if ((exeBase === "gh" || exeBase === "gh.exe") && script?.toLowerCase() === "copilot") return COPILOT_PLAN;
  return DEFAULT_PLAN;
}

export type CommandLineReader = (pid: number, platform: NodeJS.Platform) => Promise<string | null>;

const LOOKUP_TIMEOUT_MS = 4000;

/** One process's command line, or null when it cannot be read. Bounded by
 *  a timeout; never throws. */
export const readCommandLine: CommandLineReader = (pid, platform) => {
  const safePid = Math.floor(pid);
  if (!(safePid > 0)) return Promise.resolve(null);
  const [cmd, args] = platform === "win32"
    ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${safePid}").CommandLine`]] as const
    : ["ps", ["-o", "args=", "-p", String(safePid)]] as const;
  return new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const line = String(stdout).trim();
      resolve(line ? line : null);
    });
  });
};

const CACHE_TTL_MS = 60_000;
const cache = new Map<number, { at: number; plan: Promise<SubmitPlan> }>();

export interface ClassifyDeps {
  read?: CommandLineReader;
  now?: () => number;
}

/**
 * The submit plan for the process a wake types into. Cached per pid for a
 * minute (a pid recycled within that minute keeps the old plan until it
 * expires; the cost of that is one extra or one missing Enter). A failed or
 * empty lookup is the default plan and is not cached, so the next wake
 * tries again.
 */
export function classifyTarget(pid: number, platform: NodeJS.Platform = process.platform, deps: ClassifyDeps = {}): Promise<SubmitPlan> {
  if (!(pid > 0)) return Promise.resolve(DEFAULT_PLAN);
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(pid);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.plan;
  const read = deps.read ?? readCommandLine;
  const entry: { at: number; plan: Promise<SubmitPlan> } = { at: now, plan: Promise.resolve(DEFAULT_PLAN) };
  // Forget a failed lookup, but only if no newer lookup has replaced it.
  const forget = (): void => { if (cache.get(pid) === entry) cache.delete(pid); };
  entry.plan = read(pid, platform).then(
    (line) => {
      if (line === null) forget();
      return classifyCommandLine(line);
    },
    () => { forget(); return DEFAULT_PLAN; }
  );
  cache.set(pid, entry);
  return entry.plan;
}

/** Test hook: forget every cached classification. */
export function resetTargetCache(): void { cache.clear(); }

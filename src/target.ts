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
 * Unix) and identifies the application the process runs.
 *
 * One lookup per wake, never a stale answer. A plan cached by pid would be
 * inherited by whatever process reuses that pid, and learning the process's
 * start time to tell incarnations apart costs the same call as reading its
 * command line, so there is no cross-wake cache: every wake reads the
 * process it is about to type into. The call has a hard timeout, wakes that
 * overlap on one pid share the read in flight, a lifecycle signal (the
 * wake's guard saying the target left or moved) drops that shared read, and
 * any failure is the plain single-Enter plan.
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

function normalise(token: string): string {
  return token.replace(/\\/g, "/").toLowerCase();
}

function basename(token: string): string {
  const parts = normalise(token).split("/");
  return parts[parts.length - 1] ?? "";
}

/** Basename without the extensions an executable or entry script carries. */
function stem(token: string): string {
  return basename(token).replace(/\.(exe|cmd|bat|ps1|js|cjs|mjs|ts)$/, "");
}

/**
 * How the application is identified. Argv parsing was abandoned after three
 * gate rounds (5, 6 and 7): finding a runtime's entry script means knowing
 * every option that takes a separate value, and each round found another
 * (--experimental-config-file, underscore spellings, bare values after
 * unknown options), while any heuristic that scans further walks into the
 * application's own arguments (`node --trace-warnings server codex.js` read
 * as Codex). When the command line is ambiguous the answer is the default
 * plan, not a guess. Identity now comes only from evidence that cannot be an
 * option value by accident:
 *   1. the executable's own name (codex, codex-cli, copilot, copilot-*,
 *      claude, claude-code; .exe and similar stripped), in which case the
 *      arguments are never read: `claude.exe --resume codex-notes` is Claude;
 *   2. `gh copilot`;
 *   3. for a runtime (node, bun, deno, tsx, ts-node), the FIRST argument,
 *      left to right, whose path contains node_modules/<known package>;
 *   4. anything else: the default plan.
 * Known losses, accepted: a Codex source checkout run as
 * `node codex-cli/dist/cli.js` has no package path and gets the single-Enter
 * default; and an absurd `node --require /x/node_modules/@openai/codex/y.js
 * app.js` classifies as Codex, because the package path is present.
 */
const RUNTIMES = new Set(["node", "nodejs", "bun", "deno", "tsx", "ts-node"]);

/** Known applications by the npm package they ship in. */
const PACKAGES: Array<[string, AgentKind]> = [
  ["@openai/codex", "codex"],
  ["@github/copilot", "copilot"],
  ["@githubnext/github-copilot-cli", "copilot"],
  ["@anthropic-ai/claude-code", "default"],
];

/** The known package a path runs from, if any: of the node_modules/<pkg>
 *  segments in it that name a known package, the last one, so a package
 *  nested inside another package's tree is the one that counts. */
function knownPackageIn(token: string): AgentKind | null {
  const re = /node_modules\/((?:@[^/]+\/)?[^/]+)/g;
  const path = normalise(token);
  let found: AgentKind | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    const pkg = m[1];
    const known = PACKAGES.find(([p]) => p === pkg);
    if (known) found = known[1];
  }
  return found;
}

/** An application's own executable name. */
function kindOfName(name: string): AgentKind | null {
  if (name === "codex" || name === "codex-cli") return "codex";
  if (name === "copilot" || name.startsWith("copilot-")) return "copilot";
  if (name === "claude" || name === "claude-code") return "default";
  return null;
}

function planFor(kind: AgentKind): SubmitPlan {
  return kind === "codex" ? CODEX_PLAN : kind === "copilot" ? COPILOT_PLAN : DEFAULT_PLAN;
}

/** Classify a process command line. Pure; null or empty is the default plan. */
export function classifyCommandLine(commandLine: string | null | undefined): SubmitPlan {
  if (!commandLine || !commandLine.trim()) return DEFAULT_PLAN;
  const t = tokens(commandLine);
  if (t.length === 0) return DEFAULT_PLAN;
  const exeStem = stem(t[0]);
  // 1. The executable names the application: its arguments are never read.
  const own = kindOfName(exeStem);
  if (own !== null) return planFor(own);
  // 2. `gh copilot ...`: the extension runs under gh with "copilot" as its verb.
  if (exeStem === "gh" && t[1]?.toLowerCase() === "copilot") return COPILOT_PLAN;
  // 3. A runtime: the first argument carrying a known package path decides.
  if (RUNTIMES.has(exeStem)) {
    for (const arg of t.slice(1)) {
      const kind = knownPackageIn(arg);
      if (kind !== null) return planFor(kind);
    }
  }
  // 4. Nothing we can identify without guessing.
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

/** Reads in flight, by pid: wakes that overlap on one process share one. */
const inFlight = new Map<number, Promise<SubmitPlan>>();

export interface ClassifyDeps {
  read?: CommandLineReader;
}

/**
 * The submit plan for the process a wake is about to type into, read now.
 * A failed or empty read is the single-Enter default; it never throws.
 */
export function classifyTarget(pid: number, platform: NodeJS.Platform = process.platform, deps: ClassifyDeps = {}): Promise<SubmitPlan> {
  if (!(pid > 0)) return Promise.resolve(DEFAULT_PLAN);
  const shared = inFlight.get(pid);
  if (shared) return shared;
  const read = deps.read ?? readCommandLine;
  const plan: Promise<SubmitPlan> = read(pid, platform).then(
    (line) => classifyCommandLine(line),
    () => DEFAULT_PLAN
  ).finally(() => {
    if (inFlight.get(pid) === plan) inFlight.delete(pid);
  });
  inFlight.set(pid, plan);
  return plan;
}

/** A lifecycle signal for this pid (the wake's guard said the target left
 *  or moved): nothing read before it may serve a later wake. */
export function forgetTarget(pid: number): void {
  inFlight.delete(pid);
}

/** Test hook: forget every read in flight. */
export function resetTargetCache(): void { inFlight.clear(); }

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

const RUNTIMES = new Set(["node", "nodejs", "bun", "deno"]);

/** Runtime options that take their value as the NEXT argument. The `=` form
 *  (`--inspect=9229`, `--max-old-space-size=4096`) is one token and needs no
 *  entry here. Node's list, plus the few Bun and Deno spell the same way. */
const OPTIONS_WITH_VALUE = new Set([
  "-r", "--require", "--import", "--loader", "--experimental-loader",
  "-C", "--conditions", "--input-type", "--env-file", "--env-file-if-exists", "--title", "--inspect-port",
  "--experimental-default-type", "--experimental-sea-config", "--localstorage-file", "--run",
  "--test-name-pattern", "--test-skip-pattern", "--test-shard", "--test-isolation",
  "--test-coverage-include", "--test-coverage-exclude", "--snapshot-blob",
  "--cpu-prof-dir", "--cpu-prof-name", "--heap-prof-dir", "--heap-prof-name",
  "--redirect-warnings", "--diagnostic-dir", "--icu-data-dir", "--openssl-config",
  "--watch-path", "--experimental-policy", "--policy-integrity", "--heapsnapshot-signal",
  "--report-dir", "--report-directory", "--report-filename", "--report-signal",
  "--trace-event-categories", "--trace-event-file-pattern", "--unhandled-rejections",
  "--tls-cipher-list", "--disable-proto", "--dns-result-order", "--max-http-header-size",
  "--secure-heap", "--secure-heap-min", "--test-reporter", "--test-reporter-destination",
  "--config", "--cwd", "--preload", "--import-map", "--lock", "--cert", "--location",
]);
/** Options whose value is the program itself: there is no entry script. */
const INLINE_PROGRAM = new Set(["-e", "--eval", "-p", "--print"]);
/** Runtimes that take a `run` subcommand before the script (`bun run x`,
 *  `deno run x`). For node, `run` is just a file name. */
const RUN_SUBCOMMAND_RUNTIMES = new Set(["bun", "deno"]);

/**
 * Node accepts `_` for `-` inside long option names; compare the hyphen form.
 * Short options keep their case (node's -C takes a value, -c does not).
 */
function normalizeOption(flag: string): string {
  return flag.startsWith("--") ? flag.replace(/_/g, "-") : flag;
}

/** Does a token look like a script a runtime would execute: a path (has a
 *  separator) or a file with a script extension? A bare word such as
 *  `ExperimentalWarning`, `5000` or `.env` does not. */
export function looksLikeScript(token: string): boolean {
  if (token.includes("/") || token.includes("\\")) return true;
  return /\.(c|m)?[jt]sx?$/i.test(token);
}

/**
 * The entry script a runtime runs, or null when there is none (an inline
 * `-e` program, a bare REPL). Options and their values are skipped, `--`
 * ends the options, and a `run` subcommand is stepped over. Node's list of
 * value-taking options is long and grows with every release, so the known
 * ones are skipped by name and, for any OTHER option, a following bare word
 * (no path separator, no script extension) is taken as its value rather
 * than as the entry script. The one thing this cannot tell apart is a
 * boolean option followed by an extension-less script name; node itself
 * would run that file, and this classifier then reports the default plan.
 */
export function entryScript(args: string[], runtime = "node"): string | null {
  let i = 0;
  let sawSubcommand = !RUN_SUBCOMMAND_RUNTIMES.has(runtime);
  while (i < args.length) {
    const a = args[i];
    if (a === "--") return args[i + 1] ?? null;
    const flag = normalizeOption(a.split("=")[0]);
    if (INLINE_PROGRAM.has(flag)) return null;
    if (a.startsWith("-")) {
      if (a.includes("=")) { i += 1; continue; }
      if (OPTIONS_WITH_VALUE.has(flag)) { i += 2; continue; }
      const next = args[i + 1];
      // Unknown option: a bare word after it is its value, a script is the entry.
      if (next != null && !next.startsWith("-") && !looksLikeScript(next) && !(!sawSubcommand && next === "run")) { i += 2; continue; }
      i += 1;
      continue;
    }
    if (!sawSubcommand && a === "run") { sawSubcommand = true; i++; continue; }
    return a;
  }
  return null;
}

/** Known applications by the npm package they ship in. */
const PACKAGES: Array<[string, AgentKind]> = [
  ["@openai/codex", "codex"],
  ["@github/copilot", "copilot"],
  ["@githubnext/github-copilot-cli", "copilot"],
  ["@anthropic-ai/claude-code", "default"],
];

/** The package a path runs from: the LAST `node_modules/<pkg>` in it, so a
 *  package nested in another package's tree is the one that counts. */
function packageOf(path: string): string | null {
  // Windows command lines carry backslashes; match on one separator form.
  const re = /node_modules\/((?:@[^/]+\/)?[^/]+)/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path.replace(/\\/g, "/"))) !== null) last = m[1];
  return last;
}

/** An application's own name, as its executable or entry script. */
function kindOfName(name: string): AgentKind | null {
  if (name === "codex" || name === "codex-cli") return "codex";
  if (name === "copilot" || name.startsWith("copilot-")) return "copilot";
  if (name === "claude" || name === "claude-code") return "default";
  return null;
}

/** Entry points that say nothing about the application they start. */
const GENERIC_ENTRIES = new Set(["index", "main", "cli", "bin", "run", "start", "app", "entry"]);
/** Build and layout folders between an application's root and its entry. */
const LAYOUT_DIRS = new Set(["dist", "bin", "build", "lib", "src", "out", "cli", "esm", "cjs"]);

/**
 * The application a path starts, most explicit evidence first:
 *   1. the npm package it runs from (the last node_modules/<pkg>);
 *   2. the entry point's own name (codex.exe, copilot, claude);
 *   3. only for a generic entry (cli.js, index.js), its application root:
 *      the first parent folder that is not a build or layout folder.
 * Folders above that root are never consulted, so a checkout folder named
 * codex-cli does not make every tool inside it Codex.
 */
function kindOfPath(subject: string): AgentKind {
  const path = normalise(subject);
  const pkg = packageOf(path);
  if (pkg !== null) {
    const known = PACKAGES.find(([p]) => p === pkg);
    if (known) return known[1];
  }
  const own = kindOfName(stem(subject));
  if (own !== null) return own;
  if (pkg === null && GENERIC_ENTRIES.has(stem(subject))) {
    const dirs = path.split("/").slice(0, -1);
    for (let i = dirs.length - 1; i >= 0; i--) {
      if (LAYOUT_DIRS.has(dirs[i])) continue;
      return kindOfName(dirs[i]) ?? "default";
    }
  }
  return "default";
}

function planFor(kind: AgentKind): SubmitPlan {
  return kind === "codex" ? CODEX_PLAN : kind === "copilot" ? COPILOT_PLAN : DEFAULT_PLAN;
}

/** Classify a process command line. Pure; null or empty is the default plan. */
export function classifyCommandLine(commandLine: string | null | undefined): SubmitPlan {
  if (!commandLine || !commandLine.trim()) return DEFAULT_PLAN;
  const t = tokens(commandLine);
  if (t.length === 0) return DEFAULT_PLAN;
  const exe = t[0];
  const exeStem = stem(exe);
  if (RUNTIMES.has(exeStem)) {
    // A runtime's identity is the script it runs; with no script (an inline
    // program, a REPL) it is nothing we know.
    const script = entryScript(t.slice(1), exeStem);
    return script === null ? DEFAULT_PLAN : planFor(kindOfPath(script));
  }
  // `gh copilot ...`: the extension runs under gh with "copilot" as its verb.
  if (exeStem === "gh" && t[1]?.toLowerCase() === "copilot") return COPILOT_PLAN;
  return planFor(kindOfPath(exe));
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

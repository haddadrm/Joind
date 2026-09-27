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
 * overlap on one pid share the read in flight, and a lifecycle signal (the
 * wake's guard saying the target left or moved) drops that shared read.
 *
 * A lookup that did not answer is not an answer (field log, 27 Sep 2026: a
 * Codex TUI classified "codex" alone was classified "default" when two
 * lookups overlapped and both ran past the limit, and its prompts sat
 * unsubmitted). A confident read ("this command line is no known target")
 * is the single-Enter default; a read that timed out, failed, or could not
 * see the command line is UNKNOWN_PLAN, and says so in the log. It presses
 * Enter once, after the longer 300 ms pause: a second Enter sent blind is
 * not harmless (gate round 5: into a Claude Code session that is mid-turn,
 * the first Enter queues the prompt and a permission dialog that opens in
 * the gap would take the second Enter as its confirmation). An unsubmitted
 * prompt can be recovered; an approved tool call cannot. The cure for
 * "unknown" is a lookup that answers, which the cost changes below make the
 * common case.
 *
 * Cost. On Windows the read is a PowerShell CIM query: a cold Windows
 * PowerShell 5.1 start measured about 2.7 s, pwsh about 0.9 s, the query in
 * a warm shell about 0.2 s. So pwsh is preferred when installed, and reads
 * are coalesced: one shell reads every pid asked for since the previous
 * shell started, so N simultaneous wakes cost one shell start, not N. A read
 * asked for while a shell runs waits for the next one (never served by a
 * query that started before it was asked: no stale answers).
 */

import { execFile } from "child_process";
import { existsSync } from "fs";
import { realpath as fsRealpath } from "fs/promises";
import { isAbsolute, join } from "path";

/** "unknown": the lookup did not answer; see UNKNOWN_PLAN. */
export type AgentKind = "codex" | "copilot" | "default" | "unknown";

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
/** The lookup did not answer: one Enter after the longer pause, never a
 *  blind second Enter (it could confirm a dialog; see the file header). */
export const UNKNOWN_PLAN: SubmitPlan = Object.freeze({ kind: "unknown", doubleEnter: false, delayMs: 300 });

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
 *   3. for a runtime (node, bun, deno, tsx, ts-node) whose first argument
 *      is a script (does not start with "-"), that argument alone, never a
 *      later one: its own name if it is a known application name (a global
 *      bin link such as /usr/local/bin/copilot), else a node_modules/<known
 *      package> in its path, else (in the async lookup only, see
 *      classifyTarget) the same two checks on its realpath, since a global
 *      bin symlink resolves into node_modules/<package>/bin/...; nothing
 *      found is the default plan (gate round 8: scanning later arguments
 *      made `node /usr/local/bin/claude --add-dir .../node_modules/@openai/codex`
 *      read as Codex);
 *   4. for a runtime whose first argument is an option, the weaker fallback:
 *      the first argument anywhere whose path contains node_modules/<known
 *      package> (so `node --require x .../@openai/codex/bin/codex.js` is
 *      Codex and `node --trace-warnings server codex.js` is not);
 *   5. anything else: the default plan.
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
  return kind === "codex" ? CODEX_PLAN : kind === "copilot" ? COPILOT_PLAN : kind === "unknown" ? UNKNOWN_PLAN : DEFAULT_PLAN;
}

/** A script path's own identity: its name, else a known package in it. */
function kindOfScript(path: string): AgentKind | null {
  return kindOfName(stem(path)) ?? knownPackageIn(path);
}

interface Identification {
  plan: SubmitPlan;
  /** A runtime's first-argument script that neither its name nor its path
   *  identified: the async lookup may resolve it (symlinks) and look again. */
  unresolvedScript?: string;
}

function identify(commandLine: string | null | undefined): Identification {
  if (!commandLine || !commandLine.trim()) return { plan: DEFAULT_PLAN };
  const t = tokens(commandLine);
  if (t.length === 0) return { plan: DEFAULT_PLAN };
  const exeStem = stem(t[0]);
  // 1. The executable names the application: its arguments are never read.
  const own = kindOfName(exeStem);
  if (own !== null) return { plan: planFor(own) };
  // 2. `gh copilot ...`: the extension runs under gh with "copilot" as its verb.
  if (exeStem === "gh" && t[1]?.toLowerCase() === "copilot") return { plan: COPILOT_PLAN };
  if (RUNTIMES.has(exeStem)) {
    // Bun and Deno put a fixed `run` subcommand before their arguments; that
    // one word is stepped over (a subcommand, not an option to parse).
    const args = (exeStem === "bun" || exeStem === "deno") && t[1] === "run" ? t.slice(2) : t.slice(1);
    const first = args[0];
    if (first !== undefined && !first.startsWith("-")) {
      // 3. The first argument is the script: it alone decides; later
      //    arguments belong to the application and are never read.
      const kind = kindOfScript(first);
      if (kind !== null) return { plan: planFor(kind) };
      return { plan: DEFAULT_PLAN, unresolvedScript: first };
    }
    // 4. Options first: the weaker fallback, the first known package path
    //    anywhere on the line.
    for (const arg of args) {
      const kind = knownPackageIn(arg);
      if (kind !== null) return { plan: planFor(kind) };
    }
  }
  // 5. Nothing we can identify without guessing.
  return { plan: DEFAULT_PLAN };
}

/** Classify a process command line. Pure, no I/O: a script that only a
 *  symlink would identify is the default plan here (classifyTarget resolves
 *  it). Null or empty is the default plan. */
export function classifyCommandLine(commandLine: string | null | undefined): SubmitPlan {
  return identify(commandLine).plan;
}

export type Realpath = (path: string) => Promise<string>;

/**
 * classifyCommandLine plus the one filesystem step: a runtime's first-argument
 * script that its name and path did not identify is resolved with realpath
 * (only when absolute: a relative path is relative to the target's working
 * directory, which is not ours), and the resolved path gets the same two
 * checks. Bounded by `deadlineMs`: a resolve that does not finish in time is
 * UNKNOWN_PLAN (no answer); a resolve that fails (a dangling link) is the
 * default plan (an answer: nothing known runs there).
 */
export async function classifyCommandLineResolved(
  commandLine: string | null | undefined,
  opts: { realpath?: Realpath; deadlineMs?: number } = {}
): Promise<SubmitPlan> {
  const found = identify(commandLine);
  const script = found.unresolvedScript;
  if (script === undefined || !(isAbsolute(script) || script.startsWith("/"))) return found.plan;
  const realpath = opts.realpath ?? ((p: string) => fsRealpath(p));
  const remaining = Math.max(0, opts.deadlineMs ?? LOOKUP_TIMEOUT_MS);
  let timer: NodeJS.Timeout | undefined;
  try {
    const resolved = await Promise.race([
      realpath(script),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), remaining); }),
    ]);
    if (resolved === null) return UNKNOWN_PLAN;
    const kind = kindOfScript(resolved);
    return kind === null ? DEFAULT_PLAN : planFor(kind);
  } catch {
    return DEFAULT_PLAN;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A reader for one pid: the command line, or null when no such process
 *  exists (an answer). It rejects when it could not find out (a timeout,
 *  an error, a command line it was not allowed to see): LookupFailed. */
export type CommandLineReader = (pid: number, platform: NodeJS.Platform) => Promise<string | null>;

/** Per shell start. Wide on purpose: one cold Windows PowerShell start was
 *  measured at about 2.7 s, and a lookup that runs out is a guess. */
export const LOOKUP_TIMEOUT_MS = 10000;

/** The read could not tell: "timeout" or "error" (including "hidden", a
 *  process whose command line the query was not allowed to read). */
export class LookupFailed extends Error {
  constructor(message: string, public readonly reason: "timeout" | "error" | "hidden") {
    super(message);
    this.name = "LookupFailed";
  }
}

/** What one shell start read: each asked pid's command line (null: no such
 *  process), or undefined for a process listed without a readable one. */
export interface BatchRead {
  lines: Map<number, string | null | undefined>;
  via: string;
}
export type BatchRunner = (pids: number[], platform: NodeJS.Platform) => Promise<BatchRead>;

/** The shells to try on Windows, cheapest first: pwsh (PowerShell 7) from
 *  PATH or its default install folder, then Windows PowerShell. */
export function powerShellCandidates(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string[] {
  const out: string[] = [];
  const path = env.PATH ?? env.Path ?? "";
  for (const dir of path.split(";")) {
    if (dir && exists(join(dir, "pwsh.exe"))) { out.push(join(dir, "pwsh.exe")); break; }
  }
  const pf = env.ProgramFiles;
  if (out.length === 0 && pf && exists(join(pf, "PowerShell", "7", "pwsh.exe"))) out.push(join(pf, "PowerShell", "7", "pwsh.exe"));
  out.push("powershell");
  return out;
}

/** The runner for one command: stdout, or a LookupFailed. `missing` is set
 *  when the executable itself does not exist (so the next shell is tried). */
export type ExecLookup = (cmd: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr?: string; exitCode: number; missing?: boolean }>;
const realExec: ExecLookup = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
    if (!err) { resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 }); return; }
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: string | number };
    if (e.code === "ENOENT") { resolve({ stdout: "", exitCode: -1, missing: true }); return; }
    if (e.killed || e.signal) { reject(new LookupFailed(`${cmd} did not answer within ${timeoutMs} ms`, "timeout")); return; }
    if (typeof e.code === "number") { resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: e.code }); return; }
    reject(new LookupFailed(`${cmd} failed (${String(e.code ?? e.message).slice(0, 80)})`, "error"));
  });
});

/** The PowerShell command for several pids: one CIM query, JSON out, UTF-8.
 *  Every error is terminating, so a query that could not run (access denied,
 *  a broken WMI) exits nonzero instead of printing an empty list that would
 *  read as "no such process". Pids are positive integers by construction. */
export function cimCommand(pids: number[]): string {
  const filter = pids.map((p) => `ProcessId=${Math.floor(p)}`).join(" OR ");
  return "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
    `$r = @(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; c = $_.CommandLine } }); ` +
    "ConvertTo-Json -InputObject $r -Compress";
}

/** Parse the CIM JSON: an array of { p, c } (or one such object). Anything
 *  else, empty output included, is an error: only a query that answered
 *  may say a process does not exist. */
export function parseCimLines(stdout: string, pids: number[]): Map<number, string | null | undefined> {
  const unreadable = (): LookupFailed => new LookupFailed("the process query answered with unreadable output", "error");
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim()); } catch { throw unreadable(); }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out = new Map<number, string | null | undefined>(pids.map((p) => [p, null]));
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw unreadable();
    const { p, c } = row as { p?: unknown; c?: unknown };
    if (typeof p !== "number" || !Number.isInteger(p) || (c !== null && c !== undefined && typeof c !== "string")) throw unreadable();
    if (!out.has(p)) continue;
    out.set(p, typeof c === "string" && c.trim() ? c.trim() : undefined);
  }
  return out;
}

/** `ps -o pid=,args=` output to a map; a pid ps did not list is null. */
export function parsePsLines(stdout: string, pids: number[]): Map<number, string | null | undefined> {
  const out = new Map<number, string | null | undefined>(pids.map((p) => [p, null]));
  for (const raw of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    const pid = Number(m[1]);
    if (out.has(pid)) out.set(pid, m[2]);
  }
  return out;
}

/** The index of the first Windows shell that exists, learned once. */
let shellIndex = 0;

/** The real batch runner: one shell start for all `pids`. */
export function makeBatchRunner(deps: { exec?: ExecLookup; candidates?: () => string[] } = {}): BatchRunner {
  const exec = deps.exec ?? realExec;
  const candidates = deps.candidates ?? (() => powerShellCandidates());
  return async (pids, platform) => {
    if (platform !== "win32") {
      const r = await exec("ps", ["-o", "pid=,args=", "-p", pids.join(",")], LOOKUP_TIMEOUT_MS);
      if (r.missing) throw new LookupFailed("ps not found", "error");
      // ps exits 1, silently, when it selected no process: an answer, none of
      // them exist. Any other failure (another code, or a diagnostic) is not.
      if ((r.stderr ?? "").trim() !== "") throw new LookupFailed(`ps reported an error (exit ${r.exitCode})`, "error");
      if (r.exitCode === 1 && r.stdout.trim() === "") return { lines: new Map(pids.map((p) => [p, null])), via: "ps" };
      if (r.exitCode !== 0) throw new LookupFailed(`ps exited ${r.exitCode}`, "error");
      return { lines: parsePsLines(r.stdout, pids), via: "ps" };
    }
    const shells = candidates();
    for (let i = Math.min(shellIndex, shells.length - 1); i < shells.length; i++) {
      const shell = shells[i];
      const r = await exec(shell, ["-NoProfile", "-NonInteractive", "-Command", cimCommand(pids)], LOOKUP_TIMEOUT_MS);
      if (r.missing) { shellIndex = i + 1; continue; }
      if (r.exitCode !== 0) throw new LookupFailed(`${shell} exited ${r.exitCode}`, "error");
      // A non-terminating error the preference did not catch still counts.
      if ((r.stderr ?? "").trim() !== "") throw new LookupFailed(`${shell} reported an error`, "error");
      return { lines: parseCimLines(r.stdout, pids), via: /pwsh/i.test(shell) ? "pwsh" : "powershell" };
    }
    throw new LookupFailed("no PowerShell found", "error");
  };
}

interface Waiter { resolve: (v: { line: string | null; via: string; batch: number }) => void; reject: (e: unknown) => void; }

/**
 * Coalesces reads: every pid asked for while no shell runs goes into the
 * next shell start together; a pid asked for while one runs waits for the
 * one after it (never answered by a query that began before it was asked).
 */
export class CommandLineBatcher {
  private queued = new Map<number, Waiter[]>();
  private running = false;
  private scheduled = false;
  constructor(private run: BatchRunner, private platform: NodeJS.Platform = process.platform) {}

  read(pid: number): Promise<{ line: string | null; via: string; batch: number }> {
    return new Promise((resolve, reject) => {
      const list = this.queued.get(pid) ?? [];
      list.push({ resolve, reject });
      this.queued.set(pid, list);
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.running || this.scheduled || this.queued.size === 0) return;
    this.scheduled = true;
    // One turn of the event loop: wakes asked for together share one shell.
    setImmediate(() => { this.scheduled = false; void this.start(); });
  }

  private async start(): Promise<void> {
    if (this.running || this.queued.size === 0) return;
    this.running = true;
    const batch = this.queued;
    this.queued = new Map();
    const pids = [...batch.keys()];
    try {
      const r = await this.run(pids, this.platform);
      for (const [pid, waiters] of batch) {
        const line = r.lines.get(pid);
        for (const w of waiters) {
          if (line === undefined) w.reject(new LookupFailed(`the command line of pid ${pid} is not readable`, "hidden"));
          else w.resolve({ line, via: r.via, batch: pids.length });
        }
      }
    } catch (err) {
      for (const waiters of batch.values()) for (const w of waiters) w.reject(err);
    } finally {
      this.running = false;
      this.schedule();
    }
  }
}

/** One batcher per platform asked for (tests ask for another platform). */
const batchers = new Map<NodeJS.Platform, CommandLineBatcher>();
function batcher(platform: NodeJS.Platform): CommandLineBatcher {
  let b = batchers.get(platform);
  if (!b) { b = new CommandLineBatcher(makeBatchRunner(), platform); batchers.set(platform, b); }
  return b;
}

/** The most a read may take, queue included: one shell start ahead of it
 *  and its own, each bounded by LOOKUP_TIMEOUT_MS, plus a margin. A read
 *  past it is a lookup that did not answer. */
export const LOOKUP_WAIT_LIMIT_MS = 2 * LOOKUP_TIMEOUT_MS + 1000;

/** Reads in flight, by pid: wakes that overlap on one process share one. */
const inFlight = new Map<number, Promise<SubmitPlan>>();

export interface ClassifyDeps {
  /** One pid's reader; defaults to the shared batcher. */
  read?: CommandLineReader;
  /** The shared reader, injectable for tests; defaults to one per platform. */
  batcher?: CommandLineBatcher;
  /** Log sink, injectable for tests. */
  log?: (line: string) => void;
  /** Injectable for tests; defaults to fs.promises.realpath. */
  realpath?: Realpath;
  now?: () => number;
}

/**
 * The submit plan for the process a wake is about to type into, read now.
 * A confident read decides (no such process, or no known application: the
 * single-Enter default); a read that did not answer is UNKNOWN_PLAN. It
 * never throws, and logs one line per read: its duration, its shell and
 * the plan, or why the target stayed unidentified.
 */
export function classifyTarget(pid: number, platform: NodeJS.Platform = process.platform, deps: ClassifyDeps = {}): Promise<SubmitPlan> {
  if (!(pid > 0)) return Promise.resolve(DEFAULT_PLAN);
  const shared = inFlight.get(pid);
  if (shared) return shared;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  const reader: (p: number) => Promise<{ line: string | null; via: string; batch: number }> = deps.read
    ? async (p) => ({ line: await deps.read!(p, platform), via: "reader", batch: 1 })
    : (p) => (deps.batcher ?? batcher(platform)).read(p);
  // One budget for the whole lookup: reading the command line and, when
  // needed, resolving the script it runs.
  const started = now();
  let waitTimer: NodeJS.Timeout | undefined;
  const bounded = Promise.race([
    reader(pid),
    new Promise<never>((_, reject) => {
      waitTimer = setTimeout(() => reject(new LookupFailed(`no answer within ${LOOKUP_WAIT_LIMIT_MS} ms`, "timeout")), LOOKUP_WAIT_LIMIT_MS);
      waitTimer.unref?.();
    }),
  ]).finally(() => { if (waitTimer) clearTimeout(waitTimer); });
  const plan: Promise<SubmitPlan> = bounded.then(
    async (r) => {
      const p = await classifyCommandLineResolved(r.line, { realpath: deps.realpath, deadlineMs: LOOKUP_TIMEOUT_MS - (now() - started) });
      const ms = now() - started;
      const shared = r.batch > 1 ? `, one query for ${r.batch} pids` : "";
      log(p.kind === "unknown"
        ? `  [target] pid=${pid} lookup ${ms} ms via ${r.via}${shared}: resolving the script timed out; target unidentified; pressing Enter once (a Codex or Copilot session may need Enter by hand)`
        : `  [target] pid=${pid} lookup ${ms} ms via ${r.via}${shared}: ${p.kind}`);
      return p;
    },
    (err: unknown) => {
      const ms = now() - started;
      const why = err instanceof LookupFailed
        ? (err.reason === "timeout" ? `timed out after ${ms} ms` : err.reason === "hidden" ? `could not see the command line after ${ms} ms` : `failed after ${ms} ms (${err.message.slice(0, 100)})`)
        : `failed after ${ms} ms (${(err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 100)})`;
      log(`  [target] pid=${pid} target lookup ${why}; target unidentified; pressing Enter once (a Codex or Copilot session may need Enter by hand)`);
      return UNKNOWN_PLAN;
    }
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

/** Test hook: forget every read in flight, the shell choice and the batcher. */
export function resetTargetCache(): void { inFlight.clear(); shellIndex = 0; batchers.clear(); }

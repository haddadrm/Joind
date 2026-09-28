/**
 * Codex queue backend. Codex CLI 0.158 and later can hand a message to a
 * running session without typing: `codex queue --thread <THREAD> --message
 * <TEXT>` ("Queue a message for an existing session"). No keys are typed,
 * so the TUI's paste-burst detection cannot swallow the Enter (field
 * finding, 28 Sep 2026: a typed wake sat unsent in a Codex input box for
 * hours).
 *
 * A member opts in by joining with `codexThread` (a session UUID; names are
 * refused, see isCodexThread) and, when its Codex runs with a home other
 * than the server's, `codexHome`. The route is tried first; what happens
 * next depends on what the CLI said (see classifyCodexQueue):
 *   exit 0                                  accepted: no keys, no submit check
 *   proven before any handoff: the CLI      CodexQueueNotHandedOff: the
 *     is missing (spawn ENOENT), or it        caller may fall back to the
 *     said the thread has no rollout in       keystroke routes, through the
 *     this home                               same guard as the Orca path
 *   anything else (a timeout, a kill, a     UnconfirmedDeliveryError: the
 *     spawn error other than ENOENT, any      message may be queued already,
 *     other nonzero exit or wording)          so never a fallback or retry
 *
 * Observed on Windows, codex-cli 0.158.0, 28 Sep 2026, only ever against
 * random UUIDs that name no session (nothing can be delivered):
 *   exit 1 in about 0.3 s with the live ~/.codex (its app-server daemon up),
 *   and in 1.5 s with an empty scratch CODEX_HOME (no daemon there), stderr
 *   both times "Error: failed to queue session message: thread/queue/add
 *   failed: failed to read thread: invalid thread-store request: no rollout
 *   found for thread id <uuid> (code -32603)".
 * That is the one wording taken as proof. A missing daemon was not an error
 * of its own: with no daemon in the home the CLI still ran the request
 * (in process, as far as can be seen: it created queue_1.sqlite, state and
 * log databases in the empty home and left no process behind).
 *
 * Which Codex it talks to: everything is under CODEX_HOME (default
 * ~/.codex). The thread store is $CODEX_HOME/sessions, the queue a SQLite
 * database there (queue_1.sqlite), and a running daemon keeps its control
 * socket at $CODEX_HOME/app-server-control/app-server-control.sock and its
 * pid under $CODEX_HOME/app-server-daemon. On the Y530 two daemons run side
 * by side, ~/.codex and an Orca runtime home, so the server's own CODEX_HOME
 * may not be the target's. The run therefore sets CODEX_HOME to the
 * member's codexHome when it gave one; otherwise it inherits the server's.
 * A thread that is not in the home used is the proven "no rollout" case, so
 * a wrong home falls back to keys rather than queueing somewhere unseen.
 * (`--remote unix://PATH` could name a daemon socket instead; it is not
 * used, since the thread store follows CODEX_HOME either way.)
 *
 * Windows invocation. npm installs codex as codex.cmd (a batch shim that
 * runs node on bin/codex.js, which spawns the native codex.exe). Node will
 * not spawn a .cmd without a shell, and a shell would re-parse the prompt
 * (it carries `&`, `|` and quotes). So the native codex.exe is found and run
 * directly: from JOIND_CODEX_BIN when set (a .cmd or .bat there is swapped
 * for the codex.exe of the npm package beside it), else codex.exe on PATH,
 * else the codex.exe inside the npm package of the first codex.cmd on PATH.
 * Running the native binary also means the timeout's kill reaches the
 * process that holds the message (killing the node launcher would leave it
 * running). The argv goes through libuv's CreateProcess quoting, which the
 * Rust argument parser decodes exactly; no shell sees it.
 */

import { execFile } from "child_process";
import { existsSync } from "fs";
import { delimiter, dirname, join } from "path";
import { performance } from "perf_hooks";
import { UnconfirmedDeliveryError } from "./orca.js";

/** How long one `codex queue` may run before it is killed. */
export const CODEX_QUEUE_TIMEOUT_MS = 20000;

/** A Codex session UUID (8-4-4-4-12 hex). Session names are refused on
 *  purpose: `codex queue --thread` accepts an exact session name too, but a
 *  name is a mutable selector (a rename or a new session can take it over),
 *  while a UUID names one session for good. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** True for a value that may be handed to `codex queue --thread`. */
export function isCodexThread(value: string): boolean {
  return UUID.test(value);
}

/** A join's codexThread or codexHome: absent (undefined), a valid value, or
 *  an error. An empty or blank string counts as absent (an unset variable in
 *  a snippet). */
export type JoinParse = { ok: true; value: string | undefined } | { ok: false; error: string };

export function parseCodexThread(raw: unknown): JoinParse {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, error: "codexThread must be a string" };
  const v = raw.trim();
  if (v === "") return { ok: true, value: undefined };
  if (!isCodexThread(v)) return { ok: false, error: "codexThread must be a Codex session UUID (8-4-4-4-12 hex); session names are not accepted" };
  return { ok: true, value: v.toLowerCase() };
}

/** An absolute path in this server's own terms: a drive or UNC path on
 *  Windows (never a root-relative "\\x"), a "/" path elsewhere. */
function isAbsoluteHere(p: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p);
  return p.startsWith("/");
}

/**
 * A join's codexHome: the CODEX_HOME of the target session, so `codex queue`
 * reads the same thread store and writes the same queue as the session.
 * It must be an absolute path to an existing Codex home (one with a
 * `sessions` directory): the CLI creates a whole Codex home in any directory
 * it is pointed at (seen on 28 Sep 2026 with an empty directory), so a typo
 * is refused here rather than populated later.
 */
export function parseCodexHome(raw: unknown, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): JoinParse {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, error: "codexHome must be a string" };
  const v = raw.trim();
  if (v === "") return { ok: true, value: undefined };
  // No control characters, no parent segments, bounded.
  if (v.length > 1024 || /[\u0000-\u001f\u007f]/.test(v) || /(^|[\\/])\.\.([\\/]|$)/.test(v) || !isAbsoluteHere(v, platform)) {
    return { ok: false, error: "codexHome must be an absolute path (no '..', no control characters)" };
  }
  if (!exists(join(v, "sessions"))) return { ok: false, error: "codexHome is not a Codex home on this server (no sessions directory in it)" };
  return { ok: true, value: v };
}

/** How to start the Codex CLI: the executable and any leading arguments. */
export interface CodexInvocation { file: string; args: string[] }

/** The codex.exe inside the npm package whose shim lives in `shimDir`. */
function nativeBesideShim(shimDir: string, exists: (p: string) => boolean): string | undefined {
  const pkg = join(shimDir, "node_modules", "@openai", "codex");
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const platformPkg = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const candidates = [
    join(pkg, "node_modules", "@openai", platformPkg, "vendor", triple, "bin", "codex.exe"),
    join(shimDir, "node_modules", "@openai", platformPkg, "vendor", triple, "bin", "codex.exe"),
    join(pkg, "vendor", triple, "bin", "codex.exe"),
  ];
  return candidates.find((c) => exists(c));
}

/**
 * The Codex CLI to run (see the file header). A name that cannot be found
 * is returned as is, so the run fails with ENOENT: before any handoff.
 */
export function resolveCodexCli(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): CodexInvocation {
  const override = env.JOIND_CODEX_BIN?.trim();
  if (platform !== "win32") return { file: override || "codex", args: [] };
  if (override) {
    if (/\.(cmd|bat)$/i.test(override)) {
      const native = nativeBesideShim(dirname(override), exists);
      // Never the batch file itself: a shell would re-parse the prompt.
      return { file: native ?? override.replace(/\.(cmd|bat)$/i, ".exe"), args: [] };
    }
    return { file: override, args: [] };
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).map((d) => d.trim()).filter(Boolean);
  for (const d of dirs) {
    const exe = join(d, "codex.exe");
    if (exists(exe)) return { file: exe, args: [] };
  }
  for (const d of dirs) {
    if (!exists(join(d, "codex.cmd"))) continue;
    const native = nativeBesideShim(d, exists);
    if (native) return { file: native, args: [] };
  }
  return { file: "codex.exe", args: [] };
}

/** What one `codex queue` run did. */
export type CodexQueueRun =
  | { kind: "exit"; code: number; stdout: string; stderr: string }
  /** The process never started; `code` is the spawn error's (ENOENT, EACCES, ...). */
  | { kind: "not-started"; code: string }
  /** Killed at the time limit. */
  | { kind: "timeout" }
  /** Ended by a signal before the limit, or any other process error. */
  | { kind: "killed"; why: string };

export interface CodexQueueRunOptions {
  timeoutMs: number;
  /** The child's whole environment. */
  env: NodeJS.ProcessEnv;
}

export type CodexQueueRunner = (inv: CodexInvocation, args: string[], opts: CodexQueueRunOptions) => Promise<CodexQueueRun>;

/** The one place a Codex process is started. No shell, argv only, no stdin. */
export const runCodexQueue: CodexQueueRunner = (inv, args, opts) => new Promise((resolve) => {
  const t0 = performance.now();
  const child = execFile(inv.file, [...inv.args, ...args], {
    timeout: opts.timeoutMs, env: opts.env, windowsHide: true, shell: false, maxBuffer: 1024 * 1024, encoding: "utf8",
  }, (err, stdout, stderr) => {
    if (!err) { resolve({ kind: "exit", code: 0, stdout, stderr }); return; }
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
    // A spawn failure carries a string code and leaves no pid; an exit carries a number.
    if (typeof e.code === "string" && child.pid === undefined) { resolve({ kind: "not-started", code: e.code }); return; }
    if (typeof e.code === "number") { resolve({ kind: "exit", code: e.code, stdout, stderr }); return; }
    const elapsed = performance.now() - t0;
    if (e.killed && elapsed >= opts.timeoutMs - 50) { resolve({ kind: "timeout" }); return; }
    resolve({ kind: "killed", why: e.signal ? `signal ${e.signal}` : (typeof e.code === "string" ? e.code : "process error") });
  });
  // No stdin: nothing is ever written to it.
  child.stdin?.end();
});

/**
 * The queue route failed before anything was handed to Codex: the caller may
 * try the keystroke routes. The message never names the thread or the home
 * (it can reach a room line); they go to the log only.
 */
export class CodexQueueNotHandedOff extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexQueueNotHandedOff";
  }
}

/** The observed "thread not in this home" answer, whole (see the file header). */
const NO_ROLLOUT = /^Error: failed to queue session message: thread\/queue\/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id ([0-9a-fA-F-]{36}) \(code -32603\)$/;

/**
 * What a run means: null when accepted, else the error to throw. Only two
 * things prove that nothing was handed over: a CLI that is not there (spawn
 * ENOENT), and exit 1 with a stderr line that is exactly the observed
 * no-rollout answer for THIS thread. Anything else is unconfirmed.
 */
export function classifyCodexQueue(r: CodexQueueRun, thread: string, timeoutMs: number = CODEX_QUEUE_TIMEOUT_MS): CodexQueueNotHandedOff | UnconfirmedDeliveryError | null {
  if (r.kind === "exit" && r.code === 0) return null;
  if (r.kind === "not-started" && r.code === "ENOENT") return new CodexQueueNotHandedOff("codex queue unavailable: the codex CLI was not found (ENOENT)");
  if (r.kind === "not-started") return new UnconfirmedDeliveryError(`codex queue could not be confirmed: the CLI failed to start (${r.code}), not proven to precede any handoff`);
  if (r.kind === "timeout") return new UnconfirmedDeliveryError(`codex queue timed out without confirming delivery within ${Math.round(timeoutMs / 1000)} s`);
  if (r.kind === "killed") return new UnconfirmedDeliveryError(`codex queue ended without confirming delivery (${r.why})`);
  if (r.code === 1) {
    const proven = r.stderr.split(/\r?\n/).some((line) => {
      const m = NO_ROLLOUT.exec(line.trim());
      return m !== null && m[1].toLowerCase() === thread.toLowerCase();
    });
    if (proven) return new CodexQueueNotHandedOff("codex queue unavailable: the thread has no rollout in this Codex home (exit 1)");
  }
  return new UnconfirmedDeliveryError(`codex queue exited ${r.code} without confirming delivery`);
}

export interface InjectCodexQueueDeps {
  run?: CodexQueueRunner;
  resolve?: () => CodexInvocation;
  timeoutMs?: number;
  /** Whether a path exists; the home is re-checked before each run. */
  exists?: (p: string) => boolean;
  /** The environment the child inherits; process.env when unset. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Queue `text` for the Codex session `thread`, in `codexHome` when given
 * (CODEX_HOME for the child), else in the server's own Codex home. Resolves
 * when Codex accepted it; throws CodexQueueNotHandedOff or
 * UnconfirmedDeliveryError (see classifyCodexQueue).
 */
export async function injectCodexQueue(thread: string, text: string, codexHome?: string, deps: InjectCodexQueueDeps = {}): Promise<void> {
  // Neither of these runs anything: nothing can have been handed over.
  if (!isCodexThread(thread)) throw new CodexQueueNotHandedOff("codex queue unavailable: malformed thread id");
  if (codexHome !== undefined && !(deps.exists ?? existsSync)(join(codexHome, "sessions"))) {
    console.log(`  [inject:codex-queue] thread=${thread} home=${codexHome} is no Codex home any more; not run`);
    throw new CodexQueueNotHandedOff("codex queue unavailable: the Codex home given at join is gone");
  }
  const timeoutMs = deps.timeoutMs ?? CODEX_QUEUE_TIMEOUT_MS;
  const inv = (deps.resolve ?? (() => resolveCodexCli()))();
  const base = deps.env ?? process.env;
  const env: NodeJS.ProcessEnv = codexHome !== undefined ? { ...base, CODEX_HOME: codexHome } : { ...base };
  const startedAt = Date.now();
  console.log(`  [inject:codex-queue] thread=${thread} len=${text.length} home=${codexHome ?? "(inherited)"}`);
  // The = form: a value that starts with '-' is never read as a flag.
  const r = await (deps.run ?? runCodexQueue)(inv, ["queue", `--thread=${thread}`, `--message=${text}`], { timeoutMs, env });
  const err = classifyCodexQueue(r, thread, timeoutMs);
  const ms = Date.now() - startedAt;
  if (!err) {
    console.log(`  [inject:codex-queue] thread=${thread} accepted in ${ms} ms`);
    return;
  }
  const detail = r.kind === "exit" ? ` stderr=${JSON.stringify(r.stderr.trim().split(/\r?\n/).pop()?.slice(0, 200) ?? "")}` : "";
  if (err instanceof CodexQueueNotHandedOff) {
    console.log(`  [inject:codex-queue] thread=${thread} not handed off after ${ms} ms (${err.message})${detail}`);
  } else {
    console.log(`  [inject:codex-queue] thread=${thread} ${err.message} after ${ms} ms${detail}; outcome unknown, classified unconfirmed: no retry, no keystroke fallback`);
  }
  throw err;
}

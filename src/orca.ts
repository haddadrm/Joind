/**
 * Orca terminal backend. Orca hosts agents in its own terminals; each shell
 * it starts carries ORCA_TERMINAL_HANDLE=term_<uuid>, and its CLI types into
 * a live terminal by handle (`orca terminal send`). There is no pid in
 * Orca's terminal listing, so a handle is only ever bound when the agent
 * supplies it (see resolveOrcaForJoin in tools.ts).
 *
 * Every Orca invocation goes through runOrca(), which goes through
 * resolveOrcaCli(); a source-level test keeps it that way.
 *
 * Why the native launcher and never orca.cmd: cmd.exe re-parses a batch
 * file's arguments, and a wake prompt carries `&`, `|` and quotes. Node also
 * refuses to spawn a .cmd without a shell. Orca's own shim says as much: it
 * refuses to forward message bodies and points at orca.exe.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import { performance } from "perf_hooks";
import { dirname, join } from "path";

/** A well-formed Orca terminal handle. Anything else (a flag, a path, an
 *  empty string from an unset variable) is never handed to the CLI. */
export const ORCA_HANDLE = /^term_[A-Za-z0-9_-]{1,128}$/;

/** Error codes from `orca terminal send` that no retry can fix: the handle
 *  names no live, writable terminal. Observed live (Orca 1.4.209):
 *  terminal_handle_stale for an unknown handle, terminal_not_writable for a
 *  terminal closed a moment ago. The others are defensive, same meaning.
 *  runtime_unavailable (Orca not running; "no input was sent") is not here:
 *  it is transient. */
const PERMANENT_CODES = new Set([
  "terminal_handle_stale",
  "terminal_not_found",
  "terminal_not_connected",
  "terminal_not_writable",
  "terminal_closed",
]);

/** Thrown when no usable Orca CLI exists on this host. */
export class OrcaCliUnavailable extends Error {}

/** How long one `orca terminal send` may run before it is killed. */
export const ORCA_SEND_TIMEOUT_MS = 15000;

/**
 * An Orca process ended without an exit code: killed by a signal (the spawn
 * timeout, or anything else), or a process error. `started` says whether the
 * process was running: when it was, its arguments (for a send, the prompt
 * text) were already handed over, and whatever it did with them is unknown.
 * `timedOut` is true only for a kill at or after the time limit.
 */
export class OrcaRunError extends Error {
  constructor(message: string, public readonly started: boolean, public readonly signal: string | null, public readonly timedOut: boolean) {
    super(message);
    this.name = "OrcaRunError";
  }
}

/**
 * `orca terminal send` was running with the text and did not answer within
 * its limit: Orca may have typed and submitted the prompt, or not. Never
 * answered with a console fallback or a coordinator retry, either of which
 * would type the prompt a second time if Orca did deliver it (field log,
 * 27 Sep 2026: the agent got the same prompt twice). classifyWakeFailure
 * reports it as "unconfirmed".
 */
export class UnconfirmedDeliveryError extends Error {
  readonly phase = "text-handed-over" as const;
  constructor(message: string) {
    super(message);
    this.name = "UnconfirmedDeliveryError";
  }
}

/**
 * The Orca CLI executable: ORCA_CLI when set (a .cmd or .bat is swapped for
 * the native orca.exe beside it, or refused), else the per-user install's
 * native launcher on Windows, else `orca` on PATH.
 */
export function resolveOrcaCli(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string {
  const override = env.ORCA_CLI?.trim();
  if (override) {
    if (/\.(cmd|bat)$/i.test(override)) {
      const native = join(dirname(override), "orca.exe");
      if (exists(native)) return native;
      throw new OrcaCliUnavailable(`orca cli unavailable: ORCA_CLI points at a batch shim (${override}); point it at orca.exe`);
    }
    return override;
  }
  if (platform === "win32") {
    const base = env.LOCALAPPDATA;
    if (base) {
      const native = join(base, "Programs", "orca", "resources", "bin", "orca.exe");
      if (exists(native)) return native;
    }
    return "orca.exe";
  }
  return "orca";
}

export interface OrcaResult {
  /** Parsed JSON envelope, or null when stdout was not JSON. A result is
   *  only ever produced by a process that ran and exited, so a send result
   *  with no JSON is a started send whose outcome is unknown. */
  json: OrcaEnvelope | null;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface OrcaEnvelope {
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; data?: { orchestrationRequestId?: string } };
}

/** The slice of a child process runOrca uses. */
export interface OrcaProcess {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}
export type SpawnOrca = (exe: string, args: string[], opts: { timeout: number; windowsHide: boolean; stdio: ["ignore", "pipe", "pipe"] }) => OrcaProcess;

export interface RunOrcaDeps {
  /** Injectable for tests; the suite never starts a real Orca. */
  spawnFn?: SpawnOrca;
  /** Monotonic clock in ms, injectable for tests (whether a kill came at
   *  the time limit); defaults to performance.now, never the wall clock. */
  now?: () => number;
}

/** The one place an Orca process is started. No shell, argv only. */
export function runOrca(args: string[], timeoutMs: number, deps: RunOrcaDeps = {}): Promise<OrcaResult> {
  let exe: string;
  try {
    exe = resolveOrcaCli();
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const opts: Parameters<SpawnOrca>[2] = { timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
    const proc: OrcaProcess = deps.spawnFn ? deps.spawnFn(exe, args, opts) : spawn(exe, args, opts);
    let stdout = "";
    let stderr = "";
    // Set once the process is running: from then on it holds its argv.
    let started = false;
    proc.on("spawn", () => { started = true; });
    proc.stdout?.on("data", (d) => { stdout += d; });
    proc.stderr?.on("data", (d) => { stderr += d; });
    const now = deps.now ?? (() => performance.now());
    const t0 = now();
    // When the process itself ended: "close" waits for its streams too, and
    // a stream held open by a grandchild can close long after the kill.
    let exitedAt: number | null = null;
    proc.on("exit", () => { exitedAt ??= now(); });
    const what = `orca ${args.slice(0, 2).join(" ")}`;
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" && !started) reject(new OrcaCliUnavailable(`orca cli unavailable: ${exe} not found`));
      else reject(new OrcaRunError(`${what} error (${err.code ?? err.message.split("\n")[0].slice(0, 80)})${started ? " after it started" : " before it started"}`, started, null, false));
    });
    proc.on("close", (code, signal) => {
      if (signal) {
        const elapsed = Math.round((exitedAt ?? now()) - t0);
        const timedOut = elapsed >= timeoutMs;
        reject(new OrcaRunError(timedOut ? `${what} killed (${signal}) after ${timeoutMs}ms` : `${what} killed (${signal}) after ${elapsed}ms, before its ${timeoutMs}ms limit`, started, signal, timedOut));
        return;
      }
      let json: OrcaEnvelope | null = null;
      try { json = JSON.parse(stdout.trim()) as OrcaEnvelope; } catch { json = null; }
      resolve({ json, code, stdout, stderr });
    });
  });
}

export interface OrcaTerminalState { connected: boolean; writable: boolean; }

let listCache: { at: number; value: Promise<Map<string, OrcaTerminalState> | null> } | null = null;
const LIST_TTL_MS = 3000;

/**
 * Live Orca terminals by handle, or null when Orca cannot be reached (not
 * installed, not running, or the call timed out). Cached for a few seconds
 * so a burst of joins costs one CLI call; the timeout keeps a join from
 * hanging on a wedged Orca.
 */
export function listOrcaTerminals(run: typeof runOrca = runOrca, now: () => number = Date.now): Promise<Map<string, OrcaTerminalState> | null> {
  if (listCache && now() - listCache.at < LIST_TTL_MS) return listCache.value;
  const value = run(["terminal", "list", "--json"], 5000).then((r) => parseOrcaTerminalList(r.json), () => null);
  listCache = { at: now(), value };
  return value;
}

/** Test hook: forget the cached listing. */
export function resetOrcaListCache(): void { listCache = null; }

/** `orca terminal list --json` envelope to a handle map; null when not ok. */
export function parseOrcaTerminalList(json: OrcaEnvelope | null): Map<string, OrcaTerminalState> | null {
  if (!json || json.ok !== true) return null;
  const terminals = (json.result as { terminals?: unknown } | undefined)?.terminals;
  if (!Array.isArray(terminals)) return null;
  const out = new Map<string, OrcaTerminalState>();
  for (const t of terminals as Array<{ handle?: unknown; connected?: unknown; writable?: unknown }>) {
    if (typeof t.handle !== "string") continue;
    out.set(t.handle, { connected: t.connected === true, writable: t.writable === true });
  }
  return out;
}

/**
 * Type `text` plus Enter into an Orca terminal. Resolves when Orca accepted
 * the input. Error wording is what classifyWakeFailure keys on:
 *   "orca terminal <h> unavailable (<code>)"  permanent (no-console class)
 *   "orca cli unavailable: ..."                permanent (no Orca here)
 *   "orca send failed (<code>)"                transient (retried once)
 *   UnconfirmedDeliveryError                   unconfirmed (never retried,
 *                                              never a console fallback)
 * A send whose process started had the text. Unless Orca answered (JSON:
 * accepted, or an error that says no input was taken), its outcome is
 * unknown: a kill (the 15 s limit or any signal), a process error, or an
 * exit with no readable JSON is an UnconfirmedDeliveryError. A process that
 * never started sent nothing and stays an ordinary error.
 * An ambiguous transport failure that reports a retry-request id is
 * re-issued once with that id (Orca binds the id to the payload and the
 * terminal incarnation, so the re-issue can never type twice). From that
 * first ambiguous answer on, only an accepted re-issue settles it: a
 * re-issue that cannot start, or any other answer, leaves the first send's
 * outcome unknown, so it is an UnconfirmedDeliveryError too. The guard asked
 * before the re-issue is the caller's post-text guard: it stops only for a
 * target that left or moved to a different terminal, never for lock growth
 * on the same terminal, where the idempotent re-issue is the safe answer.
 */
export interface InjectOrcaOptions {
  /** Process runner, injectable for tests. */
  run?: typeof runOrca;
  /** Asked before the internal retry: the first send took time and may
   *  have typed the prompt, and the target may have left or moved to a
   *  different terminal. It throws (the caller's WakeFallbackAborted) to
   *  stop the retry; a retry can deliver input the first request never did,
   *  into a terminal the agent no longer uses. */
  beforeRetry?: () => void;
}

export async function injectOrca(handle: string, text: string, opts: InjectOrcaOptions = {}): Promise<void> {
  const run = opts.run ?? runOrca;
  if (!ORCA_HANDLE.test(handle)) throw new Error(`orca terminal ${JSON.stringify(handle).slice(0, 80)} unavailable (malformed_handle)`);
  console.log(`  [inject:orca] terminal=${handle} len=${text.length}`);
  const base = ["terminal", "send", "--terminal", handle, "--text", text, "--enter", "--json"];
  const startedAt = Date.now();
  const unconfirmed = (why: string, timedOut: boolean): UnconfirmedDeliveryError => {
    console.log(`  [inject:orca] terminal=${handle} ${why}; outcome unknown, classified unconfirmed: no retry, no console fallback`);
    return new UnconfirmedDeliveryError(timedOut
      ? `orca terminal ${handle}: the send timed out without confirming delivery within ${Math.round(ORCA_SEND_TIMEOUT_MS / 1000)} s (${why})`
      : `orca terminal ${handle}: the send ended without confirming delivery (${why})`);
  };
  // One send. A started send that did not answer is an unknown outcome,
  // never a failure: the text was handed over and Orca may have typed it.
  const send = async (args: string[]): Promise<OrcaResult> => {
    let r: OrcaResult;
    try {
      r = await run(args, ORCA_SEND_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof OrcaRunError && err.started) throw unconfirmed(err.message, err.timedOut);
      throw err;
    }
    if (!isOrcaSendAnswer(r.json)) throw unconfirmed(`orca terminal send exited ${r.code} with no readable answer`, false);
    return r;
  };
  // Reading an answer never escapes as an ordinary error: the send started.
  const readAnswer = (r: OrcaResult, context: string): SendFailure | null => {
    try {
      return orcaSendFailure(handle, r);
    } catch (err) {
      const why = err instanceof Error ? err.message.split("\n")[0].slice(0, 120) : String(err);
      throw unconfirmed(`${context}the answer could not be read (${why})`, false);
    }
  };
  let r = await send(base);
  let failure = readAnswer(r, "");
  if (failure && failure.retryId && !failure.permanent) {
    // The first send may have typed the prompt. Only an accepted re-issue
    // (idempotent under the retry id) settles that; anything else leaves it
    // unknown, and an unknown outcome is never answered by typing again.
    const first = failure.message;
    // Throws the caller's WakeFallbackAborted: the agent left (nothing to
    // wake) or lives in a different terminal now (wake that one instead).
    opts.beforeRetry?.();
    console.log(`  [inject:orca] ${first}; re-issuing once with Orca's retry id`);
    try {
      r = await send([...base, "--retry-request", failure.retryId, "--wait-submit", "2"]);
    } catch (err) {
      if (err instanceof UnconfirmedDeliveryError) throw err;
      const why = err instanceof Error ? err.message.split("\n")[0].slice(0, 120) : String(err);
      throw unconfirmed(`${first}; the re-issue did not run (${why})`, false);
    }
    failure = readAnswer(r, `${first}; re-issue: `);
    if (failure) throw unconfirmed(`${first}; the re-issue answered ${failure.message}`, false);
  }
  if (failure?.ambiguous && !failure.permanent) throw unconfirmed(`${failure.message}; ambiguous, with no usable retry id`, false);
  if (failure) throw new Error(failure.message);
  console.log(`  [inject:orca] terminal=${handle} accepted in ${Date.now() - startedAt}ms`);
}

interface SendFailure {
  message: string;
  permanent: boolean;
  /** A well-formed Orca retry id: the failure was ambiguous and may be re-issued with it. */
  retryId?: string;
  /** Ambiguous, but with no usable retry id: the outcome is unknown. */
  ambiguous?: boolean;
}

/**
 * True only for a well-formed answer to `orca terminal send --json`: ok:true
 * with a boolean send.accepted, or ok:false with a string error code. Any
 * other output (no JSON, truncated JSON, `{}`, an array, a bare value, an
 * envelope missing those fields) says nothing about whether the text was
 * typed, so the send's outcome is unknown.
 */
export function isOrcaSendAnswer(json: unknown): json is OrcaEnvelope {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return false;
  const j = json as { ok?: unknown; result?: unknown; error?: unknown };
  if (j.ok === true) {
    const result = j.result;
    if (result === null || typeof result !== "object") return false;
    const send = (result as { send?: unknown }).send;
    return send !== null && typeof send === "object" && typeof (send as { accepted?: unknown }).accepted === "boolean";
  }
  if (j.ok === false) {
    const error = j.error;
    if (error === null || typeof error !== "object" || Array.isArray(error)) return false;
    const e = error as { code?: unknown; message?: unknown; data?: unknown };
    if (typeof e.code !== "string") return false;
    if (e.message !== undefined && typeof e.message !== "string") return false;
    if (e.data === undefined) return true;
    if (e.data === null || typeof e.data !== "object" || Array.isArray(e.data)) return false;
    const id = (e.data as { orchestrationRequestId?: unknown }).orchestrationRequestId;
    return id === undefined || typeof id === "string";
  }
  return false;
}

/** null when Orca accepted the input; otherwise what went wrong. */
export function orcaSendFailure(handle: string, r: OrcaResult): SendFailure | null {
  const j = r.json;
  if (j?.ok === true) {
    const send = (j.result as { send?: { accepted?: unknown } } | undefined)?.send;
    if (send?.accepted === true) return null;
    return { message: `orca send failed (not_accepted) for terminal ${handle}`, permanent: false };
  }
  if (j?.ok === false) {
    // Only Orca's error code is kept, and only when it looks like one: its
    // free-form message could echo the prompt, and it reaches logs and rooms.
    const rawCode: unknown = j.error?.code;
    const code = typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : "unrecognised_code";
    if (PERMANENT_CODES.has(code)) {
      return { message: `orca terminal ${handle} unavailable (${code})`, permanent: true };
    }
    const retryId: unknown = j.error?.data?.orchestrationRequestId;
    if (retryId === undefined) return { message: `orca send failed (${code})`, permanent: false };
    // Orca's retry id is an opaque token: only a well-formed one is used,
    // and it is never logged. One that is present but malformed still says
    // the failure was ambiguous, so the send's outcome is unknown.
    if (typeof retryId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(retryId)) {
      return { message: `orca send failed (${code})`, permanent: false, ambiguous: true };
    }
    return { message: `orca send failed (${code})`, permanent: false, retryId };
  }
  return { message: `orca send failed (exit ${r.code}, no JSON)`, permanent: false };
}

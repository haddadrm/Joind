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
  /** Parsed JSON envelope, or null when stdout was not JSON. */
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

/** The one place an Orca process is started. No shell, argv only. */
export function runOrca(args: string[], timeoutMs: number): Promise<OrcaResult> {
  let exe: string;
  try {
    exe = resolveOrcaCli();
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") reject(new OrcaCliUnavailable(`orca cli unavailable: ${exe} not found`));
      else reject(err);
    });
    proc.on("close", (code, signal) => {
      if (signal) { reject(new Error(`orca ${args.slice(0, 2).join(" ")} killed (${signal}) after ${timeoutMs}ms`)); return; }
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
 * An ambiguous transport failure that reports a retry-request id is
 * re-issued once with that id (Orca binds the id to the payload and the
 * terminal incarnation, so the re-issue can never type twice) before it is
 * reported as transient.
 */
export interface InjectOrcaOptions {
  /** Process runner, injectable for tests. */
  run?: typeof runOrca;
  /** Asked before the internal retry: the first send took time, and the
   *  target may have left, been replaced, or now need locks this wake does
   *  not hold. It throws (the caller's WakeFallbackAborted) to stop the
   *  retry; a retry can deliver input the first request never did. */
  beforeRetry?: () => void;
}

export async function injectOrca(handle: string, text: string, opts: InjectOrcaOptions = {}): Promise<void> {
  const run = opts.run ?? runOrca;
  if (!ORCA_HANDLE.test(handle)) throw new Error(`orca terminal ${JSON.stringify(handle).slice(0, 80)} unavailable (malformed_handle)`);
  console.log(`  [inject:orca] terminal=${handle} len=${text.length}`);
  const base = ["terminal", "send", "--terminal", handle, "--text", text, "--enter", "--json"];
  let r = await run(base, 15000);
  let failure = orcaSendFailure(handle, r);
  if (failure && failure.retryId && !failure.permanent) {
    opts.beforeRetry?.();
    console.log(`  [inject:orca] ${failure.message}; re-issuing once with --retry-request ${failure.retryId}`);
    r = await run([...base, "--retry-request", failure.retryId, "--wait-submit", "2"], 15000);
    failure = orcaSendFailure(handle, r);
  }
  if (failure) throw new Error(failure.message);
}

interface SendFailure { message: string; permanent: boolean; retryId?: string; }

/** null when Orca accepted the input; otherwise what went wrong. */
export function orcaSendFailure(handle: string, r: OrcaResult): SendFailure | null {
  const j = r.json;
  if (j?.ok === true) {
    const send = (j.result as { send?: { accepted?: unknown } } | undefined)?.send;
    if (send?.accepted === true) return null;
    return { message: `orca send failed (not_accepted) for terminal ${handle}`, permanent: false };
  }
  if (j?.ok === false) {
    const code = j.error?.code ?? "unknown_error";
    const detail = (j.error?.message ?? "").split("\n")[0].slice(0, 160);
    if (PERMANENT_CODES.has(code)) {
      return { message: `orca terminal ${handle} unavailable (${code})`, permanent: true };
    }
    return { message: `orca send failed (${code}): ${detail}`, permanent: false, retryId: j.error?.data?.orchestrationRequestId };
  }
  const tail = (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 160) ?? "";
  return { message: `orca send failed (exit ${r.code}, no JSON): ${tail}`, permanent: false };
}

/**
 * Cross-process terminal injection — types text + Enter into another process's console.
 *
 * Windows: Uses Python with ctypes (same proven approach as agentchattr)
 * Unix:    tmux send-keys
 */

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { injectOrca } from "./orca.js";
import { classifyTarget, forgetTarget, DEFAULT_PLAN, type SubmitPlan } from "./target.js";

const execFileAsync = promisify(execFile);

/**
 * Spawn a new WezTerm pane running the given command in the given cwd.
 * Returns the new pane ID.
 * Optionally sets a tab title (best-effort).
 * Throws if the pane ID returned by wezterm is not a valid integer.
 */
export async function spawnWeztermPane(opts: {
  cwd: string;
  command: string[];
  tabTitle?: string;
  weztermExe?: string;
  weztermEnv?: Record<string, string>;
}): Promise<number> {
  const exe = opts.weztermExe ?? "wezterm";
  const env =
    opts.weztermEnv && Object.keys(opts.weztermEnv).length > 0
      ? { ...process.env, ...opts.weztermEnv }
      : undefined;

  // wezterm cli spawn --cwd <cwd> -- <command...>
  // stdout is the new pane ID as a plain integer string
  const { stdout } = await execFileAsync(
    exe,
    ["cli", "spawn", "--cwd", opts.cwd, "--", ...opts.command],
    { timeout: 10000, env }
  );

  const paneId = parseInt(stdout.trim(), 10);
  if (!Number.isFinite(paneId) || isNaN(paneId)) {
    throw new Error(
      `wezterm cli spawn returned unexpected output (expected pane ID integer): ${stdout.trim()}`
    );
  }

  // Best-effort tab title rename — ignore failures
  if (opts.tabTitle) {
    execFileAsync(
      exe,
      ["cli", "--no-auto-start", "set-tab-title", "--pane-id", String(paneId), opts.tabTitle],
      { timeout: 5000, env }
    ).catch(() => {});
  }

  return paneId;
}

/** A submit plan, or a request to send only the Enter that a delivered
 *  prompt is still missing (after a wake was interrupted between its text
 *  and its Enter). */
export interface SendPlan extends SubmitPlan {
  enterOnly?: boolean;
}

/** The slice of a child process that `wezterm cli send-text` needs. */
export interface SendTextProcess {
  stdin: { write(chunk: string): unknown; end(): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}
export type SpawnSendText = (exe: string, args: string[], opts: { timeout: number; stdio: ["pipe", "pipe", "pipe"]; env?: NodeJS.ProcessEnv }) => SendTextProcess;

const realSpawn: SpawnSendText = (exe, args, opts) => spawn(exe, args, opts);
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WezTermSendOptions {
  /** How to submit: a second carriage return after delayMs for Codex and
   *  Copilot; enterOnly sends one carriage return and no text. */
  plan?: SendPlan;
  /** Re-asked immediately before each send that follows a wait (the second
   *  Enter and its one recovery). It throws (the caller's
   *  WakeFallbackAborted) when the target left, moved, or needs locks this
   *  wake does not hold. */
  guard?: () => void;
  /** Injectable for tests. */
  spawn?: SpawnSendText;
  sleep?: (ms: number) => Promise<void>;
}

/** One `wezterm cli send-text` call, `payload` piped on stdin. */
function weztermSendText(spawnFn: SpawnSendText, exe: string, paneId: number, payload: string, env: NodeJS.ProcessEnv | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawnFn(exe, ["cli", "--no-auto-start", "send-text", "--pane-id", String(paneId), "--no-paste"], {
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wezterm send-text exit ${code}: ${stderr}`));
    });
    proc.on("error", reject);
    proc.stdin?.write(payload);
    proc.stdin?.end();
  });
}

/**
 * The text reached the terminal but the Enter that submits it could not be
 * sent, even after one retry of the Enter alone. The prompt is sitting in the
 * agent's input box. Never answered with a full-payload fallback or a
 * coordinator retry: either would type the prompt a second time behind the
 * first. classifyWakeFailure reports it as "partial".
 */
export class PartialDeliveryError extends Error {
  readonly phase = "text-delivered" as const;
  constructor(message: string) {
    super(message);
    this.name = "PartialDeliveryError";
  }
}

/**
 * Inject text into a WezTerm pane by pane ID, then submit it.
 * The text goes through stdin because a carriage return in a CLI argument
 * is literal, not interpreted. `--no-paste` stays: the text must arrive as
 * typed keys, not as a bracketed paste the TUI would hold for review.
 *
 * The line ends with a carriage return, not a line feed. Measured with the
 * injection matrix (tools/inject-matrix, 24 Sep 2026): a raw key reader in a
 * WezTerm pane receives U+000A for a line feed and U+000D for a carriage
 * return, and every other route (console, Orca, wmux) delivers U+000D. With
 * a real Claude Code 2.1.28x in the pane, text ending in a line feed stayed
 * unsent in the input box until a later Enter, while the same text ending in
 * a carriage return submitted and got its reply in 6.3 s. A line feed also
 * never submits a cooked-mode ReadLine under ConPTY.
 *
 * Codex and Copilot (plan.doubleEnter) get a second carriage return,
 * plan.delayMs later, in its own send-text call: with Codex CLI 0.154.0 in
 * the pane, one Enter left every prompt unsent and a second one submitted it.
 */
export async function injectWezTerm(paneId: number, text: string, weztermExe?: string, extraEnv?: Record<string, string>, opts: WezTermSendOptions = {}): Promise<void> {
  const exe = weztermExe || "wezterm";
  const plan: SendPlan = opts.plan ?? DEFAULT_PLAN;
  const spawnFn = opts.spawn ?? realSpawn;
  const sleep = opts.sleep ?? realSleep;
  console.log(`  [inject:wezterm] pane=${paneId} len=${text.length} doubleEnter=${plan.doubleEnter}`);
  const env = extraEnv && Object.keys(extraEnv).length > 0 ? { ...process.env, ...extraEnv } : undefined;
  const afterText = guardAfterText(opts.guard);
  if (plan.enterOnly) {
    // The text is already in the pane from an earlier, interrupted wake.
    afterText();
    try {
      await weztermSendText(spawnFn, exe, paneId, "\r", env);
    } catch (err) {
      const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
      throw new PartialDeliveryError(`wezterm pane ${paneId}: text delivered earlier, but the Enter that submits it failed (${why.slice(0, 120)})`);
    }
    return;
  }
  // A failure here is ambiguous (the text may or may not have arrived), so it
  // stays an ordinary error and the caller may fall back.
  await weztermSendText(spawnFn, exe, paneId, text + "\r", env);
  if (plan.doubleEnter) {
    // From here the text is in the pane. Only the missing Enter may be sent
    // again, and every send after a wait re-asks the guard first; an abort
    // from here on carries delivered: "text".
    await sleep(plan.delayMs);
    afterText();
    try {
      await weztermSendText(spawnFn, exe, paneId, "\r", env);
    } catch (first) {
      const why = first instanceof Error ? first.message.split("\n")[0] : String(first);
      console.log(`  [inject:wezterm] second Enter failed (${why.slice(0, 120)}); sending the Enter once more`);
      afterText();
      try {
        await weztermSendText(spawnFn, exe, paneId, "\r", env);
      } catch (second) {
        const again = second instanceof Error ? second.message.split("\n")[0] : String(second);
        throw new PartialDeliveryError(`wezterm pane ${paneId}: text delivered, but the Enter that submits it failed twice (${again.slice(0, 120)})`);
      }
    }
  }
}

/** Thrown by inject() when the caller's guard refused the console fallback:
 *  the target left ("skip") or is a different session now ("moved"). */
export class WakeFallbackAborted extends Error {
  /** `delivered: "text"`: the abort came after the prompt's text reached the
   *  terminal. The caller must not type the prompt again into that terminal;
   *  at most the missing Enter may follow (inject with submitOnly). */
  constructor(public readonly result: "skip" | "moved", public readonly delivered?: "text") {
    super(`console fallback aborted: target ${result === "skip" ? "left" : "moved"}${delivered ? " after the text was delivered" : ""}`);
  }
}

/** The guard as asked once the text is in the terminal: an abort from here on
 *  says so, so no caller mistakes it for "nothing was typed". */
function guardAfterText(guard: (() => void) | undefined): () => void {
  return () => {
    try {
      guard?.();
    } catch (err) {
      if (err instanceof WakeFallbackAborted && err.delivered === undefined) throw new WakeFallbackAborted(err.result, "text");
      throw err;
    }
  };
}

export interface InjectOptions {
  /** Orca terminal handle: when set, Orca's own input path is tried first
   *  (before WezTerm and the console). */
  orcaTerminal?: string;
  /** Send only the Enter a previously delivered prompt is missing: no text,
   *  no Orca, no fallback to another route. Any failure is a
   *  PartialDeliveryError and every abort carries delivered: "text". */
  submitOnly?: boolean;
  /** Called after an Orca or WezTerm failure and before the console fallback: the
   *  caller re-checks that the target is still the same live session.
   *  Anything but "proceed" aborts the fallback with WakeFallbackAborted. */
  fallbackGuard?: () => "proceed" | "skip" | "moved";
}

/** Backends, injectable for tests. */
export interface InjectBackends {
  /** Optional so callers that predate Orca keep compiling; defaults to injectOrca. */
  orca?: (handle: string, text: string, opts?: { beforeRetry?: () => void }) => Promise<void>;
  wezterm: typeof injectWezTerm;
  windows: (pid: number, text: string, delayMs: number, doubleEnter: boolean) => Promise<void>;
  unix: (pid: number, text: string, guard?: () => void, plan?: SendPlan) => Promise<void>;
  platform?: NodeJS.Platform;
  /** How to submit to the target (a second Enter for Codex and Copilot);
   *  defaults to classifyTarget, which reads the process command line. */
  classify?: (pid: number, platform: NodeJS.Platform) => Promise<SubmitPlan>;
}

/**
 * Inject a text prompt + Enter into the terminal of a running process.
 * Backend order: Orca (options.orcaTerminal), else WezTerm (paneId), else
 * the console. When the Orca or WezTerm path fails and a real pid is known,
 * fall back to console injection rather than giving up (a handle or pane can
 * be stale while the process is alive), through the caller's guard.
 */
export async function inject(
  pid: number, text: string, weztermPaneId?: number, weztermExe?: string, weztermEnv?: Record<string, string>,
  backends: InjectBackends = { orca: injectOrca, wezterm: injectWezTerm, windows: injectWindows, unix: injectUnix },
  options: InjectOptions = {}
): Promise<void> {
  const platform = backends.platform ?? process.platform;
  // The guard, and a lifecycle signal for the target classifier: when the
  // target left or moved, no read taken for this pid may serve a later wake.
  const guard = (): void => {
    try {
      assertStillTarget(options);
    } catch (err) {
      if (err instanceof WakeFallbackAborted && pid > 0) forgetTarget(pid);
      throw err;
    }
  };
  if (options.submitOnly) return submitOnlyWake(pid, weztermPaneId, weztermExe, weztermEnv, platform, backends, guard);
  // How to submit, worked out at most once per wake and only when a backend
  // that presses Enter itself needs it (the Orca path does not).
  let planPromise: Promise<SubmitPlan> | null = null;
  const plan = (): Promise<SubmitPlan> => {
    planPromise ??= resolvePlan(pid, platform, backends);
    return planPromise;
  };
  let primary: unknown;
  let via: string | null = null;
  let attempt: (() => Promise<void>) | null = null;
  if (options.orcaTerminal) {
    const handle = options.orcaTerminal;
    const orca = backends.orca ?? injectOrca;
    via = `orca terminal ${handle}`;
    // Orca's own retry is re-checked by the same guard as the console fallback.
    // No second Enter here: `orca terminal send --enter` submitted to a real
    // Codex CLI in one go in the injection matrix (25 s to reply), where every
    // single-Enter keystroke route needed a second one. Orca presses Enter
    // separately from the text, which is what Codex waits for.
    attempt = () => orca(handle, text, { beforeRetry: guard });
  } else if (weztermPaneId != null) {
    via = `wezterm pane ${weztermPaneId}`;
    attempt = async () => {
      const p = await plan();
      guard(); // the classification awaited: is this still the session to type into?
      await backends.wezterm(weztermPaneId, text, weztermExe, weztermEnv, { plan: p, guard });
    };
  }
  if (attempt) {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof WakeFallbackAborted) throw err; // the guard stopped the backend's own retry
      // The text is already in the terminal: typing it again elsewhere would
      // put the prompt in twice. Report it; never fall back.
      if (err instanceof PartialDeliveryError) throw err;
      if (!(pid > 0)) throw err;
      primary = err;
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      // The first attempt took time; the target may have left or been
      // replaced meanwhile. Never type into a pid the caller no longer vouches for.
      const verdict = options.fallbackGuard?.() ?? "proceed";
      if (verdict !== "proceed") {
        console.log(`  [inject] ${via} failed (${msg.slice(0, 120)}); no console fallback: target ${verdict === "skip" ? "left" : "moved"}`);
        forgetTarget(pid);
        throw new WakeFallbackAborted(verdict);
      }
      console.log(`  [inject] ${via} failed (${msg.slice(0, 120)}); falling back to pid ${pid}`);
    }
  }

  try {
    await injectConsole(pid, text, platform, backends, guard, plan);
  } catch (err) {
    if (primary === undefined || err instanceof WakeFallbackAborted || err instanceof PartialDeliveryError) throw err;
    // Both paths failed: the first backend's error stays the reported one,
    // so a transient socket failure is still retried rather than being
    // reclassed as "no console" by the fallback's own complaint.
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.log(`  [inject] console fallback for pid ${pid} failed too (${msg.slice(0, 120)})`);
    throw primary;
  }
}

/** The last word before typing: the caller's guard, re-asked after every
 *  await that precedes the backend (the process-name lookup takes time too). */
function assertStillTarget(options: InjectOptions): void {
  const verdict = options.fallbackGuard?.() ?? "proceed";
  if (verdict !== "proceed") throw new WakeFallbackAborted(verdict);
}

/**
 * The Enter-only resume of a wake interrupted between its text and its Enter
 * (the room re-queues it under the full lock set). Same route as the text:
 * the WezTerm pane when there is one, else the console. The Orca path never
 * gets here: it sends text and Enter in one call and is never interrupted
 * between them.
 */
async function submitOnlyWake(
  pid: number, paneId: number | undefined, weztermExe: string | undefined, weztermEnv: Record<string, string> | undefined,
  platform: NodeJS.Platform, backends: InjectBackends, guard: () => void
): Promise<void> {
  const afterText = guardAfterText(guard);
  const enterOnly: SendPlan = { ...DEFAULT_PLAN, enterOnly: true };
  console.log(`  [inject] resuming a delivered prompt: Enter only (${paneId != null ? `pane ${paneId}` : `pid ${pid}`})`);
  afterText();
  try {
    if (paneId != null) await backends.wezterm(paneId, "", weztermExe, weztermEnv, { plan: enterOnly, guard: afterText });
    else if (platform === "win32") await backends.windows(pid, "", DEFAULT_PLAN.delayMs, false);
    else await backends.unix(pid, "", afterText, enterOnly);
  } catch (err) {
    if (err instanceof WakeFallbackAborted || err instanceof PartialDeliveryError) throw err;
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new PartialDeliveryError(`text delivered earlier, but the Enter that submits it failed (${why.slice(0, 160)})`);
  }
}

/** The target's submit plan; a classifier that fails or throws is the
 *  single-Enter default, never a failed wake. */
async function resolvePlan(pid: number, platform: NodeJS.Platform, backends: InjectBackends): Promise<SubmitPlan> {
  try {
    const p = await (backends.classify ?? classifyTarget)(pid, platform);
    console.log(`  [inject] target=${p.kind} delay=${p.delayMs}ms doubleEnter=${p.doubleEnter}`);
    return p;
  } catch {
    return DEFAULT_PLAN;
  }
}

async function injectConsole(pid: number, text: string, platform: NodeJS.Platform, backends: InjectBackends, guard: () => void, plan: () => Promise<SubmitPlan>): Promise<void> {
  const p = await plan();
  if (platform === "win32") {
    guard();
    await backends.windows(pid, text, p.delayMs, p.doubleEnter);
  } else {
    guard();
    // tmux discovery inside the backend awaits too; it re-asks before typing.
    await backends.unix(pid, text, guard, p);
  }
}

// ---------------------------------------------------------------------------
// Windows: Python + ctypes (proven pattern from agentchattr)
// ---------------------------------------------------------------------------

async function injectWindows(pid: number, text: string, delayMs = DEFAULT_PLAN.delayMs, doubleEnter = false): Promise<void> {
  // Escape for Python string literal
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");

  const script = `
import ctypes
from ctypes import wintypes
import sys

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

STD_INPUT_HANDLE = -10
KEY_EVENT = 0x0001
VK_RETURN = 0x0D

class _CHAR_UNION(ctypes.Union):
    _fields_ = [('UnicodeChar', wintypes.WCHAR), ('AsciiChar', wintypes.CHAR)]

class _KEY_EVENT_RECORD(ctypes.Structure):
    _fields_ = [
        ('bKeyDown', wintypes.BOOL),
        ('wRepeatCount', wintypes.WORD),
        ('wVirtualKeyCode', wintypes.WORD),
        ('wVirtualScanCode', wintypes.WORD),
        ('uChar', _CHAR_UNION),
        ('dwControlKeyState', wintypes.DWORD),
    ]

class _EVENT_UNION(ctypes.Union):
    _fields_ = [('KeyEvent', _KEY_EVENT_RECORD)]

class _INPUT_RECORD(ctypes.Structure):
    _fields_ = [('EventType', wintypes.WORD), ('Event', _EVENT_UNION)]

pid = ${pid}
text = '${escaped}'

# Detach from our own console
kernel32.FreeConsole()

# Attach to target's console
if not kernel32.AttachConsole(pid):
    err = ctypes.get_last_error()
    print(f'AttachConsole({pid}) failed: error {err}', file=sys.stderr)
    sys.exit(1)

# IMPORTANT: Use CreateFile("CONIN$") instead of GetStdHandle.
# When spawned via execFile, std handles are pipes, not console handles.
# CONIN$ always opens the actual console input buffer.
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_SHARE_READ = 0x00000001
FILE_SHARE_WRITE = 0x00000002
OPEN_EXISTING = 3
kernel32.CreateFileW.restype = wintypes.HANDLE
handle = kernel32.CreateFileW(
    'CONIN$',
    GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    None,
    OPEN_EXISTING,
    0,
    None
)

# Build key events (down + up for each char)
n_events = len(text) * 2
records = (_INPUT_RECORD * n_events)()
idx = 0
for ch in text:
    for key_down in (True, False):
        rec = records[idx]
        rec.EventType = KEY_EVENT
        evt = rec.Event.KeyEvent
        evt.bKeyDown = key_down
        evt.wRepeatCount = 1
        evt.uChar.UnicodeChar = ch
        evt.wVirtualKeyCode = 0
        evt.wVirtualScanCode = 0
        idx += 1

written = wintypes.DWORD(0)
kernel32.WriteConsoleInputW(handle, records, n_events, ctypes.byref(written))

# Configurable delay, scaled with text length (from agentchattr)
import time
base_delay = ${delayMs / 1000}
delay_s = max(base_delay, len(text) * 0.001)
double_enter = ${doubleEnter ? "True" : "False"}
time.sleep(delay_s)

def write_key(h, char, key_down, vk=0, scan=0):
    rec = _INPUT_RECORD()
    rec.EventType = KEY_EVENT
    evt = rec.Event.KeyEvent
    evt.bKeyDown = key_down
    evt.wRepeatCount = 1
    evt.uChar.UnicodeChar = char
    evt.wVirtualKeyCode = vk
    evt.wVirtualScanCode = scan
    w = wintypes.DWORD(0)
    kernel32.WriteConsoleInputW(h, ctypes.byref(rec), 1, ctypes.byref(w))

write_key(handle, '\\r', True, vk=VK_RETURN, scan=0x1C)
write_key(handle, '\\r', False, vk=VK_RETURN, scan=0x1C)

if double_enter:
    time.sleep(delay_s)
    write_key(handle, '\\r', True, vk=VK_RETURN, scan=0x1C)
    write_key(handle, '\\r', False, vk=VK_RETURN, scan=0x1C)

kernel32.FreeConsole()
print(f'Injected {len(text)} chars + Enter (delay={delay_s}s, double={double_enter}) into PID {pid}')
`;

  const { stdout, stderr } = await execFileAsync("python", ["-c", script], {
    timeout: 10000,
  });
  if (stderr) {
    throw new Error(stderr.trim());
  }
  if (stdout) {
    console.log(`  ${stdout.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Unix: tmux send-keys
// ---------------------------------------------------------------------------

/** The one way injectUnix runs tmux and pgrep; injectable for tests. */
export type UnixExec = (cmd: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;
const realUnixExec: UnixExec = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, args, opts);
  return { stdout: String(stdout) };
};

export interface UnixSendDeps {
  exec?: UnixExec;
  sleep?: (ms: number) => Promise<void>;
}

export async function injectUnix(pid: number, text: string, guard?: () => void, plan: SendPlan = DEFAULT_PLAN, deps: UnixSendDeps = {}): Promise<void> {
  const execFileAsync = deps.exec ?? realUnixExec;
  const sleep = deps.sleep ?? realSleep;
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      [
        "list-panes",
        "-a",
        "-F",
        "#{pane_pid} #{session_name}:#{window_index}.#{pane_index}",
      ],
      { timeout: 5000 }
    );

    const lines = stdout.trim().split("\n");
    let target: string | null = null;

    for (const line of lines) {
      const [panePid, paneTarget] = line.split(" ", 2);
      if (panePid === String(pid)) {
        target = paneTarget;
        break;
      }
    }

    if (!target) {
      // Check child processes
      for (const line of lines) {
        const [panePid, paneTarget] = line.split(" ", 2);
        try {
          const { stdout: children } = await execFileAsync(
            "pgrep",
            ["-P", panePid],
            { timeout: 3000 }
          );
          if (children.trim().split("\n").includes(String(pid))) {
            target = paneTarget;
            break;
          }
        } catch {
          // pgrep not found or no children
        }
      }
    }

    if (!target) {
      throw new Error(`PID ${pid} not found in any tmux pane`);
    }

    const afterText = guardAfterText(guard);
    if (plan.enterOnly) {
      // The text is already in the pane from an earlier, interrupted wake.
      afterText();
      try {
        await execFileAsync("tmux", ["send-keys", "-t", target, "Enter"], { timeout: 5000 });
      } catch (err) {
        const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
        throw new PartialDeliveryError(`tmux pane ${target}: text delivered earlier, but the Enter that submits it failed (${why.slice(0, 120)})`);
      }
      return;
    }
    guard?.(); // discovery took time: is this still the session we were asked to wake?
    await execFileAsync("tmux", ["send-keys", "-t", target, "-l", text], {
      timeout: 5000,
    });
    await execFileAsync("tmux", ["send-keys", "-t", target, "Enter"], {
      timeout: 5000,
    });
    if (plan.doubleEnter) {
      // Codex and Copilot submit on the second Enter (see target.ts). The
      // text is in the pane now: only the Enter may be sent again, and the
      // guard is re-asked before each send that follows a wait; an abort
      // from here on carries delivered: "text".
      await sleep(plan.delayMs);
      afterText();
      try {
        await execFileAsync("tmux", ["send-keys", "-t", target, "Enter"], { timeout: 5000 });
      } catch (first) {
        if (first instanceof WakeFallbackAborted) throw first;
        afterText();
        try {
          await execFileAsync("tmux", ["send-keys", "-t", target, "Enter"], { timeout: 5000 });
        } catch (second) {
          const why = second instanceof Error ? second.message.split("\n")[0] : String(second);
          throw new PartialDeliveryError(`tmux pane ${target}: text delivered, but the Enter that submits it failed twice (${why.slice(0, 120)})`);
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof WakeFallbackAborted) throw err;
    if (err instanceof PartialDeliveryError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unix injection failed: ${msg}. Ensure the agent runs inside tmux.`
    );
  }
}

/**
 * Cross-process terminal injection — types text + Enter into another process's console.
 *
 * Windows: Uses Python with ctypes (same proven approach as agentchattr)
 * Unix:    tmux send-keys
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { injectOrca } from "./orca.js";

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

/** Default delays (ms) between text injection and Enter keystroke */
const DEFAULT_DELAY_MS = 50;
const CODEX_DELAY_MS = 300;

/**
 * Detect the process name for a given PID (Windows only).
 * Returns lowercase process name (e.g. "codex.exe", "claude.exe") or null.
 */
async function getProcessName(pid: number): Promise<string | null> {
  if (process.platform !== "win32") return null;
  try {
    // wmic is gone from current Windows builds; CIM through PowerShell instead.
    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.floor(pid)}").Name`],
      { timeout: 8000 }
    );
    const name = stdout.trim().toLowerCase();
    return name ? name : null;
  } catch {
    return null;
  }
}

/**
 * Inject text into a WezTerm pane by pane ID. Clean and reliable.
 * Must pipe text+\r via stdin because \r in CLI args is literal, not interpreted.
 */
export async function injectWezTerm(paneId: number, text: string, weztermExe?: string, extraEnv?: Record<string, string>): Promise<void> {
  const exe = weztermExe || "wezterm";
  console.log(`  [inject:wezterm] pane=${paneId} len=${text.length}`);
  const { spawn } = await import("child_process");
  const env = extraEnv && Object.keys(extraEnv).length > 0 ? { ...process.env, ...extraEnv } : undefined;
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, ["cli", "--no-auto-start", "send-text", "--pane-id", String(paneId), "--no-paste"], {
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wezterm send-text exit ${code}: ${stderr}`));
    });
    proc.on("error", reject);
    // Pipe text + newline via stdin (\n works more reliably across TUIs than \r)
    proc.stdin.write(text + "\n");
    proc.stdin.end();
  });
}

/** Thrown by inject() when the caller's guard refused the console fallback:
 *  the target left ("skip") or is a different session now ("moved"). */
export class WakeFallbackAborted extends Error {
  constructor(public readonly result: "skip" | "moved") {
    super(`console fallback aborted: target ${result === "skip" ? "left" : "moved"}`);
  }
}

export interface InjectOptions {
  /** Orca terminal handle: when set, Orca's own input path is tried first
   *  (before WezTerm and the console). */
  orcaTerminal?: string;
  /** Called after an Orca or WezTerm failure and before the console fallback: the
   *  caller re-checks that the target is still the same live session.
   *  Anything but "proceed" aborts the fallback with WakeFallbackAborted. */
  fallbackGuard?: () => "proceed" | "skip" | "moved";
}

/** Backends, injectable for tests. */
export interface InjectBackends {
  /** Optional so callers that predate Orca keep compiling; defaults to injectOrca. */
  orca?: (handle: string, text: string) => Promise<void>;
  wezterm: typeof injectWezTerm;
  windows: (pid: number, text: string, delayMs: number, doubleEnter: boolean) => Promise<void>;
  unix: (pid: number, text: string, guard?: () => void) => Promise<void>;
  platform?: NodeJS.Platform;
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
  let primary: unknown;
  let via: string | null = null;
  let attempt: (() => Promise<void>) | null = null;
  if (options.orcaTerminal) {
    const handle = options.orcaTerminal;
    const orca = backends.orca ?? injectOrca;
    via = `orca terminal ${handle}`;
    attempt = () => orca(handle, text);
  } else if (weztermPaneId != null) {
    via = `wezterm pane ${weztermPaneId}`;
    attempt = () => backends.wezterm(weztermPaneId, text, weztermExe, weztermEnv);
  }
  if (attempt) {
    try {
      return await attempt();
    } catch (err) {
      if (!(pid > 0)) throw err;
      primary = err;
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      // The first attempt took time; the target may have left or been
      // replaced meanwhile. Never type into a pid the caller no longer vouches for.
      const verdict = options.fallbackGuard?.() ?? "proceed";
      if (verdict !== "proceed") {
        console.log(`  [inject] ${via} failed (${msg.slice(0, 120)}); no console fallback: target ${verdict === "skip" ? "left" : "moved"}`);
        throw new WakeFallbackAborted(verdict);
      }
      console.log(`  [inject] ${via} failed (${msg.slice(0, 120)}); falling back to pid ${pid}`);
    }
  }

  try {
    await injectConsole(pid, text, platform, backends, options);
  } catch (err) {
    if (primary === undefined || err instanceof WakeFallbackAborted) throw err;
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

async function injectConsole(pid: number, text: string, platform: NodeJS.Platform, backends: InjectBackends, options: InjectOptions): Promise<void> {
  if (platform === "win32") {
    const procName = await getProcessName(pid);
    const isCodex = procName === "codex.exe";
    const isCopilot = procName?.includes("copilot") ?? false;
    const delayMs = (isCodex || isCopilot) ? CODEX_DELAY_MS : DEFAULT_DELAY_MS;
    const doubleEnter = isCodex || isCopilot;
    console.log(`  [inject] target=${procName ?? "unknown"} delay=${delayMs}ms doubleEnter=${doubleEnter}`);
    assertStillTarget(options);
    await backends.windows(pid, text, delayMs, doubleEnter);
  } else {
    assertStillTarget(options);
    // tmux discovery inside the backend awaits too; it re-asks before typing.
    await backends.unix(pid, text, () => assertStillTarget(options));
  }
}

// ---------------------------------------------------------------------------
// Windows: Python + ctypes (proven pattern from agentchattr)
// ---------------------------------------------------------------------------

async function injectWindows(pid: number, text: string, delayMs = DEFAULT_DELAY_MS, doubleEnter = false): Promise<void> {
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

async function injectUnix(pid: number, text: string, guard?: () => void): Promise<void> {
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

    const lines = stdout.trim().split("\\n");
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
          if (children.trim().split("\\n").includes(String(pid))) {
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

    guard?.(); // discovery took time: is this still the session we were asked to wake?
    await execFileAsync("tmux", ["send-keys", "-t", target, "-l", text], {
      timeout: 5000,
    });
    await execFileAsync("tmux", ["send-keys", "-t", target, "Enter"], {
      timeout: 5000,
    });
  } catch (err: unknown) {
    if (err instanceof WakeFallbackAborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unix injection failed: ${msg}. Ensure the agent runs inside tmux.`
    );
  }
}

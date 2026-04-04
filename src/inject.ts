/**
 * Cross-process terminal injection — types text + Enter into another process's console.
 *
 * Windows: Uses Python with ctypes (same proven approach as agentchattr)
 * Unix:    tmux send-keys
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

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
    const { stdout } = await execFileAsync(
      "wmic",
      ["process", "where", `ProcessId=${pid}`, "get", "Name", "/value"],
      { timeout: 5000 }
    );
    const match = stdout.match(/Name=(.+)/i);
    return match ? match[1].trim().toLowerCase() : null;
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
    const proc = spawn(exe, ["cli", "send-text", "--pane-id", String(paneId), "--no-paste"], {
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

/**
 * Inject a text prompt + Enter into the terminal of a running process.
 * Prefer WezTerm pane injection when paneId is provided.
 */
export async function inject(pid: number, text: string, weztermPaneId?: number, weztermExe?: string, weztermEnv?: Record<string, string>): Promise<void> {
  // WezTerm path — clean, no Python/ctypes needed
  if (weztermPaneId != null) {
    return injectWezTerm(weztermPaneId, text, weztermExe, weztermEnv);
  }

  if (process.platform === "win32") {
    const procName = await getProcessName(pid);
    const isCodex = procName === "codex.exe";
    const isCopilot = procName?.includes("copilot") ?? false;
    const delayMs = (isCodex || isCopilot) ? CODEX_DELAY_MS : DEFAULT_DELAY_MS;
    const doubleEnter = isCodex || isCopilot;
    console.log(`  [inject] target=${procName ?? "unknown"} delay=${delayMs}ms doubleEnter=${doubleEnter}`);
    await injectWindows(pid, text, delayMs, doubleEnter);
  } else {
    await injectUnix(pid, text);
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

async function injectUnix(pid: number, text: string): Promise<void> {
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

    await execFileAsync("tmux", ["send-keys", "-t", target, "-l", text], {
      timeout: 5000,
    });
    await execFileAsync("tmux", ["send-keys", "-t", target, "Enter"], {
      timeout: 5000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unix injection failed: ${msg}. Ensure the agent runs inside tmux.`
    );
  }
}

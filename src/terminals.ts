/**
 * Terminal session discovery — finds running CLI agent processes.
 *
 * Tab title strategy (Windows):
 *  1. AttachConsole(pid) + GetConsoleTitleW  → process-set title + pseudo-HWND + WT root HWND
 *  2. NtQueryInformationProcess             → WT_SESSION GUID from process env (best-effort)
 *  3. PowerShell UIAutomation               → all WT tab names keyed by WT window HWND
 *  4. Correlation heuristic                 → exact match first, then sole-unmatched fallback
 *  5. After invite: SetConsoleTitleW(name)  → future scans auto-match by exact title
 *     + WT_SESSION→name stored in data/tab-names.json for shell-prompt-override recovery
 *
 * Deduplication: openclaw double-spawns (cmd → node → node). We keep only
 * the outermost process of each same-type parent-child chain.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { readdirSync, existsSync } from "fs";
import { homedir } from "os";

const execFileAsync = promisify(execFile);

export interface TerminalInfo {
  pid: number;
  ppid: number;
  name: string;
  command: string;
  type: "claude" | "codex" | "gemini" | "openclaw" | "unknown";
  tabTitle?: string;
  wtSession?: string;
  weztermPaneId?: number;
}

interface RawProcess {
  pid: number;
  ppid: number;
  name: string;
  commandline: string;
}

interface ConsoleInfo {
  processTitle: string;
  pseudoHwnd: number;
  wtHwnd: number;
  wtSession?: string;
}

const AGENT_PATTERNS: Array<{
  nameMatch?: RegExp;
  cmdMatch?: RegExp;
  type: TerminalInfo["type"];
  label: string;
}> = [
  { nameMatch: /^claude\.exe$/i, type: "claude", label: "Claude Code" },
  { nameMatch: /^codex\.exe$/i, type: "codex", label: "Codex" },
  { cmdMatch: /gemini-cli/i, type: "gemini", label: "Gemini" },
  { cmdMatch: /openclaw\.mjs.*tui/i, type: "openclaw", label: "OpenClaw" },
];

const SKIP_PATTERNS = [
  /--output-format\s+stream-json/i,
  /--input-format\s+stream-json/i,
  /--permission-prompt-tool\s+stdio/i,
  /openclaw\.mjs\s+gateway/i,
  /openclaw\.mjs\s+serve/i,
  /openclaw\.mjs\s+dashboard/i,
];

// ---------------------------------------------------------------------------
// Step 1: AttachConsole per PID — process title, HWND data, WT_SESSION GUID
// ---------------------------------------------------------------------------

async function readConsoleInfo(pids: number[]): Promise<Map<number, ConsoleInfo>> {
  const result = new Map<number, ConsoleInfo>();
  if (pids.length === 0) return result;

  const pidList = pids.join(",");
  const script = `
import ctypes, struct
from ctypes import wintypes
import json

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
ntdll    = ctypes.WinDLL('ntdll',    use_last_error=True)
user32   = ctypes.WinDLL('user32',   use_last_error=True)

kernel32.FreeConsole.restype    = wintypes.BOOL
kernel32.AttachConsole.restype  = wintypes.BOOL
kernel32.AttachConsole.argtypes = [wintypes.DWORD]
kernel32.GetConsoleTitleW.restype  = wintypes.DWORD
kernel32.GetConsoleTitleW.argtypes = [wintypes.LPWSTR, wintypes.DWORD]
user32.GetConsoleWindow.restype = wintypes.HWND
user32.GetAncestor.restype      = wintypes.HWND
user32.GetAncestor.argtypes     = [wintypes.HWND, wintypes.UINT]

GA_ROOTOWNER   = 3
ATTACH_PARENT  = 0xFFFFFFFF
PROCESS_QI_VM  = 0x0410  # QUERY_INFORMATION | VM_READ

class PBI(ctypes.Structure):
    _fields_ = [
        ('ExitStatus',                   ctypes.c_long),
        ('PebBaseAddress',               ctypes.c_size_t),
        ('AffinityMask',                 ctypes.c_size_t),
        ('BasePriority',                 ctypes.c_long),
        ('UniqueProcessId',              ctypes.c_size_t),
        ('InheritedFromUniqueProcessId', ctypes.c_size_t),
    ]

def get_wt_session(pid):
    try:
        h = kernel32.OpenProcess(PROCESS_QI_VM, False, pid)
        if not h:
            return None
        def rdmem(addr, size):
            buf = (ctypes.c_byte * size)()
            rd  = ctypes.c_size_t()
            kernel32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, size, ctypes.byref(rd))
            return bytes(buf[:int(rd.value)])
        pbi = PBI()
        ntdll.NtQueryInformationProcess(h, 0, ctypes.byref(pbi), ctypes.sizeof(pbi), None)
        if not pbi.PebBaseAddress:
            kernel32.CloseHandle(h); return None
        # PEB+0x20 → RTL_USER_PROCESS_PARAMETERS* (64-bit)
        pp_ptr = struct.unpack('<Q', rdmem(pbi.PebBaseAddress + 0x20, 8))[0]
        if not pp_ptr:
            kernel32.CloseHandle(h); return None
        # ProcessParameters+0x80 → Environment* (64-bit)
        env_ptr = struct.unpack('<Q', rdmem(pp_ptr + 0x80, 8))[0]
        if not env_ptr:
            kernel32.CloseHandle(h); return None
        env_data = rdmem(env_ptr, 32768)
        kernel32.CloseHandle(h)
        for entry in env_data.decode('utf-16-le', errors='ignore').split('\\x00'):
            if entry.startswith('WT_SESSION='):
                return entry[len('WT_SESSION='):]
        return None
    except:
        return None

results = {}

for pid in [${pidList}]:
    kernel32.FreeConsole()
    if kernel32.AttachConsole(pid):
        buf = ctypes.create_unicode_buffer(1024)
        length = kernel32.GetConsoleTitleW(buf, 1024)
        process_title = buf.value if length > 0 else ''
        pseudo_hwnd = user32.GetConsoleWindow() or 0
        wt_hwnd = 0
        if pseudo_hwnd:
            root = user32.GetAncestor(pseudo_hwnd, GA_ROOTOWNER)
            if root and root != pseudo_hwnd:
                wt_hwnd = root
        kernel32.FreeConsole()
    else:
        process_title = ''
        pseudo_hwnd = 0
        wt_hwnd = 0
    wt_session = get_wt_session(pid)
    results[str(pid)] = {
        'processTitle': process_title,
        'pseudoHwnd':   pseudo_hwnd,
        'wtHwnd':       wt_hwnd,
        'wtSession':    wt_session
    }

kernel32.AttachConsole(ATTACH_PARENT)
print(json.dumps(results))
`;

  try {
    const { stdout } = await execFileAsync("python", ["-c", script], {
      timeout: 12000,
    });
    const data = JSON.parse(stdout.trim()) as Record<
      string,
      ConsoleInfo & { wtSession: string | null }
    >;
    for (const [pidStr, info] of Object.entries(data)) {
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) {
        result.set(pid, {
          ...info,
          wtSession: info.wtSession ?? undefined,
        });
      }
    }
  } catch {
    /* best-effort */
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 2: PowerShell UIAutomation — WT tab names keyed by WT window HWND
// ---------------------------------------------------------------------------

async function readWtUiaTabs(): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();

  const psScript = `
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $classCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty,
    'CASCADIA_HOSTING_WINDOW_CLASS'
  )
  $wtWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $classCond)
  $out = @{}
  foreach ($wt in $wtWindows) {
    $hwnd = [string]$wt.Current.NativeWindowHandle
    $tabCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TabItem
    )
    $tabs = $wt.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
    $out[$hwnd] = @($tabs | ForEach-Object { $_.Current.Name })
  }
  $out | ConvertTo-Json -Compress
} catch { Write-Output '{}' }
`;

  try {
    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: 8000 }
    );
    const raw = stdout.trim();
    if (!raw || raw === "{}") return result;
    const data = JSON.parse(raw) as Record<string, unknown>;
    for (const [hwndStr, names] of Object.entries(data)) {
      const hwnd = parseInt(hwndStr, 10);
      if (!isNaN(hwnd) && Array.isArray(names)) {
        result.set(
          hwnd,
          (names as unknown[]).filter((n): n is string => typeof n === "string")
        );
      }
    }
  } catch {
    /* best-effort */
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 3: Correlate console info + UIA tab names → best title per PID
// ---------------------------------------------------------------------------

function correlateTabTitles(
  consoleInfo: Map<number, ConsoleInfo>,
  uiaTabs: Map<number, string[]>
): Map<number, string> {
  const result = new Map<number, string>();

  // All tab names across every WT window (for global exact-match fallback)
  const allTabNames = new Set<string>();
  for (const names of uiaTabs.values()) for (const n of names) allTabNames.add(n);

  // Pass A: per-window HWND correlation
  const byWtHwnd = new Map<number, number[]>();
  for (const [pid, info] of consoleInfo) {
    if (info.wtHwnd) {
      if (!byWtHwnd.has(info.wtHwnd)) byWtHwnd.set(info.wtHwnd, []);
      byWtHwnd.get(info.wtHwnd)!.push(pid);
    }
  }

  for (const [wtHwnd, pids] of byWtHwnd) {
    const tabNames = uiaTabs.get(wtHwnd) ?? [];
    const claimed = new Set<string>();

    // Exact process title → UIA tab name
    for (const pid of pids) {
      const pt = consoleInfo.get(pid)!.processTitle;
      if (pt && tabNames.includes(pt)) {
        result.set(pid, pt);
        claimed.add(pt);
      }
    }

    // Sole unmatched PID ↔ sole unmatched tab (user-renamed tab)
    const unPids = pids.filter((p) => !result.has(p));
    const unTabs = tabNames.filter((t) => !claimed.has(t));
    if (unPids.length === 1 && unTabs.length === 1) {
      result.set(unPids[0], unTabs[0]);
    }
  }

  // Pass B: global exact match — works when GetAncestor returns 0 (ConPTY pseudo-HWND)
  // After renameTabTitle(pid, name), processTitle === name === tab title → matches here
  for (const [pid, info] of consoleInfo) {
    if (!result.has(pid) && info.processTitle && allTabNames.has(info.processTitle)) {
      result.set(pid, info.processTitle);
    }
  }

  // Pass C: fallback to process title (at least shows something)
  for (const [pid, info] of consoleInfo) {
    if (!result.has(pid) && info.processTitle) {
      result.set(pid, info.processTitle);
    }
  }

  return result;
}

interface TabReadResult {
  titles: Map<number, string>;
  wtSessions: Map<number, string>;
}

async function readTabInfo(pids: number[]): Promise<TabReadResult> {
  const [consoleInfo, uiaTabs] = await Promise.all([
    readConsoleInfo(pids),
    readWtUiaTabs(),
  ]);
  const titles = correlateTabTitles(consoleInfo, uiaTabs);
  const wtSessions = new Map<number, string>();
  for (const [pid, info] of consoleInfo) {
    if (info.wtSession) wtSessions.set(pid, info.wtSession);
  }
  return { titles, wtSessions };
}

// ---------------------------------------------------------------------------
// Rename a terminal tab by setting the console title via AttachConsole
// (works for tabs without a user-set custom rename; silently no-ops otherwise)
// ---------------------------------------------------------------------------

export async function renameTabTitle(pid: number, title: string): Promise<void> {
  if (process.platform !== "win32" || !pid) return;
  const safe = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
import ctypes
from ctypes import wintypes
k = ctypes.WinDLL('kernel32', use_last_error=True)
k.FreeConsole.restype = wintypes.BOOL
k.AttachConsole.restype = wintypes.BOOL
k.AttachConsole.argtypes = [wintypes.DWORD]
k.SetConsoleTitleW.restype = wintypes.BOOL
k.SetConsoleTitleW.argtypes = [wintypes.LPCWSTR]
k.FreeConsole()
if k.AttachConsole(${pid}):
    k.SetConsoleTitleW("${safe}")
    k.FreeConsole()
k.AttachConsole(0xFFFFFFFF)
`;
  try {
    await execFileAsync("python", ["-c", script], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// WezTerm discovery — clean pane enumeration via CLI
// ---------------------------------------------------------------------------

interface WezTermPane {
  pane_id: number;
  tab_id: number;
  window_id: number;
  workspace: string;
  title: string;      // process title (e.g. "claude.exe")
  tab_title: string;  // user/programmatic tab title (empty if not set)
  cwd: string;        // URI format: "file:///C:/Users/..."
  cursor_x: number;
  cursor_y: number;
  cursor_shape: string;
  cursor_visibility: string;
  is_active: boolean;
  is_zoomed: boolean;
  tty_name: string | null; // always null on Windows
}

let weztermAvailable: boolean | null = null;
let weztermPath: string = "wezterm";
let weztermEnv: Record<string, string> = {}; // extra env vars needed (WEZTERM_UNIX_SOCKET)
let weztermLastCheck = 0;
const WEZTERM_CHECK_INTERVAL = 30_000;

/** Find the WezTerm GUI socket path (needed when running outside WezTerm). */
function findWeztermSocket(): string | undefined {
  // Already set in environment (inside WezTerm)
  if (process.env.WEZTERM_UNIX_SOCKET) return process.env.WEZTERM_UNIX_SOCKET;
  // Search the standard location for gui-sock-* files
  const sockDir = join(homedir(), ".local", "share", "wezterm");
  try {
    if (!existsSync(sockDir)) return undefined;
    const files = readdirSync(sockDir).filter(f => f.startsWith("gui-sock-"));
    if (files.length === 1) return join(sockDir, files[0]);
    // Multiple sockets — pick the most recent
    if (files.length > 1) {
      return join(sockDir, files[files.length - 1]);
    }
  } catch { /* ignore */ }
  return undefined;
}

/** Resolve the wezterm executable path. */
function findWezTermExe(): string[] {
  const candidates = ["wezterm"];
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\WezTerm\\wezterm.exe",
      join(process.env.LOCALAPPDATA || "", "Programs", "WezTerm", "wezterm.exe"),
    );
    if (process.env.WEZTERM_EXECUTABLE) {
      candidates.unshift(process.env.WEZTERM_EXECUTABLE.replace(/wezterm-gui\.exe$/i, "wezterm.exe"));
    }
  }
  return candidates;
}

async function checkWezTerm(): Promise<boolean> {
  const now = Date.now();
  if (weztermAvailable !== null && (now - weztermLastCheck) < WEZTERM_CHECK_INTERVAL) {
    return weztermAvailable;
  }
  weztermLastCheck = now;

  // Build env with socket path if needed
  const socketPath = findWeztermSocket();
  const env = socketPath ? { ...process.env, WEZTERM_UNIX_SOCKET: socketPath } : undefined;

  for (const candidate of findWezTermExe()) {
    try {
      await execFileAsync(candidate, ["cli", "list", "--format", "json"], {
        timeout: 3000,
        env,
      });
      if (!weztermAvailable) {
        console.log(`  WezTerm detected at ${candidate}${socketPath ? ` (socket: ${socketPath})` : ""}`);
      }
      weztermPath = candidate;
      weztermEnv = socketPath ? { WEZTERM_UNIX_SOCKET: socketPath } : {};
      weztermAvailable = true;
      return true;
    } catch { /* try next */ }
  }

  if (weztermAvailable !== false) {
    console.log("  WezTerm not found in PATH or common locations");
  }
  weztermAvailable = false;
  return false;
}

/** Get the resolved wezterm executable path. */
export function getWeztermPath(): string { return weztermPath; }

/** Get extra env vars needed for wezterm CLI (socket path). */
export function getWeztermEnv(): Record<string, string> { return weztermEnv; }

export async function discoverWezTerm(): Promise<TerminalInfo[]> {
  try {
    const env = Object.keys(weztermEnv).length > 0 ? { ...process.env, ...weztermEnv } : undefined;
    const { stdout } = await execFileAsync(
      weztermPath, ["cli", "list", "--format", "json"],
      { timeout: 5000, env }
    );
    const panes = JSON.parse(stdout.trim()) as WezTermPane[];
    const results: TerminalInfo[] = [];

    for (const pane of panes) {
      const title = pane.title || "";
      const displayTitle = pane.tab_title || title; // prefer user-set tab title
      // Match against agent patterns using the pane title (which shows the running command)
      let matched = false;
      for (const pattern of AGENT_PATTERNS) {
        const byName = pattern.nameMatch?.test(title) ?? false;
        const byCmd = pattern.cmdMatch?.test(title) ?? false;
        if (!byName && !byCmd) continue;
        if (SKIP_PATTERNS.some((skip) => skip.test(title))) continue;

        results.push({
          pid: 0, // WezTerm pane_id is the primary identifier, not PID
          ppid: 0,
          name: pattern.label,
          command: title.length > 120 ? title.slice(0, 120) + "\u2026" : title,
          type: pattern.type,
          tabTitle: displayTitle,
          weztermPaneId: pane.pane_id,
        });
        matched = true;
        break;
      }

      // Also include panes that don't match agent patterns — they might be
      // manually started agents or shells the user wants to invite
      if (!matched) {
        results.push({
          pid: 0,
          ppid: 0,
          name: displayTitle || title.split(/[\s\\\/]/).pop()?.replace(/\.exe$/i, "") || "shell",
          command: title.length > 120 ? title.slice(0, 120) + "\u2026" : title,
          type: "unknown",
          tabTitle: displayTitle || title,
          weztermPaneId: pane.pane_id,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

/** Check if WezTerm is available (cached). */
export { checkWezTerm };

// ---------------------------------------------------------------------------
// Main discovery
// ---------------------------------------------------------------------------

export async function discoverTerminals(): Promise<TerminalInfo[]> {
  const results: TerminalInfo[] = [];

  // WezTerm panes (if available)
  if (await checkWezTerm()) {
    results.push(...await discoverWezTerm());
  }

  // Also discover Windows Terminal / native processes
  if (process.platform === "win32") {
    const native = await discoverWindows();
    // Deduplicate: skip native entries that share a PID with a WezTerm pane
    // (WezTerm panes have pid=0 so no overlap in practice)
    results.push(...native);
  } else {
    results.push(...await discoverUnix());
  }

  return results;
}

async function discoverWindows(): Promise<TerminalInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      "wmic",
      [
        "process",
        "get",
        "processid,parentprocessid,name,commandline",
        "/format:csv",
      ],
      { timeout: 10000 }
    );

    const allProcs = new Map<number, RawProcess>();
    for (const line of stdout.trim().split("\n")) {
      const parts = line.split(",");
      if (parts.length < 4) continue;
      const commandline = parts.slice(1, -3).join(",").trim();
      const name = parts[parts.length - 3]?.trim() ?? "";
      const ppid = parseInt(parts[parts.length - 2]?.trim() ?? "", 10);
      const pid = parseInt(parts[parts.length - 1]?.trim() ?? "", 10);
      if (isNaN(pid) || pid === 0) continue;
      allProcs.set(pid, { pid, ppid: ppid || 0, name, commandline });
    }

    const matches: Array<{
      proc: RawProcess;
      pattern: (typeof AGENT_PATTERNS)[0];
    }> = [];

    for (const proc of allProcs.values()) {
      for (const pattern of AGENT_PATTERNS) {
        const byName = pattern.nameMatch?.test(proc.name) ?? false;
        const byCmd = pattern.cmdMatch?.test(proc.commandline) ?? false;
        if (!byName && !byCmd) continue;
        if (SKIP_PATTERNS.some((skip) => skip.test(proc.commandline))) continue;
        matches.push({ proc, pattern });
        break;
      }
    }

    const childPids = new Set<number>();
    for (const m of matches) {
      for (const other of matches) {
        if (other.proc.pid === m.proc.pid) continue;
        if (other.pattern.type !== m.pattern.type) continue;
        if (other.proc.ppid === m.proc.pid) childPids.add(other.proc.pid);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of matches) {
        if (childPids.has(m.proc.pid)) continue;
        const parent = allProcs.get(m.proc.ppid);
        if (parent && childPids.has(parent.pid)) {
          childPids.add(m.proc.pid);
          changed = true;
        }
      }
    }

    const rootMatches = matches.filter((m) => !childPids.has(m.proc.pid));
    const { titles, wtSessions } = await readTabInfo(
      rootMatches.map((m) => m.proc.pid)
    );

    const results: TerminalInfo[] = [];
    for (const m of rootMatches) {
      results.push({
        pid: m.proc.pid,
        ppid: m.proc.ppid,
        name: m.pattern.label,
        command:
          m.proc.commandline.length > 120
            ? m.proc.commandline.slice(0, 120) + "\u2026"
            : m.proc.commandline,
        type: m.pattern.type,
        tabTitle: titles.get(m.proc.pid),
        wtSession: wtSessions.get(m.proc.pid),
      });
    }

    return results;
  } catch {
    return [];
  }
}

async function discoverUnix(): Promise<TerminalInfo[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid,ppid,comm,args"], {
      timeout: 5000,
    });

    const results: TerminalInfo[] = [];
    const lines = stdout.trim().split("\n").slice(1);

    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)/);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const ppid = parseInt(match[2], 10);
      const comm = match[3];
      const args = match[4];

      for (const pattern of AGENT_PATTERNS) {
        const byName = pattern.nameMatch?.test(comm) ?? false;
        const byCmd = pattern.cmdMatch?.test(args) ?? false;
        if (!byName && !byCmd) continue;
        if (SKIP_PATTERNS.some((skip) => skip.test(args))) continue;

        results.push({
          pid,
          ppid,
          name: pattern.label,
          command: args.length > 120 ? args.slice(0, 120) + "\u2026" : args,
          type: pattern.type,
        });
        break;
      }
    }

    return results;
  } catch {
    return [];
  }
}

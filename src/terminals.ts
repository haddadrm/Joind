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
import { readdirSync, existsSync, statSync } from "fs";
import { homedir } from "os";

const execFileAsync = promisify(execFile);

export interface TerminalInfo {
  pid: number;
  ppid: number;
  name: string;
  command: string;
  type: "claude" | "codex" | "gemini" | "openclaw" | "copilot" | "unknown";
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
  { cmdMatch: /copilot/i, type: "copilot", label: "Copilot" },
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

/** Where WezTerm GUIs put their sockets, gui-sock-<gui pid>. */
export function weztermSocketDir(): string {
  return join(homedir(), ".local", "share", "wezterm");
}

/** The GUI pid a socket path names (gui-sock-<pid>), or null. */
export function socketGuiPid(socketPath: string | undefined): number | null {
  const m = /gui-sock-(\d+)$/.exec(socketPath ?? "");
  return m ? parseInt(m[1], 10) : null;
}

/** Is a process with this pid running? A cheap existence check (signal 0),
 *  no process enumeration. EPERM means it exists but is not ours. */
export function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

export interface SocketFinderDeps {
  env?: NodeJS.ProcessEnv;
  dir?: string;
  list?: (dir: string) => string[];
  mtimeMs?: (path: string) => number;
  alive?: (pid: number) => boolean;
}

/**
 * The WezTerm GUI socket the server talks to when it runs outside WezTerm.
 * WEZTERM_UNIX_SOCKET wins when set. Otherwise the gui-sock-<pid> files are
 * candidates only while their GUI process is alive, newest first where the
 * file's time can be read. On Windows a LIVE GUI's socket cannot be stat'ed
 * at all (stat and lstat fail with EACCES, existsSync says false; measured
 * 25 Sep 2026), so existence comes from the directory listing, and among
 * several live GUIs the order is the listing's. That only decides the
 * default: a join whose GUI instance is known uses that instance's socket. A GUI that
 * closed leaves its socket file behind, and the old rule (the alphabetically
 * last file) picked such a leftover whenever its pid sorted last: the server
 * then reported "WezTerm not found" next to a live GUI (seen 25 Sep 2026 with
 * gui-sock-42272 left over). Dead files are ignored, never deleted.
 */
export function findWeztermSocket(deps: SocketFinderDeps = {}): string | undefined {
  const env = deps.env ?? process.env;
  if (env.WEZTERM_UNIX_SOCKET) return env.WEZTERM_UNIX_SOCKET;
  const sockDir = deps.dir ?? weztermSocketDir();
  const list = deps.list ?? ((d: string) => (existsSync(d) ? readdirSync(d) : []));
  const mtimeMs = deps.mtimeMs ?? ((f: string) => statSync(f).mtimeMs);
  const alive = deps.alive ?? pidAlive;
  try {
    const live = list(sockDir)
      .map((f) => ({ f, pid: socketGuiPid(f) }))
      .filter((x): x is { f: string; pid: number } => x.pid !== null && alive(x.pid))
      .map((x) => ({ path: join(sockDir, x.f), mtime: (() => { try { return mtimeMs(join(sockDir, x.f)); } catch { return 0; } })() }))
      .sort((a, b) => b.mtime - a.mtime);
    return live[0]?.path;
  } catch {
    return undefined;
  }
}

/** The socket of one GUI instance, when that GUI is alive and its socket
 *  file is listed in the socket directory (a listing, not existsSync: see
 *  findWeztermSocket, a live socket file cannot be stat'ed on Windows). */
export function socketForGui(guiPid: number, deps: { dir?: string; list?: (dir: string) => string[]; alive?: (pid: number) => boolean } = {}): string | undefined {
  const dir = deps.dir ?? weztermSocketDir();
  const name = `gui-sock-${guiPid}`;
  const list = deps.list ?? ((d: string) => { try { return readdirSync(d); } catch { return []; } });
  const alive = deps.alive ?? pidAlive;
  return alive(guiPid) && list(dir).includes(name) ? join(dir, name) : undefined;
}

/** The server's socket, but only while its GUI is alive: a GUI that closed
 *  is no "other instance" to compare against. */
export function liveServerSocket(): string | undefined {
  const s = weztermEnv.WEZTERM_UNIX_SOCKET;
  const gui = socketGuiPid(s);
  return gui === null || pidAlive(gui) ? s : undefined;
}

/** Environment for `wezterm cli` PROBES (list): WEZTERM_LOG=off, because
 *  every failed probe otherwise writes a wezterm.exe-log-<pid>.txt into the
 *  runtime dir (26 of them after one morning of joins against a dead socket).
 *  Measured: WEZTERM_LOG=off (or none) writes no file; error still does. It
 *  also empties stderr, so it is not used for send-text, whose stderr is the
 *  only explanation of a failed injection. */
export function weztermProbeEnv(socket?: string): NodeJS.ProcessEnv {
  return { ...process.env, ...(socket ? { WEZTERM_UNIX_SOCKET: socket } : {}), WEZTERM_LOG: "off" };
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

  // Build env with socket path if needed; probes run with WezTerm's own log off.
  const socketPath = findWeztermSocket();
  const env = weztermProbeEnv(socketPath);

  for (const candidate of findWezTermExe()) {
    try {
      // --no-auto-start: without it, wezterm cli spawns a headless mux server
      // whenever no GUI socket answers, one per call, forever (579 orphans on
      // one host after three days of joins and heartbeat checks).
      await execFileAsync(candidate, ["cli", "--no-auto-start", "list", "--format", "json"], {
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

/** Ids of the panes the reachable WezTerm reports right now (never
 *  auto-starting a mux server). Empty when WezTerm cannot be reached. */
/** Live pane ids in one WezTerm GUI: the server's own socket by default, or
 *  `socket` (an agent's own GUI instance; pane ids are per instance). */
export async function listWezTermPaneIds(socket?: string): Promise<Set<number>> {
  try {
    const env = weztermProbeEnv(socket ?? weztermEnv.WEZTERM_UNIX_SOCKET);
    const { stdout } = await execFileAsync(
      weztermPath, ["cli", "--no-auto-start", "list", "--format", "json"],
      { timeout: 3000, env }
    );
    const panes = JSON.parse(stdout.trim()) as Array<{ pane_id: number }>;
    return new Set(panes.map((p) => p.pane_id).filter((id) => Number.isInteger(id)));
  } catch {
    return new Set();
  }
}

export interface ProcessEntry {
  ppid: number;
  name: string;
  /** epoch ms, when known */
  started?: number;
  /** resolution of `started` in ms: 1 for WMI CIM_DATETIME, 1000 for ps etime */
  startedPrecisionMs?: number;
}

/** WMI CIM_DATETIME (yyyymmddHHMMSS.ffffff+zzz) to epoch ms; undefined when unparsable. */
export function parseCimDate(v: string | undefined): number | undefined {
  const m = (v ?? "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{3})$/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, se, us, tz] = m;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, Math.floor(+us / 1000));
  return utc - (+tz) * 60_000;
}

/** ps etime ([[dd-]hh:]mm:ss) to elapsed seconds; undefined when unparsable.
 *  (etime is portable across macOS, Linux and BSD; etimes is Linux-only.) */
export function parseEtime(v: string | undefined): number | undefined {
  const m = (v ?? "").trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const [, dd, hh, mm, ss] = m;
  return (+(dd ?? 0)) * 86400 + (+(hh ?? 0)) * 3600 + (+mm) * 60 + (+ss);
}

/** Parse the pipe-separated process table produced by PS_PROCESS_TABLE:
 *  one `pid|ppid|startMs|name` line per process, name last so a name that
 *  contains the separator still parses. */
export function parseProcessTable(stdout: string): Map<number, ProcessEntry> {
  const out = new Map<number, ProcessEntry>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\|(\d*)\|(\d*)\|(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (!Number.isFinite(pid) || pid === 0) continue;
    const ppid = parseInt(m[2], 10);
    const started = m[3] ? parseInt(m[3], 10) : undefined;
    out.set(pid, {
      ppid: Number.isFinite(ppid) ? ppid : 0,
      name: m[4].trim(),
      started: Number.isFinite(started as number) ? started : undefined,
      startedPrecisionMs: 1,
    });
  }
  return out;
}

/** wmic is gone from current Windows builds (absent on every host seen in
 *  September 2026), so the table comes from CIM through PowerShell. About a
 *  second per call; it runs only at join time, never on heartbeats. */
const PS_PROCESS_TABLE =
  "Get-CimInstance Win32_Process | ForEach-Object { " +
  "\"$($_.ProcessId)|$($_.ParentProcessId)|$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { '' })|$($_.Name)\" }";

/**
 * Parent pid, name and start time for every process on this host, or null
 * when the enumeration itself is unavailable (unknown is not "elsewhere").
 */
export async function listParentPids(): Promise<Map<number, ProcessEntry> | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_PROCESS_TABLE],
        { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }
      );
      const out = parseProcessTable(stdout);
      return out.size > 0 ? out : null;
    }
    const out = new Map<number, ProcessEntry>();
    const now = Date.now();
    const { stdout } = await execFileAsync("ps", ["-eo", "pid,ppid,etime,comm"], { timeout: 5000 });
    for (const line of stdout.trim().split("\n").slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!m) continue;
      const elapsed = parseEtime(m[3]);
      out.set(parseInt(m[1], 10), {
        ppid: parseInt(m[2], 10),
        name: m[4].trim(),
        started: elapsed != null ? now - elapsed * 1000 : undefined,
        startedPrecisionMs: 1000,
      });
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

const WEZTERM_PROCESS = /^wezterm(-gui|-mux-server)?(\.exe)?$/i;
function processBasename(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/** Session and system roots: processes no terminal is ever an ancestor of.
 *  On Windows every process chain ends at one of these with its parent
 *  gone (userinit exits after starting explorer; smss after wininit). */
const ROOT_PROCESS =
  /^(explorer|wininit|winlogon|services|smss|csrss|lsass|svchost|wmiprvse|taskhostw|runtimebroker|sihost|userinit|dwm)\.exe$|^(launchd|systemd|init)$/i;

/** Is this process a session or system root (see ROOT_PROCESS)? pid 4 is
 *  Windows' System, pid 1 is init/launchd/systemd on Unix. */
export function isSessionRoot(pid: number, entry: ProcessEntry): boolean {
  return entry.ppid === 0 || pid === 4 || pid === 1 || ROOT_PROCESS.test(processBasename(entry.name));
}

/**
 * Does `pid` have a process whose executable basename matches `host` among
 * its ancestors (itself included) on this host? False for a pid that does
 * not exist here, which is what a remote agent's pid looks like. A parent
 * that started after its child is a recycled pid, not an ancestor: false.
 * Ordering that the clock cannot settle (missing start times, or a gap
 * inside the clock's precision) is "unknown", never a silent yes. `tree` is
 * injectable for tests; names may be full paths (macOS ps prints them).
 */
export function hasAncestor(pid: number, tree: Map<number, ProcessEntry>, host: RegExp): boolean | "unknown" {
  const found = findAncestor(pid, tree, host);
  return typeof found === "number" ? true : found;
}

/** hasAncestor, but naming the matching ancestor: its pid, false, or
 *  "unknown", under exactly the same rules (one walk, two answers). */
export function findAncestor(pid: number, tree: Map<number, ProcessEntry>, host: RegExp): number | false | "unknown" {
  let cur = pid;
  let child = tree.get(pid);
  for (let depth = 0; depth < 64 && cur > 0; depth++) {
    const entry = tree.get(cur);
    if (!entry) return false;
    if (host.test(processBasename(entry.name))) return cur;
    if (entry.ppid === cur || entry.ppid <= 0) return false;
    const parent = tree.get(entry.ppid);
    // The chain breaks above a live process. Above a session or system root
    // (explorer.exe, services.exe, launchd...) that is the normal end of
    // every chain, and no terminal lives above a root: disproved. Above
    // anything else it is an exited intermediary (a wrapper), which leaves
    // the association unverifiable, not disproved. The same holds when a
    // root's parent cannot be ordered by start time (system processes often
    // carry no creation date).
    if (!parent) return isSessionRoot(cur, entry) ? false : "unknown";
    if (child?.started == null || parent.started == null) return isSessionRoot(cur, entry) ? false : "unknown";
    const precision = Math.max(child.startedPrecisionMs ?? 1, parent.startedPrecisionMs ?? 1);
    const gap = parent.started - child.started; // positive: parent "younger" than child
    if (gap > 0) {
      if (gap >= precision) return false; // provably recycled
      return "unknown";                   // inside the clock's resolution
    }
    child = parent;
    cur = entry.ppid;
  }
  return false;
}

/** The WezTerm GUI process (wezterm-gui) above `pid`: pane ids are per GUI
 *  instance, and its socket is gui-sock-<that pid>. */
const WEZTERM_GUI_PROCESS = /^wezterm-gui(\.exe)?$/i;

/** The pid of the WezTerm GUI instance `pid` runs in, false when it runs in
 *  none, or "unknown" (see hasAncestor). A pane under a mux server with no
 *  GUI above it is false here while isInsideWezTermTree says true. */
export function weztermGuiOfTree(pid: number, tree: Map<number, ProcessEntry>): number | false | "unknown" {
  return findAncestor(pid, tree, WEZTERM_GUI_PROCESS);
}

/** weztermGuiOfTree with the host's process table. */
export async function weztermGuiOf(pid: number, tree?: () => Promise<Map<number, ProcessEntry> | null>): Promise<number | false | "unknown"> {
  if (!(pid > 0)) return false;
  const t = await (tree ?? listParentPids)();
  if (!t) return "unknown";
  return weztermGuiOfTree(pid, t);
}

/** Environment for `wezterm cli` aimed at an agent's pane: its own GUI
 *  instance's socket when known and alive, else the server's default. */
export function weztermEnvForGui(gui: number | undefined): Record<string, string> {
  const own = gui != null ? socketForGui(gui) : undefined;
  return own ? { WEZTERM_UNIX_SOCKET: own } : weztermEnv;
}

/** The socket the server currently uses for WezTerm, if any. */
export function getWeztermSocket(): string | undefined { return weztermEnv.WEZTERM_UNIX_SOCKET; }

/** Does `pid` run inside WezTerm on this host? See hasAncestor. */
export function isInsideWezTermTree(pid: number, tree: Map<number, ProcessEntry>): boolean | "unknown" {
  return hasAncestor(pid, tree, WEZTERM_PROCESS);
}

/** Orca's app process (Orca.exe on Windows, Orca on macOS and Linux). Its
 *  own CLI launcher (orca.exe, lowercase, short-lived) never parents a shell,
 *  so an exact match is safe on case-insensitive names. */
const ORCA_PROCESS = /^orca(\.exe)?$/i;

/** Does `pid` run inside an Orca terminal on this host? See hasAncestor. */
export function isInsideOrcaTree(pid: number, tree: Map<number, ProcessEntry>): boolean | "unknown" {
  return hasAncestor(pid, tree, ORCA_PROCESS);
}

/** true / false, or "unknown" when the host cannot enumerate processes or
 *  cannot order the chain by start time. `tree` lets one join share a single
 *  enumeration between the WezTerm and Orca checks. */
export async function isInsideWezTerm(pid: number, tree?: () => Promise<Map<number, ProcessEntry> | null>): Promise<boolean | "unknown"> {
  if (!(pid > 0)) return false;
  const t = await (tree ?? listParentPids)();
  if (!t) return "unknown";
  return isInsideWezTermTree(pid, t);
}

/** Same contract as isInsideWezTerm, for Orca. */
export async function isInsideOrca(pid: number, tree?: () => Promise<Map<number, ProcessEntry> | null>): Promise<boolean | "unknown"> {
  if (!(pid > 0)) return false;
  const t = await (tree ?? listParentPids)();
  if (!t) return "unknown";
  return isInsideOrcaTree(pid, t);
}

/** One process enumeration per join, however many terminal checks ask for
 *  it. Never shared across joins: a cached table could miss a process that
 *  started a moment ago and misread it as absent. */
export function processTreeOnce(): () => Promise<Map<number, ProcessEntry> | null> {
  let pending: Promise<Map<number, ProcessEntry> | null> | null = null;
  return () => (pending ??= listParentPids());
}

/** Get extra env vars needed for wezterm CLI (socket path). */
export function getWeztermEnv(): Record<string, string> { return weztermEnv; }

export async function discoverWezTerm(): Promise<TerminalInfo[]> {
  try {
    const env = weztermProbeEnv(weztermEnv.WEZTERM_UNIX_SOCKET);
    const { stdout } = await execFileAsync(
      weztermPath, ["cli", "--no-auto-start", "list", "--format", "json"],
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

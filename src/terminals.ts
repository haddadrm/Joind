/**
 * Terminal session discovery — finds running CLI agent processes.
 *
 * Tab title strategy (Windows):
 *  1. AttachConsole(pid) + GetConsoleTitleW  → process-set title + pseudo-HWND + WT root HWND
 *  2. PowerShell UIAutomation               → all WT tab names keyed by WT window HWND
 *  3. Correlation heuristic                 → exact match first, then sole-unmatched fallback
 *  4. After invite: SetConsoleTitleW(name)  → future scans auto-match by exact title
 *
 * Deduplication: openclaw double-spawns (cmd → node → node). We keep only
 * the outermost process of each same-type parent-child chain.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface TerminalInfo {
  pid: number;
  ppid: number;
  name: string;
  command: string;
  type: "claude" | "codex" | "gemini" | "openclaw" | "unknown";
  tabTitle?: string;
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
// Step 1: AttachConsole per PID — process title + pseudo-HWND + WT HWND
// ---------------------------------------------------------------------------

async function readConsoleInfo(pids: number[]): Promise<Map<number, ConsoleInfo>> {
  const result = new Map<number, ConsoleInfo>();
  if (pids.length === 0) return result;

  const pidList = pids.join(",");
  const script = `
import ctypes
from ctypes import wintypes
import json

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
user32 = ctypes.WinDLL('user32', use_last_error=True)

kernel32.FreeConsole.restype = wintypes.BOOL
kernel32.AttachConsole.restype = wintypes.BOOL
kernel32.AttachConsole.argtypes = [wintypes.DWORD]
kernel32.GetConsoleTitleW.restype = wintypes.DWORD
kernel32.GetConsoleTitleW.argtypes = [wintypes.LPWSTR, wintypes.DWORD]
user32.GetConsoleWindow.restype = wintypes.HWND
user32.GetAncestor.restype = wintypes.HWND
user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]

GA_ROOTOWNER = 3
ATTACH_PARENT = 0xFFFFFFFF
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
        results[str(pid)] = {
            'processTitle': process_title,
            'pseudoHwnd': pseudo_hwnd,
            'wtHwnd': wt_hwnd
        }
        kernel32.FreeConsole()

kernel32.AttachConsole(ATTACH_PARENT)
print(json.dumps(results))
`;

  try {
    const { stdout } = await execFileAsync("python", ["-c", script], {
      timeout: 10000,
    });
    const data = JSON.parse(stdout.trim()) as Record<string, ConsoleInfo>;
    for (const [pidStr, info] of Object.entries(data)) {
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) result.set(pid, info);
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

  // Group PIDs by WT window HWND
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

    // Pass 1: exact process title → UIA tab name match
    for (const pid of pids) {
      const pt = consoleInfo.get(pid)!.processTitle;
      if (pt && tabNames.includes(pt)) {
        result.set(pid, pt);
        claimed.add(pt);
      }
    }

    // Pass 2: sole unmatched PID ↔ sole unmatched tab name (user-renamed tab)
    const unPids = pids.filter((p) => !result.has(p));
    const unTabs = tabNames.filter((t) => !claimed.has(t));
    if (unPids.length === 1 && unTabs.length === 1) {
      result.set(unPids[0], unTabs[0]);
    } else {
      // Multiple ambiguous: fall back to process title
      for (const pid of unPids) {
        const pt = consoleInfo.get(pid)!.processTitle;
        if (pt) result.set(pid, pt);
      }
    }
  }

  // PIDs not in any detected WT window (plain cmd, defterm edge case)
  for (const [pid, info] of consoleInfo) {
    if (!result.has(pid) && info.processTitle) {
      result.set(pid, info.processTitle);
    }
  }

  return result;
}

async function readTabTitles(pids: number[]): Promise<Map<number, string>> {
  const [consoleInfo, uiaTabs] = await Promise.all([
    readConsoleInfo(pids),
    readWtUiaTabs(),
  ]);
  return correlateTabTitles(consoleInfo, uiaTabs);
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
// Main discovery
// ---------------------------------------------------------------------------

export async function discoverTerminals(): Promise<TerminalInfo[]> {
  if (process.platform === "win32") {
    return discoverWindows();
  }
  return discoverUnix();
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

    // Parse all processes
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

    // Find matching agent processes
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

    // Deduplicate parent-child chains (same agent type)
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

    // Read tab titles for all root matches
    const tabTitles = await readTabTitles(rootMatches.map((m) => m.proc.pid));

    // Build results
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
        tabTitle: tabTitles.get(m.proc.pid),
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

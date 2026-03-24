/**
 * Terminal session discovery — finds running CLI agent processes.
 *
 * Tab title: Uses AttachConsole(pid) + GetConsoleTitleW() to read the exact
 * title Windows Terminal displays in the tab strip. Simple, reliable, direct.
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
// Tab title: AttachConsole + GetConsoleTitleW (the only approach that works)
// ---------------------------------------------------------------------------

async function readConsoleTitles(pids: number[]): Promise<Map<number, string>> {
  const titles = new Map<number, string>();
  if (pids.length === 0) return titles;

  const pidList = pids.join(",");

  // Python script — AttachConsole per PID, read title, reattach.
  // Uses CONIN$ pattern (proven in inject.ts). Brief console detach per PID.
  const script = `
import ctypes
from ctypes import wintypes
import sys, json

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
kernel32.FreeConsole.restype = wintypes.BOOL
kernel32.AttachConsole.restype = wintypes.BOOL
kernel32.AttachConsole.argtypes = [wintypes.DWORD]
kernel32.GetConsoleTitleW.restype = wintypes.DWORD
kernel32.GetConsoleTitleW.argtypes = [wintypes.LPWSTR, wintypes.DWORD]

ATTACH_PARENT = 0xFFFFFFFF
results = {}

for pid in [${pidList}]:
    kernel32.FreeConsole()
    if kernel32.AttachConsole(pid):
        buf = ctypes.create_unicode_buffer(1024)
        length = kernel32.GetConsoleTitleW(buf, 1024)
        if length > 0:
            results[str(pid)] = buf.value
        kernel32.FreeConsole()

# Reattach to parent
kernel32.AttachConsole(ATTACH_PARENT)
print(json.dumps(results))
`;

  try {
    const { stdout } = await execFileAsync("python", ["-c", script], {
      timeout: 10000,
    });
    const data = JSON.parse(stdout.trim());
    for (const [pidStr, title] of Object.entries(data)) {
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && typeof title === "string" && title) {
        titles.set(pid, title);
      }
    }
  } catch {
    /* best-effort */
  }

  return titles;
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

    // Read console titles for all root matches
    const consoleTitles = await readConsoleTitles(
      rootMatches.map((m) => m.proc.pid)
    );

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
        tabTitle: consoleTitles.get(m.proc.pid),
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

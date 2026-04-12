/**
 * HarnessRegistry — defines available TUI agent harnesses and checks installation.
 *
 * Each harness describes a CLI tool (claude, codex, gemini, openclaw) with its
 * available flags, join support type, and default injection delay.
 *
 * Results are cached after the first call (per server lifetime).
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface FlagDef {
  id: string;
  label: string;
  type: "text" | "enum" | "boolean" | "multi-text";
  cli: string;           // "--permission-mode"
  options?: string[];    // for enum
  default?: string;
  placeholder?: string;
  help?: string;
  /**
   * Optional override for enum flags: maps each option value to a full
   * argv expansion. When set, replaces the default `--cli <value>` behavior.
   * Empty array means "emit nothing for this option" (useful for default modes).
   */
  valueArgs?: Record<string, string[]>;
}

export interface HarnessDefinition {
  id: string;
  label: string;
  command: string;       // "claude"
  installed: boolean;    // resolved by checkInstalled()
  version?: string;
  resolvedPath?: string; // full path resolved by where/which
  joinSupport: "mcp" | "rest" | "none";
  flags: FlagDef[];
  defaultDelay: number;  // ms to wait before injecting
}

/**
 * Pick the most Windows-executable path from a `where` result list.
 * On Windows, `where` often returns both a bash-style shim (no extension)
 * and the real `.cmd`/`.exe`/`.bat` wrapper — prefer the latter.
 */
export function pickBestExePath(paths: string[]): string | null {
  if (paths.length === 0) return null;
  if (process.platform !== "win32") return paths[0] ?? null;
  const extRank = (p: string): number => {
    const lower = p.toLowerCase();
    if (lower.endsWith(".exe")) return 0;
    if (lower.endsWith(".cmd")) return 1;
    if (lower.endsWith(".bat")) return 2;
    if (lower.endsWith(".ps1")) return 3;
    return 4; // bare (bash shim) — last resort
  };
  const sorted = [...paths].sort((a, b) => extRank(a) - extRank(b));
  return sorted[0] ?? null;
}

/** Check whether a CLI command is installed and retrieve its version string. */
export async function checkInstalled(
  command: string
): Promise<{ installed: boolean; version?: string; resolvedPath?: string }> {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const { stdout: wherePath } = await execFileAsync(whichCmd, [command], { timeout: 3000 });
    const lines = wherePath.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const resolved = pickBestExePath(lines);
    if (!resolved) return { installed: false };
    // Try --version on the resolved path (best-effort, non-fatal)
    try {
      const { stdout } = await execFileAsync(resolved, ["--version"], { timeout: 3000 });
      return { installed: true, version: stdout.trim().split(/\r?\n/)[0] || undefined, resolvedPath: resolved };
    } catch {
      return { installed: true, resolvedPath: resolved }; // found by where but --version failed — still installed
    }
  } catch {
    return { installed: false };
  }
}

/** Static harness flag definitions. Simplified schema: model + autonomy only. */
const HARNESS_DEFS: Array<Omit<HarnessDefinition, "installed" | "version">> = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    joinSupport: "mcp",
    defaultDelay: 5000,
    flags: [
      {
        id: "model",
        label: "Model",
        type: "text",
        cli: "--model",
        placeholder: "(default)",
        help: "Override the default model — leave blank for default",
      },
      {
        id: "permission-mode",
        label: "Autonomy",
        type: "enum",
        cli: "--permission-mode",
        options: ["default", "acceptEdits", "bypassPermissions"],
        default: "default",
        help: "Permission mode: default (prompt) | acceptEdits (auto-approve edits) | bypassPermissions (YOLO)",
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    joinSupport: "mcp",
    defaultDelay: 6000,
    flags: [
      {
        id: "model",
        label: "Model",
        type: "enum",
        cli: "--model",
        options: ["(default)", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark"],
        default: "(default)",
        help: "Codex model — (default) leaves the choice to Codex",
        valueArgs: {
          "(default)": [],
          "gpt-5.4": ["--model", "gpt-5.4"],
          "gpt-5.4-mini": ["--model", "gpt-5.4-mini"],
          "gpt-5.3-codex": ["--model", "gpt-5.3-codex"],
          "gpt-5.3-codex-spark": ["--model", "gpt-5.3-codex-spark"],
        },
      },
      {
        id: "autonomy",
        label: "Autonomy",
        type: "enum",
        cli: "",
        options: ["read-only", "workspace-write", "full-auto", "yolo"],
        default: "full-auto",
        help: "read-only: sandbox + ask | workspace-write: sandbox + on-request | full-auto: sandboxed auto | yolo: bypass everything",
        valueArgs: {
          "read-only": ["--sandbox", "read-only", "--ask-for-approval", "untrusted"],
          "workspace-write": ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
          "full-auto": ["--full-auto"],
          "yolo": ["--dangerously-bypass-approvals-and-sandbox"],
        },
      },
    ],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    joinSupport: "mcp",
    defaultDelay: 5000,
    flags: [
      {
        id: "model",
        label: "Model",
        type: "enum",
        cli: "--model",
        options: ["(default)", "gemini-3.1-pro", "gemini-3-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
        default: "(default)",
        help: "Gemini model — (default) lets Gemini auto-select",
        valueArgs: {
          "(default)": [],
          "gemini-3.1-pro": ["--model", "gemini-3.1-pro"],
          "gemini-3-flash": ["--model", "gemini-3-flash"],
          "gemini-2.5-pro": ["--model", "gemini-2.5-pro"],
          "gemini-2.5-flash": ["--model", "gemini-2.5-flash"],
        },
      },
      {
        id: "autonomy",
        label: "Autonomy",
        type: "enum",
        cli: "",
        options: ["default", "auto_edit", "plan", "yolo"],
        default: "yolo",
        help: "default: prompt | auto_edit: auto-approve edits | plan: read-only | yolo: auto-approve everything",
        valueArgs: {
          "default": [],
          "auto_edit": ["--approval-mode", "auto_edit"],
          "plan": ["--approval-mode", "plan"],
          "yolo": ["--yolo"],
        },
      },
    ],
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    command: "openclaw",
    joinSupport: "mcp",
    defaultDelay: 5000,
    flags: [
      {
        id: "model",
        label: "Model",
        type: "text",
        cli: "--model",
        placeholder: "(default)",
        help: "Override the default model — leave blank for default",
      },
    ],
  },
];

/** Cached result after first check. */
let cachedHarnesses: HarnessDefinition[] | null = null;

/**
 * Load harness definitions with live installed/version checks.
 * Checks all 4 harnesses in parallel.
 */
export async function loadHarnesses(): Promise<HarnessDefinition[]> {
  const results = await Promise.all(
    HARNESS_DEFS.map(async (def) => {
      const { installed, version, resolvedPath } = await checkInstalled(def.command);
      const harness: HarnessDefinition = {
        ...def,
        installed,
        version,
        resolvedPath,
      };
      return harness;
    })
  );
  return results;
}

/**
 * Get harness definitions, using cached result after first call.
 * Cache is per server lifetime — a restart re-checks installation.
 */
export async function getHarnesses(): Promise<HarnessDefinition[]> {
  if (cachedHarnesses !== null) return cachedHarnesses;
  cachedHarnesses = await loadHarnesses();
  return cachedHarnesses;
}

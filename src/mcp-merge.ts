/**
 * Project .mcp.json discovery and merge into agent-specific configs.
 *
 * When the launcher spawns a non-Claude agent in a crew folder, we look up
 * the directory tree for a project `.mcp.json`. If found, the listed MCP
 * servers are merged into that agent's config so the agent inherits the
 * project's MCP setup without manual configuration.
 *
 * Claude Code reads .mcp.json natively and is skipped here.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join, parse } from "path";

export type McpServerEntry = Record<string, unknown>;
export type McpServerMap = Record<string, McpServerEntry>;

export interface ProjectMcp {
  path: string;
  servers: McpServerMap;
}

/**
 * Walk up from `startDir` looking for the first `.mcp.json` containing an
 * `mcpServers` map. Returns null when none is found before reaching the
 * filesystem root.
 */
export function findProjectMcp(startDir: string): ProjectMcp | null {
  let dir = startDir;
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, ".mcp.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { mcpServers?: McpServerMap };
        const servers = parsed.mcpServers;
        if (servers && typeof servers === "object" && Object.keys(servers).length > 0) {
          return { path: candidate, servers };
        }
      } catch {
        /* ignore malformed; keep walking */
      }
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Merge project MCP servers into Gemini's project-local settings file at
 * `<crewPath>/.gemini/settings.json`. Project entries override existing
 * keys; a `_joindMergedAt` timestamp is written so a human can see the
 * file was touched by Joind.
 */
function applyForGemini(crewPath: string, servers: McpServerMap): void {
  const settingsDir = join(crewPath, ".gemini");
  const settingsPath = join(settingsDir, "settings.json");
  let existing: { mcpServers?: McpServerMap; [key: string]: unknown } = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf8")) ?? {};
    } catch {
      existing = {};
    }
  }
  const merged = { ...existing, mcpServers: { ...(existing.mcpServers ?? {}), ...servers }, _joindMergedAt: new Date().toISOString() };
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2), "utf8");
}

/**
 * Apply discovered project MCP servers to whichever harness benefits.
 * Returns a short status string for logging; never throws.
 *
 * Currently implemented for Gemini. Claude/OpenClaw read project `.mcp.json`
 * natively. Codex/Copilot are documented as TODO — they use TOML/per-user
 * config formats that need agent-specific testing before mutation.
 */
export function applyProjectMcp(harnessId: string, crewPath: string): string {
  try {
    const project = findProjectMcp(crewPath);
    if (!project) return "no project .mcp.json found";
    const count = Object.keys(project.servers).length;
    switch (harnessId) {
      case "gemini":
        applyForGemini(crewPath, project.servers);
        return `merged ${count} server(s) into ${join(crewPath, ".gemini", "settings.json")}`;
      case "claude":
      case "openclaw":
        return `${count} server(s) available; ${harnessId} reads .mcp.json natively`;
      case "codex":
      case "copilot":
        return `${count} server(s) available but ${harnessId} merge not yet implemented`;
      default:
        return `${count} server(s) available; no merge implementation for ${harnessId}`;
    }
  } catch (err) {
    return `merge failed: ${(err as Error).message}`;
  }
}

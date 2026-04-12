/**
 * Session listers for the Agent Launcher resume feature.
 *
 * Each harness stores its sessions differently:
 *  - Claude Code:  ~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl  (per-cwd dir)
 *  - Codex:        ~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl  (global, cwd in file)
 *  - Gemini CLI:   ~/.gemini/tmp/<friendly-or-sha256>/chats/session-*.json
 *  - OpenClaw:     stubbed (broken install, different invocation pattern)
 *
 * Returns a uniform SessionInfo shape for the frontend dropdown.
 *
 * Note: This is separate from src/sessions.ts which handles multi-phase
 * workflow session orchestration. This module only handles listing past
 * TUI sessions for the resume dropdown.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { createReadStream } from "fs";
import { createInterface } from "readline";

export interface SessionInfo {
  id: string;              // resume identifier — UUID or sessionKey
  title?: string;          // human-readable title when available (slug, thread name, etc.)
  firstMessage?: string;   // truncated first user message for preview
  lastActivity: number;    // Unix ms — file mtime
  messageCount?: number;
  model?: string;
  cwd?: string;
}

const DEFAULT_LIMIT = 30;
const PREVIEW_LEN = 100;

/** Normalize a Windows path for comparison: absolute + lowercase + backslash separators. */
function normalizePath(p: string): string {
  if (!p) return "";
  try {
    return path.win32.resolve(p).toLowerCase().replace(/\//g, "\\");
  } catch {
    return p.toLowerCase().replace(/\//g, "\\");
  }
}

/** Truncate a string to at most n characters, ending with ellipsis if cut. */
function preview(s: string, n = PREVIEW_LEN): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

/** Extract the text of a polymorphic message.content (string or array of blocks). */
function extractMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") return block;
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (typeof b.text === "string") return b.text;
      }
    }
  }
  return undefined;
}

// ---------- Claude Code ----------

async function listClaudeSessions(cwd: string, limit: number): Promise<SessionInfo[]> {
  const sanitized = cwd.replace(/[:\\/]/g, "-");
  const dir = path.join(os.homedir(), ".claude", "projects", sanitized);
  if (!fs.existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));

  const withStats = await Promise.all(
    jsonlFiles.map(async (f) => {
      const full = path.join(dir, f);
      try {
        const st = await fsp.stat(full);
        return { file: f, full, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
  );
  const sorted = withStats
    .filter((x): x is { file: string; full: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  const results: SessionInfo[] = [];
  for (const entry of sorted) {
    const id = entry.file.replace(/\.jsonl$/, "");
    let slug: string | undefined;
    let firstMessage: string | undefined;
    let messageCount = 0;

    try {
      const stream = createReadStream(entry.full, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let linesRead = 0;
      for await (const line of rl) {
        linesRead++;
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (!slug && typeof obj.slug === "string") slug = obj.slug;
          if (obj.type === "user" && !firstMessage) {
            const msg = obj.message as Record<string, unknown> | undefined;
            const text = extractMessageText(msg?.content);
            // Skip heartbeat prompts and other injected noise
            if (text && !/HEARTBEAT|Read HEARTBEAT\.md/i.test(text)) {
              firstMessage = text;
            }
          }
          if (obj.type === "user" || obj.type === "assistant") messageCount++;
        } catch {
          // skip malformed line
        }
        // Stop early once we have both slug and first message
        if (slug && firstMessage && linesRead > 50) break;
      }
      rl.close();
      stream.destroy();
    } catch {
      // file unreadable — still include it with minimal info
    }

    results.push({
      id,
      title: slug,
      firstMessage: firstMessage ? preview(firstMessage) : undefined,
      lastActivity: entry.mtime,
      messageCount: messageCount || undefined,
      cwd,
    });
  }
  return results;
}

// ---------- Codex ----------

async function walkRollouts(dir: string, acc: Array<{ full: string; mtime: number }>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkRollouts(full, acc);
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      try {
        const st = await fsp.stat(full);
        acc.push({ full, mtime: st.mtimeMs });
      } catch {
        // skip
      }
    }
  }
}

async function listCodexSessions(cwd: string, limit: number): Promise<SessionInfo[]> {
  const root = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(root)) return [];

  const files: Array<{ full: string; mtime: number }> = [];
  await walkRollouts(root, files);
  files.sort((a, b) => b.mtime - a.mtime);

  const target = normalizePath(cwd);
  const results: SessionInfo[] = [];

  for (const entry of files) {
    if (results.length >= limit) break;

    let sessionId: string | undefined;
    let sessionCwd: string | undefined;
    let title: string | undefined;
    let firstMessage: string | undefined;
    let model: string | undefined;

    try {
      const stream = createReadStream(entry.full, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let lineNum = 0;
      for await (const line of rl) {
        lineNum++;
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          // Codex wraps all data in a `payload` object
          const payload = (typeof obj.payload === "object" && obj.payload !== null
            ? obj.payload
            : obj) as Record<string, unknown>;
          if (obj.type === "session_meta") {
            sessionId = typeof payload.id === "string" ? payload.id : undefined;
            sessionCwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
            // Early exit if wrong cwd
            if (!sessionCwd || normalizePath(sessionCwd) !== target) break;
          }
          if (obj.type === "turn_context" && !model) {
            if (typeof payload.model === "string") model = payload.model;
          }
          // Codex uses response_item with role=user for user messages
          if (obj.type === "response_item" && !firstMessage) {
            if (payload.role === "user" || payload.role === "developer") {
              const content = Array.isArray(payload.content) ? payload.content : [];
              for (const block of content) {
                if (block && typeof block === "object") {
                  const b = block as Record<string, unknown>;
                  if (b.type === "input_text" && typeof b.text === "string") {
                    if (!/HEARTBEAT|Read HEARTBEAT\.md/i.test(b.text)) {
                      firstMessage = b.text;
                      break;
                    }
                  }
                }
              }
            }
          }
          if (lineNum > 30 && firstMessage) break;
        } catch {
          // skip
        }
      }
      rl.close();
      stream.destroy();
    } catch {
      continue;
    }

    if (!sessionId || !sessionCwd || normalizePath(sessionCwd) !== target) continue;
    results.push({
      id: sessionId,
      title,
      firstMessage: firstMessage ? preview(firstMessage) : undefined,
      lastActivity: entry.mtime,
      model,
      cwd: sessionCwd,
    });
  }
  return results;
}

// ---------- Gemini CLI ----------

async function listGeminiSessions(cwd: string, limit: number): Promise<SessionInfo[]> {
  const home = os.homedir();
  const tmpRoot = path.join(home, ".gemini", "tmp");
  if (!fs.existsSync(tmpRoot)) return [];

  // Gemini uses two coexisting project dir schemes:
  //   1. Friendly name from ~/.gemini/projects.json (lowercased cwd → short name)
  //   2. sha256(cwd) — hash of cwd preserving case
  const expectedHash = crypto.createHash("sha256").update(cwd).digest("hex");
  const dirsToScan = new Set<string>();
  dirsToScan.add(path.join(tmpRoot, expectedHash));

  const projectsJson = path.join(home, ".gemini", "projects.json");
  if (fs.existsSync(projectsJson)) {
    try {
      const raw = await fsp.readFile(projectsJson, "utf8");
      const outer = JSON.parse(raw) as Record<string, unknown>;
      // projects.json may be { "projects": { cwd: friendlyName } } or flat
      const map = (
        typeof outer.projects === "object" && outer.projects !== null
          ? outer.projects
          : outer
      ) as Record<string, string>;
      const friendly = map[cwd.toLowerCase()] ?? map[cwd];
      if (typeof friendly === "string") dirsToScan.add(path.join(tmpRoot, friendly));
    } catch {
      // ignore
    }
  }

  const files: Array<{ full: string; mtime: number }> = [];
  for (const dir of dirsToScan) {
    const chats = path.join(dir, "chats");
    if (!fs.existsSync(chats)) continue;
    try {
      const entries = await fsp.readdir(chats);
      for (const f of entries) {
        if (!f.startsWith("session-") || !f.endsWith(".json")) continue;
        const full = path.join(chats, f);
        try {
          const st = await fsp.stat(full);
          files.push({ full, mtime: st.mtimeMs });
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const seen = new Set<string>();
  const results: SessionInfo[] = [];
  for (const entry of files) {
    if (results.length >= limit) break;
    try {
      const raw = await fsp.readFile(entry.full, "utf8");
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const projectHash = typeof obj.projectHash === "string" ? obj.projectHash : undefined;
      if (projectHash && projectHash !== expectedHash) continue;

      const id = typeof obj.sessionId === "string" ? obj.sessionId : undefined;
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const messages = Array.isArray(obj.messages) ? obj.messages : [];
      let firstMessage: string | undefined;
      for (const msg of messages) {
        if (msg && typeof msg === "object") {
          const m = msg as Record<string, unknown>;
          if (m.role === "user" || m.type === "user") {
            const text = extractMessageText(m.content);
            if (text && !/HEARTBEAT|Read HEARTBEAT\.md/i.test(text)) {
              firstMessage = text;
              break;
            }
          }
        }
      }

      results.push({
        id,
        firstMessage: firstMessage ? preview(firstMessage) : undefined,
        lastActivity: entry.mtime,
        messageCount: messages.length || undefined,
        cwd,
      });
    } catch {
      // skip malformed file
    }
  }
  return results;
}

// ---------- OpenClaw (stubbed) ----------

async function listOpenclawSessions(_cwd: string, _limit: number): Promise<SessionInfo[]> {
  // OpenClaw session resume is not yet supported in the launcher:
  //  - The local install is currently broken (ERR_MODULE_NOT_FOUND)
  //  - Resume invocation differs significantly (`openclaw tui --session <key> --message ...`)
  //  - Requires a running Gateway
  // Returns empty; v2 can wire this up after reinstall.
  return [];
}

// ---------- Dispatcher ----------

export async function listSessionsForHarness(
  harnessId: string,
  cwd: string,
  limit = DEFAULT_LIMIT
): Promise<SessionInfo[]> {
  switch (harnessId) {
    case "claude":
      return listClaudeSessions(cwd, limit);
    case "codex":
      return listCodexSessions(cwd, limit);
    case "gemini":
      return listGeminiSessions(cwd, limit);
    case "openclaw":
      return listOpenclawSessions(cwd, limit);
    default:
      return [];
  }
}

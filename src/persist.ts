/**
 * Session-aware JSONL persistence.
 *
 * Each conversation is a "session" with its own JSONL file.
 * Sessions are indexed in sessions.json for listing/switching.
 *
 * data/
 *   sessions/
 *     s-2026-03-24T10-30-00.jsonl
 *     s-2026-03-24T22-00-00.jsonl
 *   sessions.json  ← index
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "fs";
import { dirname, join } from "path";

export interface Persistable {
  id: number;
}

export interface SessionMeta {
  id: string;
  name: string;
  createdAt: number;
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Directory / file helpers
// ---------------------------------------------------------------------------

export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

export function loadMessages<T extends Persistable>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  const records: T[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      /* skip malformed */
    }
  }
  return records;
}

export function appendMessage<T>(filePath: string, record: T): void {
  ensureDir(dirname(filePath));
  appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
}

export function maxId<T extends Persistable>(records: T[]): number {
  let max = 0;
  for (const r of records) {
    if (r.id > max) max = r.id;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export class SessionStore {
  private dataDir: string;
  private sessionsDir: string;
  private indexPath: string;
  private sessions: SessionMeta[] = [];
  private activeId: string | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.sessionsDir = join(dataDir, "sessions");
    this.indexPath = join(dataDir, "sessions.json");
    ensureDir(this.sessionsDir);
    this.loadIndex();
  }

  private loadIndex(): void {
    if (existsSync(this.indexPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.indexPath, "utf-8"));
        this.sessions = raw.sessions ?? [];
        // Reconcile: check that JSONL files actually exist
        this.sessions = this.sessions.filter((s) =>
          existsSync(join(this.sessionsDir, s.id + ".jsonl"))
        );
      } catch {
        this.sessions = [];
      }
    }
    // Also discover any JSONL files not in the index (crash recovery)
    try {
      for (const file of readdirSync(this.sessionsDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const id = file.replace(".jsonl", "");
        if (!this.sessions.find((s) => s.id === id)) {
          const fullPath = join(this.sessionsDir, file);
          const msgs = loadMessages<Persistable>(fullPath);
          const stat = statSync(fullPath);
          this.sessions.push({
            id,
            name: id,
            createdAt: stat.birthtimeMs || Date.now(),
            messageCount: msgs.length,
          });
        }
      }
    } catch {
      /* sessionsDir might not exist yet */
    }
    this.saveIndex();
  }

  private saveIndex(): void {
    writeFileSync(
      this.indexPath,
      JSON.stringify({ sessions: this.sessions, active: this.activeId }, null, 2),
      "utf-8"
    );
  }

  /** Create a new session and make it active. Returns session meta. */
  createSession(name?: string): SessionMeta {
    const now = new Date();
    const id =
      "s-" +
      now.toISOString().replace(/[:.]/g, "-").replace("Z", "").slice(0, 19);
    const meta: SessionMeta = {
      id,
      name: name || this.defaultName(now),
      createdAt: now.getTime(),
      messageCount: 0,
    };
    this.sessions.push(meta);
    this.activeId = id;
    this.saveIndex();
    console.log(`  New session: ${meta.name} (${id})`);
    return meta;
  }

  /** Continue the most recent session. Returns null if none exist. */
  continueLastSession(): SessionMeta | null {
    if (this.sessions.length === 0) return null;
    const last = this.sessions[this.sessions.length - 1];
    this.activeId = last.id;
    this.saveIndex();
    console.log(`  Continuing session: ${last.name} (${last.id})`);
    return last;
  }

  /** Switch to a specific session by ID. */
  switchSession(id: string): SessionMeta | null {
    const meta = this.sessions.find((s) => s.id === id);
    if (!meta) return null;
    this.activeId = id;
    this.saveIndex();
    return meta;
  }

  /** Rename a session. */
  renameSession(id: string, newName: string): boolean {
    const meta = this.sessions.find((s) => s.id === id);
    if (!meta) return false;
    meta.name = newName;
    this.saveIndex();
    return true;
  }

  /** Get the active session's JSONL file path, or null. */
  getActiveFilePath(): string | null {
    if (!this.activeId) return null;
    return join(this.sessionsDir, this.activeId + ".jsonl");
  }

  getActiveSession(): SessionMeta | null {
    if (!this.activeId) return null;
    return this.sessions.find((s) => s.id === this.activeId) ?? null;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  /** List all sessions, newest first. */
  listSessions(): SessionMeta[] {
    return [...this.sessions].reverse();
  }

  /** Update message count for active session. */
  incrementMessageCount(): void {
    const meta = this.getActiveSession();
    if (meta) {
      meta.messageCount++;
      // Debounce index writes — save every 10 messages
      if (meta.messageCount % 10 === 0) this.saveIndex();
    }
  }

  /** Force save the index (call on shutdown). */
  flush(): void {
    this.saveIndex();
  }

  private defaultName(date: Date): string {
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const d = date.getDate();
    const m = months[date.getMonth()];
    const h = date.getHours();
    const period = h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
    return `${m} ${d} ${period}`;
  }
}

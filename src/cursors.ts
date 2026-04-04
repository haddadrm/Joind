/**
 * CursorStore — per-agent unread message cursors.
 *
 * Tracks the last-read message ID for each agent so the system
 * can compute unread counts and sender lists on demand.
 * Flat JSON file, debounced saves, monotonically increasing cursors.
 */

import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";

export class CursorStore {
  private cursors: Record<string, number> = {};
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "agent-cursors.json");
    this.load();
  }

  /** Returns last-read message ID for the agent (0 if never read). */
  get(agentName: string): number {
    return this.cursors[agentName] ?? 0;
  }

  /** Advance cursor forward. No-op if messageId <= current cursor. */
  advance(agentName: string, messageId: number): void {
    const current = this.cursors[agentName] ?? 0;
    if (messageId <= current) return;
    this.cursors[agentName] = messageId;
    this.scheduleSave();
  }

  /** Count unread messages and collect unique senders (excluding the agent itself). */
  getUnreadCount(
    agentName: string,
    allMessages: Array<{ id: number; sender: string }>,
  ): { count: number; senders: string[] } {
    const cursor = this.get(agentName);
    const senderSet = new Set<string>();
    let count = 0;

    for (const m of allMessages) {
      if (m.id > cursor && m.sender !== agentName) {
        count++;
        senderSet.add(m.sender);
      }
    }

    return { count, senders: Array.from(senderSet) };
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.cursors = parsed as Record<string, number>;
      }
    } catch {
      /* corrupt file — start fresh */
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      writeFileSync(this.filePath, JSON.stringify(this.cursors, null, 2) + "\n", "utf-8");
    }, 5_000);
  }
}

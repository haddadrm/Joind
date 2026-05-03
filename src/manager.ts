/**
 * ConversationManager — holds multiple isolated ChatRoom instances.
 *
 * Each conversation has its own messages, agents, and JSONL file.
 * Agents are bound to a specific conversation via chat_join.
 * The web UI has an "active" conversation it's viewing.
 */

import { EventEmitter } from "events";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { ChatRoom, type ChatMessage, type Agent, type RoomEvent } from "./room.js";
import { ensureDir, loadMessages, maxId, appendMessage } from "./persist.js";

export interface ConversationMeta {
  id: string;
  name: string;
  createdAt: number;
  messageCount: number;
  starred: boolean;
}

export class ConversationManager extends EventEmitter {
  private conversations = new Map<string, ChatRoom>();
  private meta = new Map<string, ConversationMeta>();
  private agentBindings = new Map<string, Array<{ conversationId: string; pid?: number; paneId?: number }>>(); // agentName → bindings
  private dataDir: string;
  private indexPath: string;
  private activeId: string | null = null; // web UI's currently viewed conversation

  constructor(dataDir: string) {
    super();
    this.dataDir = join(dataDir, "conversations");
    this.indexPath = join(dataDir, "conversations.json");
    ensureDir(this.dataDir);
    this.loadIndex();
  }

  // -----------------------------------------------------------------------
  // Index management
  // -----------------------------------------------------------------------

  private loadIndex(): void {
    if (existsSync(this.indexPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.indexPath, "utf-8"));
        const items: ConversationMeta[] = raw.conversations ?? [];
        for (const m of items) {
          if (existsSync(join(this.dataDir, m.id + ".jsonl")) || existsSync(join(this.dataDir, m.id))) {
            this.meta.set(m.id, m);
          }
        }
        this.activeId = raw.active ?? null;
      } catch {
        /* fresh start */
      }
    }
    // Discover orphan JSONL files not in index (fast — no file parsing)
    try {
      for (const file of readdirSync(this.dataDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const id = file.replace(".jsonl", "");
        if (!this.meta.has(id)) {
          const fullPath = join(this.dataDir, file);
          const stat = statSync(fullPath);
          // Count actual lines for accurate message count (only runs at startup for orphan files)
          const lineCount = Math.max(1, readFileSync(fullPath, "utf-8").split("\n").filter((l: string) => l.trim()).length);
          this.meta.set(id, {
            id,
            name: id,
            createdAt: stat.birthtimeMs || Date.now(),
            messageCount: lineCount,
            starred: false,
          });
        }
      }
    } catch { /* dir might not exist */ }
    this.saveIndex();
  }

  private saveIndex(): void {
    const conversations = [...this.meta.values()].sort((a, b) => b.createdAt - a.createdAt);
    writeFileSync(
      this.indexPath,
      JSON.stringify({ conversations, active: this.activeId }, null, 2),
      "utf-8"
    );
  }

  // -----------------------------------------------------------------------
  // Conversation lifecycle
  // -----------------------------------------------------------------------

  private validateName(name: string): string {
    const cleaned = name.trim().replace(/\s+/g, " ");
    if (cleaned.length === 0) return "New conversation";
    if (cleaned.length > 100) return cleaned.slice(0, 100);
    return cleaned;
  }

  /**
   * Import a conversation from an export bundle. Writes messages to a fresh
   * JSONL file before constructing the room so original IDs/timestamps are
   * preserved. Returns the new conversation meta.
   */
  importConversation(name: string, messages: ChatMessage[]): ConversationMeta {
    const now = new Date();
    const id = "c-" + now.toISOString().replace(/[:.]/g, "-").replace("Z", "").slice(0, 19) +
      "-" + Math.random().toString(36).slice(2, 6);
    const filePath = join(this.dataDir, id + ".jsonl");
    ensureDir(this.dataDir);
    for (const msg of messages) {
      if (msg.id == null) continue;
      appendMessage(filePath, msg);
    }
    const meta: ConversationMeta = {
      id,
      name: this.validateName(name || "Imported conversation"),
      createdAt: now.getTime(),
      messageCount: messages.length,
      starred: false,
    };
    this.meta.set(id, meta);
    this.getOrCreateRoom(id);  // loads from JSONL we just wrote
    this.saveIndex();
    this.emitGlobal("conversation-created", meta);
    console.log(`  Imported conversation: ${meta.name} (${id}) with ${messages.length} messages`);
    return meta;
  }

  createConversation(name?: string): ConversationMeta {
    const now = new Date();
    const id = "c-" + now.toISOString().replace(/[:.]/g, "-").replace("Z", "").slice(0, 19) +
      "-" + Math.random().toString(36).slice(2, 6);
    const meta: ConversationMeta = {
      id,
      name: this.validateName(name || "New conversation"),
      createdAt: now.getTime(),
      messageCount: 0,
      starred: false,
    };
    this.meta.set(id, meta);
    // Don't auto-switch active — callers choose when to switch
    this.getOrCreateRoom(id); // ensure room exists
    this.saveIndex();
    this.emitGlobal("conversation-created", meta);
    console.log(`  New conversation: ${meta.name} (${id})`);
    return meta;
  }

  private getOrCreateRoom(id: string): ChatRoom {
    let room = this.conversations.get(id);
    if (!room) {
      const filePath = join(this.dataDir, id + ".jsonl");
      room = new ChatRoom(filePath);
      // Forward room events with conversation ID
      room.on("room", (event: RoomEvent) => {
        this.emit("room", { ...event, conversationId: id });
        // Update message count
        if (event.type === "message") {
          const m = this.meta.get(id);
          if (m) {
            m.messageCount++;
            if (m.messageCount % 10 === 0) this.saveIndex();
          }
        }
      });
      this.conversations.set(id, room);
      this.emit("room-created", room);
    }
    return room;
  }

  /** Auto-name conversation from first non-system message. */
  autoName(id: string, text: string): void {
    const m = this.meta.get(id);
    if (!m || m.name !== "New conversation") return;
    m.name = this.validateName(text.slice(0, 60));
    this.saveIndex();
    this.emitGlobal("conversation-renamed", m);
  }

  getRoom(id: string): ChatRoom | undefined {
    if (!this.meta.has(id)) return undefined; // Prevent ghost-room resurrection
    return this.getOrCreateRoom(id);
  }

  getRoomForAgent(agentName: string, pid?: number, paneId?: number): ChatRoom | undefined {
    const convId = this.getAgentBinding(agentName, pid, paneId);
    if (!convId) return undefined;
    return this.conversations.get(convId);
  }

  getAgentConversationId(agentName: string, pid?: number, paneId?: number): string | undefined {
    return this.getAgentBinding(agentName, pid, paneId);
  }

  // -----------------------------------------------------------------------
  // Active conversation (web UI view)
  // -----------------------------------------------------------------------

  getActiveId(): string | null {
    return this.activeId;
  }

  setActive(id: string): boolean {
    if (!this.meta.has(id)) return false;
    this.activeId = id;
    this.getOrCreateRoom(id); // ensure loaded
    this.saveIndex();
    return true;
  }

  getActiveRoom(): ChatRoom | undefined {
    if (!this.activeId) return undefined;
    return this.getOrCreateRoom(this.activeId);
  }

  getActiveMeta(): ConversationMeta | null {
    if (!this.activeId) return null;
    return this.meta.get(this.activeId) ?? null;
  }

  // -----------------------------------------------------------------------
  // Agent binding
  // -----------------------------------------------------------------------

  bindAgent(agentName: string, conversationId: string, pid?: number, paneId?: number): void {
    let entries = this.agentBindings.get(agentName);
    if (!entries) {
      entries = [];
      this.agentBindings.set(agentName, entries);
    }
    // Update existing entry for same pid/paneId, else same conversation, else append
    const idx = entries.findIndex(e =>
      (paneId != null && e.paneId === paneId) ||
      (pid != null && pid !== 0 && e.pid === pid)
    );
    const convIdx = idx < 0 ? entries.findIndex(e => e.conversationId === conversationId) : -1;
    if (idx >= 0) {
      // Merge: keep non-zero values from both old and new
      const old = entries[idx];
      entries[idx] = {
        conversationId,
        pid: (pid && pid !== 0) ? pid : old.pid,
        paneId: paneId != null ? paneId : old.paneId,
      };
    } else if (convIdx >= 0) {
      const old = entries[convIdx];
      entries[convIdx] = {
        conversationId,
        pid: (pid && pid !== 0) ? pid : old.pid,
        paneId: paneId != null ? paneId : old.paneId,
      };
    } else {
      entries.push({ conversationId, pid, paneId });
    }
  }

  unbindAgent(agentName: string, conversationId?: string): void {
    if (!conversationId) {
      this.agentBindings.delete(agentName);
      return;
    }
    const entries = this.agentBindings.get(agentName);
    if (!entries) return;
    const filtered = entries.filter(e => e.conversationId !== conversationId);
    if (filtered.length === 0) {
      this.agentBindings.delete(agentName);
    } else {
      this.agentBindings.set(agentName, filtered);
    }
  }

  getAgentBinding(agentName: string, pid?: number, paneId?: number): string | undefined {
    const entries = this.agentBindings.get(agentName);
    if (!entries || entries.length === 0) return undefined;
    // Exact match by paneId (most specific)
    if (paneId != null) {
      const match = entries.find(e => e.paneId === paneId);
      if (match) return match.conversationId;
    }
    // Exact match by pid
    if (pid != null && pid !== 0) {
      const match = entries.find(e => e.pid === pid);
      if (match) return match.conversationId;
    }
    // Fallback: single binding = unambiguous
    if (entries.length === 1) return entries[0].conversationId;
    // Ambiguous — multiple bindings, no disambiguator
    return undefined;
  }

  // -----------------------------------------------------------------------
  // Conversation operations
  // -----------------------------------------------------------------------

  renameConversation(id: string, name: string): boolean {
    const m = this.meta.get(id);
    if (!m) return false;
    m.name = this.validateName(name);
    this.saveIndex();
    this.emitGlobal("conversation-renamed", m);
    return true;
  }

  starConversation(id: string, starred: boolean): boolean {
    const m = this.meta.get(id);
    if (!m) return false;
    m.starred = starred;
    this.saveIndex();
    return true;
  }

  deleteConversation(id: string): boolean {
    const m = this.meta.get(id);
    if (!m) return false;
    // Destroy room (clears stale-sweep interval + typing timeouts)
    const room = this.conversations.get(id);
    if (room) room.destroy();
    // Remove JSONL file
    const filePath = join(this.dataDir, id + ".jsonl");
    try { unlinkSync(filePath); } catch { /* ok */ }
    // Remove room from memory
    this.conversations.delete(id);
    this.meta.delete(id);
    // Unbind any agents in this conversation
    for (const [agent, entries] of this.agentBindings) {
      const filtered = entries.filter(e => e.conversationId !== id);
      if (filtered.length === 0) {
        this.agentBindings.delete(agent);
      } else {
        this.agentBindings.set(agent, filtered);
      }
    }
    // If this was active, clear
    if (this.activeId === id) this.activeId = null;
    this.saveIndex();
    this.emitGlobal("conversation-deleted", { id });
    return true;
  }

  // -----------------------------------------------------------------------
  // Listing
  // -----------------------------------------------------------------------

  listConversations(): ConversationMeta[] {
    const all = [...this.meta.values()];
    // Starred first, then by date descending
    return all.sort((a, b) => {
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
  }

  searchConversations(query: string): ConversationMeta[] {
    const q = query.toLowerCase();
    return this.listConversations().filter(
      (c) => c.name.toLowerCase().includes(q) || c.id.includes(q)
    );
  }

  getMeta(id: string): ConversationMeta | undefined {
    return this.meta.get(id);
  }

  /** Flush all indexes to disk. */
  flush(): void {
    this.saveIndex();
  }

  private emitGlobal(type: string, data: unknown): void {
    this.emit("global", { type, data });
  }
}

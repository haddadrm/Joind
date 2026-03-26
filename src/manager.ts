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
import { ensureDir, loadMessages, maxId } from "./persist.js";

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
  private agentBindings = new Map<string, string>(); // agentName → conversationId
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
          // Estimate message count from file size (~150 bytes per message avg)
          const estimatedCount = Math.max(1, Math.round(stat.size / 150));
          this.meta.set(id, {
            id,
            name: id,
            createdAt: stat.birthtimeMs || Date.now(),
            messageCount: estimatedCount,
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

  createConversation(name?: string): ConversationMeta {
    const now = new Date();
    const id = "c-" + now.toISOString().replace(/[:.]/g, "-").replace("Z", "").slice(0, 19) +
      "-" + Math.random().toString(36).slice(2, 6);
    const meta: ConversationMeta = {
      id,
      name: name || "New conversation",
      createdAt: now.getTime(),
      messageCount: 0,
      starred: false,
    };
    this.meta.set(id, meta);
    this.activeId = id;
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
    }
    return room;
  }

  /** Auto-name conversation from first non-system message. */
  autoName(id: string, text: string): void {
    const m = this.meta.get(id);
    if (!m || m.name !== "New conversation") return;
    m.name = text.slice(0, 60).replace(/\n/g, " ").trim() || "New conversation";
    this.saveIndex();
    this.emitGlobal("conversation-renamed", m);
  }

  getRoom(id: string): ChatRoom | undefined {
    return this.getOrCreateRoom(id);
  }

  getRoomForAgent(agentName: string): ChatRoom | undefined {
    const convId = this.agentBindings.get(agentName);
    if (!convId) return undefined;
    return this.conversations.get(convId);
  }

  getAgentConversationId(agentName: string): string | undefined {
    return this.agentBindings.get(agentName);
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

  bindAgent(agentName: string, conversationId: string): void {
    this.agentBindings.set(agentName, conversationId);
  }

  unbindAgent(agentName: string): void {
    this.agentBindings.delete(agentName);
  }

  getAgentBinding(agentName: string): string | undefined {
    return this.agentBindings.get(agentName);
  }

  // -----------------------------------------------------------------------
  // Conversation operations
  // -----------------------------------------------------------------------

  renameConversation(id: string, name: string): boolean {
    const m = this.meta.get(id);
    if (!m) return false;
    m.name = name;
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
    // Remove JSONL file
    const filePath = join(this.dataDir, id + ".jsonl");
    try { unlinkSync(filePath); } catch { /* ok */ }
    // Remove room from memory
    this.conversations.delete(id);
    this.meta.delete(id);
    // Unbind any agents in this conversation
    for (const [agent, convId] of this.agentBindings) {
      if (convId === id) this.agentBindings.delete(agent);
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

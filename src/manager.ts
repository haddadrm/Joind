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
import { ChoiceStore } from "./choices.js";
import { PinStore } from "./pins.js";
import { TagStore } from "./tags.js";
import { AskStore } from "./asks.js";

export interface ConversationMeta {
  id: string;
  name: string;
  createdAt: number;
  messageCount: number;
  starred: boolean;
}

/** Handle for a join that is awaiting validation; see beginJoin. */
export interface JoinToken {
  agentName: string;
  conversationId: string;
  /** position of this join in the global order of joins and departures */
  seq: number;
  /** the aliases known when the join began (request plus merge target) */
  aliases: string[];
}

export class ConversationManager extends EventEmitter {
  private conversations = new Map<string, ChatRoom>();
  private meta = new Map<string, ConversationMeta>();
  private agentBindings = new Map<string, Array<{ conversationId: string; pid?: number; paneId?: number }>>(); // agentName → bindings
  private dataDir: string;
  private indexPath: string;
  private activeId: string | null = null; // web UI's currently viewed conversation
  private choiceStore: ChoiceStore;
  private pinStore: PinStore;
  private tagStore: TagStore;
  private askStore: AskStore;

  constructor(dataDir: string) {
    super();
    this.dataDir = join(dataDir, "conversations");
    this.indexPath = join(dataDir, "conversations.json");
    this.choiceStore = new ChoiceStore(this.dataDir);
    this.pinStore = new PinStore(this.dataDir);
    this.tagStore = new TagStore(this.dataDir);
    this.askStore = new AskStore(this.dataDir);
    ensureDir(this.dataDir);
    this.loadIndex();
  }

  // -----------------------------------------------------------------------
  // Index management
  // -----------------------------------------------------------------------

  /**
   * Sidecar suffixes for per-conversation auxiliary stores. Files matching
   * `<convId>.<suffix>.jsonl` are NOT conversations and must be excluded
   * from orphan discovery and the index.
   */
  private static readonly SIDECAR_SUFFIXES = [".reactions", ".tasks", ".edits", ".choices", ".pins", ".tags", ".asks"];

  private isSidecarId(id: string): boolean {
    return ConversationManager.SIDECAR_SUFFIXES.some((s) => id.endsWith(s));
  }

  private loadIndex(): void {
    if (existsSync(this.indexPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.indexPath, "utf-8"));
        const items: ConversationMeta[] = raw.conversations ?? [];
        for (const m of items) {
          // Skip phantom entries from a previous run that mistook sidecar files for conversations
          if (this.isSidecarId(m.id)) continue;
          if (existsSync(join(this.dataDir, m.id + ".jsonl")) || existsSync(join(this.dataDir, m.id))) {
            this.meta.set(m.id, m);
          }
        }
        this.activeId = raw.active && !this.isSidecarId(raw.active) ? raw.active : null;
      } catch {
        /* fresh start */
      }
    }
    // Discover orphan JSONL files not in index (fast — no file parsing)
    try {
      for (const file of readdirSync(this.dataDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const id = file.replace(".jsonl", "");
        if (this.isSidecarId(id)) continue;
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
      const choiceStore = this.choiceStore;
      const pinStore = this.pinStore;
      const tagStore = this.tagStore;
      const askStore = this.askStore;
      room = new ChatRoom({
        chatFilePath: filePath,
        onChoice: (messageId, value, by, at) => choiceStore.record(id, { messageId, value, by, at }),
        onPin: (messageId, pinned, at) => pinStore.record(id, { messageId, pinned, at }),
        onTag: (messageId, tag, at) => tagStore.record(id, { messageId, tag, at }),
        onAskResolve: (messageId, by, at) => askStore.record(id, { messageId, resolvedBy: by, at }),
      });
      // Replay any persisted choice resolutions onto the freshly loaded messages
      const persistedChoices = choiceStore.load(id);
      if (persistedChoices.length > 0) room.applyChoiceRecords(persistedChoices);
      // Replay any persisted pin state
      const persistedPins = pinStore.load(id);
      if (persistedPins.length > 0) room.applyPinRecords(persistedPins);
      // Replay any persisted tags
      const persistedTags = tagStore.load(id);
      if (persistedTags.length > 0) room.applyTagRecords(persistedTags);
      // Replay any persisted ask resolutions
      const persistedAsks = askStore.load(id);
      if (persistedAsks.length > 0) room.applyAskRecords(persistedAsks);
      // Forward room events with conversation ID
      room.on("room", (event: RoomEvent) => {
        // Any departure (deliberate, timed out, or rename away) supersedes
        // every join for that name that is still waiting on validation.
        if (event.type === "leave") this.supersedeJoins((event.data as { name: string }).name);
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

  // ---- Join ordering ------------------------------------------------------
  // A join that awaits validation takes its place in a global order first
  // (beginJoin) and applies only if, at completion, nothing NEWER has touched
  // any alias it ends up holding or the room it targets (joinIsCurrent).
  // "Ends up holding" includes aliases discovered during validation (an
  // auto-detected pane) and aliases an existing binding would keep through
  // the merge, judged by the join's ORIGINAL position, so a late discovery
  // never promotes an older request over a newer one. A departure for the
  // name outranks every join begun before it. Different terminals of one
  // name in different rooms stay independent registrations.
  private joinCounter = 0;
  private aliasTouchedAt = new Map<string, number>();   // `${name}|${alias}` -> latest seq
  private roomTouchedAt = new Map<string, number>();    // `${conversationId}|${name}` -> latest seq
  private departedAt = new Map<string, number>();       // name -> seq of the latest departure

  /** Every alias a binding can match on (bindAgent merges by pid OR pane). */
  static joinTerminalKeys(pid: number | undefined, paneId: number | undefined): string[] {
    const keys: string[] = [];
    if (pid && pid > 0) keys.push(`pid:${pid}`);
    if (paneId != null) keys.push(`pane:${paneId}`);
    return keys.length > 0 ? keys : ["pid:0"];
  }

  /** The binding entry bindAgent() would merge a join into: first the one
   *  matching by pane or non-zero pid, else the one for the same
   *  conversation. Kept as one function so freshness and merging agree. */
  private mergeTargetFor(agentName: string, conversationId: string, pid: number | undefined, paneId: number | undefined) {
    const entries = this.agentBindings.get(agentName) ?? [];
    const byTerminal = entries.find(e =>
      (paneId != null && e.paneId === paneId) ||
      (pid != null && pid !== 0 && e.pid === pid)
    );
    return byTerminal ?? entries.find(e => e.conversationId === conversationId);
  }

  /**
   * The aliases a join will effectively hold once bound: the request's own,
   * plus those of the existing binding bindAgent would merge it with (it
   * keeps the aliases the request omitted).
   */
  effectiveJoinAliases(agentName: string, conversationId: string, pid: number | undefined, paneId: number | undefined): string[] {
    const keys = new Set(ConversationManager.joinTerminalKeys(pid, paneId));
    const target = this.mergeTargetFor(agentName, conversationId, pid, paneId);
    if (target) {
      if (target.pid && target.pid > 0) keys.add(`pid:${target.pid}`);
      if (target.paneId != null) keys.add(`pane:${target.paneId}`);
    }
    return [...keys];
  }

  beginJoin(agentName: string, conversationId: string, pid: number | undefined, paneId: number | undefined): JoinToken {
    const seq = ++this.joinCounter;
    const aliases = this.effectiveJoinAliases(agentName, conversationId, pid, paneId);
    for (const alias of aliases) this.aliasTouchedAt.set(`${agentName}|${alias}`, seq);
    this.roomTouchedAt.set(`${conversationId}|${agentName}`, seq);
    return { agentName, conversationId, seq, aliases };
  }

  /**
   * Decide at completion, with the pid and pane the join will actually bind
   * (a pane dropped by validation is passed as undefined). When current, the
   * join claims every alias it ends up with at its own position, so an older
   * join completing later and discovering one of them is superseded.
   */
  joinIsCurrent(token: JoinToken, finalPid: number | undefined, finalPaneId: number | undefined): boolean {
    const { agentName, conversationId, seq } = token;
    if ((this.departedAt.get(agentName) ?? 0) > seq) return false;
    if ((this.roomTouchedAt.get(`${conversationId}|${agentName}`) ?? 0) > seq) return false;
    const finalAliases = new Set([...token.aliases, ...this.effectiveJoinAliases(agentName, conversationId, finalPid, finalPaneId)]);
    for (const alias of finalAliases) {
      if ((this.aliasTouchedAt.get(`${agentName}|${alias}`) ?? 0) > seq) return false;
    }
    for (const alias of finalAliases) this.aliasTouchedAt.set(`${agentName}|${alias}`, seq);
    return true;
  }

  /** A departure for this name, from any terminal and room, outranks every join begun before it. */
  supersedeJoins(agentName: string): void {
    this.departedAt.set(agentName, ++this.joinCounter);
  }

  /** `paneId` null clears a previously bound pane (proved stale on rejoin); undefined keeps it. */
  bindAgent(agentName: string, conversationId: string, pid?: number, paneId?: number | null): void {
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
        paneId: paneId === null ? undefined : (paneId != null ? paneId : old.paneId),
      };
    } else if (convIdx >= 0) {
      const old = entries[convIdx];
      entries[convIdx] = {
        conversationId,
        pid: (pid && pid !== 0) ? pid : old.pid,
        paneId: paneId === null ? undefined : (paneId != null ? paneId : old.paneId),
      };
    } else {
      entries.push({ conversationId, pid, paneId: paneId ?? undefined });
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

  /**
   * Existing-binding lookup: pure read, NEVER creates a binding. Bindings are
   * created only by bindAgent during join flows (MCP chat_join, /api/agent/join,
   * UI invite /api/join). REST routes that return message content treat a
   * resolved binding as the agent's credential.
   */
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

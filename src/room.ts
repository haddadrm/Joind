/**
 * ChatRoom — a single conversation with its own messages, agents, and JSONL file.
 * Multiple ChatRoom instances exist simultaneously, managed by ConversationManager.
 */

import { EventEmitter } from "events";
import { writeFileSync } from "fs";
import { dirname } from "path";
import { inject } from "./inject.js";
import { getWeztermPath, getWeztermEnv } from "./terminals.js";
import { loadMessages, appendMessage, maxId, ensureDir } from "./persist.js";

export interface ChatMessage {
  id: number;
  sender: string;
  text: string;
  timestamp: number;
  image?: string;
  replyTo?: number;
  tag?: string;
  pinned?: boolean;
  to?: string[];  // targeted recipients (DM-style visibility)
}

export interface Agent {
  name: string;
  pid: number;
  joinedAt: number;
  active: boolean;
  role?: string;
  status?: string;
  lastSeen: number;
  weztermPaneId?: number;
}

export interface RoomEvent {
  type: "message" | "join" | "leave" | "rename" | "role" | "typing" | "stale";
  data: ChatMessage | Agent | { oldName: string; newName: string; agent: Agent } | { name: string; typing: boolean };
}

export class ChatRoom extends EventEmitter {
  private messages: ChatMessage[] = [];
  private agents = new Map<string, Agent>();
  private nextId = 1;
  private typingState = new Map<string, NodeJS.Timeout>();
  private statusTimeouts = new Map<string, NodeJS.Timeout>();
  private pendingMentions = new Map<string, NodeJS.Timeout>(); // batched mention injection
  private chatFile: string | null = null;
  private staleInterval: ReturnType<typeof setInterval> | null = null;
  private agentTurnCount = 0; // consecutive agent turns since last human message
  turnGuard: { enabled: boolean; limit: number } | null = null;

  constructor(chatFilePath?: string) {
    super();
    if (chatFilePath) {
      this.chatFile = chatFilePath;
      const loaded = loadMessages<ChatMessage>(chatFilePath);
      this.messages = loaded;
      this.nextId = maxId(loaded) + 1;
      if (loaded.length > 0) {
        console.log(`  Loaded ${loaded.length} messages (next ID: ${this.nextId})`);
      }
    }
    this.staleInterval = setInterval(() => this.sweepStale(), 5000);
  }

  private persist(msg: ChatMessage): void {
    if (this.chatFile) {
      appendMessage(this.chatFile, msg);
    }
  }

  join(name: string, pid: number, weztermPaneId?: number, persistedRole?: string): Agent {
    const existing = this.agents.get(name);
    if (existing) {
      existing.active = true;
      existing.pid = pid;
      if (weztermPaneId != null) existing.weztermPaneId = weztermPaneId;
      if (!existing.role && persistedRole) existing.role = persistedRole;
      existing.lastSeen = Date.now();
      this.emit("room", { type: "join", data: existing } as RoomEvent);
      return existing;
    }

    const agent: Agent = {
      name,
      pid,
      joinedAt: Date.now(),
      active: true,
      role: persistedRole,
      lastSeen: Date.now(),
      weztermPaneId,
    };
    this.agents.set(name, agent);
    this.addSystem(`${name} joined the chat`);
    this.emit("room", { type: "join", data: agent } as RoomEvent);
    return agent;
  }

  leave(name: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.active = false;
      this.agents.delete(name);
      this.addSystem(`${name} left the chat`);
      this.emit("room", { type: "leave", data: agent } as RoomEvent);
    }
  }

  send(sender: string, text: string, opts?: { image?: string; replyTo?: number; to?: string[] }): ChatMessage {
    const msg: ChatMessage = {
      id: this.nextId++,
      sender,
      text,
      timestamp: Date.now(),
    };
    if (opts?.image) msg.image = opts.image;
    if (opts?.replyTo) msg.replyTo = opts.replyTo;
    if (opts?.to && opts.to.length > 0) msg.to = opts.to;

    this.messages.push(msg);
    this.persist(msg);
    this.emit("room", { type: "message", data: msg } as RoomEvent);

    // Update lastSeen + clear typing
    const senderAgent = this.agents.get(sender);
    if (senderAgent) senderAgent.lastSeen = Date.now();
    this.setTyping(sender, false);

    // Turn guard: track consecutive agent turns
    if (sender !== "system") {
      if (this.agents.has(sender)) {
        this.agentTurnCount++;
      } else {
        // Human message resets the counter
        this.agentTurnCount = 0;
      }
    }

    // Detect @mentions → inject into agents IN THIS CONVERSATION
    const mentions = this.extractMentions(text);
    const targets = mentions.includes("all")
      ? [...this.agents.keys()].filter((n) => n !== sender)
      : mentions;

    // Turn guard: suppress injection if limit reached
    if (this.turnGuard && this.turnGuard.enabled && this.agentTurnCount >= this.turnGuard.limit) {
      if (targets.length > 0 && sender !== "system") {
        this.addSystem(`Turn limit reached (${this.turnGuard.limit} turns). Send a message to continue.`);
        this.emit("room", { type: "turn-guard", data: { count: this.agentTurnCount, limit: this.turnGuard.limit } } as unknown as RoomEvent);
      }
    } else {
      // Batch mentions: collect for 2s before injecting to reduce noise
      for (const target of targets) {
        if (this.pendingMentions.has(target)) continue; // already queued
        const timeout = setTimeout(() => {
          this.pendingMentions.delete(target);
          this.injectMentions(sender, [target]).catch((err) => {
            console.error(`  ✗ Mention injection error: ${err}`);
          });
        }, 2000);
        this.pendingMentions.set(target, timeout);
      }
    }

    console.log(`  [#${msg.id} ${sender}] ${text}`);
    return msg;
  }

  private async injectMentions(sender: string, targets: string[]): Promise<void> {
    for (const name of targets) {
      const agent = this.agents.get(name);
      if (agent?.active && agent.name !== sender) {
        const roleHint = agent.role ? ` Your role: ${agent.role}.` : "";
        const pidParam = agent.pid ? `&pid=${agent.pid}` : "";
        const paneParam = agent.weztermPaneId != null ? `&paneId=${agent.weztermPaneId}` : "";
        const pidBody = agent.pid ? `,"pid":${agent.pid}` : "";
        const prompt =
          `[joind] @${name} mentioned by ${sender}.${roleHint} ` +
          `Read: curl -s "http://127.0.0.1:4200/api/agent/read?sender=${name}&since=0${pidParam}${paneParam}" — ` +
          `Reply: curl -s -X POST http://127.0.0.1:4200/api/agent/send -H "Content-Type: application/json" ` +
          `-d '{"sender":"${name}","text":"YOUR_REPLY"${pidBody}}'`;
        const target = agent.weztermPaneId != null ? `pane:${agent.weztermPaneId}` : `PID:${agent.pid}`;
        console.log(`  → Injecting into ${name} (${target})...`);
        try {
          await inject(agent.pid, prompt, agent.weztermPaneId, getWeztermPath(), getWeztermEnv());
          // Brief delay between injections to let Windows console state settle
          if (process.platform === "win32") {
            await new Promise((r) => setTimeout(r, 300));
          }
        } catch (err) {
          console.error(`  ✗ Injection failed for ${name}: ${err}`);
        }
      }
    }
  }

  read(since?: number, limit = 50, from?: string, viewer?: string): ChatMessage[] {
    let msgs = this.messages;
    if (since != null) {
      msgs = msgs.filter((m) => m.id > since);
    }
    if (from) {
      msgs = msgs.filter((m) => m.sender === from);
    }
    // Filter DMs: only show messages addressed to the viewer or public messages
    if (viewer) {
      msgs = msgs.filter((m) => !m.to || m.to.includes(viewer) || m.sender === viewer);
    }
    return msgs.slice(-limit);
  }

  getMessageById(id: number): ChatMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  deleteMessage(id: number): boolean {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.messages.splice(idx, 1);
    // Rewrite JSONL without the deleted message
    if (this.chatFile) {
      ensureDir(dirname(this.chatFile));
      const content = this.messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      writeFileSync(this.chatFile, content, "utf-8");
    }
    this.emit("room", { type: "message-deleted", data: { id } } as unknown as RoomEvent);
    console.log(`  [delete] Message #${id} removed`);
    return true;
  }

  who(): Agent[] {
    return [...this.agents.values()];
  }

  whoNames(): string[] {
    return [...this.agents.keys()];
  }

  getAgent(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  touch(name: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      const wasStale = (Date.now() - agent.lastSeen) > 120000;
      agent.lastSeen = Date.now();
      if (wasStale) {
        // Agent came back from stale — emit join event to refresh pill state
        this.emit("room", { type: "join", data: agent } as RoomEvent);
      }
    }
  }

  setTyping(name: string, isTyping: boolean): void {
    const existing = this.typingState.get(name);
    if (existing) {
      clearTimeout(existing);
      this.typingState.delete(name);
    }

    if (isTyping) {
      const timeout = setTimeout(() => {
        this.typingState.delete(name);
        this.emit("room", { type: "typing", data: { name, typing: false } } as RoomEvent);
      }, 30000);
      this.typingState.set(name, timeout);
    }

    this.emit("room", { type: "typing", data: { name, typing: isTyping } } as RoomEvent);
  }

  private sweepStale(): void {
    const now = Date.now();
    for (const [name, agent] of this.agents) {
      const elapsed = now - agent.lastSeen;
      if (elapsed > 120000) {
        // Check if the process is still alive before marking stale
        try {
          process.kill(agent.pid, 0); // signal 0 = existence check, doesn't kill
          // Process alive but idle — mark stale (pill dims)
          this.emit("room", { type: "stale", data: agent } as RoomEvent);
        } catch {
          // Process is dead — remove the agent
          this.leave(name);
        }
      }
    }
  }

  rename(oldName: string, newName: string): Agent | null {
    const agent = this.agents.get(oldName);
    if (!agent) return null;
    this.agents.delete(oldName);
    agent.name = newName;
    this.agents.set(newName, agent);
    this.addSystem(`${oldName} is now ${newName}`);
    this.emit("room", { type: "rename", data: { oldName, newName, agent } });
    return agent;
  }

  setRole(name: string, role: string): Agent | null {
    const agent = this.agents.get(name);
    if (!agent) return null;
    agent.role = role || undefined;
    if (role) {
      this.addSystem(`${name} is now: ${role}`);
    } else {
      this.addSystem(`${name} cleared their role`);
    }
    this.emit("room", { type: "role", data: agent });
    return agent;
  }

  setStatus(name: string, status: string): Agent | null {
    const agent = this.agents.get(name);
    if (!agent) return null;
    agent.status = status || undefined;
    // Auto-clear status after 10 minutes
    const existing = this.statusTimeouts.get(name);
    if (existing) clearTimeout(existing);
    if (status) {
      const timeout = setTimeout(() => {
        agent.status = undefined;
        this.statusTimeouts.delete(name);
        this.emit("room", { type: "agent-status", data: agent } as unknown as RoomEvent);
      }, 600000);
      this.statusTimeouts.set(name, timeout);
    } else {
      this.statusTimeouts.delete(name);
    }
    this.emit("room", { type: "agent-status", data: agent } as unknown as RoomEvent);
    return agent;
  }

  search(query: string, limit = 20): Array<{ message: ChatMessage; matchIndex: number }> {
    const q = query.toLowerCase();
    const results: Array<{ message: ChatMessage; matchIndex: number }> = [];
    // Reverse iteration — newest first
    for (let i = this.messages.length - 1; i >= 0 && results.length < limit; i--) {
      const m = this.messages[i];
      const idx = m.text.toLowerCase().indexOf(q);
      if (idx >= 0) {
        results.push({ message: m, matchIndex: idx });
      }
    }
    return results;
  }

  updateMessageText(messageId: number, newText: string): ChatMessage | null {
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) return null;
    msg.text = newText;
    return msg;
  }

  tagMessage(messageId: number, tag: string): ChatMessage | null {
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) return null;
    msg.tag = tag || undefined;
    return msg;
  }

  pinMessage(messageId: number, pinned: boolean): ChatMessage | null {
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) return null;
    msg.pinned = pinned;
    this.emit("room", { type: "message-pinned", data: { id: messageId, pinned } } as unknown as RoomEvent);
    return msg;
  }

  getPinnedMessages(): ChatMessage[] {
    return this.messages.filter(m => m.pinned);
  }

  addSessionMarker(markerType: "start" | "end", label?: string): ChatMessage {
    const text = markerType === "start"
      ? `--- Session started${label ? ": " + label : ""} ---`
      : `--- Session ended${label ? ": " + label : ""} ---`;
    return this.addSystem(text);
  }

  messageCount(): number {
    return this.messages.length;
  }

  getAgentTurnCount(): number {
    return this.agentTurnCount;
  }

  resetTurnCount(): void {
    this.agentTurnCount = 0;
  }

  addSystem(text: string): ChatMessage {
    const msg: ChatMessage = {
      id: this.nextId++,
      sender: "system",
      text,
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    this.persist(msg);
    this.emit("room", { type: "message", data: msg } as RoomEvent);
    console.log(`  [system] ${text}`);
    return msg;
  }

  private extractMentions(text: string): string[] {
    const matches = text.match(/@(\w[\w-]*)/g);
    if (!matches) return [];
    return matches.map((m) => m.slice(1));
  }

  destroy(): void {
    if (this.staleInterval) clearInterval(this.staleInterval);
    for (const t of this.typingState.values()) clearTimeout(t);
    for (const t of this.statusTimeouts.values()) clearTimeout(t);
    for (const t of this.pendingMentions.values()) clearTimeout(t);
  }
}

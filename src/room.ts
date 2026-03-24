/**
 * Joind Chat Room — persistent message store + agent registry + @mention → injection.
 * Messages persist to JSONL and survive server restarts.
 */

import { EventEmitter } from "events";
import { join } from "path";
import { inject } from "./inject.js";
import { loadMessages, appendMessage, maxId, ensureDir } from "./persist.js";

export interface ChatMessage {
  id: number;
  sender: string;
  text: string;
  timestamp: number;
  image?: string;
  replyTo?: number;
}

export interface Agent {
  name: string;
  pid: number;
  joinedAt: number;
  active: boolean;
  role?: string;
  lastSeen: number;
}

export interface RoomEvent {
  type: "message" | "join" | "leave" | "rename" | "role" | "typing" | "stale";
  data: ChatMessage | Agent | { oldName: string; newName: string; agent: Agent } | { name: string; typing: boolean };
}

export class ChatRoom extends EventEmitter {
  private messages: ChatMessage[] = [];
  private agents = new Map<string, Agent>();
  private nextId = 1;
  private chatFile: string | null = null;
  private typingState = new Map<string, NodeJS.Timeout>();

  constructor(dataDir?: string) {
    super();
    if (dataDir) {
      ensureDir(dataDir);
      this.chatFile = join(dataDir, "chat.jsonl");
      const loaded = loadMessages<ChatMessage>(this.chatFile);
      this.messages = loaded;
      this.nextId = maxId(loaded) + 1;
      if (loaded.length > 0) {
        console.log(`  Loaded ${loaded.length} messages from disk (next ID: ${this.nextId})`);
      }
    }

    // Sweep stale agents every 30 seconds
    setInterval(() => this.sweepStale(), 30000);
  }

  private persist(msg: ChatMessage): void {
    if (this.chatFile) {
      appendMessage(this.chatFile, msg);
    }
  }

  join(name: string, pid: number): Agent {
    const existing = this.agents.get(name);
    if (existing) {
      existing.active = true;
      existing.pid = pid;
      existing.lastSeen = Date.now();
      this.emit("room", { type: "join", data: existing } as RoomEvent);
      return existing;
    }

    const agent: Agent = {
      name,
      pid,
      joinedAt: Date.now(),
      active: true,
      lastSeen: Date.now(),
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

  send(sender: string, text: string, opts?: { image?: string; replyTo?: number }): ChatMessage {
    const msg: ChatMessage = {
      id: this.nextId++,
      sender,
      text,
      timestamp: Date.now(),
    };
    if (opts?.image) msg.image = opts.image;
    if (opts?.replyTo) msg.replyTo = opts.replyTo;

    this.messages.push(msg);
    this.persist(msg);
    this.emit("room", { type: "message", data: msg } as RoomEvent);

    // Update lastSeen for the sender
    const senderAgent = this.agents.get(sender);
    if (senderAgent) senderAgent.lastSeen = Date.now();

    // Detect @mentions → inject into mentioned agent's terminal
    const mentions = this.extractMentions(text);
    const targets = mentions.includes("all")
      ? [...this.agents.keys()].filter((n) => n !== sender)
      : mentions;

    for (const name of targets) {
      const agent = this.agents.get(name);
      if (agent?.active && agent.name !== sender) {
        const roleHint = agent.role ? ` Your role: ${agent.role}.` : "";
        const prompt =
          `[joind] You were @mentioned by ${sender}.${roleHint} ` +
          `Use the joind MCP tools: chat_read to see messages, chat_send to respond.`;
        console.log(`  → Injecting into ${name} (PID ${agent.pid})...`);
        inject(agent.pid, prompt).catch((err) => {
          console.error(`  ✗ Injection failed for ${name}: ${err}`);
        });
      }
    }

    console.log(`  [#${msg.id} ${sender}] ${text}`);
    return msg;
  }

  read(since?: number, limit = 50): ChatMessage[] {
    if (since != null) {
      return this.messages.filter((m) => m.id > since).slice(-limit);
    }
    return this.messages.slice(-limit);
  }

  getMessageById(id: number): ChatMessage | undefined {
    return this.messages.find((m) => m.id === id);
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

  /** Touch lastSeen for an agent (called on any MCP tool use). */
  touch(name: string): void {
    const agent = this.agents.get(name);
    if (agent) agent.lastSeen = Date.now();
  }

  /** Set or clear typing indicator for an agent. Auto-clears after 30s. */
  setTyping(name: string, isTyping: boolean): void {
    const existing = this.typingState.get(name);
    if (existing) {
      clearTimeout(existing);
      this.typingState.delete(name);
    }

    if (isTyping) {
      const timeout = setTimeout(() => {
        this.typingState.delete(name);
        this.emit("room", {
          type: "typing",
          data: { name, typing: false },
        } as RoomEvent);
      }, 30000);
      this.typingState.set(name, timeout);
      this.emit("room", {
        type: "typing",
        data: { name, typing: true },
      } as RoomEvent);
    } else {
      this.emit("room", {
        type: "typing",
        data: { name, typing: false },
      } as RoomEvent);
    }
  }

  /** Sweep stale agents: emit stale at 2min, auto-leave at 5min. */
  private sweepStale(): void {
    const now = Date.now();
    for (const [name, agent] of this.agents) {
      const elapsed = now - agent.lastSeen;
      if (elapsed > 300000) {
        // 5 minutes — auto-remove
        this.leave(name);
      } else if (elapsed > 120000) {
        // 2 minutes — mark stale
        this.emit("room", { type: "stale", data: agent } as RoomEvent);
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

  private addSystem(text: string): void {
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
  }

  private extractMentions(text: string): string[] {
    const matches = text.match(/@(\w[\w-]*)/g);
    if (!matches) return [];
    return matches.map((m) => m.slice(1));
  }
}

/**
 * Joind Chat Room — in-memory message store + agent registry + @mention → injection.
 * Emits events for real-time web UI updates via WebSocket.
 */

import { EventEmitter } from "events";
import { inject } from "./inject.js";

export interface ChatMessage {
  id: number;
  sender: string;
  text: string;
  timestamp: number;
}

export interface Agent {
  name: string;
  pid: number;
  joinedAt: number;
  active: boolean;
  role?: string;
}

export interface RoomEvent {
  type: "message" | "join" | "leave" | "rename" | "role";
  data: ChatMessage | Agent | { oldName: string; newName: string; agent: Agent };
}

export class ChatRoom extends EventEmitter {
  private messages: ChatMessage[] = [];
  private agents = new Map<string, Agent>();
  private nextId = 1;

  join(name: string, pid: number): Agent {
    const existing = this.agents.get(name);
    if (existing) {
      existing.active = true;
      existing.pid = pid;
      this.emit("room", { type: "join", data: existing } as RoomEvent);
      return existing;
    }

    const agent: Agent = {
      name,
      pid,
      joinedAt: Date.now(),
      active: true,
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

  send(sender: string, text: string): ChatMessage {
    const msg: ChatMessage = {
      id: this.nextId++,
      sender,
      text,
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    this.emit("room", { type: "message", data: msg } as RoomEvent);

    // Detect @mentions → inject into mentioned agent's terminal
    const mentions = this.extractMentions(text);

    // @all → expand to all online agents (except sender)
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

  who(): Agent[] {
    return [...this.agents.values()];
  }

  whoNames(): string[] {
    return [...this.agents.keys()];
  }

  getAgent(name: string): Agent | undefined {
    return this.agents.get(name);
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
    this.emit("room", { type: "message", data: msg } as RoomEvent);
    console.log(`  [system] ${text}`);
  }

  private extractMentions(text: string): string[] {
    const matches = text.match(/@(\w[\w-]*)/g);
    if (!matches) return [];
    return matches.map((m) => m.slice(1));
  }
}

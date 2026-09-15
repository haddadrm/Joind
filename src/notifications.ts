/**
 * NotificationStore: a small high-signal feed for the human watching the
 * room(s). Only seven kinds exist, deliberately: crew joined, crew left,
 * action required from the human (mention, decision card, urgent or
 * human-assigned task), task picked, task completed, session started,
 * session ended. Everything else stays in the chat where it belongs.
 */

import { EventEmitter } from "events";
import { mentionsAgent } from "./listen.js";
import type { ChatMessage } from "./room.js";
import type { Task } from "./tasks.js";

export type NotificationKind =
  | "crew-joined"
  | "crew-left"
  | "action-required"
  | "task-picked"
  | "task-completed"
  | "session-started"
  | "session-ended";

export interface Notification {
  id: number;
  kind: NotificationKind;
  conversationId: string;
  conversationName?: string;
  text: string;
  timestamp: number;
  read: boolean;
  refMessageId?: number;
  refTaskId?: number;
}

export interface Classified {
  kind: NotificationKind;
  text: string;
  refMessageId?: number;
  refTaskId?: number;
}

const JOINED_RE = /^(.+) joined the chat$/;
const LEFT_RE = /^(.+) left the chat$/;
const SESSION_START_RE = /^--- Session started(?::\s*(.*?))? ---$/;
const SESSION_END_RE = /^--- Session ended(?::\s*(.*?))? ---$/;

/**
 * Classify a chat message into a notification, or null for ordinary traffic.
 * `humanNames` are the names the human answers to in rooms (e.g. Admiral).
 */
export function classifyMessage(msg: ChatMessage, humanNames: string[]): Classified | null {
  if (msg.sender === "system") {
    let m = msg.text.match(JOINED_RE);
    if (m) return { kind: "crew-joined", text: `${m[1]} joined`, refMessageId: msg.id };
    m = msg.text.match(LEFT_RE);
    if (m) return { kind: "crew-left", text: `${m[1]} left`, refMessageId: msg.id };
    m = msg.text.match(SESSION_START_RE);
    if (m) return { kind: "session-started", text: `Session started${m[1] ? ": " + m[1] : ""}`, refMessageId: msg.id };
    m = msg.text.match(SESSION_END_RE);
    if (m) return { kind: "session-ended", text: `Session ended${m[1] ? ": " + m[1] : ""}`, refMessageId: msg.id };
    return null;
  }
  if (msg.choices && msg.choices.length > 0) {
    return {
      kind: "action-required",
      text: `${msg.sender} needs a decision: ${truncate(msg.text)}`,
      refMessageId: msg.id,
    };
  }
  for (const name of humanNames) {
    if (mentionsAgent(msg.text, name) && !mentionsAll(msg.text)) {
      return {
        kind: "action-required",
        text: `${msg.sender} needs you: ${truncate(msg.text)}`,
        refMessageId: msg.id,
      };
    }
  }
  return null;
}

/** @all is crew broadcast, not a personal summons; it must not ring the bell. */
function mentionsAll(text: string): boolean {
  return /@all(?![\p{L}\p{N}_])/iu.test(text);
}

function truncate(text: string, max = 120): string {
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

interface TaskSnapshot {
  assignee?: string;
  status: string;
}

/**
 * Stateful task classifier: transitions matter (picked = assignee appears,
 * completed = open becomes done), so the store keeps last-seen snapshots.
 */
export class TaskTracker {
  private snapshots = new Map<number, TaskSnapshot>();

  classify(eventType: string, task: Task, humanNames: string[]): Classified | null {
    const prev = this.snapshots.get(task.id);
    this.snapshots.set(task.id, { assignee: task.assignee, status: task.status });

    if (eventType === "task-created") {
      const forHuman = task.assignee != null && humanNames.some((n) => n.toLowerCase() === task.assignee?.toLowerCase());
      if (forHuman || task.priority === "urgent") {
        return { kind: "action-required", text: `Task for you: ${truncate(task.title)}`, refTaskId: task.id };
      }
      if (task.assignee) {
        return { kind: "task-picked", text: `${task.assignee} took: ${truncate(task.title)}`, refTaskId: task.id };
      }
      return null;
    }

    if (eventType === "task-updated") {
      if (task.status === "done" && prev?.status !== "done") {
        this.snapshots.delete(task.id);
        return { kind: "task-completed", text: `Done: ${truncate(task.title)}`, refTaskId: task.id };
      }
      if (task.assignee && task.assignee !== prev?.assignee && task.status !== "done") {
        return { kind: "task-picked", text: `${task.assignee} took: ${truncate(task.title)}`, refTaskId: task.id };
      }
    }
    return null;
  }
}

const CAP = 200;

export class NotificationStore extends EventEmitter {
  private items: Notification[] = [];
  private nextId = 1;

  add(kind: Classified, conversationId: string, conversationName?: string): Notification {
    const n: Notification = {
      id: this.nextId++,
      kind: kind.kind,
      conversationId,
      conversationName,
      text: kind.text,
      timestamp: Date.now(),
      read: false,
      refMessageId: kind.refMessageId,
      refTaskId: kind.refTaskId,
    };
    this.items.push(n);
    if (this.items.length > CAP) this.items.splice(0, this.items.length - CAP);
    this.emit("notification", n);
    return n;
  }

  list(limit = 50): Notification[] {
    return this.items.slice(-limit).reverse();
  }

  unreadCount(): number {
    return this.items.reduce((acc, n) => acc + (n.read ? 0 : 1), 0);
  }

  /** Mark read up to and including `upToId`; omit to mark everything. */
  markRead(upToId?: number): number {
    let changed = 0;
    for (const n of this.items) {
      if (!n.read && (upToId == null || n.id <= upToId)) {
        n.read = true;
        changed++;
      }
    }
    return changed;
  }
}

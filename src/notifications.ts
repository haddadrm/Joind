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
  priority: string;
}

/**
 * Stateful task classifier: transitions matter (picked = assignee appears,
 * completed = open becomes done, escalation = priority turns urgent), so the
 * store keeps last-seen snapshots keyed by conversation AND task id (task
 * ids restart per conversation). Done snapshots are retained so a later
 * update to a finished task cannot re-ring; an update to a task never seen
 * before stays silent (no invented transition after a restart).
 */
export class TaskTracker {
  private snapshots = new Map<string, TaskSnapshot>();

  private key(task: Task): string {
    return `${task.conversationId}:${task.id}`;
  }

  /** Drop all state for a deleted conversation. */
  clearConversation(conversationId: string): void {
    const prefix = `${conversationId}:`;
    for (const k of this.snapshots.keys()) {
      if (k.startsWith(prefix)) this.snapshots.delete(k);
    }
  }

  classify(eventType: string, task: Task, humanNames: string[]): Classified | null {
    const isHuman = (name?: string): boolean =>
      name != null && humanNames.some((n) => n.toLowerCase() === name.toLowerCase());
    const prev = this.snapshots.get(this.key(task));
    this.snapshots.set(this.key(task), {
      assignee: task.assignee,
      status: task.status,
      priority: task.priority,
    });

    if (eventType === "task-created") {
      if (isHuman(task.assignee) || task.priority === "urgent") {
        return { kind: "action-required", text: `Task for you: ${truncate(task.title)}`, refTaskId: task.id };
      }
      if (task.assignee) {
        return { kind: "task-picked", text: `${task.assignee} took: ${truncate(task.title)}`, refTaskId: task.id };
      }
      return null;
    }

    if (eventType === "task-updated") {
      // Unknown history (e.g. after a restart): record and stay silent
      // rather than inventing a transition.
      if (!prev) return null;
      if (task.status === "done") {
        if (prev.status !== "done") {
          return { kind: "task-completed", text: `Done: ${truncate(task.title)}`, refTaskId: task.id };
        }
        return null;
      }
      const becameHumanAssigned = isHuman(task.assignee) && !isHuman(prev.assignee);
      const becameUrgent = task.priority === "urgent" && prev.priority !== "urgent";
      if (becameHumanAssigned || becameUrgent) {
        return { kind: "action-required", text: `Task for you: ${truncate(task.title)}`, refTaskId: task.id };
      }
      if (task.assignee && task.assignee !== prev.assignee) {
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
  /** Changes on every server start: ids restart at 1, so clients must treat
   *  a new generation as a fresh world and replace, never merge. */
  readonly generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

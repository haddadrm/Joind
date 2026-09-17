import { describe, it, expect } from "vitest";
import { classifyMessage, isNotifiable, TaskTracker, NotificationStore } from "../src/notifications.js";
import type { ChatMessage } from "../src/room.js";
import type { Task } from "../src/tasks.js";

const HUMANS = ["Admiral", "Rami"];

function msg(sender: string, text: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { id: 1, sender, text, timestamp: Date.now(), ...extra } as ChatMessage;
}

function task(overrides: Partial<Task>): Task {
  return {
    id: 1, conversationId: "c1", title: "Fix the denominator", creator: "Jadzia",
    status: "open", priority: "normal", createdAt: 0, updatedAt: 0, ...overrides,
  } as Task;
}

describe("classifyMessage", () => {
  it("targeted DMs are never notifiable, even when they mention a human", () => {
    const dm = msg("Codex", "@Rami approve this privately", { to: ["Rami"] });
    expect(isNotifiable(dm)).toBe(false);
    const decisionDm = msg("Codex", "@Rami pick one?", { to: ["Rami"], choices: ["A", "B"] });
    expect(isNotifiable(decisionDm)).toBe(false);
    expect(isNotifiable(msg("Codex", "@Rami public approval"))).toBe(true);
    expect(isNotifiable(msg("system", "Codex joined the chat"))).toBe(true);
  });

  it("classifies joins, leaves, and session markers from system messages", () => {
    expect(classifyMessage(msg("system", "Curzon joined the chat"), HUMANS)?.kind).toBe("crew-joined");
    expect(classifyMessage(msg("system", "Codex left the chat"), HUMANS)?.kind).toBe("crew-left");
    expect(classifyMessage(msg("system", "--- Session started: brainstorm ---"), HUMANS)?.kind).toBe("session-started");
    expect(classifyMessage(msg("system", "--- Session ended: brainstorm ---"), HUMANS)?.kind).toBe("session-ended");
    expect(classifyMessage(msg("system", "Turn limit reached"), HUMANS)).toBeNull();
  });

  it("rings action-required for direct human mentions but not @all or chatter", () => {
    expect(classifyMessage(msg("Codex", "@Admiral please approve the export"), HUMANS)?.kind).toBe("action-required");
    expect(classifyMessage(msg("Codex", "@rami quick check?"), HUMANS)?.kind).toBe("action-required");
    expect(classifyMessage(msg("Codex", "@all stand-up in five"), HUMANS)).toBeNull();
    expect(classifyMessage(msg("Codex", "@Curzon your turn"), HUMANS)).toBeNull();
    expect(classifyMessage(msg("Codex", "long technical ramble with no tags"), HUMANS)).toBeNull();
  });

  it("rings action-required for decision cards", () => {
    const decision = msg("Jadzia", "Ship it or hold?", { choices: ["Ship", "Hold"] });
    expect(classifyMessage(decision, HUMANS)?.kind).toBe("action-required");
  });
});

describe("TaskTracker", () => {
  it("created-with-assignee is picked; urgent or human-assigned is action-required", () => {
    const t = new TaskTracker();
    expect(t.classify("task-created", task({ id: 1, assignee: "Codex" }), HUMANS)?.kind).toBe("task-picked");
    expect(t.classify("task-created", task({ id: 2, priority: "urgent" }), HUMANS)?.kind).toBe("action-required");
    expect(t.classify("task-created", task({ id: 3, assignee: "Admiral" }), HUMANS)?.kind).toBe("action-required");
    expect(t.classify("task-created", task({ id: 4 }), HUMANS)).toBeNull();
  });

  it("assignee transition is picked once; completion fires once and never re-rings", () => {
    const t = new TaskTracker();
    t.classify("task-created", task({ id: 5 }), HUMANS);
    expect(t.classify("task-updated", task({ id: 5, assignee: "Codex" }), HUMANS)?.kind).toBe("task-picked");
    expect(t.classify("task-updated", task({ id: 5, assignee: "Codex" }), HUMANS)).toBeNull();
    expect(t.classify("task-updated", task({ id: 5, assignee: "Codex", status: "done" }), HUMANS)?.kind).toBe("task-completed");
    expect(t.classify("task-updated", task({ id: 5, assignee: "Codex", status: "done", response: "edited" }), HUMANS)).toBeNull();
  });

  it("keys by conversation so same-numbered tasks in different rooms cannot collide", () => {
    const t = new TaskTracker();
    expect(t.classify("task-created", task({ id: 1, conversationId: "roomB", assignee: "Codex" }), HUMANS)?.kind).toBe("task-picked");
    t.classify("task-created", task({ id: 1, conversationId: "roomA" }), HUMANS);
    // Under numeric-only keys roomA's unassigned snapshot would shadow
    // roomB's, so this unchanged-assignee update would falsely ring picked.
    expect(t.classify("task-updated", task({ id: 1, conversationId: "roomB", assignee: "Codex" }), HUMANS)).toBeNull();
    expect(t.classify("task-updated", task({ id: 1, conversationId: "roomA", assignee: "Codex" }), HUMANS)?.kind).toBe("task-picked");
  });

  it("exposes a per-boot generation for clients to detect id restarts", () => {
    const a = new NotificationStore();
    const b = new NotificationStore();
    expect(a.generation).toBeTruthy();
    expect(a.generation).not.toBe(b.generation);
  });

  it("urgent escalation and human reassignment on update ring action-required", () => {
    const t = new TaskTracker();
    t.classify("task-created", task({ id: 7 }), HUMANS);
    expect(t.classify("task-updated", task({ id: 7, priority: "urgent" }), HUMANS)?.kind).toBe("action-required");
    t.classify("task-created", task({ id: 8, assignee: "Codex" }), HUMANS);
    expect(t.classify("task-updated", task({ id: 8, assignee: "Admiral" }), HUMANS)?.kind).toBe("action-required");
  });

  it("an update to a task with no known history stays silent", () => {
    const t = new TaskTracker();
    expect(t.classify("task-updated", task({ id: 9, status: "done" }), HUMANS)).toBeNull();
    expect(t.classify("task-updated", task({ id: 9, status: "done" }), HUMANS)).toBeNull();
  });

  it("clearConversation drops only that conversation's state", () => {
    const t = new TaskTracker();
    t.classify("task-created", task({ id: 1, conversationId: "gone" }), HUMANS);
    t.classify("task-created", task({ id: 1, conversationId: "kept" }), HUMANS);
    t.clearConversation("gone");
    expect(t.classify("task-updated", task({ id: 1, conversationId: "gone", assignee: "Codex" }), HUMANS)).toBeNull();
    expect(t.classify("task-updated", task({ id: 1, conversationId: "kept", assignee: "Codex" }), HUMANS)?.kind).toBe("task-picked");
  });
});

describe("NotificationStore", () => {
  it("tracks unread, caps the feed, and marks read up to an id", () => {
    const store = new NotificationStore();
    for (let i = 0; i < 5; i++) store.add({ kind: "crew-joined", text: `agent ${i} joined` }, "c1", "Bridge");
    expect(store.unreadCount()).toBe(5);
    const newestFirst = store.list();
    expect(newestFirst[0].text).toContain("agent 4");
    store.markRead(newestFirst[2].id);
    expect(store.unreadCount()).toBe(2);
    store.markRead();
    expect(store.unreadCount()).toBe(0);
  });
});

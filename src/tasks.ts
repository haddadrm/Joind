/**
 * TaskStore — conversation-scoped task management.
 *
 * Tasks surface agent requests for input, decisions, and actions
 * in a structured, visible way that doesn't get lost in chat flow.
 * Both agents (via MCP tools) and humans (via web UI) can create
 * and resolve tasks.
 */

import { EventEmitter } from "events";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { ensureDir } from "./persist.js";

/**
 * Task states (redesign lane 5, the board): open, in_progress, review, done.
 * Files written before the board hold only open and done, which keep their
 * meaning; an unknown state read from a file is treated as open. Every state
 * but done counts as open for the badge and for the "open" list filter.
 */
export const TASK_STATUSES = ["open", "in_progress", "review", "done"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);
}

/** Not done: open, in progress or in review. */
export function isActiveStatus(s: TaskStatus): boolean {
  return s !== "done";
}

export interface Task {
  id: number;
  conversationId: string;
  title: string;
  description?: string;
  creator: string;
  assignee?: string;
  status: TaskStatus;
  priority: "normal" | "urgent";
  anchorMessageId?: number;
  response?: string;
  respondedBy?: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

export interface TaskEvent {
  type: "task-created" | "task-updated";
  conversationId: string;
  data: Task;
}

export class TaskStore extends EventEmitter {
  private tasks = new Map<string, Task[]>(); // convId → tasks
  private nextIds = new Map<string, number>(); // convId → next ID
  private dataDir: string;

  constructor(dataDir: string) {
    super();
    this.dataDir = join(dataDir, "conversations");
    ensureDir(this.dataDir);
  }

  private filePath(convId: string): string {
    return join(this.dataDir, convId + ".tasks.jsonl");
  }

  private ensureLoaded(convId: string): Task[] {
    if (this.tasks.has(convId)) return this.tasks.get(convId)!;

    const fp = this.filePath(convId);
    const loaded: Task[] = [];
    let maxId = 0;

    if (existsSync(fp)) {
      for (const line of readFileSync(fp, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const task = JSON.parse(trimmed) as Task;
          if (!isTaskStatus(task.status)) task.status = "open";
          loaded.push(task);
          if (task.id > maxId) maxId = task.id;
        } catch { /* skip malformed */ }
      }
    }

    this.tasks.set(convId, loaded);
    this.nextIds.set(convId, maxId + 1);
    return loaded;
  }

  create(convId: string, opts: {
    title: string;
    description?: string;
    creator: string;
    assignee?: string;
    priority?: "normal" | "urgent";
    anchorMessageId?: number;
  }): Task {
    const tasks = this.ensureLoaded(convId);
    const id = this.nextIds.get(convId) ?? 1;
    this.nextIds.set(convId, id + 1);

    const now = Date.now();
    const task: Task = {
      id,
      conversationId: convId,
      title: opts.title.trim().slice(0, 200),
      description: opts.description?.trim().slice(0, 1000),
      creator: opts.creator,
      assignee: opts.assignee,
      status: "open",
      priority: opts.priority ?? "normal",
      anchorMessageId: opts.anchorMessageId,
      createdAt: now,
      updatedAt: now,
    };

    tasks.push(task);
    this.persist(convId);
    this.emit("task", { type: "task-created", conversationId: convId, data: task } as TaskEvent);
    return task;
  }

  update(convId: string, taskId: number, opts: {
    status?: TaskStatus;
    response?: string;
    respondedBy?: string;
    /** A name assigns; null or an empty string clears the assignee. */
    assignee?: string | null;
    priority?: "normal" | "urgent";
  }): Task | null {
    const tasks = this.ensureLoaded(convId);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return null;

    const now = Date.now();
    if (opts.status !== undefined) {
      if (!isTaskStatus(opts.status)) return null;
      // Reopened from done: it is no longer resolved.
      if (opts.status !== "done" && task.status === "done") task.resolvedAt = undefined;
      task.status = opts.status;
    }
    if (opts.response !== undefined) task.response = opts.response;
    if (opts.respondedBy !== undefined) task.respondedBy = opts.respondedBy;
    if (opts.assignee !== undefined) task.assignee = opts.assignee ? opts.assignee : undefined;
    if (opts.priority !== undefined) task.priority = opts.priority;
    task.updatedAt = now;
    if (task.status === "done" && !task.resolvedAt) task.resolvedAt = now;

    this.persist(convId);
    this.emit("task", { type: "task-updated", conversationId: convId, data: task } as TaskEvent);
    return task;
  }

  list(convId: string, filter?: { status?: string; assignee?: string }): Task[] {
    const tasks = this.ensureLoaded(convId);
    let result = tasks;
    // "open" means not done (as before the board, when open was the only
    // state before done); "all" means every task; any other state is exact.
    if (filter?.status === "open") {
      result = result.filter((t) => isActiveStatus(t.status));
    } else if (filter?.status && filter.status !== "all") {
      result = result.filter((t) => t.status === filter.status);
    }
    if (filter?.assignee) {
      result = result.filter((t) => t.assignee === filter.assignee);
    }
    return result;
  }

  get(convId: string, taskId: number): Task | null {
    const tasks = this.ensureLoaded(convId);
    return tasks.find((t) => t.id === taskId) ?? null;
  }

  countOpen(convId: string): number {
    const tasks = this.ensureLoaded(convId);
    return tasks.filter((t) => isActiveStatus(t.status)).length;
  }

  hasUrgent(convId: string): boolean {
    const tasks = this.ensureLoaded(convId);
    return tasks.some((t) => isActiveStatus(t.status) && t.priority === "urgent");
  }

  deleteForConversation(convId: string): void {
    this.tasks.delete(convId);
    this.nextIds.delete(convId);
    try { unlinkSync(this.filePath(convId)); } catch { /* ok */ }
  }

  private persist(convId: string): void {
    const tasks = this.tasks.get(convId);
    if (!tasks) return;
    ensureDir(this.dataDir);
    const content = tasks.map((t) => JSON.stringify(t)).join("\n") + "\n";
    writeFileSync(this.filePath(convId), content, "utf-8");
  }
}

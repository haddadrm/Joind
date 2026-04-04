/**
 * ReactionStore — conversation-scoped emoji reactions on messages.
 *
 * Follows the same lazy-load + atomic-persist pattern as TaskStore.
 * Each conversation gets a `.reactions.jsonl` file alongside its
 * messages and tasks.
 */

import { EventEmitter } from "events";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { ensureDir } from "./persist.js";

export interface Reaction {
  messageId: number;
  emoji: string;
  sender: string;
  timestamp: number;
}

export interface ReactionEvent {
  type: "reaction";
  conversationId: string;
  data: {
    messageId: number;
    emoji: string;
    sender: string;
    action: "added" | "removed";
  };
}

export class ReactionStore extends EventEmitter {
  private reactions = new Map<string, Reaction[]>(); // convId -> reactions

  constructor(private dataDir: string) {
    super();
    ensureDir(this.dataDir);
  }

  private filePath(convId: string): string {
    return join(this.dataDir, convId + ".reactions.jsonl");
  }

  private ensureLoaded(convId: string): Reaction[] {
    if (this.reactions.has(convId)) return this.reactions.get(convId)!;

    const fp = this.filePath(convId);
    const loaded: Reaction[] = [];

    if (existsSync(fp)) {
      for (const line of readFileSync(fp, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          loaded.push(JSON.parse(trimmed) as Reaction);
        } catch { /* skip malformed */ }
      }
    }

    this.reactions.set(convId, loaded);
    return loaded;
  }

  toggle(
    convId: string,
    messageId: number,
    emoji: string,
    sender: string,
  ): { action: "added" | "removed"; reaction: Reaction } {
    const reactions = this.ensureLoaded(convId);

    const idx = reactions.findIndex(
      (r) => r.messageId === messageId && r.emoji === emoji && r.sender === sender,
    );

    let action: "added" | "removed";
    let reaction: Reaction;

    if (idx !== -1) {
      reaction = reactions[idx];
      reactions.splice(idx, 1);
      action = "removed";
    } else {
      reaction = { messageId, emoji, sender, timestamp: Date.now() };
      reactions.push(reaction);
      action = "added";
    }

    this.persist(convId);
    this.emit("reaction", {
      type: "reaction",
      conversationId: convId,
      data: { messageId, emoji, sender, action },
    } as ReactionEvent);

    return { action, reaction };
  }

  getForConversation(convId: string): Reaction[] {
    return this.ensureLoaded(convId);
  }

  getForMessage(convId: string, messageId: number): Reaction[] {
    return this.ensureLoaded(convId).filter((r) => r.messageId === messageId);
  }

  deleteForConversation(convId: string): void {
    this.reactions.delete(convId);
    try { unlinkSync(this.filePath(convId)); } catch { /* ok */ }
  }

  private persist(convId: string): void {
    const reactions = this.reactions.get(convId);
    if (!reactions) return;
    ensureDir(this.dataDir);
    const content = reactions.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(this.filePath(convId), content, "utf-8");
  }
}

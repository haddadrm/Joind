/**
 * EditStore -- message edit overlay management.
 *
 * Original JSONL message files are NEVER modified. Edits are stored
 * separately in per-conversation .edits.jsonl files and applied at
 * read time via the applyEdits() method.
 */

import { EventEmitter } from "events";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { ensureDir } from "./persist.js";

export interface EditRecord {
  messageId: number;
  newText: string;
  editedBy: string;
  editedAt: number;
  originalText: string;
}

export interface EditEvent {
  type: "message-edited";
  conversationId: string;
  data: {
    messageId: number;
    newText: string;
    editedBy: string;
    editedAt: number;
  };
}

export class EditStore extends EventEmitter {
  private edits = new Map<string, EditRecord[]>(); // convId -> edits
  private dataDir: string;

  constructor(dataDir: string) {
    super();
    this.dataDir = dataDir;
    ensureDir(this.dataDir);
  }

  private filePath(convId: string): string {
    return join(this.dataDir, convId + ".edits.jsonl");
  }

  private ensureLoaded(convId: string): EditRecord[] {
    if (this.edits.has(convId)) return this.edits.get(convId)!;

    const fp = this.filePath(convId);
    const loaded: EditRecord[] = [];

    if (existsSync(fp)) {
      for (const line of readFileSync(fp, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          loaded.push(JSON.parse(trimmed) as EditRecord);
        } catch { /* skip malformed */ }
      }
    }

    this.edits.set(convId, loaded);
    return loaded;
  }

  edit(
    convId: string,
    messageId: number,
    newText: string,
    editedBy: string,
    originalText: string,
  ): EditRecord {
    const records = this.ensureLoaded(convId);

    const record: EditRecord = {
      messageId,
      newText,
      editedBy,
      editedAt: Date.now(),
      originalText,
    };

    records.push(record);
    this.persist(convId);
    this.emit("edit", {
      type: "message-edited",
      conversationId: convId,
      data: { messageId, newText, editedBy, editedAt: record.editedAt },
    } as EditEvent);
    return record;
  }

  getEdits(convId: string, messageId: number): EditRecord[] {
    const records = this.ensureLoaded(convId);
    return records.filter((r) => r.messageId === messageId);
  }

  getLatestText(convId: string, messageId: number): string | undefined {
    const records = this.ensureLoaded(convId);
    let latest: EditRecord | undefined;
    for (const r of records) {
      if (r.messageId === messageId) {
        if (!latest || r.editedAt > latest.editedAt) latest = r;
      }
    }
    return latest?.newText;
  }

  applyEdits(
    convId: string,
    messages: Array<{ id: number; text: string; [key: string]: unknown }>,
  ): Array<{ id: number; text: string; edited?: boolean; editHistory?: EditRecord[]; [key: string]: unknown }> {
    const records = this.ensureLoaded(convId);
    if (records.length === 0) return messages;

    // Group edits by messageId for efficient lookup
    const byMessage = new Map<number, EditRecord[]>();
    for (const r of records) {
      let arr = byMessage.get(r.messageId);
      if (!arr) {
        arr = [];
        byMessage.set(r.messageId, arr);
      }
      arr.push(r);
    }

    for (const msg of messages) {
      const history = byMessage.get(msg.id);
      if (!history || history.length === 0) continue;

      // Latest edit wins
      let latest = history[0];
      for (let i = 1; i < history.length; i++) {
        if (history[i].editedAt > latest.editedAt) latest = history[i];
      }

      msg.text = latest.newText;
      (msg as Record<string, unknown>).edited = true;
      (msg as Record<string, unknown>).editHistory = history;
    }

    return messages;
  }

  deleteForConversation(convId: string): void {
    this.edits.delete(convId);
    try { unlinkSync(this.filePath(convId)); } catch { /* ok */ }
  }

  private persist(convId: string): void {
    const records = this.edits.get(convId);
    if (!records) return;
    ensureDir(this.dataDir);
    const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(this.filePath(convId), content, "utf-8");
  }
}

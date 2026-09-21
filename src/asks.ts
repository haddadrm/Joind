/**
 * AskStore — persists ask resolutions. An ask is born inside its message
 * (persisted with the message JSONL); only the resolution needs a sidecar.
 * Append-only JSONL per conversation; latest record per messageId wins.
 */

import { join } from "path";
import { existsSync, readFileSync, appendFileSync } from "fs";
import { ensureDir } from "./persist.js";

export interface AskRecord {
  messageId: number;
  resolvedBy: string;
  at: number;
}

export class AskStore {
  private cache = new Map<string, AskRecord[]>();

  constructor(private dataDir: string) {
    ensureDir(this.dataDir);
  }

  private filePath(convId: string): string {
    return join(this.dataDir, convId + ".asks.jsonl");
  }

  load(convId: string): AskRecord[] {
    if (this.cache.has(convId)) return this.cache.get(convId)!;
    const fp = this.filePath(convId);
    const out: AskRecord[] = [];
    if (existsSync(fp)) {
      for (const line of readFileSync(fp, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { out.push(JSON.parse(trimmed) as AskRecord); } catch { /* skip */ }
      }
    }
    this.cache.set(convId, out);
    return out;
  }

  record(convId: string, rec: AskRecord): void {
    appendFileSync(this.filePath(convId), JSON.stringify(rec) + "\n");
    this.load(convId).push(rec);
  }

  deleteForConversation(convId: string): void {
    this.cache.delete(convId);
  }
}

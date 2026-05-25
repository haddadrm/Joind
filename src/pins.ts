/**
 * PinStore — persists pin/unpin state for messages. Append-only JSONL
 * sidecar per conversation. Pins are toggleable, so on replay the LATEST
 * record per messageId wins (unlike ChoiceStore's first-wins).
 */

import { join } from "path";
import { existsSync, readFileSync, appendFileSync } from "fs";
import { ensureDir } from "./persist.js";

export interface PinRecord {
  messageId: number;
  pinned: boolean;
  by?: string;
  at: number;
}

export class PinStore {
  private cache = new Map<string, PinRecord[]>();

  constructor(private dataDir: string) {
    ensureDir(this.dataDir);
  }

  private filePath(convId: string): string {
    return join(this.dataDir, convId + ".pins.jsonl");
  }

  /** Read all records for a conversation; latest-wins reduction is applied by callers. */
  load(convId: string): PinRecord[] {
    if (this.cache.has(convId)) return this.cache.get(convId)!;
    const fp = this.filePath(convId);
    const out: PinRecord[] = [];
    if (existsSync(fp)) {
      for (const line of readFileSync(fp, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { out.push(JSON.parse(trimmed) as PinRecord); } catch { /* skip */ }
      }
    }
    this.cache.set(convId, out);
    return out;
  }

  /** Append a pin/unpin record. */
  record(convId: string, rec: PinRecord): void {
    const fp = this.filePath(convId);
    ensureDir(this.dataDir);
    appendFileSync(fp, JSON.stringify(rec) + "\n", "utf-8");
    const list = this.cache.get(convId);
    if (list) list.push(rec);
  }
}

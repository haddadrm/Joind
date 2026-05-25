/**
 * TagStore — persists message tag classifications. Append-only JSONL
 * sidecar per conversation. Tags are overwriteable, so on replay the
 * LATEST record per messageId wins; an empty tag clears it.
 */

import { join } from "path";
import { existsSync, readFileSync, appendFileSync } from "fs";
import { ensureDir } from "./persist.js";

export interface TagRecord {
  messageId: number;
  tag: string;  // empty string clears the tag
  by?: string;
  at: number;
}

export class TagStore {
  private cache = new Map<string, TagRecord[]>();

  constructor(private dataDir: string) {
    ensureDir(this.dataDir);
  }

  private filePath(convId: string): string {
    return join(this.dataDir, convId + ".tags.jsonl");
  }

  /** Read all records for a conversation; latest-wins reduction is applied by callers. */
  load(convId: string): TagRecord[] {
    if (this.cache.has(convId)) return this.cache.get(convId)!;
    const fp = this.filePath(convId);
    const out: TagRecord[] = [];
    if (existsSync(fp)) {
      for (const line of readFileSync(fp, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { out.push(JSON.parse(trimmed) as TagRecord); } catch { /* skip */ }
      }
    }
    this.cache.set(convId, out);
    return out;
  }

  /** Append a tag record. */
  record(convId: string, rec: TagRecord): void {
    const fp = this.filePath(convId);
    ensureDir(this.dataDir);
    appendFileSync(fp, JSON.stringify(rec) + "\n", "utf-8");
    const list = this.cache.get(convId);
    if (list) list.push(rec);
  }
}

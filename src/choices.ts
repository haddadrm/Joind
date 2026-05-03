/**
 * ChoiceStore — persists `choiceResponse` resolutions for inline decision
 * cards. Append-only JSONL sidecar per conversation; first response wins
 * (later appends are ignored on replay).
 */

import { join } from "path";
import { existsSync, readFileSync, appendFileSync } from "fs";
import { ensureDir } from "./persist.js";

export interface ChoiceRecord {
  messageId: number;
  value: string;
  by: string;
  at: number;
}

export class ChoiceStore {
  private cache = new Map<string, ChoiceRecord[]>();

  constructor(private dataDir: string) {
    ensureDir(this.dataDir);
  }

  private filePath(convId: string): string {
    return join(this.dataDir, convId + ".choices.jsonl");
  }

  /** Read all records for a conversation; first-wins reduction is applied by callers. */
  load(convId: string): ChoiceRecord[] {
    if (this.cache.has(convId)) return this.cache.get(convId)!;
    const fp = this.filePath(convId);
    const out: ChoiceRecord[] = [];
    if (existsSync(fp)) {
      for (const line of readFileSync(fp, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { out.push(JSON.parse(trimmed) as ChoiceRecord); } catch { /* skip */ }
      }
    }
    this.cache.set(convId, out);
    return out;
  }

  /** Append a choice resolution. Callers should already have enforced first-wins. */
  record(convId: string, rec: ChoiceRecord): void {
    const fp = this.filePath(convId);
    ensureDir(this.dataDir);
    appendFileSync(fp, JSON.stringify(rec) + "\n", "utf-8");
    const list = this.cache.get(convId);
    if (list) list.push(rec);
  }
}

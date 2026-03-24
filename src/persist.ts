/**
 * JSONL persistence — append-only message log that survives restarts.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { dirname } from "path";

export interface Persistable {
  id: number;
}

/**
 * Ensure directory exists (recursive mkdir).
 */
export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Load all records from a JSONL file. Returns empty array if file doesn't exist.
 */
export function loadMessages<T extends Persistable>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const records: T[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip malformed lines
    }
  }

  return records;
}

/**
 * Append a single record to a JSONL file.
 */
export function appendMessage<T>(filePath: string, record: T): void {
  ensureDir(dirname(filePath));
  appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
}

/**
 * Get the max ID from a set of records, or 0 if empty.
 */
export function maxId<T extends Persistable>(records: T[]): number {
  let max = 0;
  for (const r of records) {
    if (r.id > max) max = r.id;
  }
  return max;
}

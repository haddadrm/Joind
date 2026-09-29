/**
 * Prompt snippets (composer plus-menu, 29 Sep 2026): short plain-text
 * prompts a viewer keeps on the server and inserts into the composer.
 *
 * One JSON file in the data dir, `snippets.json`, keyed by the web viewer's
 * registered name, so each viewer has their own list:
 *   { "version": 1, "users": { "<viewer>": [ { id, title, text, createdAt, updatedAt } ] } }
 * Snippet text is plain text. The page inserts it into the textarea and
 * never renders it as HTML; the store only bounds its size.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

export interface Snippet {
  id: string;
  title: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

interface SnippetFile {
  version: 1;
  users: Record<string, Snippet[]>;
}

export const SNIPPET_LIMITS = { title: 80, text: 8000, perUser: 200 } as const;

/** A request the store refuses: its status and a one-line reason. */
export class SnippetError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** Control characters other than tab and newline are dropped; CRLF becomes LF. */
function cleanText(v: string): string {
  return v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function cleanTitle(v: string): string {
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export interface SnippetInput { title?: unknown; text?: unknown }

/** A validated title and text, or a SnippetError (400). `partial` allows either to be absent. */
export function validateSnippet(input: SnippetInput, partial: boolean): { title?: string; text?: string } {
  const out: { title?: string; text?: string } = {};
  if (input.title !== undefined || !partial) {
    if (typeof input.title !== "string") throw new SnippetError(400, "title must be a string");
    const t = cleanTitle(input.title);
    if (!t) throw new SnippetError(400, "title is required");
    if (t.length > SNIPPET_LIMITS.title) throw new SnippetError(400, `title is longer than ${SNIPPET_LIMITS.title} characters`);
    out.title = t;
  }
  if (input.text !== undefined || !partial) {
    if (typeof input.text !== "string") throw new SnippetError(400, "text must be a string");
    const x = cleanText(input.text);
    if (!x.trim()) throw new SnippetError(400, "text is required");
    if (x.length > SNIPPET_LIMITS.text) throw new SnippetError(400, `text is longer than ${SNIPPET_LIMITS.text} characters`);
    out.text = x;
  }
  if (partial && out.title === undefined && out.text === undefined) throw new SnippetError(400, "nothing to change");
  return out;
}

function isSnippet(v: unknown): v is Snippet {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === "string" && typeof s.title === "string" && typeof s.text === "string"
    && typeof s.createdAt === "number" && typeof s.updatedAt === "number";
}

export class SnippetStore {
  private readonly path: string;
  private users = new Map<string, Snippet[]>();

  constructor(dataDir: string) {
    this.path = join(dataDir, "snippets.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      const users = raw && typeof raw === "object" ? (raw as Record<string, unknown>).users : undefined;
      if (!users || typeof users !== "object") return;
      for (const [name, list] of Object.entries(users as Record<string, unknown>)) {
        if (Array.isArray(list)) this.users.set(name, list.filter(isSnippet));
      }
    } catch {
      // A damaged file stays on disk until the next write replaces it; the
      // store starts empty rather than failing the server.
    }
  }

  private save(): void {
    const file: SnippetFile = { version: 1, users: Object.fromEntries(this.users) };
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, this.path);
  }

  list(user: string): Snippet[] {
    return (this.users.get(user) ?? []).map((s) => ({ ...s }));
  }

  create(user: string, input: SnippetInput): Snippet {
    const v = validateSnippet(input, false);
    const list = this.users.get(user) ?? [];
    if (list.length >= SNIPPET_LIMITS.perUser) throw new SnippetError(409, `at most ${SNIPPET_LIMITS.perUser} snippets`);
    const now = Date.now();
    const s: Snippet = { id: randomUUID(), title: v.title as string, text: v.text as string, createdAt: now, updatedAt: now };
    this.users.set(user, [...list, s]);
    this.save();
    return { ...s };
  }

  update(user: string, id: string, input: SnippetInput): Snippet {
    const v = validateSnippet(input, true);
    const s = (this.users.get(user) ?? []).find((x) => x.id === id);
    if (!s) throw new SnippetError(404, "snippet not found");
    if (v.title !== undefined) s.title = v.title;
    if (v.text !== undefined) s.text = v.text;
    s.updatedAt = Date.now();
    this.save();
    return { ...s };
  }

  remove(user: string, id: string): void {
    const list = this.users.get(user) ?? [];
    const next = list.filter((x) => x.id !== id);
    if (next.length === list.length) throw new SnippetError(404, "snippet not found");
    this.users.set(user, next);
    this.save();
  }
}

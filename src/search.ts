/**
 * Room search: a small query grammar over one room's messages.
 *
 * Grammar (tokens split on whitespace; a double-quoted run is one word):
 *   from:<name>          the poster is <name> (case-insensitive, exact name)
 *   @<name>              the text mentions @<name> (case-insensitive)
 *   mentions:<name>      the same as @<name>
 *   #<a>-<b>             the message id lies in a..b (inclusive; order free)
 *   anything else        a free word: the text must contain it (case-insensitive)
 *
 * Every term must hold (AND). A mention filter matches only a literal
 * @<name> in the text: a broadcast @all is NOT counted as mentioning each
 * name (search `@all` for those). A lone `#123` is a free word, so it finds
 * the messages that cite #123.
 *
 * Visibility is the caller's predicate, fail closed (the room passes visibleToViewer): a
 * targeted message never matches for a viewer outside it, and never for an
 * unknown viewer.
 */
import type { ChatMessage } from "./room.js";

/** The caller's visibility rule for one message (fail closed). */
export type Visible = (m: ChatMessage) => boolean;

export interface SearchQuery {
  /** Free words, lower-cased; each must occur in the text. */
  words: string[];
  /** Poster names, lower-cased; each must equal the sender (AND). */
  from: string[];
  /** Mentioned names, lower-cased; each must appear as @name in the text. */
  mentions: string[];
  /** Inclusive id range. */
  range?: { min: number; max: number };
}

export interface SearchHit {
  message: ChatMessage;
  /** Index in the text of the first free word, or 0 when there is none. */
  matchIndex: number;
}

export interface SearchPage {
  results: SearchHit[];
  /** Pass as `before` for the next (older) page; null when there is no more. */
  nextBefore: number | null;
}

/** The longest query accepted; anything beyond is cut before parsing. */
export const SEARCH_QUERY_MAX = 500;
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 100;

const NAME = /^\w[\w-]*$/;
const MENTION = /@(\w[\w-]*)/g;

export function parseSearchQuery(raw: string): SearchQuery {
  const q: SearchQuery = { words: [], from: [], mentions: [] };
  const text = raw.slice(0, SEARCH_QUERY_MAX);
  const tokens = /"([^"]*)"|(\S+)/g;
  let t: RegExpExecArray | null;
  while ((t = tokens.exec(text)) !== null) {
    if (t[1] !== undefined) {
      const phrase = t[1].trim().toLowerCase();
      if (phrase) q.words.push(phrase);
      continue;
    }
    const tok = t[2];
    const lower = tok.toLowerCase();
    if (lower.startsWith("from:")) {
      const name = tok.slice(5);
      if (NAME.test(name)) { q.from.push(name.toLowerCase()); continue; }
    } else if (lower.startsWith("mentions:")) {
      const name = tok.slice(9).replace(/^@/, "");
      if (NAME.test(name)) { q.mentions.push(name.toLowerCase()); continue; }
    } else if (tok.startsWith("@")) {
      const name = tok.slice(1);
      if (NAME.test(name)) { q.mentions.push(name.toLowerCase()); continue; }
    } else {
      const r = /^#(\d{1,15})-#?(\d{1,15})$/.exec(tok);
      if (r) {
        const a = Number(r[1]);
        const b = Number(r[2]);
        q.range = { min: Math.min(a, b), max: Math.max(a, b) };
        continue;
      }
    }
    q.words.push(lower);
  }
  return q;
}

export function hasTerms(q: SearchQuery): boolean {
  return q.words.length > 0 || q.from.length > 0 || q.mentions.length > 0 || q.range !== undefined;
}

function mentionsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION)) out.add(m[1].toLowerCase());
  return out;
}

/** Whether one message satisfies every term (visibility is checked apart). */
export function matchesSearch(msg: ChatMessage, q: SearchQuery): boolean {
  if (q.range && (msg.id < q.range.min || msg.id > q.range.max)) return false;
  const sender = msg.sender.toLowerCase();
  for (const f of q.from) if (sender !== f) return false;
  const text = (msg.text ?? "").toLowerCase();
  for (const w of q.words) if (!text.includes(w)) return false;
  if (q.mentions.length > 0) {
    const named = mentionsIn(msg.text ?? "");
    for (const n of q.mentions) if (!named.has(n)) return false;
  }
  return true;
}

/** Clamp a requested page size. */
export function searchLimit(raw: unknown): number {
  const n = Number(raw ?? SEARCH_LIMIT_DEFAULT);
  if (!Number.isFinite(n) || n < 1) return SEARCH_LIMIT_DEFAULT;
  return Math.min(Math.floor(n), SEARCH_LIMIT_MAX);
}

/** A `before` cursor: a positive integer id, else none. */
export function searchBefore(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Newest first over `messages` (which must be in ascending id order), only
 * ids below `before` when given. The cursor is the id of the last hit
 * returned: ids are unique and ordered, so pages never skip or repeat.
 * Messages with a non-positive id (a mirror's local lines) never match.
 */
export function searchMessages(messages: readonly ChatMessage[], q: SearchQuery, opts: { limit: number; before?: number; visible: Visible }): SearchPage {
  const results: SearchHit[] = [];
  if (!hasTerms(q)) return { results, nextBefore: null };
  let more = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!(m.id > 0)) continue;
    if (opts.before !== undefined && m.id >= opts.before) continue;
    if (q.range && m.id < q.range.min) break;
    if (!opts.visible(m)) continue;
    if (!matchesSearch(m, q)) continue;
    if (results.length === opts.limit) { more = true; break; }
    const first = q.words[0];
    results.push({ message: m, matchIndex: first ? Math.max(0, (m.text ?? "").toLowerCase().indexOf(first)) : 0 });
  }
  return { results, nextBefore: more && results.length > 0 ? results[results.length - 1].message.id : null };
}

/** A window of visible messages around `id`, or null when the viewer cannot see it. */
export interface MessageWindow {
  messages: ChatMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
}

export const WINDOW_LIMIT_DEFAULT = 50;
export const WINDOW_LIMIT_MAX = 200;

export function windowLimit(raw: unknown): number {
  const n = Number(raw ?? WINDOW_LIMIT_DEFAULT);
  if (!Number.isFinite(n) || n < 1) return WINDOW_LIMIT_DEFAULT;
  return Math.min(Math.floor(n), WINDOW_LIMIT_MAX);
}

export function windowAround(messages: readonly ChatMessage[], id: number, limit: number, isVisible: Visible): MessageWindow | null {
  const visible = messages.filter((m) => m.id > 0 && isVisible(m));
  const idx = visible.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const n = Math.max(1, limit);
  let start = Math.max(0, idx - Math.floor((n - 1) / 2));
  const end = Math.min(visible.length, start + n);
  start = Math.max(0, end - n);
  return { messages: visible.slice(start, end), hasOlder: start > 0, hasNewer: end < visible.length };
}

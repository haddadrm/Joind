/**
 * Long-poll listen support for resident sessions (agents living in GUI
 * harnesses: Codex Desktop, OpenClaw web UI). Instead of terminal injection,
 * a resident agent blocks on a listen call that resolves as soon as a
 * deliverable message lands, or times out quietly so the agent can loop.
 *
 * Deliverable means: visible to the listener (public, or a DM that includes
 * them), sent by someone else, and, in mentionsOnly mode, addressing them
 * with @Name or @all. Non-deliverable traffic advances the cursor silently.
 */

import type { ChatRoom, ChatMessage } from "./room.js";

export interface ListenResult {
  messages: ChatMessage[];
  lastId: number;
  timedOut: boolean;
  /** True when the wait ended because the client went away; callers must not
   *  advance any persistent cursor for an aborted result. */
  aborted?: boolean;
}

export const LISTEN_DEFAULT_MS = 50_000;
export const LISTEN_MAX_MS = 240_000;
/** Page size per call: a scan never advances the cursor past more messages
 *  than it actually examined, so a backlog can never be skipped. */
export const LISTEN_PAGE = 100;
/** Global cap on concurrently parked listens across all rooms. */
export const LISTEN_MAX_CONCURRENT = 64;

/** Clamp a caller-supplied timeout into the allowed window. */
export function clampListenTimeout(ms: number | undefined): number {
  if (ms == null || Number.isNaN(ms)) return LISTEN_DEFAULT_MS;
  return Math.max(1_000, Math.min(LISTEN_MAX_MS, ms));
}

/** True when the text addresses the agent: @Name (case-insensitive) or @all.
 *  Word boundary is a Unicode-aware lookahead so names like "C++" or "José"
 *  terminate correctly where JS \b does not. */
export function mentionsAgent(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@(${escaped}|all)(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

function visibleTo(m: ChatMessage, viewer: string): boolean {
  return !m.to || m.to.includes(viewer) || m.sender === viewer;
}

/** Sanitize a caller cursor: a finite non-negative integer or undefined. */
function sanitizeSince(since: number | undefined): number | undefined {
  if (since == null) return undefined;
  if (!Number.isSafeInteger(since) || since < 0) return 0;
  return since;
}

// One parked listen per (room, sender): a newer call aborts the older one so
// overlapping polls can never double-deliver. WeakMap so closed rooms free up.
const activeListens = new WeakMap<ChatRoom, Map<string, () => void>>();
let parkedCount = 0;

/**
 * Resolve as soon as a deliverable message lands after cursor `since`, or
 * after `timeoutMs` with an empty result. Messages already waiting past the
 * cursor resolve immediately. The scan is ascending and paged: the returned
 * lastId never advances past messages the call did not examine, so a large
 * backlog yields quick empty results with a moving cursor instead of skips.
 */
export function waitForMessage(
  room: ChatRoom,
  sender: string,
  since: number | undefined,
  timeoutMs: number,
  options?: { mentionsOnly?: boolean; signal?: AbortSignal }
): Promise<ListenResult> {
  const mentionsOnly = options?.mentionsOnly === true;
  const signal = options?.signal;

  const deliverable = (m: ChatMessage): boolean =>
    m.sender !== sender && visibleTo(m, sender) && (!mentionsOnly || mentionsAgent(m.text, sender));

  const highWater = room.read(undefined, 1)[0]?.id ?? 0;
  const cursor = Math.min(sanitizeSince(since) ?? 0, highWater);

  // Ascending page: everything visible after the cursor, oldest first,
  // capped at LISTEN_PAGE actually-examined messages.
  const page = (from: number): ChatMessage[] =>
    room.read(from, Number.MAX_SAFE_INTEGER, undefined, sender).slice(0, LISTEN_PAGE);

  const scanned = page(cursor);
  const hits = scanned.filter(deliverable);
  const scanEnd = scanned.length > 0 ? scanned[scanned.length - 1].id : cursor;
  if (hits.length > 0) {
    return Promise.resolve({ messages: hits, lastId: scanEnd, timedOut: false });
  }
  if (scanned.length >= LISTEN_PAGE) {
    // Full page with no hits: hand the cursor forward and let the caller
    // loop straight back rather than blocking behind an unscanned backlog.
    return Promise.resolve({ messages: [], lastId: scanEnd, timedOut: false });
  }
  const skipTo = scanEnd;

  if (signal?.aborted) {
    return Promise.resolve({ messages: [], lastId: skipTo, timedOut: true, aborted: true });
  }
  if (parkedCount >= LISTEN_MAX_CONCURRENT) {
    return Promise.resolve({ messages: [], lastId: skipTo, timedOut: true });
  }

  return new Promise<ListenResult>((resolve) => {
    let settled = false;
    parkedCount++;

    let perRoom = activeListens.get(room);
    if (!perRoom) {
      perRoom = new Map();
      activeListens.set(room, perRoom);
    }
    // Abort any previous parked listen for this agent in this room.
    perRoom.get(sender)?.();

    const finish = (timedOut: boolean, aborted = false): void => {
      if (settled) return;
      settled = true;
      parkedCount--;
      room.removeListener("room", onEvent);
      clearTimeout(timer);
      clearInterval(keepAlive);
      signal?.removeEventListener("abort", onAbort);
      if (perRoom?.get(sender) === abortThis) perRoom.delete(sender);
      if (aborted) {
        resolve({ messages: [], lastId: skipTo, timedOut: true, aborted: true });
        return;
      }
      const fresh = page(skipTo);
      const messages = fresh.filter(deliverable);
      const lastId = fresh.length > 0 ? fresh[fresh.length - 1].id : skipTo;
      resolve({ messages, lastId, timedOut });
    };
    const abortThis = (): void => finish(true, true);
    const onAbort = (): void => finish(true, true);
    const onEvent = (event: { type: string; data?: unknown }): void => {
      if (event.type !== "message" || event.data == null) return;
      if (deliverable(event.data as ChatMessage)) finish(false);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    // A listening agent is present by definition: touch it through the hold
    // so the 120s stale sweep (which also pid-probes, meaningless for remote
    // or GUI-resident agents) neither dims nor removes it mid-listen.
    const keepAlive = setInterval(() => room.touch(sender), 30_000);
    perRoom.set(sender, abortThis);
    signal?.addEventListener("abort", onAbort, { once: true });
    room.on("room", onEvent);
  });
}

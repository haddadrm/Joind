/**
 * Long-poll listen support for resident sessions (agents living in GUI
 * harnesses: Codex Desktop, OpenClaw web UI). Instead of terminal injection,
 * a resident agent blocks on a listen call that resolves as soon as another
 * participant posts, or times out quietly so the agent can loop.
 */

import type { ChatRoom, ChatMessage } from "./room.js";

export interface ListenResult {
  messages: ChatMessage[];
  lastId: number;
  timedOut: boolean;
}

export const LISTEN_DEFAULT_MS = 50_000;
export const LISTEN_MAX_MS = 240_000;

/** Clamp a caller-supplied timeout into the allowed window. */
export function clampListenTimeout(ms: number | undefined): number {
  if (ms == null || Number.isNaN(ms)) return LISTEN_DEFAULT_MS;
  return Math.max(1_000, Math.min(LISTEN_MAX_MS, ms));
}

/**
 * Resolve as soon as a message from someone other than `sender` lands after
 * cursor `since`, or after `timeoutMs` with an empty result. Messages already
 * waiting past the cursor resolve immediately.
 */
export function waitForMessage(
  room: ChatRoom,
  sender: string,
  since: number | undefined,
  timeoutMs: number
): Promise<ListenResult> {
  const pending = room.read(since, 100, undefined, sender);
  const foreign = pending.some((m) => m.sender !== sender);
  if (foreign) {
    const lastId = pending[pending.length - 1]?.id ?? since ?? 0;
    return Promise.resolve({ messages: pending, lastId, timedOut: false });
  }
  // Own messages past the cursor do not wake the listener, but the cursor
  // still moves past them so they are not re-delivered forever.
  const skipTo = pending.length > 0 ? pending[pending.length - 1].id : since;

  return new Promise<ListenResult>((resolve) => {
    let settled = false;
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      room.removeListener("room", onEvent);
      clearTimeout(timer);
      clearInterval(keepAlive);
      const messages = room.read(skipTo, 100, undefined, sender);
      const lastId = messages.length > 0 ? messages[messages.length - 1].id : (skipTo ?? 0);
      resolve({ messages, lastId, timedOut });
    };
    const onEvent = (event: { type: string; data?: { sender?: string } }): void => {
      if (event.type === "message" && event.data?.sender !== sender) finish(false);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    // A listening agent is present by definition: touch it through the hold
    // so the 120s stale sweep (which also pid-probes, meaningless for remote
    // or GUI-resident agents) neither dims nor removes it mid-listen.
    const keepAlive = setInterval(() => room.touch(sender), 30_000);
    room.on("room", onEvent);
  });
}

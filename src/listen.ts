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

/** True when the text addresses the agent: @Name (case-insensitive) or @all. */
export function mentionsAgent(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@(${escaped}|all)\\b`, "i").test(text);
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
  timeoutMs: number,
  options?: { mentionsOnly?: boolean }
): Promise<ListenResult> {
  const mentionsOnly = options?.mentionsOnly === true;
  // A message wakes the listener when someone else sent it, and (in
  // mentionsOnly mode) it addresses the listener with @Name or @all.
  // mentionsOnly protects a resident's context budget: unaddressed traffic
  // advances the cursor silently and can be caught up on via chat_read.
  const wakes = (m: ChatMessage): boolean =>
    m.sender !== sender && (!mentionsOnly || mentionsAgent(m.text, sender));
  const deliver = (all: ChatMessage[]): ChatMessage[] =>
    mentionsOnly ? all.filter(wakes) : all;

  const pending = room.read(since, 100, undefined, sender);
  if (pending.some(wakes)) {
    const lastId = pending[pending.length - 1]?.id ?? since ?? 0;
    return Promise.resolve({ messages: deliver(pending), lastId, timedOut: false });
  }
  // Non-waking messages past the cursor (own posts, and unaddressed traffic
  // in mentionsOnly mode) do not wake the listener, but the cursor still
  // moves past them so they are not re-delivered forever.
  const skipTo = pending.length > 0 ? pending[pending.length - 1].id : since;

  return new Promise<ListenResult>((resolve) => {
    let settled = false;
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      room.removeListener("room", onEvent);
      clearTimeout(timer);
      clearInterval(keepAlive);
      const all = room.read(skipTo, 100, undefined, sender);
      const lastId = all.length > 0 ? all[all.length - 1].id : (skipTo ?? 0);
      resolve({ messages: deliver(all), lastId, timedOut });
    };
    const onEvent = (event: { type: string; data?: { sender?: string; text?: string } }): void => {
      if (event.type !== "message" || !event.data) return;
      if (wakes(event.data as ChatMessage)) finish(false);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    // A listening agent is present by definition: touch it through the hold
    // so the 120s stale sweep (which also pid-probes, meaningless for remote
    // or GUI-resident agents) neither dims nor removes it mid-listen.
    const keepAlive = setInterval(() => room.touch(sender), 30_000);
    room.on("room", onEvent);
  });
}

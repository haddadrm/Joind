/**
 * DM mailboxes: cross-conversation aggregation and routing.
 *
 * Kimi's DM view (2026-09-16) filtered the ACTIVE conversation only, which
 * made the sidebar mailboxes feel like stubs: the thread changed with the
 * channel, sends landed in whatever room the human was viewing (often one
 * the recipient never reads), and background-room DMs were invisible.
 *
 * These helpers make a mailbox mean one thing: everything between the
 * viewer and one partner, across every conversation, with new DMs routed
 * into a room the partner actually reads.
 */

import type { ChatMessage, ChatRoom } from "./room.js";
import { visibleToViewer } from "./room.js";

export interface ConversationMetaLike {
  id: string;
  name: string;
}

/** The slice of ConversationManager these helpers need (kept small for tests). */
export interface ManagerLike {
  listConversations(): ConversationMetaLike[];
  /** Local rooms and mirrors of remote rooms ("<server>:<room>"); the
   *  mailboxes cover both (gate round 1, finding 9). */
  listAllRoomMetas?(): ConversationMetaLike[];
  getRoom(id: string): ChatRoom | undefined;
  getAgentConversationId(agentName: string): string | undefined;
  getActiveId(): string | null;
}

export interface DmThreadMessage extends ChatMessage {
  conversationId: string;
  conversationName: string;
}

function isBetween(m: ChatMessage, a: string, b: string): boolean {
  if (!m.to || m.to.length === 0) return false;
  if (m.sender === a) return m.to.includes(b);
  if (m.sender === b) return m.to.includes(a);
  return false;
}

/**
 * The full DM thread between viewer and partner across every conversation,
 * oldest first, capped to the newest `cap` messages. Visibility is enforced
 * per message with the viewer as reader (fail closed, same predicate as
 * every other DM surface).
 */
export function collectDmThread(
  manager: ManagerLike,
  viewer: string,
  partner: string,
  cap = 200
): DmThreadMessage[] {
  const out: DmThreadMessage[] = [];
  for (const meta of manager.listAllRoomMetas?.() ?? manager.listConversations()) {
    const room = manager.getRoom(meta.id);
    if (!room) continue;
    for (const m of room.read(undefined, Number.MAX_SAFE_INTEGER, undefined, viewer)) {
      if (!isBetween(m, viewer, partner)) continue;
      if (!visibleToViewer(m, viewer)) continue;
      out.push({ ...m, conversationId: meta.id, conversationName: meta.name });
    }
  }
  out.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

export interface DmPartnerSummary {
  partner: string;
  lastTimestamp: number;
  lastText: string;
  lastSender: string;
}

/** Every partner the viewer has exchanged DMs with, newest activity first. */
export function collectDmPartners(manager: ManagerLike, viewer: string): DmPartnerSummary[] {
  const latest = new Map<string, DmPartnerSummary>();
  for (const meta of manager.listAllRoomMetas?.() ?? manager.listConversations()) {
    const room = manager.getRoom(meta.id);
    if (!room) continue;
    for (const m of room.read(undefined, Number.MAX_SAFE_INTEGER, undefined, viewer)) {
      if (!m.to || m.to.length === 0) continue;
      if (!visibleToViewer(m, viewer)) continue;
      // An outgoing group DM belongs to every recipient's mailbox; an
      // incoming one belongs to the sender's.
      const partners: string[] = [];
      if (m.sender === viewer) {
        for (const t of m.to) if (t !== viewer && !partners.includes(t)) partners.push(t);
      } else if (m.to.includes(viewer)) {
        partners.push(m.sender);
      }
      for (const partner of partners) {
        const prev = latest.get(partner);
        if (!prev || m.timestamp > prev.lastTimestamp) {
          latest.set(partner, {
            partner,
            lastTimestamp: m.timestamp,
            lastText: m.text.length > 80 ? m.text.slice(0, 77) + "..." : m.text,
            lastSender: m.sender,
          });
        }
      }
    }
  }
  return [...latest.values()].sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

/**
 * Where a new DM to `partner` should live so the partner actually reads it:
 * 1. the conversation the partner is currently bound to (they read there);
 * 2. else the conversation of the most recent DM between the pair;
 * 3. else the active conversation.
 */
export function resolveDmTargetConversation(
  manager: ManagerLike,
  viewer: string,
  partner: string
): string | null {
  const bound = manager.getAgentConversationId(partner);
  if (bound && manager.getRoom(bound)) return bound;
  const thread = collectDmThread(manager, viewer, partner, 1);
  if (thread.length > 0) return thread[thread.length - 1].conversationId;
  return manager.getActiveId();
}

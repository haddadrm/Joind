/**
 * Linked servers: the wire vocabulary shared by the home side (src/peer.ts),
 * the mirroring side (src/link.ts, src/mirror.ts) and the routes.
 *
 * A remote room is addressed on the mirroring server as "<server>:<room>",
 * where <server> is the home server's name (its instance name, which is also
 * the name of the link to it) and <room> is the home's own conversation id.
 */

import type { Agent, ChatMessage, JoinRoute } from "./room.js";
import { SUBMIT_CHECK_CAP_MS, SUBMIT_CHECK_GRACE_MS } from "./submit-check.js";
import type { ServerBadge } from "./server-badge.js";

/** How long a home waits for its host to answer a hosted wake. It bounds the
 *  home's wait only: work still running on the host after it (the typing,
 *  the submit check) goes on. */
export const LINK_WAKE_TIMEOUT_MS = 90_000;
/** Slack for a submit check whose last poll's file I/O finishes after its
 *  nominal cap (its waitedMs can pass cap plus grace). */
export const HOSTED_VERDICT_IO_SLACK_MS = 60_000;
/** How long a host holds a verdict it could not deliver (the link was down),
 *  on the host's clock. In memory only. */
export const HOSTED_VERDICT_QUEUE_TTL_MS = 5 * 60_000;
/** Margin on top of everything else (the request itself, clock drift). */
export const HOSTED_VERDICT_MARGIN_MS = 60_000;
/**
 * How long a home keeps the record of a hosted wake for its verdict, on the
 * home's clock from the moment it minted the wake id: the wake's dispatch and
 * the check's start (the link wake timeout), the check's cap and grace, the
 * I/O overrun, the host's retry queue, and a margin. 1,125 s (18 min 45 s).
 * This constant is the single source of truth for the budget. A verdict that
 * arrives later than this is refused as expired: a documented delivery
 * limit, not a claim that a delayed verdict can never be refused.
 */
export const HOSTED_VERDICT_TTL_MS =
  LINK_WAKE_TIMEOUT_MS + SUBMIT_CHECK_CAP_MS + SUBMIT_CHECK_GRACE_MS +
  HOSTED_VERDICT_IO_SLACK_MS + HOSTED_VERDICT_QUEUE_TTL_MS + HOSTED_VERDICT_MARGIN_MS;
/** A wake id as a home mints it (randomUUID). */
export const WAKE_ID_PATTERN = /^[0-9a-f-]{36}$/;

/** The first eight characters of a wake id, for log lines. */
export function shortWakeId(wakeId: string): string {
  return wakeId.slice(0, 8);
}

/** One room event forwarded by a home server, numbered per room. `data` is
 *  the payload WebSocket clients of the home server get for that event. */
export interface PeerEvent {
  seq: number;
  type: string;
  data: unknown;
}

export interface PeerSubscribeResult {
  events: PeerEvent[];
  cursor: number;
  /** The cursor is outside what the home can replay (it restarted, or the
   *  peer fell too far behind): refill from /api/peer/messages. */
  reset?: boolean;
}

export interface PeerMessagesResult {
  server: string;
  room: string;
  name: string;
  messages: ChatMessage[];
  members: Agent[];
  /** The room's event sequence when the snapshot was taken: subscribe from here. */
  cursor: number;
  /** The snapshot holds every visible message after `since` (none was cut
   *  by the limit): a cached message absent from it is gone on the home. */
  complete?: boolean;
}

export interface PeerRoomsResult {
  server: string;
  rooms: Array<{ id: string; name: string; createdAt: number; messageCount: number; starred: boolean }>;
  /** The home's own server badge (src/server-badge.ts), so a peer shows the
   *  same badge for it. Absent from older homes: the peer then shows the
   *  default badge for the name. */
  badge?: ServerBadge;
}

export interface PeerRegisterBody {
  room: string;
  name: string;
  host: string;
  /** The host's registration id for the member (the home keeps it as the
   *  hosted registration and sends it back with wakes). */
  registration: string;
  terminalSummary?: string;
  role?: string;
  /** How the member joined on its host ("mcp" or "rest"): the home keeps it
   *  on the hosted member, as the host keeps it on its own. */
  joinRoute?: JoinRoute;
  /** The host's human web viewer: may post and read DMs, is never woken. */
  human?: boolean;
}

export interface PeerRegisterResult {
  ok: boolean;
  /** The home server's registration id for the member. */
  registration: string;
  online: string[];
}

export interface PeerWriteOptions {
  replyTo?: number;
  to?: string[];
  askFor?: string;
  choices?: string[];
}

export interface PeerSendBody extends PeerWriteOptions {
  room: string;
  sender: string;
  text: string;
  pid?: number;
  /** Peer-generated id: a retry after a dropped link returns the first copy. */
  clientId: string;
  /** The home registration id of the sender (checked against the member). */
  registration?: string;
}

export interface PeerSendResult {
  ok: boolean;
  duplicate?: boolean;
  message: ChatMessage;
}

/** A departure names either this server's registration (`registration`,
 *  the home's id) or the peer's own (`hostedRegistration`). */
export interface PeerLeaveBody {
  room: string;
  name: string;
  registration?: string;
  hostedRegistration?: string;
}

/** Everything else a hosted member does in a remote room, carried home.
 *  (An addition to the plan's wire contract: presence, typing, status,
 *  ask resolution, choices, tags and pins of hosted members.) */
export type PeerAction =
  | { action: "touch" }
  | { action: "typing"; typing: boolean }
  | { action: "status"; status: string }
  | { action: "resolve"; messageId: number }
  | { action: "choose"; messageId: number; value: string }
  | { action: "tag"; messageId: number; tag: string }
  | { action: "pin"; messageId: number; pinned: boolean };

export type PeerActBody = { room: string; name: string; registration: string } & PeerAction;

export interface PeerWakeBody {
  room: string;
  name: string;
  hostedRegistration: string;
  sender: string;
  prompt: string;
  /** The earliest uncovered mention id in the home room (absent from older homes). */
  mentionId?: number;
  /** The home's id for this wake, recorded before dispatch; the host names
   *  it in a later verdict (absent from older homes: nothing is reported). */
  wakeId?: string;
}

/**
 * Host to home, after a hosted wake's submit check: the keys were typed on
 * the host, and its check saw no matching submitted prompt within its
 * window, with `excludedStale` rollouts not read. An unconfirmed observation,
 * not proof that the text sits in the input box. Only this kind is sent:
 * submitted and unverifiable stay in the host's log.
 */
export interface PeerWakeVerdictBody {
  room: string;
  name: string;
  wakeId: string;
  /** The host's registration of the member, echoed back. A credential: never logged. */
  hostedRegistration: string;
  verdict: "not-submitted";
  pid: number;
  waitedMs: number;
  excludedStale: number;
  horizonMs: number;
  /** The host's clock when the check ended. Informational only: expiry
   *  runs on the home's clock. */
  checkedAt: number;
}

/** Why a home did not take a verdict (it posts nothing for any of them). */
export type HostedVerdictRefusal =
  | "unknown"             // no such wake here (never minted, already taken, or the home restarted)
  | "expired"             // older than HOSTED_VERDICT_TTL_MS on the home's clock
  | "wrong-peer"          // the wake went to another host
  | "wrong-name"
  | "wrong-registration"
  | "member-left"
  | "member-inactive"
  | "member-changed"      // rejoined (a new registration) since the wake
  | "incomplete"          // excludedStale or horizonMs absent: never defaulted
  | "invalid";            // a field outside its bounds, or another kind of verdict

/** The home's answer to every well-formed verdict (a malformed one is 400). */
export interface PeerWakeVerdictResult {
  ok: true;
  accepted: boolean;
  reason?: HostedVerdictRefusal;
}

/** The link could not carry the request (connection refused, timeout, 5xx). */
export class LinkDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkDownError";
  }
}

/** The peer answered and refused (4xx). */
export class PeerRefusedError extends Error {
  constructor(public status: number, message: string, public code?: string, public body?: unknown) {
    super(message);
    this.name = "PeerRefusedError";
  }
}

/** What a local join into a remote room needs from the link layer; the
 *  tools and routes see only this. */
export interface RemoteRooms {
  /** Whether `convId` names a remote room through a configured link. */
  isRemoteId(convId: string): boolean;
  /** Make a remote room resolvable through the manager (its mirror exists).
   *  False when the home server has no such room, or it cannot be reached
   *  and the room was never seen. */
  prepare(convId: string): Promise<boolean>;
  /** Register a local member with the remote room's home server. Nothing
   *  changes on this server: the caller commits (commitMember) only when its
   *  join is still current, and abandons (abandonMember) otherwise. */
  registerMember(convId: string, name: string, registration: string, terminal: { pid?: number; paneId?: number; gui?: number; orcaTerminal?: string; role?: string; joinRoute?: JoinRoute }): Promise<RemoteRegisterOutcome>;
  /** The join is current and joined locally: keep its home registration,
   *  resume any queued messages of that author. */
  commitMember(convId: string, name: string, outcome: RemoteRegistered): void;
  /** The join was superseded after it registered with the home server: put
   *  the home back to the member that is current here (or remove the
   *  abandoned registration when none is). */
  abandonMember(convId: string, name: string, outcome: RemoteRegistered): Promise<void>;
  /** The member is joined locally: subscribe (again, with the new viewer) and fill. */
  joined(convId: string): Promise<void>;
}

export interface RemoteRegistered {
  ok: true;
  online: string[];
  homeRegistration: string;
  /** This server's registration id the home holds as the hosted one. */
  hostedRegistration: string;
  role?: string;
  terminalSummary: string;
}

export type RemoteRegisterOutcome =
  | RemoteRegistered
  | { ok: false; status: number; error: string; candidates?: unknown };

/** "<server>:<room>" */
export function remoteRoomId(server: string, room: string): string {
  return `${server}:${room}`;
}

/** Split a remote room id at its first ":"; null for a local id. Local ids
 *  (c-2026-...) never contain ":". */
export function parseRemoteRoomId(id: string): { server: string; room: string } | null {
  const i = id.indexOf(":");
  if (i <= 0 || i === id.length - 1) return null;
  return { server: id.slice(0, i), room: id.slice(i + 1) };
}

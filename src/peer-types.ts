/**
 * Linked servers: the wire vocabulary shared by the home side (src/peer.ts),
 * the mirroring side (src/link.ts, src/mirror.ts) and the routes.
 *
 * A remote room is addressed on the mirroring server as "<server>:<room>",
 * where <server> is the home server's name (its instance name, which is also
 * the name of the link to it) and <room> is the home's own conversation id.
 */

import type { Agent, ChatMessage } from "./room.js";

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

export interface PeerLeaveBody {
  room: string;
  name: string;
  registration: string;
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
  registerMember(convId: string, name: string, registration: string, terminal: { pid?: number; paneId?: number; gui?: number; orcaTerminal?: string; role?: string }): Promise<RemoteRegisterOutcome>;
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

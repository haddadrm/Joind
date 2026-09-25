/**
 * PeerHub: the home server's side of its links, and the peer routes.
 *
 * Home side (this server owns the room):
 * - Every event of a local room gets a per-room sequence number (persisted
 *   beside the JSONL as <room>.peerseq, so a restart continues the numbering
 *   past anything issued before) and is kept in a bounded buffer that
 *   /api/peer/subscribe long-polls from.
 * - A peer sees no more of a room than its members may: the viewers are the
 *   room's members hosted on that peer (and the peer's registered human),
 *   whatever the request asks for, and DM visibility is applied here before
 *   anything crosses the link.
 * - Hosted members register, send (idempotent by clientId), act and leave
 *   through the link, each checked against the calling peer.
 * - A peer that stops calling for longer than the presence grace is said
 *   once in every room where it hosts members; its return is said too.
 *
 * Peer side (this server hosts a member of a room elsewhere):
 * - /api/peer/wake runs the normal wake path for the local member and
 *   returns the outcome to the home server, which says the line.
 */

import express from "express";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { LinkConfig } from "./config.js";
import { tokensEqual } from "./config.js";
import { newRegistrationId, type ConversationManager } from "./manager.js";
import { visibleToViewer, type ChatMessage, type ChatRoom, type RoomEvent } from "./room.js";
import type { LinkRegistry } from "./link.js";
import type { PeerAction, PeerEvent, PeerSubscribeResult } from "./peer-types.js";

export interface PeerHubOptions {
  manager: ConversationManager;
  /** The server's own name. */
  selfName: string;
  /** Where conversation JSONL lives (the .peerseq files go beside it). */
  conversationsDir: string;
  links: LinkConfig[];
  registry?: LinkRegistry;
  getPersistedRole?: (name: string) => string | undefined;
  /** How long a silent peer may stay silent before its rooms are told. */
  peerGraceMs: number;
  monitorEveryMs?: number;
  bufferSize?: number;
  now?: () => number;
}

/** Numbers issued before a restart are never reissued: the persisted value
 *  is written at most once a second, so a restart skips this far ahead. */
const SEQ_RESTART_GAP = 100_000;
const CLIENT_IDS_KEPT = 5_000;
const SUBSCRIBE_MAX_MS = 60_000;

interface Waiter { wake: () => void }

type Req = express.Request & { peer?: LinkConfig };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export class PeerHub {
  private seq = new Map<string, number>();
  private seqDirty = new Map<string, ReturnType<typeof setTimeout>>();
  private buffers = new Map<string, PeerEvent[]>();
  private waiters = new Map<string, Set<Waiter>>();
  private clientIds = new Map<string, Map<string, ChatMessage>>();
  private lastContact = new Map<string, number>();
  private announcedGone = new Set<string>();
  private monitor: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly bufferSize: number;

  constructor(private opts: PeerHubOptions) {
    this.now = opts.now ?? Date.now;
    this.bufferSize = opts.bufferSize ?? 2_000;
    const start = this.now();
    for (const l of opts.links) this.lastContact.set(l.name, start);
  }

  // ---------------------------------------------------------------------
  // Event capture
  // ---------------------------------------------------------------------

  /** Record every event of every LOCAL room (a mirror's events are never
   *  forwarded again: links do not chain). */
  attach(stores: Array<{ on(event: string, fn: (e: { type: string; conversationId: string; data: unknown }) => void): unknown; eventName: string }>): void {
    this.opts.manager.on("room", (event: RoomEvent & { conversationId: string }) => {
      if (this.opts.manager.isRemote(event.conversationId) || event.conversationId.includes(":")) return;
      this.record(event.conversationId, event.type, event.data);
    });
    for (const s of stores) {
      s.on(s.eventName, (e) => {
        if (!e || typeof e.conversationId !== "string" || this.opts.manager.isRemote(e.conversationId)) return;
        this.record(e.conversationId, e.type, e.data);
      });
    }
  }

  startMonitor(): void {
    this.monitor = setInterval(() => this.checkPeers(), this.opts.monitorEveryMs ?? 15_000);
  }

  stop(): void {
    if (this.monitor) clearInterval(this.monitor);
    for (const [room, t] of this.seqDirty) { clearTimeout(t); this.persistSeq(room); }
    this.seqDirty.clear();
    for (const set of this.waiters.values()) for (const w of set) w.wake();
  }

  private seqFile(room: string): string {
    return join(this.opts.conversationsDir, `${room}.peerseq`);
  }

  currentSeq(room: string): number {
    let s = this.seq.get(room);
    if (s == null) {
      s = 0;
      try {
        if (existsSync(this.seqFile(room))) {
          const n = Number(readFileSync(this.seqFile(room), "utf-8").trim());
          if (Number.isSafeInteger(n) && n > 0) s = n + SEQ_RESTART_GAP;
        }
      } catch { /* start at 0 */ }
      this.seq.set(room, s);
    }
    return s;
  }

  private persistSeq(room: string): void {
    try { writeFileSync(this.seqFile(room), String(this.seq.get(room) ?? 0), "utf-8"); } catch { /* next write */ }
  }

  record(room: string, type: string, data: unknown): PeerEvent {
    const seq = this.currentSeq(room) + 1;
    this.seq.set(room, seq);
    const ev: PeerEvent = { seq, type, data };
    let buf = this.buffers.get(room);
    if (!buf) { buf = []; this.buffers.set(room, buf); }
    buf.push(ev);
    if (buf.length > this.bufferSize) buf.splice(0, buf.length - this.bufferSize);
    if (!this.seqDirty.has(room)) {
      this.persistSeq(room);
      this.seqDirty.set(room, setTimeout(() => { this.seqDirty.delete(room); this.persistSeq(room); }, 1_000));
    }
    const waiting = this.waiters.get(room);
    if (waiting) for (const w of [...waiting]) w.wake();
    return ev;
  }

  // ---------------------------------------------------------------------
  // Who a peer may see as
  // ---------------------------------------------------------------------

  /** The names a peer's view of a room is filtered for: its hosted members
   *  and its registered human, intersected with what it asked for. */
  viewersFor(peer: string, roomId: string, requested?: string[]): string[] {
    const room = this.opts.manager.getRoom(roomId);
    const allowed = new Set<string>();
    for (const a of room?.who() ?? []) if (a.host === peer) allowed.add(a.name);
    for (const name of room?.peerHumanNames(peer) ?? []) allowed.add(name);
    if (!requested) return [...allowed];
    return requested.filter((n) => allowed.has(n));
  }

  private visibleToAny(m: ChatMessage | undefined, viewers: string[]): boolean {
    if (!m) return false;
    if (!m.to) return true;
    return viewers.some((v) => visibleToViewer(m, v));
  }

  /** Whether an event may cross the link to a peer whose viewers are these. */
  eventVisible(room: ChatRoom | undefined, ev: PeerEvent, viewers: string[]): boolean {
    const d = ev.data as Record<string, unknown> | null;
    switch (ev.type) {
      case "message":
        return this.visibleToAny(ev.data as ChatMessage, viewers);
      case "message-choice": case "ask-resolved": case "message-pinned":
        // Follows the original message; a missing original fails closed.
        return this.visibleToAny(room?.getMessageById(Number(d?.id)), viewers);
      case "message-edited": case "reaction":
        return this.visibleToAny(room?.getMessageById(Number(d?.messageId)), viewers);
      default:
        return true;
    }
  }

  /**
   * Long-poll the events of a room after `since`, filtered for the peer's
   * viewers. Filtered events still advance the cursor. A cursor this server
   * cannot replay (it restarted, or the peer fell out of the buffer) gets
   * `reset`, and the peer refills from /api/peer/messages.
   */
  async subscribe(peer: string, roomId: string, since: number, requested: string[] | undefined, timeoutMs: number, signal?: AbortSignal): Promise<PeerSubscribeResult> {
    const room = this.opts.manager.getRoom(roomId);
    const collect = (): PeerSubscribeResult => {
      const cur = this.currentSeq(roomId);
      if (since > cur) return { events: [], cursor: cur, reset: true };
      const buf = this.buffers.get(roomId) ?? [];
      if (since < cur && (buf.length === 0 || buf[0].seq > since + 1)) return { events: [], cursor: cur, reset: true };
      const viewers = this.viewersFor(peer, roomId, requested);
      const events = buf.filter((e) => e.seq > since && this.eventVisible(room, e, viewers));
      return { events, cursor: cur };
    };
    const first = collect();
    if (first.reset || first.cursor > since || signal?.aborted) return first;
    await new Promise<void>((resolve) => {
      let set = this.waiters.get(roomId);
      if (!set) { set = new Set(); this.waiters.set(roomId, set); }
      const waiter: Waiter = { wake: () => finish() };
      const timer = setTimeout(() => finish(), Math.max(0, Math.min(timeoutMs, SUBSCRIBE_MAX_MS)));
      const finish = (): void => {
        clearTimeout(timer);
        set?.delete(waiter);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      set.add(waiter);
      signal?.addEventListener("abort", finish, { once: true });
    });
    return collect();
  }

  // ---------------------------------------------------------------------
  // Peer liveness
  // ---------------------------------------------------------------------

  noteContact(peer: string): void {
    this.lastContact.set(peer, this.now());
    if (this.announcedGone.delete(peer)) {
      for (const room of this.roomsHosting(peer)) room.addSystem(`${peer} is reachable again; members hosted there can be woken`);
    }
  }

  private roomsHosting(peer: string): ChatRoom[] {
    const out: ChatRoom[] = [];
    for (const meta of this.opts.manager.listConversations()) {
      const room = this.opts.manager.getRoom(meta.id);
      if (room?.who().some((a) => a.host === peer)) out.push(room);
    }
    return out;
  }

  /** A peer silent for longer than the grace: said once in each room where
   *  it hosts members (their pills are already dimmed by the stale sweep). */
  checkPeers(): void {
    const now = this.now();
    for (const l of this.opts.links) {
      if (this.announcedGone.has(l.name)) continue;
      if (now - (this.lastContact.get(l.name) ?? now) <= this.opts.peerGraceMs) continue;
      const rooms = this.roomsHosting(l.name);
      if (rooms.length === 0) continue;
      this.announcedGone.add(l.name);
      for (const room of rooms) room.addSystem(`${l.name} unreachable; members hosted there cannot be woken until it returns`);
    }
  }

  // ---------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------

  router(): express.Router {
    const r = express.Router();
    const { manager } = this.opts;

    // Token authentication: the token names the peer. No links configured: 503.
    r.use((req: Req, res, next) => {
      if (this.opts.links.length === 0) { res.status(503).json({ error: "Linking is not enabled on this server" }); return; }
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
      const peer = this.opts.links.find((l) => tokensEqual(token, l.token));
      if (!peer) { res.status(401).json({ error: "unauthorized" }); return; }
      req.peer = peer;
      this.noteContact(peer.name);
      next();
    });

    const localRoom = (id: unknown): ChatRoom | undefined => {
      const s = str(id);
      if (!s || s.includes(":") || manager.isRemote(s)) return undefined;
      return manager.getRoom(s);
    };

    r.get("/rooms", (_req: Req, res) => {
      res.json({ server: this.opts.selfName, rooms: manager.listConversations() });
    });

    r.get("/subscribe", async (req: Req, res) => {
      const peer = req.peer!.name;
      const roomId = str(req.query.room);
      if (!roomId || !localRoom(roomId)) { res.status(404).json({ error: "Conversation not found" }); return; }
      const since = Number(req.query.since ?? 0);
      const timeoutMs = Number(req.query.timeoutMs ?? 25_000);
      const viewers = typeof req.query.viewers === "string" ? req.query.viewers.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const out = await this.subscribe(peer, roomId, Number.isSafeInteger(since) && since >= 0 ? since : 0, viewers, Number.isFinite(timeoutMs) ? timeoutMs : 25_000, abort.signal);
      this.noteContact(peer);
      if (!res.headersSent && !res.writableEnded) res.json(out);
    });

    r.get("/messages", (req: Req, res) => {
      const peer = req.peer!.name;
      const roomId = str(req.query.room)!;
      const room = localRoom(roomId);
      if (!room) { res.status(404).json({ error: "Conversation not found" }); return; }
      // The cursor first: anything after it is replayed by subscribe.
      const cursor = this.currentSeq(roomId);
      const requested = typeof req.query.viewers === "string" ? req.query.viewers.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const viewers = this.viewersFor(peer, roomId, requested);
      const sinceRaw = Number(req.query.since);
      const since = Number.isSafeInteger(sinceRaw) && sinceRaw >= 0 ? sinceRaw : undefined;
      const limitRaw = Number(req.query.limit ?? 200);
      const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5_000) : 200;
      const visible = room.readAll(1_000_000).filter((m) => (since == null || m.id > since) && this.visibleToAny(m, viewers));
      const messages = visible.slice(-limit);
      const meta = manager.getMeta(roomId);
      res.json({ server: this.opts.selfName, room: roomId, name: meta?.name ?? roomId, messages, members: room.who(), cursor, complete: since == null && visible.length <= limit });
    });

    r.post("/register", express.json(), (req: Req, res) => {
      const peer = req.peer!.name;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const roomId = str(body.room);
      const room = localRoom(roomId);
      const name = str(body.name);
      const hostedRegistration = str(body.registration);
      if (!roomId || !room) { res.status(404).json({ error: "Conversation not found" }); return; }
      if (!name || name.length > 64 || !hostedRegistration) { res.status(400).json({ error: "room, name, host and registration required" }); return; }
      if (str(body.host) !== peer) { res.status(403).json({ error: `host must be the calling server (${peer})` }); return; }
      const existing = room.getAgent(name);
      const human = room.peerHumanOf(name);
      // A name bound locally in this room (a member that timed out keeps its
      // binding until it rejoins or leaves) is local too.
      const localBinding = manager.bindingsOf(name).some((e) => e.conversationId === roomId && !e.host);
      const conflict = (): void => {
        const candidates = existing
          ? [{ conversation: roomId, host: existing.host ?? this.opts.selfName, ...(existing.host ? {} : existing.pid ? { pid: existing.pid } : {}) }]
          : human ? [{ conversation: roomId, host: human.peer, human: true }]
          : localBinding ? [{ conversation: roomId, host: this.opts.selfName }] : [];
        res.status(409).json({ error: `${name} is already registered in this room from another host`, code: "name-conflict", candidates });
      };
      // One owner per name in a room: a local member or binding, a hosted
      // member of one peer, or one peer's human (gate round 1, finding 1).
      if (body.human === true) {
        if (existing || localBinding || (human && human.peer !== peer)) { conflict(); return; }
        const registration = human?.registration ?? newRegistrationId();
        room.setPeerHuman(name, peer, registration);
        // A local join of this name still validating is superseded (finding 4).
        manager.supersedeRoomJoins(roomId, name);
        res.json({ ok: true, registration, online: room.whoNames() });
        return;
      }
      if (human) { conflict(); return; }
      if (existing && existing.host !== peer) { conflict(); return; }
      if (!existing && localBinding) { conflict(); return; }
      if (existing && room.hostedRegistrationOf(name) === hostedRegistration) {
        // The same host and the same hosted registration: idempotent.
        const registration = room.registrationOf(name) ?? newRegistrationId();
        room.touch(name);
        res.json({ ok: true, registration, online: room.whoNames() });
        return;
      }
      // Prefixed with this server's name: ids stay unique across links.
      const registration = `reg-${this.opts.selfName}-${randomUUID()}`;
      const role = str(body.role) ?? this.opts.getPersistedRole?.(name);
      // A local join of this name still validating is superseded (finding 4).
      manager.supersedeRoomJoins(roomId, name);
      room.joinHosted(name, peer, registration, hostedRegistration, role);
      manager.bindHosted(name, roomId, registration, peer);
      res.json({ ok: true, registration, online: room.whoNames() });
    });

    /** Who may act as `name` in `roomId` for this peer: its hosted member
     *  (the registration, when named, must be the member's), or its human. */
    const authorized = (peer: string, roomId: string, room: ChatRoom, name: string, registration: string | undefined, allowHuman: boolean): boolean => {
      const member = room.getAgent(name);
      if (member?.host === peer) return registration == null || room.registrationOf(name) === registration;
      const human = room.peerHumanOf(name);
      return allowHuman && human?.peer === peer && (registration == null || human.registration === registration);
    };

    r.post("/send", express.json(), (req: Req, res) => {
      const peer = req.peer!.name;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const roomId = str(body.room)!;
      const room = localRoom(roomId);
      if (!room) { res.status(404).json({ error: "Conversation not found" }); return; }
      const sender = str(body.sender);
      const text = typeof body.text === "string" ? body.text : undefined;
      const clientId = str(body.clientId);
      if (!sender || !text || !clientId || clientId.length > 100) { res.status(400).json({ error: "room, sender, text and clientId required" }); return; }
      // Authorize first: a retry is answered only to the sender that made the
      // original, from the peer that sent it (gate round 1, finding 2). The
      // key is the sender's name, not its registration id, so a retry after
      // a re-registration (the home forgot it) still finds its first copy.
      if (!authorized(peer, roomId, room, sender, str(body.registration), true)) {
        res.status(403).json({ error: `${sender} is not registered in this room from ${peer}`, code: "not-registered" });
        return;
      }
      // Keyed by the sender's INCARNATION (gate round 2, finding 3): for a
      // hosted member, its host's registration id, which the host keeps
      // across re-registrations of the same member and changes for a new
      // session; for a peer's human, its registration here. A new owner of
      // the name reusing an old clientId is a new message.
      const incarnation = room.getAgent(sender)?.host === peer ? `m:${room.hostedRegistrationOf(sender) ?? ""}` : `h:${room.peerHumanOf(sender)?.registration ?? ""}`;
      const dedupeKey = `${peer}\n${sender}\n${incarnation}\n${clientId}`;
      let seen = this.clientIds.get(roomId);
      const dup = seen?.get(dedupeKey);
      if (dup) { res.json({ ok: true, duplicate: true, message: dup }); return; }
      let to: string[] | undefined;
      if (body.to !== undefined) {
        if (!Array.isArray(body.to) || !body.to.every((t) => typeof t === "string" && t.trim() !== "")) { res.status(400).json({ error: "to must be an array of names" }); return; }
        to = [...new Set((body.to as string[]).map((t) => t.trim()).filter((t) => t !== sender))];
        if (to.length === 0) { res.status(400).json({ error: "to must name someone other than the sender" }); return; }
      }
      const choices = Array.isArray(body.choices) && body.choices.every((c) => typeof c === "string") ? (body.choices as string[]) : undefined;
      const replyTo = typeof body.replyTo === "number" && Number.isSafeInteger(body.replyTo) ? body.replyTo : undefined;
      // A DM never titles the room (the name is broadcast to every client).
      if (!to) manager.autoName(roomId, text);
      if (room.getAgent(sender)) { room.touch(sender); room.setTyping(sender, false); }
      const message = room.send(sender, text, { replyTo, to, choices, askFor: str(body.askFor) });
      if (!seen) { seen = new Map(); this.clientIds.set(roomId, seen); }
      seen.set(dedupeKey, message);
      if (seen.size > CLIENT_IDS_KEPT) seen.delete(seen.keys().next().value as string);
      res.json({ ok: true, message });
    });

    r.post("/leave", express.json(), (req: Req, res) => {
      const peer = req.peer!.name;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const roomId = str(body.room)!;
      const room = localRoom(roomId);
      const name = str(body.name);
      const registration = str(body.registration);
      // The peer may name the member by ITS OWN registration id (the hosted
      // one) instead of this server's: it releases whatever is held here for
      // that host and that id, so a peer never has to re-register an old id
      // to learn what to release (gate round 10).
      const hosted = str(body.hostedRegistration);
      if (!room || !name || (!registration && !hosted)) { res.status(404).json({ error: "No such registration" }); return; }
      const member = room.getAgent(name);
      if (member?.host === peer && hosted && !registration && room.hostedRegistrationOf(name) === hosted) {
        const own = room.registrationOf(name);
        manager.supersedeJoins(name);
        room.leave(name);
        if (own) manager.unbindRegistration(name, own);
        res.json({ ok: true });
        return;
      }
      if (member?.host === peer && registration && room.registrationOf(name) === registration) {
        manager.supersedeJoins(name);
        room.leave(name);
        manager.unbindRegistration(name, registration);
        res.json({ ok: true });
        return;
      }
      const human = room.peerHumanOf(name);
      if (registration && human?.peer === peer && human.registration === registration) {
        room.deletePeerHuman(name);
        res.json({ ok: true });
        return;
      }
      res.status(404).json({ error: "No such registration (already left, or rejoined with a new id)" });
    });

    r.post("/act", express.json(), (req: Req, res) => {
      const peer = req.peer!.name;
      const body = (req.body ?? {}) as Record<string, unknown> & Partial<PeerAction>;
      const roomId = str(body.room)!;
      const room = localRoom(roomId);
      const name = str(body.name);
      if (!room || !name) { res.status(404).json({ error: "Conversation not found" }); return; }
      const human = body.action === "resolve" || body.action === "choose" || body.action === "tag" || body.action === "pin";
      if (!authorized(peer, roomId, room, name, str(body.registration), human)) {
        res.status(403).json({ error: `${name} is not registered in this room from ${peer}`, code: "not-registered" });
        return;
      }
      const visible = (id: unknown): ChatMessage | undefined => {
        const m = room.getMessageById(Number(id));
        return m && visibleToViewer(m, name) ? m : undefined;
      };
      switch (body.action) {
        case "touch": room.touch(name); break;
        case "typing": room.setTyping(name, body.typing === true); break;
        case "status": room.setStatus(name, typeof body.status === "string" ? body.status : ""); break;
        case "resolve": if (visible(body.messageId)) room.resolveAsk(Number(body.messageId), name); break;
        case "choose": if (visible(body.messageId) && typeof body.value === "string") room.chooseMessage(Number(body.messageId), body.value, name); break;
        case "tag": if (visible(body.messageId) && typeof body.tag === "string") room.tagMessage(Number(body.messageId), body.tag); break;
        case "pin": if (visible(body.messageId)) room.pinMessage(Number(body.messageId), body.pinned !== false); break;
        default: res.status(400).json({ error: "unknown action" }); return;
      }
      res.json({ ok: true });
    });

    // Served by the HOST of a member: the home server asks for a wake.
    r.post("/wake", express.json(), async (req: Req, res) => {
      const peer = req.peer!.name;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const room = str(body.room);
      const name = str(body.name);
      const hostedRegistration = str(body.hostedRegistration);
      const sender = str(body.sender) ?? "someone";
      if (!room || !name || !hostedRegistration) { res.status(400).json({ error: "room, name and hostedRegistration required" }); return; }
      // Only a mirror of the CALLING server's room: a peer can wake our
      // members only in its own rooms.
      const mirror = this.opts.registry?.mirror(`${peer}:${room}`);
      if (!mirror) { res.status(404).json({ error: "Conversation not found" }); return; }
      const result = await mirror.wakeFromHome(sender, name, hostedRegistration);
      res.json(result);
    });

    return r;
  }
}

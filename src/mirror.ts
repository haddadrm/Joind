/**
 * MirrorRoom: this server's view of a room whose home is a linked server.
 *
 * It is a ChatRoom, so every tool and route that reads a room (read, who,
 * search, listen, asks, message lookups) works on it unchanged. What differs:
 *
 * - Messages, members and room events come from the home server, keyed by
 *   the home's ids, never rewritten. Nothing is persisted but the event
 *   cursor (kept by the link) and the undelivered queue.
 * - The room's own member map holds only this server's local members of the
 *   remote room: their real terminals (pid, pane, Orca handle), so the home
 *   server's wake requests run the normal wake machinery here (locks, guards,
 *   retries, classification). Their local events never leave this object;
 *   the home server is the one that says who joined.
 * - Writes go home. `writeThrough` sends at once when the link is up, and
 *   queues otherwise (or when older messages are still queued, to keep
 *   order); the queue drains in order when the link returns, each message
 *   carrying a clientId so a retry after a dropped reply is sent once. The
 *   author of an undelivered message may delete it before it goes.
 * - Lines that only this server can say ("link down", "link restored") are
 *   local: negative ids, never in a read cursor, shown to the web viewer.
 */

import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { dirname } from "path";
import { ChatRoom, visibleToViewer, type Agent, type ChatMessage, type HostedWakeResult } from "./room.js";
import { ensureDir } from "./persist.js";
import {
  LinkDownError, PeerRefusedError,
  type PeerActBody, type PeerAction, type PeerEvent, type PeerLeaveBody, type PeerMessagesResult,
  type PeerRegisterBody, type PeerRegisterResult, type PeerSendBody, type PeerWriteOptions,
} from "./peer-types.js";

/** How a mirror reaches its home server (implemented by the link). */
export interface MirrorTransport {
  isUp(): boolean;
  send(body: PeerSendBody): Promise<ChatMessage>;
  leave(body: PeerLeaveBody): Promise<void>;
  act(body: PeerActBody): Promise<void>;
  register(body: PeerRegisterBody): Promise<PeerRegisterResult>;
  /** The link failed under a mirror's own request (it marks the link down). */
  failed(reason: string): void;
}

export interface QueuedMessage extends PeerWriteOptions {
  clientId: string;
  sender: string;
  text: string;
  queuedAt: number;
  attempts: number;
}

/** The pending payload the web UI receives. */
export interface PendingPayload {
  conversationId: string;
  clientId: string;
  sender: string;
  text: string;
  queuedAt: number;
  to?: string[];
}

/** What a mirror tells the server beside its room events. The envelope
 *  carries conversationId like every other event, and the pending payloads
 *  carry it too (the web UI contract). */
export type MirrorNotice =
  | { type: "pending"; conversationId: string; data: PendingPayload }
  | { type: "pending-dispatched"; conversationId: string; data: { conversationId: string; clientId: string; id: number } }
  | { type: "pending-deleted"; conversationId: string; data: { conversationId: string; clientId: string } }
  | { type: "message"; conversationId: string; data: ChatMessage };

export type WriteResult =
  | { status: "sent"; message: ChatMessage }
  | { status: "queued"; clientId: string; reason: string };

export type DeleteResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * The undelivered queue of one remote room: one JSON line per message, in
 * send order, rewritten whole on every change (it is small, and a rewrite
 * through a temp file never leaves a torn line).
 */
export class UndeliveredQueue {
  private entries: QueuedMessage[] = [];

  constructor(private file: string | null) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as QueuedMessage;
          if (typeof e.clientId === "string" && typeof e.sender === "string" && typeof e.text === "string") this.entries.push(e);
        } catch { /* a torn line is dropped */ }
      }
    }
  }

  list(): QueuedMessage[] { return this.entries.map((e) => ({ ...e })); }
  size(): number { return this.entries.length; }
  first(): QueuedMessage | undefined { return this.entries[0] ? { ...this.entries[0] } : undefined; }
  get(clientId: string): QueuedMessage | undefined {
    const e = this.entries.find((x) => x.clientId === clientId);
    return e ? { ...e } : undefined;
  }

  add(e: QueuedMessage): void {
    this.entries.push({ ...e });
    this.save();
  }

  remove(clientId: string): QueuedMessage | undefined {
    const i = this.entries.findIndex((x) => x.clientId === clientId);
    if (i < 0) return undefined;
    const [e] = this.entries.splice(i, 1);
    this.save();
    return e;
  }

  bump(clientId: string): void {
    const e = this.entries.find((x) => x.clientId === clientId);
    if (!e) return;
    e.attempts++;
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    ensureDir(dirname(this.file));
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length ? "\n" : ""), "utf-8");
    renameSync(tmp, this.file);
  }
}

export interface MirrorOptions {
  /** The home server's name (the link's name). */
  server: string;
  /** The room's id on its home server. */
  homeId: string;
  name: string;
  createdAt?: number;
  messageCount?: number;
  /** The queue file (data/links/<server>/<room>.queue.jsonl); null keeps it in memory. */
  queueFile: string | null;
  transport: MirrorTransport;
  /** This server's own name: the host its members are registered from. */
  selfName: string;
}

interface ShadowInfo {
  homeRegistration: string;
  role?: string;
  terminalSummary?: string;
}

const LOCAL_LINES_KEPT = 50;
const TOUCH_FORWARD_MS = 30_000;

export class MirrorRoom extends ChatRoom {
  readonly id: string;
  readonly server: string;
  readonly homeRoomId: string;
  name: string;
  createdAt: number;
  homeMessageCount: number;
  /** Set once a "link down" line was said here, so a restore line follows. */
  downNoted = false;
  private readonly transport: MirrorTransport;
  private readonly selfName: string;
  private roster = new Map<string, Agent>();
  private shadows = new Map<string, ShadowInfo>();
  private human: { name: string; registration: string } | null = null;
  private queue: UndeliveredQueue;
  private localLines: ChatMessage[] = [];
  private localSeq = 0;
  private mirroring = false;
  private dispatching: string | null = null;
  private draining: Promise<number> | null = null;
  private lastTouchSent = new Map<string, number>();

  constructor(opts: MirrorOptions) {
    super({});
    this.server = opts.server;
    this.homeRoomId = opts.homeId;
    this.id = `${opts.server}:${opts.homeId}`;
    this.homeId = this.id;
    this.name = opts.name;
    this.createdAt = opts.createdAt ?? Date.now();
    this.homeMessageCount = opts.messageCount ?? 0;
    this.transport = opts.transport;
    this.selfName = opts.selfName;
    this.queue = new UndeliveredQueue(opts.queueFile);
  }

  // ---------------------------------------------------------------------
  // Events: only the home server's events leave this object as room events.
  // ---------------------------------------------------------------------

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    // A local member's own join, presence, typing or leave is not a fact of
    // the remote room; the home server announces its members.
    if (event === "room" && !this.mirroring) return false;
    return super.emit(event, ...args);
  }

  private emitMirrored(type: string, data: unknown): void {
    this.mirroring = true;
    try { super.emit("room", { type, data }); } finally { this.mirroring = false; }
  }

  private notice(n: MirrorNotice): void {
    super.emit("mirror-notice", n);
  }

  /** Lines the base class would post (joins, wake failures) are the home
   *  server's to say; here they are neither kept nor shown. */
  override addSystem(text: string): ChatMessage {
    return { id: 0, sender: "system", text, timestamp: Date.now() };
  }

  /** A line only this server can say (the link's state). */
  addLocalLine(text: string): ChatMessage {
    const msg: ChatMessage = { id: -(++this.localSeq), sender: "system", text, timestamp: Date.now(), local: true };
    this.localLines.push(msg);
    if (this.localLines.length > LOCAL_LINES_KEPT) this.localLines.shift();
    console.log(`  [link ${this.server}] ${this.id}: ${text}`);
    this.notice({ type: "message", conversationId: this.id, data: msg });
    return msg;
  }

  // ---------------------------------------------------------------------
  // The home server's view
  // ---------------------------------------------------------------------

  /** Replace the mirror with a home snapshot (initial fill or refill). */
  fill(snap: PeerMessagesResult): void {
    const byId = new Map<number, ChatMessage>();
    for (const m of this.messages) byId.set(m.id, m);
    for (const m of snap.messages) if (typeof m.id === "number") byId.set(m.id, m);
    this.messages = [...byId.values()].sort((a, b) => a.id - b.id);
    this.roster = new Map(snap.members.map((a) => [a.name, a]));
    if (snap.name) this.name = snap.name;
    this.homeMessageCount = Math.max(this.homeMessageCount, this.messages.length);
  }

  /** Insert a home message by id; false when it is already here. */
  private insertMessage(m: ChatMessage): boolean {
    if (typeof m.id !== "number" || this.messages.some((x) => x.id === m.id)) return false;
    const last = this.messages[this.messages.length - 1];
    if (!last || last.id < m.id) this.messages.push(m);
    else this.messages.splice(this.messages.findIndex((x) => x.id > m.id), 0, m);
    this.homeMessageCount++;
    return true;
  }

  /** Apply one forwarded home event and re-emit it as this room's event. */
  applyEvent(ev: PeerEvent): void {
    const d = ev.data as Record<string, unknown> | null;
    switch (ev.type) {
      case "message": {
        if (!this.insertMessage(ev.data as ChatMessage)) return;
        break;
      }
      case "join": case "role": case "agent-status": case "stale": {
        const a = ev.data as Agent;
        if (a && typeof a.name === "string") this.roster.set(a.name, a);
        break;
      }
      case "leave": {
        const a = ev.data as Agent;
        if (a && typeof a.name === "string") this.roster.delete(a.name);
        break;
      }
      case "rename": {
        const r = ev.data as { oldName: string; newName: string; agent: Agent };
        this.roster.delete(r.oldName);
        if (r.agent) this.roster.set(r.newName, r.agent);
        break;
      }
      case "presence": {
        const p = ev.data as { name: string; lastSeen: number; lastPostAt?: number };
        const a = this.roster.get(p.name);
        if (a) { a.lastSeen = p.lastSeen; a.lastPostAt = p.lastPostAt; }
        break;
      }
      case "message-choice": {
        const m = this.getMessageById(Number(d?.id));
        if (m) m.choiceResponse = d?.response as ChatMessage["choiceResponse"];
        break;
      }
      case "ask-resolved": {
        const m = this.getMessageById(Number(d?.id));
        if (m?.ask) { m.ask.state = "resolved"; m.ask.resolvedBy = String(d?.by ?? ""); m.ask.resolvedAt = Number(d?.at ?? Date.now()); }
        break;
      }
      case "message-pinned": {
        const m = this.getMessageById(Number(d?.id));
        if (m) m.pinned = d?.pinned === true;
        break;
      }
      case "message-deleted": {
        const id = Number(d?.id);
        this.messages = this.messages.filter((m) => m.id !== id);
        break;
      }
      case "message-edited": {
        const m = this.getMessageById(Number(d?.messageId));
        if (m && typeof d?.newText === "string") m.text = d.newText;
        break;
      }
      default:
        break;
    }
    this.emitMirrored(ev.type, ev.data);
  }

  /** The remote room's members, as the home server reports them. */
  override who(): Agent[] {
    return [...this.roster.values()];
  }

  override whoNames(): string[] {
    return [...this.roster.keys()];
  }

  /** Room messages merged with this server's local lines, for the web viewer. */
  readForView(limit: number, viewer: string | undefined): ChatMessage[] {
    const merged = [...this.read(undefined, limit, undefined, viewer), ...this.localLines];
    merged.sort((a, b) => a.timestamp - b.timestamp);
    return merged.slice(-limit);
  }

  meta(): { id: string; name: string; createdAt: number; messageCount: number; starred: boolean } {
    return { id: this.id, name: this.name, createdAt: this.createdAt, messageCount: Math.max(this.homeMessageCount, this.messages.length), starred: false };
  }

  // ---------------------------------------------------------------------
  // Local members (shadow registrations) and the human viewer
  // ---------------------------------------------------------------------

  /** Record the home registration of a local member (after /api/peer/register). */
  setShadow(name: string, info: ShadowInfo): void {
    this.shadows.set(name, { ...info });
  }

  homeRegistrationOf(name: string): string | undefined {
    return this.shadows.get(name)?.homeRegistration;
  }

  setHuman(name: string, registration: string): void {
    this.human = { name, registration };
  }

  humanName(): string | undefined {
    return this.human?.name;
  }

  /** The names whose view of the room this server mirrors (DM visibility). */
  viewerNames(): string[] {
    const names = [...this.agents.keys()];
    if (this.human && !names.includes(this.human.name)) names.push(this.human.name);
    return names.sort();
  }

  hasLocalMembers(): boolean {
    return this.agents.size > 0;
  }

  /** Local members with what re-registering them needs. */
  shadowsForRegister(): Array<{ name: string; registration: string; role?: string; terminalSummary?: string }> {
    const out: Array<{ name: string; registration: string; role?: string; terminalSummary?: string }> = [];
    for (const name of this.agents.keys()) {
      const reg = this.registrationOf(name);
      const info = this.shadows.get(name);
      if (reg) out.push({ name, registration: reg, role: info?.role, terminalSummary: info?.terminalSummary });
    }
    return out;
  }

  /** Register (again) every local member and the human with the home
   *  server: idempotent there, and needed after the home restarted. */
  async reregisterAll(): Promise<void> {
    for (const s of this.shadowsForRegister()) {
      try {
        const r = await this.transport.register({ room: this.homeRoomId, name: s.name, host: this.selfName, registration: s.registration, terminalSummary: s.terminalSummary, role: s.role });
        this.shadows.set(s.name, { homeRegistration: r.registration, role: s.role, terminalSummary: s.terminalSummary });
      } catch (err) {
        if (err instanceof LinkDownError) return;
        console.log(`  [link ${this.server}] re-register ${s.name} in ${this.id} refused: ${(err as Error).message}`);
      }
    }
    if (this.human) {
      try {
        const r = await this.transport.register({ room: this.homeRoomId, name: this.human.name, host: this.selfName, registration: `human:${this.selfName}`, human: true });
        this.human = { name: this.human.name, registration: r.registration };
      } catch { /* retried at the next restore */ }
    }
  }

  override leave(name: string, reason: "deliberate" | "timeout" = "deliberate"): void {
    const had = this.agents.has(name);
    const reg = this.shadows.get(name)?.homeRegistration;
    super.leave(name, reason);
    this.shadows.delete(name);
    this.lastTouchSent.delete(name);
    if (had && reg) {
      this.transport.leave({ room: this.homeRoomId, name, registration: reg }).catch((err: unknown) => {
        console.log(`  [link ${this.server}] leave of ${name} not delivered: ${(err as Error).message}`);
      });
    }
  }

  private registrationFor(sender: string): string | undefined {
    if (this.agents.has(sender)) return this.shadows.get(sender)?.homeRegistration;
    if (this.human?.name === sender) return this.human.registration;
    return undefined;
  }

  private forward(name: string, action: PeerAction): boolean {
    const registration = this.registrationFor(name);
    if (!registration || !this.transport.isUp()) return false;
    this.transport.act({ room: this.homeRoomId, name, registration, ...action }).catch((err: unknown) => {
      if (err instanceof LinkDownError) this.transport.failed(err.message);
    });
    return true;
  }

  override touch(name: string): void {
    super.touch(name);
    if (!this.agents.has(name)) return;
    const now = Date.now();
    if (now - (this.lastTouchSent.get(name) ?? 0) < TOUCH_FORWARD_MS) return;
    if (this.forward(name, { action: "touch" })) this.lastTouchSent.set(name, now);
  }

  override setTyping(name: string, isTyping: boolean): void {
    super.setTyping(name, isTyping);
    if (this.agents.has(name)) this.forward(name, { action: "typing", typing: isTyping });
  }

  override setStatus(name: string, status: string): Agent | null {
    const agent = super.setStatus(name, status);
    if (agent) this.forward(name, { action: "status", status });
    return agent;
  }

  /** Resolution happens on the home server; the mirrored event updates this
   *  copy. The message is returned as it stands now. */
  override resolveAsk(messageId: number, by: string): ChatMessage | null {
    const msg = this.getMessageById(messageId);
    if (!msg?.ask || msg.ask.state !== "open" || !visibleToViewer(msg, by)) return null;
    return this.forward(by, { action: "resolve", messageId }) ? msg : null;
  }

  override chooseMessage(messageId: number, value: string, by: string): ChatMessage | null {
    const msg = this.getMessageById(messageId);
    if (!msg?.choices?.includes(value) || !visibleToViewer(msg, by)) return null;
    return this.forward(by, { action: "choose", messageId, value }) ? msg : null;
  }

  /** Tag and pin act as the member who asks; the mirrored event follows. */
  tagAs(by: string, messageId: number, tag: string): ChatMessage | null {
    const msg = this.getMessageById(messageId);
    if (!msg || !visibleToViewer(msg, by)) return null;
    return this.forward(by, { action: "tag", messageId, tag }) ? msg : null;
  }

  pinAs(by: string, messageId: number, pinned: boolean): ChatMessage | null {
    const msg = this.getMessageById(messageId);
    if (!msg || !visibleToViewer(msg, by)) return null;
    return this.forward(by, { action: "pin", messageId, pinned }) ? msg : null;
  }

  /** Remote administration is out of scope: these act on the home room only. */
  override tagMessage(): ChatMessage | null { return null; }
  override pinMessage(): ChatMessage | null { return null; }
  override deleteMessage(): boolean { return false; }
  override rename(): Agent | null { return null; }
  override setRole(): Agent | null { return null; }

  /** A synchronous send cannot carry a remote write; callers use writeThrough. */
  override send(): ChatMessage {
    throw new Error(`${this.id} is a remote room: its messages are written through to ${this.server} (writeThrough)`);
  }

  // ---------------------------------------------------------------------
  // Writes and the undelivered queue
  // ---------------------------------------------------------------------

  /**
   * Send a message home as `sender` (a local member of this room, or the
   * human viewer registered here). Sent at once when the link is up and
   * nothing older is queued; otherwise queued, shown as pending, and sent in
   * order when the link returns. Throws PeerRefusedError when the home
   * server refuses the message itself (for instance, the sender is not a
   * member there).
   */
  async writeThrough(sender: string, text: string, opts: PeerWriteOptions = {}): Promise<WriteResult> {
    if (!this.registrationFor(sender)) {
      throw new PeerRefusedError(403, `${sender} is not registered in ${this.id}; join it first`, "not-registered");
    }
    const entry: QueuedMessage = {
      clientId: randomUUID(), sender, text, queuedAt: Date.now(), attempts: 0,
      ...(opts.replyTo != null ? { replyTo: opts.replyTo } : {}),
      ...(opts.to && opts.to.length > 0 ? { to: opts.to } : {}),
      ...(opts.askFor ? { askFor: opts.askFor } : {}),
      ...(opts.choices && opts.choices.length > 0 ? { choices: opts.choices } : {}),
    };
    if (!this.transport.isUp() || this.queue.size() > 0 || this.draining) {
      this.enqueue(entry);
      if (this.transport.isUp()) void this.drain();
      return { status: "queued", clientId: entry.clientId, reason: this.transport.isUp() ? "older messages are still being sent" : `the link to ${this.server} is down` };
    }
    try {
      const message = await this.dispatch(entry);
      return { status: "sent", message };
    } catch (err) {
      if (err instanceof LinkDownError) {
        this.transport.failed(err.message);
        this.enqueue(entry);
        return { status: "queued", clientId: entry.clientId, reason: `the link to ${this.server} is down` };
      }
      throw err;
    }
  }

  private enqueue(entry: QueuedMessage): void {
    this.queue.add(entry);
    this.notice({
      type: "pending",
      conversationId: this.id,
      data: { conversationId: this.id, clientId: entry.clientId, sender: entry.sender, text: entry.text, queuedAt: entry.queuedAt, ...(entry.to ? { to: entry.to } : {}) },
    });
  }

  /** Send one entry home; its registration is resolved now, not when queued
   *  (the member may have re-registered). A home that forgot the member (it
   *  restarted) gets one re-registration and one retry. */
  private async dispatch(entry: QueuedMessage): Promise<ChatMessage> {
    const body = (): PeerSendBody => ({
      room: this.homeRoomId, sender: entry.sender, text: entry.text, clientId: entry.clientId,
      registration: this.registrationFor(entry.sender),
      ...(entry.replyTo != null ? { replyTo: entry.replyTo } : {}),
      ...(entry.to ? { to: entry.to } : {}),
      ...(entry.askFor ? { askFor: entry.askFor } : {}),
      ...(entry.choices ? { choices: entry.choices } : {}),
    });
    let message: ChatMessage;
    try {
      message = await this.transport.send(body());
    } catch (err) {
      if (!(err instanceof PeerRefusedError) || err.code !== "not-registered") throw err;
      await this.reregisterAll();
      message = await this.transport.send(body());
    }
    if (this.insertMessage(message)) this.emitMirrored("message", message);
    return message;
  }

  queuedCount(): number {
    return this.queue.size();
  }

  /** Undelivered messages the viewer may see (DMs only to their parties). */
  pendingFor(viewer: string | undefined): PendingPayload[] {
    return this.queue.list()
      .filter((e) => visibleToViewer({ id: 0, sender: e.sender, text: e.text, timestamp: e.queuedAt, ...(e.to ? { to: e.to } : {}) }, viewer))
      .map((e) => ({ conversationId: this.id, clientId: e.clientId, sender: e.sender, text: e.text, queuedAt: e.queuedAt, ...(e.to ? { to: e.to } : {}) }));
  }

  /** Send the queue home in order while the link is up. Resolves with the
   *  number sent. A message the home refuses is dropped from the queue with
   *  a local line; a link failure stops the drain and keeps the rest. */
  drain(): Promise<number> {
    if (this.draining) return this.draining;
    const run = async (): Promise<number> => {
      let sent = 0;
      while (this.transport.isUp() && !this.destroyed) {
        const e = this.queue.first();
        if (!e) break;
        this.dispatching = e.clientId;
        try {
          const message = await this.dispatch(e);
          this.queue.remove(e.clientId);
          this.notice({ type: "pending-dispatched", conversationId: this.id, data: { conversationId: this.id, clientId: e.clientId, id: message.id } });
          sent++;
        } catch (err) {
          if (err instanceof LinkDownError) {
            this.queue.bump(e.clientId);
            this.transport.failed(err.message);
            break;
          }
          this.queue.remove(e.clientId);
          this.notice({ type: "pending-deleted", conversationId: this.id, data: { conversationId: this.id, clientId: e.clientId } });
          this.addLocalLine(`A queued message from ${e.sender} was not delivered: ${(err as Error).message}`);
        } finally {
          this.dispatching = null;
        }
      }
      return sent;
    };
    const p = run().finally(() => { this.draining = null; });
    this.draining = p;
    return p;
  }

  /** Delete an undelivered message; only its author may, and only before it goes. */
  deleteUndelivered(clientId: string, by: string): DeleteResult {
    const e = this.queue.get(clientId);
    if (!e) return { ok: false, status: 404, error: "No such undelivered message (already sent, or deleted)" };
    if (e.sender !== by) return { ok: false, status: 403, error: "Only its author may delete an undelivered message" };
    if (this.dispatching === clientId) return { ok: false, status: 409, error: "That message is being sent right now" };
    this.queue.remove(clientId);
    this.notice({ type: "pending-deleted", conversationId: this.id, data: { conversationId: this.id, clientId } });
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Wakes asked by the home server
  // ---------------------------------------------------------------------

  /** Wake a local member for a mention decided on the home server. The
   *  prompt names the home room and this server's base URL (the member reads
   *  and replies through this mirror). */
  wakeFromHome(sender: string, name: string, hostedRegistration: string): Promise<HostedWakeResult> {
    const label = `"${this.name}" on ${this.server} (conversation ${this.id})`;
    return this.wakeForPeer(sender, name, hostedRegistration, label);
  }
}

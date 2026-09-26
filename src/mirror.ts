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
import { HumanState, HumanStateError, type HumanStateData } from "./human-state.js";
import { MemberState, type MemberRecord } from "./member-state.js";
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
  /** "waiting": its author has no live registration here (both servers
   *  restarted, say); it goes when the author rejoins. "held": the home
   *  refused it; it stays, shown as pending, until its author deletes it.
   *  Only the author's delete or a successful send removes an entry. */
  state?: "waiting" | "held";
  heldReason?: string;
  /** Written by this server's web viewer before it was registered with the
   *  home: the viewer is registered as this server's human when the link
   *  allows, and the entry goes then (gate round 2, finding 8). */
  asHuman?: boolean;
}

/** The pending payload the web UI receives. */
export interface PendingPayload {
  conversationId: string;
  clientId: string;
  sender: string;
  text: string;
  queuedAt: number;
  to?: string[];
  /** "queued": goes when the link allows; "waiting": its author must be
   *  registered with the home first; "held": the home refused it (`reason`),
   *  it stays until its author deletes it (gate round 2, finding 7). */
  state: "queued" | "waiting" | "held";
  reason?: string;
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

  mark(clientId: string, state: "waiting" | "held" | undefined, heldReason?: string): void {
    const e = this.entries.find((x) => x.clientId === clientId);
    if (!e) return;
    if (state) e.state = state; else delete e.state;
    if (heldReason) e.heldReason = heldReason; else delete e.heldReason;
    this.save();
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
/** The lock key of this server's human (a name cannot contain NUL). */
export const HUMAN_LOCK = "\u0000human";
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
  private queue: UndeliveredQueue;
  private localLines: ChatMessage[] = [];
  private localSeq = 0;
  private mirroring = false;
  private dispatching: string | null = null;
  private draining: Promise<number> | null = null;
  private lastTouchSent = new Map<string, number>();
  private nameLocks = new Map<string, Promise<void>>();
  /** This server's human in this room: the write-ahead record (gate round 4). */
  private readonly humanState: HumanState;
  /** Home registrations of members that left here, still to release there
   *  (a registration whose reply arrived after its member left; gate round
   *  7, finding 1). Kept until the home confirms (success or 404), and
   *  saved beside the queue. */
  /** The members' write-ahead record (gate round 10): per name, the live
   *  id, an unconfirmed id, and ids owed a release, all this server's ids. */
  private readonly memberState: MemberState;
  /** Another drain pass is owed (an entry was unblocked mid-drain; gate
   *  round 3, finding 3). */
  private rerunDrain = false;
  /** Order of insertion of each cached message: a snapshot requested at a
   *  mark never removes what was inserted after it (finding 4). */
  private insertSeq = 0;
  private insertedAt = new Map<number, number>();

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
    this.humanState = new HumanState(opts.queueFile ? opts.queueFile.replace(/\.queue\.jsonl$/, "") + ".human.json" : null);
    const base = opts.queueFile ? opts.queueFile.replace(/\.queue\.jsonl$/, "") : null;
    this.memberState = new MemberState(base ? `${base}.members.json` : null, base ? `${base}.releases.json` : null);
    // After a restart the reasons of held entries are said again. The viewer
    // is never inferred from the queue: the human record alone says who it
    // is (gate round 4, finding 2).
    for (const e of this.queue.list()) {
      if (e.state === "held") this.addLocalLine(this.refusalLine(e.sender, e.heldReason ?? "refused"));
    }
  }

  /** The human record as it stands (for tests and diagnostics). */
  humanRecord(): HumanStateData {
    return this.humanState.snapshot();
  }

  /** Former human registrations still to release at the home. */
  pendingHumanReleases(): Array<{ name: string; registration: string }> {
    return this.humanState.releasesOwed;
  }

  /**
   * Record the viewer's latest explicit choice without contacting the home
   * (a choice of the current registration cancels a pending change). Throws
   * HumanStateError when the record cannot be written.
   */
  chooseHuman(want: string): void {
    if (this.humanState.wanted === want) return;
    this.humanState.update((d) => { d.wanted = want; });
  }

  /**
   * Bring the home in line with the human record, under the human's lock.
   * Each step is written before it is made and after it is confirmed:
   *   1. `want`, when given, is recorded first (the latest choice);
   *   2. owed releases are made; a debt is cleared only when the release
   *      succeeds or the home says the registration is absent (404);
   *   3. an unconfirmed registration that is not the target (a reply was
   *      lost, then the viewer changed its mind) is registered again, which
   *      is idempotent there, to learn its id, and released;
   *   4. the target (the choice, else the current viewer, again after a
   *      home restart) is registered: recorded as unconfirmed first, then as
   *      current, the former viewer's release recorded as owed;
   *   5. owed releases again, then the viewer's waiting messages resume.
   * Offline, only step 1 happens. A link failure stops at the step it hit;
   * everything owed stays recorded. A record that cannot be written throws
   * HumanStateError before the next remote call.
   */
  async settleHuman(want?: string): Promise<void> {
    const release = await this.lockName(HUMAN_LOCK);
    try {
      if (want) this.chooseHuman(want);
      if (!this.transport.isUp()) return;
      if (!(await this.releaseOwed())) return;
      const target = this.humanState.target();
      const stray = this.humanState.unconfirmed;
      if (stray && stray !== target) {
        let r: string | null = null;
        try {
          r = await this.registerHuman(stray);
        } catch (err) {
          // The home says it does not hold the stray for us (gate round 5):
          // nothing to release; clear it and go on to the chosen viewer.
          if (!this.homeDoesNotHold(err)) throw err;
        }
        const learned = r;
        this.humanState.update((d) => {
          if (learned) d.releasesOwed.push({ name: stray, registration: learned });
          d.unconfirmed = null;
        });
        if (!(await this.releaseOwed())) return;
      }
      if (!target) return;
      const previous = this.humanState.current;
      if (previous?.name !== target) this.humanState.update((d) => { d.unconfirmed = target; });
      let registration: string;
      try {
        registration = await this.registerHuman(target);
      } catch (err) {
        // Refused for good (the name is someone else's there): the home holds
        // nothing for us under it. The choice stays; a later choice or
        // recovery tries again. Link errors keep it unconfirmed.
        if (this.homeDoesNotHold(err)) this.humanState.update((d) => { if (d.unconfirmed === target) d.unconfirmed = null; });
        throw err;
      }
      this.humanState.update((d) => {
        d.current = { name: target, registration };
        d.unconfirmed = null;
        if (d.wanted === target) d.wanted = null;
        if (previous && previous.name !== target) d.releasesOwed.push(previous);
      });
      await this.releaseOwed();
      this.resumeAuthor(target);
    } catch (err) {
      if (err instanceof HumanStateError) throw err;
      if (err instanceof LinkDownError) this.transport.failed(err.message);
      else console.log(`  [link ${this.server}] human registration in ${this.id} refused: ${(err as Error).message}`);
    } finally {
      release();
    }
  }

  /** A definitive answer that the home holds no registration of ours for
   *  the name: 404, or 409 whose candidates are not this server's. */
  private homeDoesNotHold(err: unknown): boolean {
    if (!(err instanceof PeerRefusedError)) return false;
    if (err.status === 404) return true;
    if (err.status !== 409) return false;
    // Definitive only when the home names the owners: a nonempty array of
    // candidates, each with a host string, none of them this server. Any
    // other shape (missing, empty, null, not an array, an entry without a
    // host) proves nothing: the stray is kept and retried later, as after a
    // link error (gate round 6).
    const candidates: unknown = (err.body as { candidates?: unknown } | null | undefined)?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return false;
    const hosts = candidates.map((c: unknown) => (c && typeof c === "object" ? (c as { host?: unknown }).host : undefined));
    if (!hosts.every((h): h is string => typeof h === "string" && h.length > 0)) return false;
    return !hosts.includes(this.selfName);
  }

  private async registerHuman(name: string): Promise<string> {
    const r = await this.transport.register({ room: this.homeRoomId, name, host: this.selfName, registration: `human:${this.selfName}`, human: true });
    return r.registration;
  }

  /** Make every owed release; false when one could not be made now. */
  private async releaseOwed(): Promise<boolean> {
    for (;;) {
      const r = this.humanState.releasesOwed[0];
      if (!r) return true;
      try {
        await this.transport.leave({ room: this.homeRoomId, name: r.name, registration: r.registration });
      } catch (err) {
        if (err instanceof LinkDownError) { this.transport.failed(err.message); return false; }
        // Only a confirmed absence settles the debt (gate round 4, finding 6).
        if (!(err instanceof PeerRefusedError && err.status === 404)) {
          console.log(`  [link ${this.server}] release of ${r.name} in ${this.id} refused (${(err as Error).message}); kept for the next recovery`);
          return false;
        }
      }
      this.humanState.update((d) => { d.releasesOwed = d.releasesOwed.filter((x) => !(x.name === r.name && x.registration === r.registration)); });
    }
  }

  private refusalLine(sender: string, reason: string): string {
    return `A queued message from ${sender} was refused by ${this.server}: ${reason}. It stays queued until its author deletes it.`;
  }

  /**
   * Serialize registration transitions of one name (a join's register then
   * commit or abandon, recovery re-registration, a change of the human):
   * a transition that awaited the home can never overwrite a newer one
   * (gate round 2, finding 2). Resolves with the release; a holder that
   * never releases is released after 30 s.
   */
  async lockName(name: string): Promise<() => void> {
    const prev = this.nameLocks.get(name) ?? Promise.resolve();
    let open!: () => void;
    const mine = new Promise<void>((r) => { open = r; });
    const chain = prev.then(() => mine);
    this.nameLocks.set(name, chain);
    await prev;
    let done = false;
    const release = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      open();
      if (this.nameLocks.get(name) === chain) this.nameLocks.delete(name);
    };
    const timer = setTimeout(release, 30_000);
    timer.unref?.();
    return release;
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

  /**
   * Reconcile the mirror with a home snapshot (initial fill or refill). The
   * snapshot is authoritative over its range: from its oldest message on, or
   * over everything when it is `complete`. A cached message in that range
   * that the snapshot lacks is gone on the home (deleted, or no longer
   * visible here), and is dropped (gate round 1, finding 6).
   *
   * `announce` (a refill after an outage or a reset): what changed is
   * emitted as room events, deletions and then new messages in id order, so
   * open browsers and the bell see what arrived while the link was down
   * (finding 5). A first fill announces nothing: it is history, not news.
   */
  fill(snap: PeerMessagesResult, announce = false, mark = Infinity): void {
    const incoming = snap.messages.filter((m) => typeof m.id === "number").sort((a, b) => a.id - b.id);
    const snapIds = new Set(incoming.map((m) => m.id));
    const floor = snap.complete === true ? -Infinity : incoming.length > 0 ? incoming[0].id : Infinity;
    // Only what was here before the snapshot was requested (`mark`) can be
    // judged gone by it: a message a send inserted meanwhile is newer than
    // the snapshot (gate round 2, finding 4).
    const isGone = (m: ChatMessage): boolean => m.id >= floor && !snapIds.has(m.id) && (this.insertedAt.get(m.id) ?? 0) <= mark;
    const gone = this.messages.filter(isGone);
    const had = new Set(this.messages.map((m) => m.id));
    const byId = new Map<number, ChatMessage>();
    for (const m of this.messages) if (!isGone(m)) byId.set(m.id, m);
    for (const m of gone) this.insertedAt.delete(m.id);
    for (const m of incoming) {
      byId.set(m.id, m);
      if (!this.insertedAt.has(m.id)) this.insertedAt.set(m.id, ++this.insertSeq);
    }
    this.messages = [...byId.values()].sort((a, b) => a.id - b.id);
    const before = this.roster;
    this.roster = new Map(snap.members.map((a) => [a.name, a]));
    if (snap.name) this.name = snap.name;
    this.homeMessageCount = Math.max(this.homeMessageCount, this.messages.length);
    if (!announce) return;
    for (const m of gone) this.emitMirrored("message-deleted", { id: m.id });
    // The roster too: the subscription resumes from the snapshot's cursor, so
    // membership events from the outage never arrive. A browser holding the
    // old roster would keep a member who left, or a host it no longer has
    // (gate round 11, finding 1). A leave for each name gone, a join for each
    // name new or changed; an unchanged member is left alone.
    for (const [name, a] of before) if (!this.roster.has(name)) this.emitMirrored("leave", a);
    for (const [name, a] of this.roster) {
      const prev = before.get(name);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(a)) this.emitMirrored("join", a);
    }
    for (const m of incoming) if (!had.has(m.id)) this.emitMirrored("message", m);
  }

  /** Insert a home message by id; false when it is already here. */
  /** The insertion mark a snapshot request is judged against (finding 4). */
  snapshotMark(): number {
    return this.insertSeq;
  }

  private insertMessage(m: ChatMessage): boolean {
    if (typeof m.id !== "number" || this.messages.some((x) => x.id === m.id)) return false;
    this.insertedAt.set(m.id, ++this.insertSeq);
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
    this.humanState.update((d) => {
      d.current = { name, registration };
      if (d.wanted === name) d.wanted = null;
      if (d.unconfirmed === name) d.unconfirmed = null;
    });
    // Its waiting messages go now, as for a member's commit (finding 6).
    this.resumeAuthor(name);
  }

  humanRegistration(): { name: string; registration: string } | undefined {
    return this.humanState.current ?? undefined;
  }

  /** The viewer name to register as this server's human: the current one,
   *  or one that queued before it was registered (finding 8). */
  humanToRegister(): string | undefined {
    return this.humanState.target() ?? undefined;
  }

  /** Whether the human's record owes the home anything (a release, a change). */
  humanOwes(): boolean {
    return this.humanState.owes();
  }

  humanName(): string | undefined {
    return this.humanState.current?.name;
  }

  /** The names whose view of the room this server mirrors (DM visibility). */
  viewerNames(): string[] {
    const names = [...this.agents.keys()];
    const human = this.humanState.current;
    if (human && !names.includes(human.name)) names.push(human.name);
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
  // ---------------------------------------------------------------------
  // Members' registrations at the home: one write-ahead record per name
  // (member-state.ts). Every id is this server's; the home releases by it.
  // ---------------------------------------------------------------------

  /** The record of one member (for tests and diagnostics). */
  memberRecord(name: string): MemberRecord {
    return this.memberState.get(name);
  }

  /** Whether any member id is recorded here (live, unconfirmed or owed):
   *  recovery then runs for this room even with no member here. */
  hasMemberRecords(): boolean {
    return !this.memberState.isEmpty();
  }

  /** Ids owed a release at the home, for every name. */
  pendingMemberReleases(): Array<{ name: string; registration: string }> {
    return this.memberState.owed();
  }

  /** A registration of `id` is about to be sent (under the name's lock).
   *  A previous unconfirmed id that is not the live one becomes owed.
   *  Throws MemberStateError when it cannot be written; nothing is sent. */
  beginMemberRegistration(name: string, id: string): void {
    this.memberState.update(name, (r) => {
      if (r.unconfirmed && r.unconfirmed !== id && r.unconfirmed !== r.live) r.releasesOwed.push(r.unconfirmed);
      r.unconfirmed = id;
    });
  }

  /** The home refused `id` for good: it holds nothing under it. */
  refusedMemberRegistration(name: string, id: string): void {
    try {
      this.memberState.update(name, (r) => { if (r.unconfirmed === id) r.unconfirmed = null; });
    } catch (err) {
      console.log(`  [link ${this.server}] ${(err as Error).message}`);
    }
  }

  /**
   * The home answered a registration of `id` with `homeRegistration`. It
   * becomes the live registration only if the member here is still the one
   * with that id (checked now, after the await); otherwise it is owed a
   * release. Returns whether it was kept. A record that cannot be written
   * is logged: the id stays unconfirmed there, and recovery releases it.
   */
  confirmMemberRegistration(name: string, id: string, homeRegistration: string, info?: { role?: string; terminalSummary?: string }): boolean {
    const here = this.agents.has(name) && this.registrationOf(name) === id;
    try {
      this.memberState.update(name, (r) => {
        if (here) {
          if (r.live && r.live !== id) r.releasesOwed.push(r.live);
          r.live = id;
        } else if (r.live !== id) {
          r.releasesOwed.push(id);
        }
        if (r.unconfirmed === id) r.unconfirmed = null;
      });
    } catch (err) {
      console.log(`  [link ${this.server}] ${(err as Error).message}`);
    }
    if (here) {
      const prev = this.shadows.get(name);
      this.shadows.set(name, { homeRegistration, role: info?.role ?? prev?.role, terminalSummary: info?.terminalSummary ?? prev?.terminalSummary });
    }
    return here;
  }

  /** A join that registered `id` was superseded here: whatever the home
   *  holds under `id` is owed a release. */
  abandonMemberRegistration(name: string, id: string): void {
    try {
      this.memberState.update(name, (r) => {
        if (r.unconfirmed === id) r.unconfirmed = null;
        if (r.live !== id) r.releasesOwed.push(id);
      });
    } catch (err) {
      console.log(`  [link ${this.server}] ${(err as Error).message}`);
    }
  }

  /**
   * Release every id of `name` the home may hold that is not the live one:
   * the owed ones, and an unconfirmed one (callers hold the name's lock, so
   * no attempt is in flight). A release is settled by success or 404 (the
   * home holds nothing under it); a link error stops and keeps the rest;
   * any other refusal keeps that id. False when the link failed. The
   * caller holds the name's lock.
   */
  async releaseMemberIds(name: string): Promise<boolean> {
    const first = this.memberState.get(name);
    if (first.unconfirmed && first.unconfirmed !== first.live) {
      const stray = first.unconfirmed;
      try {
        this.memberState.update(name, (r) => { if (r.unconfirmed === stray) { r.unconfirmed = null; r.releasesOwed.push(stray); } });
      } catch (err) {
        console.log(`  [link ${this.server}] ${(err as Error).message}`);
      }
    }
    for (const id of this.memberState.get(name).releasesOwed) {
      try {
        await this.transport.leave({ room: this.homeRoomId, name, hostedRegistration: id });
      } catch (err) {
        if (err instanceof LinkDownError) { this.transport.failed(err.message); return false; }
        if (!(err instanceof PeerRefusedError && err.status === 404)) {
          console.log(`  [link ${this.server}] release of ${name} (${id}) in ${this.id} refused (${(err as Error).message}); kept`);
          continue;
        }
      }
      try {
        this.memberState.update(name, (r) => { r.releasesOwed = r.releasesOwed.filter((x) => x !== id); });
      } catch (err) {
        console.log(`  [link ${this.server}] ${(err as Error).message}`);
      }
    }
    return true;
  }

  /** Round-9 records carried the home's ids: released by those until settled. */
  private async releaseLegacy(): Promise<boolean> {
    for (const r of this.memberState.legacyReleases()) {
      try {
        await this.transport.leave({ room: this.homeRoomId, name: r.name, registration: r.registration });
      } catch (err) {
        if (err instanceof LinkDownError) { this.transport.failed(err.message); return false; }
        if (!(err instanceof PeerRefusedError && err.status === 404)) continue;
      }
      try { this.memberState.removeLegacy(r); } catch (err) { console.log(`  [link ${this.server}] ${(err as Error).message}`); }
    }
    return true;
  }

  /**
   * Recovery. Per name with a member here or a record, under the name's
   * lock: (a) a member here: the home must hold exactly its id (recorded as
   * live first, then registered; the reply is applied only if the member is
   * still that one); a live id on record with no member here (a restart)
   * is owed instead. (b) Every other id, unconfirmed or owed, is released
   * by id. Nothing is registered to learn anything. Then the human.
   */
  async reregisterAll(): Promise<void> {
    if (!(await this.releaseLegacy())) return;
    const names = new Set([...this.agents.keys(), ...this.memberState.names()]);
    for (const name of names) {
      const release = await this.lockName(name);
      try {
        if (this.agents.has(name) && this.registrationOf(name)) {
          const id = this.registrationOf(name)!;
          if (this.memberState.get(name).live !== id) {
            this.memberState.update(name, (r) => {
              if (r.live && r.live !== id) r.releasesOwed.push(r.live);
              r.live = id;
              if (r.unconfirmed === id) r.unconfirmed = null;
            });
          }
          const info = this.shadows.get(name);
          const r = await this.transport.register({ room: this.homeRoomId, name, host: this.selfName, registration: id, terminalSummary: info?.terminalSummary, role: info?.role });
          this.confirmMemberRegistration(name, id, r.registration);
        } else if (this.memberState.get(name).live) {
          this.memberState.update(name, (r) => { if (r.live) r.releasesOwed.push(r.live); r.live = null; });
        }
        if (!(await this.releaseMemberIds(name))) return;
      } catch (err) {
        if (err instanceof LinkDownError) { this.transport.failed(err.message); return; }
        console.log(`  [link ${this.server}] recovery of ${name} in ${this.id}: ${(err as Error).message}`);
      } finally {
        release();
      }
    }
    if (this.humanToRegister() || this.humanOwes()) {
      await this.settleHuman().catch((err: unknown) => console.log(`  [link ${this.server}] ${(err as Error).message}`));
    }
  }

  /**
   * A local member leaves the remote room. Its id is written to the record
   * as owed FIRST (write-ahead); only then is the member removed here. A
   * record that cannot be written stops a deliberate departure with an error
   * (the member stays); a timed-out one keeps the member and logs it. The
   * release itself waits for the name's lock, so a registration in flight
   * finishes first, and a reply that lands after this converts to debt.
   */
  override leave(name: string, reason: "deliberate" | "timeout" = "deliberate"): void {
    const had = this.agents.has(name);
    const id = had ? this.registrationOf(name) : undefined;
    if (id) {
      try {
        this.memberState.update(name, (r) => {
          if (r.live === id) r.live = null;
          r.releasesOwed.push(id);
        });
      } catch (err) {
        if (reason === "timeout") {
          console.log(`  [link ${this.server}] ${name} not dropped from ${this.id}: ${(err as Error).message}`);
          return;
        }
        throw err;
      }
    }
    super.leave(name, reason);
    this.lastTouchSent.delete(name);
    if (!had) return;
    void (async () => {
      const release = await this.lockName(name);
      try {
        if (!this.agents.has(name)) this.shadows.delete(name);
        await this.releaseMemberIds(name);
      } finally {
        release();
      }
    })();
  }

  private registrationFor(sender: string): string | undefined {
    if (this.agents.has(sender)) return this.shadows.get(sender)?.homeRegistration;
    const human = this.humanState.current;
    if (human?.name === sender) return human.registration;
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
  async writeThrough(sender: string, text: string, opts: PeerWriteOptions = {}, how: { asHuman?: boolean } = {}): Promise<WriteResult> {
    const unregisteredViewer = !this.registrationFor(sender) && how.asHuman === true;
    if (!this.registrationFor(sender) && !unregisteredViewer) {
      throw new PeerRefusedError(403, `${sender} is not registered in ${this.id}; join it first`, "not-registered");
    }
    const entry: QueuedMessage = {
      clientId: randomUUID(), sender, text, queuedAt: Date.now(), attempts: 0,
      ...(opts.replyTo != null ? { replyTo: opts.replyTo } : {}),
      ...(opts.to && opts.to.length > 0 ? { to: opts.to } : {}),
      ...(opts.askFor ? { askFor: opts.askFor } : {}),
      ...(opts.choices && opts.choices.length > 0 ? { choices: opts.choices } : {}),
    };
    if (unregisteredViewer) {
      // This server's own web viewer (authenticated here) writes before the
      // home knows it: queued, waiting for its registration as this
      // server's human, which the next restore (or open) makes.
      // The choice is recorded first; if it cannot be, nothing is queued.
      this.chooseHuman(sender);
      this.enqueue({ ...entry, state: "waiting", asHuman: true });
      return { status: "queued", clientId: entry.clientId, reason: `${sender} is not registered with ${this.server} yet; it goes once the link allows` };
    }
    // Order is kept per author: queue behind this author's own older entries.
    if (!this.transport.isUp() || this.queue.list().some((e) => e.sender === sender)) {
      this.enqueue(entry);
      if (this.transport.isUp()) this.requestDrain();
      return { status: "queued", clientId: entry.clientId, reason: this.transport.isUp() ? "your older messages here are still queued" : `the link to ${this.server} is down` };
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
    this.noticePending(entry.clientId);
  }

  private payloadOf(e: QueuedMessage): PendingPayload {
    return {
      conversationId: this.id, clientId: e.clientId, sender: e.sender, text: e.text, queuedAt: e.queuedAt,
      ...(e.to ? { to: e.to } : {}),
      state: e.state ?? "queued",
      ...(e.state === "held" && e.heldReason ? { reason: e.heldReason } : {}),
      ...(e.state === "waiting" ? { reason: `waiting for ${e.sender} to be registered with ${this.server}` } : {}),
    };
  }

  /** The pending event for an entry, again whenever its state changes. */
  private noticePending(clientId: string): void {
    const e = this.queue.get(clientId);
    if (e) this.notice({ type: "pending", conversationId: this.id, data: this.payloadOf(e) });
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
      .map((e) => this.payloadOf(e));
  }

  /** The author rejoined: its waiting messages may go now. */
  resumeAuthor(name: string): void {
    let any = false;
    for (const e of this.queue.list()) {
      if (e.sender === name && e.state === "waiting") { this.queue.mark(e.clientId, undefined); this.noticePending(e.clientId); any = true; }
    }
    if (any && this.transport.isUp()) this.requestDrain();
  }

  /**
   * Send the queue home while the link is up, in order per author. Resolves
   * with the number sent. Nothing is ever dropped here (gate round 1,
   * finding 7): an entry whose author has no live registration waits for the
   * author to rejoin, one the home refuses is held with a local line, and in
   * both cases that author's later entries wait behind it. A link failure
   * stops the drain and keeps everything.
   */
  /** A drain now, or one more pass of the drain in progress: that pass may
   *  already have passed the entry this request unblocked (gate round 3,
   *  finding 3). */
  private requestDrain(): void {
    if (this.draining) this.rerunDrain = true;
    else void this.drain();
  }

  drain(): Promise<number> {
    if (this.draining) return this.draining;
    const run = async (): Promise<number> => {
      let sent = 0;
      let progress = true;
      // Entries added or unblocked while draining are picked up by another pass.
      while ((progress || this.rerunDrain) && this.transport.isUp() && !this.destroyed) {
        progress = false;
        this.rerunDrain = false;
        const blocked = new Set<string>();
        for (const e of this.queue.list()) {
          if (!this.transport.isUp() || this.destroyed) break;
          if (!this.queue.get(e.clientId)) continue; // deleted meanwhile
          // A waiting entry goes again once its author is registered here.
          if (blocked.has(e.sender) || e.state === "held" || (e.state === "waiting" && !this.registrationFor(e.sender))) { blocked.add(e.sender); continue; }
          if (!this.registrationFor(e.sender)) {
            if (e.state !== "waiting") { this.queue.mark(e.clientId, "waiting"); this.noticePending(e.clientId); }
            blocked.add(e.sender);
            continue;
          }
          this.dispatching = e.clientId;
          try {
            const message = await this.dispatch(e);
            this.queue.remove(e.clientId);
            this.notice({ type: "pending-dispatched", conversationId: this.id, data: { conversationId: this.id, clientId: e.clientId, id: message.id } });
            sent++;
            progress = true;
          } catch (err) {
            if (err instanceof LinkDownError) {
              this.queue.bump(e.clientId);
              this.transport.failed(err.message);
              return sent;
            }
            blocked.add(e.sender);
            if (err instanceof PeerRefusedError && err.code === "not-registered") {
              // The home does not know the author (and re-registering did not
              // help): it waits for the author to rejoin.
              this.queue.mark(e.clientId, "waiting");
              this.noticePending(e.clientId);
            } else {
              this.queue.mark(e.clientId, "held", (err as Error).message);
              this.noticePending(e.clientId);
              this.addLocalLine(this.refusalLine(e.sender, (err as Error).message));
            }
          } finally {
            this.dispatching = null;
          }
        }
      }
      return sent;
    };
    const p = run().finally(() => {
      this.draining = null;
      // A rerun requested after the loop's last check but before this
      // cleanup (gate round 4, finding 4) is serviced now.
      if (this.rerunDrain && this.transport.isUp() && !this.destroyed) {
        this.rerunDrain = false;
        void this.drain();
      }
    });
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
    // It may have held up its author's later entries (gate round 2, finding 5).
    if (this.transport.isUp() && this.queue.list().some((x) => x.sender === by)) this.requestDrain();
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

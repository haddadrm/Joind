/**
 * LinkClient: this server's side of one link to a peer server.
 *
 * - Discovers the peer's rooms (GET /api/peer/rooms, every 60 s) and keeps a
 *   MirrorRoom for each, registered with the manager as "<peer>:<room>".
 * - Subscribes to a remote room only while it matters here: a local member
 *   is in it, or the web UI has it open. An idle link costs one discovery
 *   request a minute. Each subscription long-polls /api/peer/subscribe from
 *   a cursor kept in data/links/<peer>/<room>.cursor.
 * - Knows the link's state. Any request that cannot reach the peer marks it
 *   down (one "link down" line in each mirror that matters, a `link` event);
 *   the first request that succeeds marks it up again, re-registers local
 *   members, drains the undelivered queues in order and says how many went.
 *   While down, a probe retries with backoff from 1 s to 30 s.
 * - Carries this server's requests to the peer: register, send, leave, act,
 *   and, when this server is the home of a room, wakes of members hosted on
 *   the peer.
 *
 * Every request goes to the configured URL only, with the link's token as
 * `Authorization: Bearer`.
 */

import { EventEmitter } from "events";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { LinkConfig } from "./config.js";
import type { ConversationManager } from "./manager.js";
import type { ChatMessage, HostedWakeRequest, HostedWakeResult } from "./room.js";
import { MirrorRoom, HUMAN_LOCK, type MirrorNotice, type MirrorTransport, type PendingPayload } from "./mirror.js";
import { ensureDir } from "./persist.js";
import {
  LinkDownError, PeerRefusedError, parseRemoteRoomId,
  type PeerActBody, type PeerLeaveBody, type PeerMessagesResult, type PeerRegisterBody, type PeerRegisterResult,
  type PeerRoomsResult, type PeerSendBody, type PeerSendResult, type PeerSubscribeResult, type PeerWakeBody,
  type RemoteRegisterOutcome, type RemoteRegistered, type RemoteRooms,
} from "./peer-types.js";

export type LinkState = "up" | "down";

export interface LinkInfo {
  name: string;
  state: LinkState;
  since: number;
}

export interface RemoteConversationInfo {
  id: string;
  server: string;
  name: string;
  messageCount: number;
  starred: boolean;
  state: LinkState;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface LinkClientOptions {
  link: LinkConfig;
  /** This server's own name (the host its members are registered from). */
  selfName: string;
  /** data/links: cursors and queues live in <linksDir>/<peer>/. */
  linksDir: string;
  manager: ConversationManager;
  fetchImpl?: FetchLike;
  discoverEveryMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** How long one subscribe long-poll may park on the peer. */
  pollTimeoutMs?: number;
  requestTimeoutMs?: number;
  wakeTimeoutMs?: number;
}

/** A room id is one path-safe segment on disk. */
function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(done, ms);
    function done(): void { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function timeText(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export class LinkClient extends EventEmitter {
  readonly name: string;
  private state: LinkState | "unknown" = "unknown";
  private since = Date.now();
  private readonly link: LinkConfig;
  private readonly opts: Required<Omit<LinkClientOptions, "fetchImpl">> & { fetchImpl: FetchLike };
  private mirrors = new Map<string, MirrorRoom>();
  private loops = new Map<string, AbortController>();
  private stopped = false;
  private discoverTimer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  /** Bumped at every "down": a reply to a request that started before the
   *  link went down does not prove it is back (a long-poll in flight at the
   *  moment of the drop can still answer). */
  private downEpoch = 0;
  private readonly onActive = (id: string): void => {
    const r = parseRemoteRoomId(id);
    if (r && r.server === this.name) this.ensureLoop(r.room);
  };

  constructor(opts: LinkClientOptions) {
    super();
    this.link = opts.link;
    this.name = opts.link.name;
    const f: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.opts = {
      link: opts.link,
      selfName: opts.selfName,
      linksDir: opts.linksDir,
      manager: opts.manager,
      fetchImpl: f,
      discoverEveryMs: opts.discoverEveryMs ?? 60_000,
      backoffMinMs: opts.backoffMinMs ?? 1_000,
      backoffMaxMs: opts.backoffMaxMs ?? 30_000,
      pollTimeoutMs: opts.pollTimeoutMs ?? 25_000,
      requestTimeoutMs: opts.requestTimeoutMs ?? 10_000,
      wakeTimeoutMs: opts.wakeTimeoutMs ?? 90_000,
    };
  }

  start(): void {
    this.opts.manager.on("active-changed", this.onActive);
    void this.discover().catch(() => undefined);
    this.discoverTimer = setInterval(() => { void this.discover().catch(() => undefined); }, this.opts.discoverEveryMs);
  }

  stop(): void {
    this.stopped = true;
    this.opts.manager.removeListener("active-changed", this.onActive);
    if (this.discoverTimer) clearInterval(this.discoverTimer);
    for (const ac of this.loops.values()) ac.abort();
    this.loops.clear();
  }

  info(): LinkInfo {
    return { name: this.name, state: this.state === "up" ? "up" : "down", since: this.since };
  }

  isUp(): boolean {
    return this.state === "up";
  }

  remoteConversations(): RemoteConversationInfo[] {
    const state = this.info().state;
    return [...this.mirrors.values()].map((m) => {
      const meta = m.meta();
      return { id: meta.id, server: this.name, name: meta.name, messageCount: meta.messageCount, starred: meta.starred, state };
    });
  }

  getMirror(homeId: string): MirrorRoom | undefined {
    return this.mirrors.get(homeId);
  }

  mirrorsList(): MirrorRoom[] {
    return [...this.mirrors.values()];
  }

  // ---------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------

  private async request<T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
    const url = `${this.link.url}${path}${qs}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? this.opts.requestTimeoutMs);
    const onOuter = (): void => ac.abort();
    opts.signal?.addEventListener("abort", onOuter, { once: true });
    let status: number;
    let text: string;
    try {
      const res = await this.opts.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${this.link.token}`, "Content-Type": "application/json" },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: ac.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      throw new LinkDownError(opts.signal?.aborted ? "aborted" : ac.signal.aborted ? `no answer from ${this.name} within the timeout` : `${this.name} unreachable: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuter);
    }
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    if (status >= 500) throw new LinkDownError(`${this.name} answered HTTP ${status}${(parsed as { error?: string } | undefined)?.error ? `: ${(parsed as { error: string }).error}` : ""}`);
    if (status >= 400) {
      const b = parsed as { error?: string; code?: string } | undefined;
      throw new PeerRefusedError(status, b?.error ?? `HTTP ${status}`, b?.code, parsed);
    }
    return parsed as T;
  }

  // ---------------------------------------------------------------------
  // Link state
  // ---------------------------------------------------------------------

  private markUp(startedEpoch: number): void {
    if (this.state === "up") return;
    if (this.state === "down" && startedEpoch !== this.downEpoch) return;
    const was = this.state;
    this.state = "up";
    this.since = Date.now();
    console.log(`  [link ${this.name}] up`);
    this.emit("link", this.info());
    void this.restore(was === "down");
  }

  /** The link failed under a request (any of ours). */
  markDown(reason: string): void {
    if (this.stopped || this.state === "down") return;
    this.downEpoch++;
    this.state = "down";
    this.since = Date.now();
    console.log(`  [link ${this.name}] down: ${reason}`);
    this.emit("link", this.info());
    for (const m of this.mirrors.values()) {
      if (!this.matters(m) && m.queuedCount() === 0) continue;
      m.addLocalLine(`link to ${this.name} down since ${timeText(this.since)}; messages you send here will be queued`);
      m.downNoted = true;
    }
    void this.probe();
  }

  /** Back up: members re-registered (the peer may have restarted), then
   *  every queue drained in order, then the restore line where "down" was said. */
  private async restore(announce: boolean): Promise<void> {
    for (const m of this.mirrors.values()) {
      if (m.hasLocalMembers() || m.humanToRegister()) await m.reregisterAll();
      const sent = m.queuedCount() > 0 ? await m.drain() : 0;
      if (announce && m.downNoted && this.state === "up") {
        m.addLocalLine(`link to ${this.name} restored; ${sent} queued message${sent === 1 ? "" : "s"} sent`);
        m.downNoted = false;
      }
      if (this.matters(m)) this.ensureLoop(m.homeRoomId);
    }
  }

  /** While down, retry discovery with backoff (1 s doubling to 30 s). */
  private async probe(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    let backoff = this.opts.backoffMinMs;
    try {
      while (!this.stopped && this.state === "down") {
        await sleep(backoff);
        if (this.stopped || this.state !== "down") break;
        await this.discover().catch(() => undefined);
        backoff = Math.min(backoff * 2, this.opts.backoffMaxMs);
      }
    } finally {
      this.probing = false;
    }
  }

  // ---------------------------------------------------------------------
  // Rooms and mirrors
  // ---------------------------------------------------------------------

  async discover(): Promise<void> {
    let r: PeerRoomsResult;
    const epoch = this.downEpoch;
    try {
      r = await this.request<PeerRoomsResult>("GET", "/api/peer/rooms");
    } catch (err) {
      if (err instanceof LinkDownError) this.markDown(err.message);
      throw err;
    }
    const seen = new Set<string>();
    for (const room of r.rooms ?? []) {
      if (typeof room.id !== "string" || room.id.includes(":")) continue;
      seen.add(room.id);
      const isNew = !this.mirrors.has(room.id);
      const m = this.mirrorFor(room.id, room.name, room.createdAt, room.messageCount);
      const renamed = !isNew && m.name !== room.name;
      m.name = room.name;
      // The web UI refetches its room list on these (a room found or renamed
      // by a later discovery shows up without a reconnect).
      if (isNew) this.emit("rooms", { type: "conversation-created", data: { id: m.id, remote: true } });
      else if (renamed) this.emit("rooms", { type: "conversation-renamed", data: { id: m.id, remote: true } });
      m.homeMessageCount = Math.max(m.homeMessageCount, room.messageCount ?? 0);
    }
    // A room gone from its home: drop the mirror unless someone is in it
    // here (its loop says so on its own), or it still holds a queue.
    for (const [id, m] of this.mirrors) {
      if (seen.has(id) || m.hasLocalMembers() || m.queuedCount() > 0) continue;
      this.loops.get(id)?.abort();
      this.mirrors.delete(id);
      this.opts.manager.unregisterRemoteRoom(m.id);
      this.emit("rooms", { type: "conversation-deleted", data: { id: m.id, remote: true } });
    }
    this.markUp(epoch);
    const active = this.opts.manager.getActiveId();
    if (active) this.onActive(active);
  }

  private mirrorFor(homeId: string, name?: string, createdAt?: number, messageCount?: number): MirrorRoom {
    let m = this.mirrors.get(homeId);
    if (m) return m;
    const dir = join(this.opts.linksDir, safeSegment(this.name));
    const transport: MirrorTransport = {
      isUp: () => this.isUp(),
      send: (body) => this.send(body),
      leave: (body) => this.leave(body),
      act: (body) => this.act(body),
      register: (body) => this.register(body),
      failed: (reason) => this.markDown(reason),
    };
    m = new MirrorRoom({
      server: this.name, homeId, name: name ?? homeId, createdAt, messageCount,
      queueFile: join(dir, `${safeSegment(homeId)}.queue.jsonl`),
      transport, selfName: this.opts.selfName,
    });
    if (this.opts.manager.injectBaseUrl) m.injectBaseUrl = this.opts.manager.injectBaseUrl;
    m.on("mirror-notice", (n: MirrorNotice) => this.emit("notice", n));
    this.mirrors.set(homeId, m);
    const mirror = m;
    this.opts.manager.registerRemoteRoom({ id: m.id, server: this.name, homeId, room: m, meta: () => mirror.meta() });
    return m;
  }

  /** The mirror of a remote room, discovering the peer's rooms once when it
   *  is not known yet. Undefined when the peer has no such room (or is down
   *  and it was never seen). */
  async resolveMirror(homeId: string): Promise<MirrorRoom | undefined> {
    const known = this.mirrors.get(homeId);
    if (known) return known;
    try { await this.discover(); } catch { /* down: unknown room */ }
    return this.mirrors.get(homeId);
  }

  /** Whether a mirror is worth a subscription: a local member is in it, the
   *  web UI has it open, or it has a local human registration. */
  private matters(m: MirrorRoom): boolean {
    return m.hasLocalMembers() || this.opts.manager.getActiveId() === m.id;
  }

  /** Start (or restart, when the set of viewers changed) the subscription
   *  loop of a room that matters here. */
  ensureLoop(homeId: string, restart = false): void {
    if (this.stopped) return;
    const m = this.mirrors.get(homeId);
    if (!m || !this.matters(m)) return;
    const running = this.loops.get(homeId);
    if (running && !restart) return;
    running?.abort();
    const ac = new AbortController();
    this.loops.set(homeId, ac);
    void this.loop(m, ac).finally(() => {
      if (this.loops.get(homeId) === ac) this.loops.delete(homeId);
    });
  }

  /** Fill a mirror from the home snapshot (messages, members, cursor).
   *  `announce`: emit what changed (a refill after an outage). The mirror's
   *  events go out before the cursor moves past them. */
  async fill(m: MirrorRoom, signal?: AbortSignal, announce = false): Promise<number> {
    // What is inserted after this point (a send completing meanwhile) is
    // newer than the snapshot and is never judged by it (gate round 2, finding 4).
    const mark = m.snapshotMark();
    const snap = await this.request<PeerMessagesResult>("GET", "/api/peer/messages", {
      query: { room: m.homeRoomId, limit: "500", viewers: m.viewerNames().join(",") }, signal,
    });
    m.fill(snap, announce, mark);
    this.writeCursor(m.homeRoomId, snap.cursor);
    return snap.cursor;
  }

  private cursorFile(homeId: string): string {
    return join(this.opts.linksDir, safeSegment(this.name), `${safeSegment(homeId)}.cursor`);
  }

  readCursor(homeId: string): number {
    try {
      const f = this.cursorFile(homeId);
      if (!existsSync(f)) return 0;
      const n = Number(readFileSync(f, "utf-8").trim());
      return Number.isSafeInteger(n) && n >= 0 ? n : 0;
    } catch { return 0; }
  }

  private writeCursor(homeId: string, cursor: number): void {
    try {
      ensureDir(join(this.opts.linksDir, safeSegment(this.name)));
      writeFileSync(this.cursorFile(homeId), String(cursor), "utf-8");
    } catch { /* the next fill recovers */ }
  }

  private async loop(m: MirrorRoom, ac: AbortController): Promise<void> {
    let backoff = this.opts.backoffMinMs;
    let filled = false;
    // Set by an outage or a reset: the next refill announces what it finds.
    let recovering = false;
    let cursor = this.readCursor(m.homeRoomId);
    while (!this.stopped && !ac.signal.aborted && this.matters(m)) {
      const epoch = this.downEpoch;
      try {
        if (!filled) {
          cursor = await this.fill(m, ac.signal, recovering);
          filled = true;
          recovering = false;
          this.markUp(epoch);
        }
        const r = await this.request<PeerSubscribeResult>("GET", "/api/peer/subscribe", {
          query: { room: m.homeRoomId, since: String(cursor), viewers: m.viewerNames().join(","), timeoutMs: String(this.opts.pollTimeoutMs) },
          timeoutMs: this.opts.pollTimeoutMs + this.opts.requestTimeoutMs,
          signal: ac.signal,
        });
        if (ac.signal.aborted) break;
        this.markUp(epoch);
        if (r.reset) { filled = false; recovering = true; continue; }
        for (const ev of r.events ?? []) m.applyEvent(ev);
        if (typeof r.cursor === "number") { cursor = r.cursor; this.writeCursor(m.homeRoomId, cursor); }
        backoff = this.opts.backoffMinMs;
      } catch (err) {
        if (ac.signal.aborted || this.stopped) break;
        if (err instanceof PeerRefusedError && err.status === 404) {
          m.addLocalLine(`this room no longer exists on ${this.name}`);
          break;
        }
        this.markDown((err as Error).message);
        // After an outage the home may have restarted: refill before
        // resuming, and announce what arrived meanwhile.
        filled = false;
        recovering = true;
        await sleep(backoff, ac.signal);
        backoff = Math.min(backoff * 2, this.opts.backoffMaxMs);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Requests to the peer
  // ---------------------------------------------------------------------

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const epoch = this.downEpoch;
    try {
      const out = await this.request<T>(method, path, { body, timeoutMs });
      this.markUp(epoch);
      return out;
    } catch (err) {
      if (err instanceof LinkDownError) this.markDown(err.message);
      throw err;
    }
  }

  register(body: PeerRegisterBody): Promise<PeerRegisterResult> {
    return this.call<PeerRegisterResult>("POST", "/api/peer/register", body);
  }

  async send(body: PeerSendBody): Promise<ChatMessage> {
    // No markDown here on failure: the mirror decides (it queues first).
    const epoch = this.downEpoch;
    const r = await this.request<PeerSendResult>("POST", "/api/peer/send", { body });
    this.markUp(epoch);
    return r.message;
  }

  async leave(body: PeerLeaveBody): Promise<void> {
    await this.call<{ ok: boolean }>("POST", "/api/peer/leave", body);
  }

  async act(body: PeerActBody): Promise<void> {
    await this.request<{ ok: boolean }>("POST", "/api/peer/act", { body });
  }

  /** This server is the home of `req.room`; the member is hosted on the peer. */
  async wake(req: HostedWakeRequest): Promise<HostedWakeResult> {
    const body: PeerWakeBody = { room: req.room, name: req.name, hostedRegistration: req.hostedRegistration, sender: req.sender, prompt: req.prompt };
    try {
      const r = await this.request<HostedWakeResult>("POST", "/api/peer/wake", { body, timeoutMs: this.opts.wakeTimeoutMs });
      return { ok: r.ok === true, kind: r.kind, attempts: Number(r.attempts ?? 1), reason: r.reason, warn: r.warn };
    } catch (err) {
      if (err instanceof LinkDownError) return { ok: false, kind: "unreachable", attempts: 1, reason: err.message };
      const e = err as PeerRefusedError;
      return { ok: false, kind: "no-console", attempts: 1, warn: true, reason: `${this.name} refused the wake: ${e.message}` };
    }
  }
}

/** Every link of this server, by peer name. */
export class LinkRegistry extends EventEmitter implements RemoteRooms {
  private clients = new Map<string, LinkClient>();
  /** A join's hold on its name's lock, from register to commit or abandon
   *  (gate round 2, finding 2). */
  private joinLocks = new WeakMap<RemoteRegistered, () => void>();
  private readonly selfName: string;

  constructor(links: LinkConfig[], base: Omit<LinkClientOptions, "link">) {
    super();
    this.selfName = base.selfName;
    for (const link of links) {
      const c = new LinkClient({ ...base, link });
      c.on("link", (info: LinkInfo) => this.emit("link", info));
      c.on("notice", (n: MirrorNotice) => this.emit("notice", n));
      c.on("rooms", (e: { type: string; data: unknown }) => this.emit("rooms", e));
      this.clients.set(link.name, c);
    }
  }

  start(): void { for (const c of this.clients.values()) c.start(); }
  stop(): void { for (const c of this.clients.values()) c.stop(); }
  get(name: string): LinkClient | undefined { return this.clients.get(name); }
  all(): LinkClient[] { return [...this.clients.values()]; }
  infos(): LinkInfo[] { return this.all().map((c) => c.info()); }
  remoteConversations(): RemoteConversationInfo[] { return this.all().flatMap((c) => c.remoteConversations()); }

  /** The mirror behind a remote room id, when its link is configured. */
  mirror(remoteId: string): MirrorRoom | undefined {
    const r = parseRemoteRoomId(remoteId);
    return r ? this.clients.get(r.server)?.getMirror(r.room) : undefined;
  }

  /** Every undelivered message the viewer may see, across remote rooms. */
  pendingFor(viewer: string | undefined): PendingPayload[] {
    return this.all().flatMap((c) => c.mirrorsList().flatMap((m) => m.pendingFor(viewer)));
  }

  isRemoteId(convId: string): boolean {
    const r = parseRemoteRoomId(convId);
    return !!r && this.clients.has(r.server);
  }

  async prepare(convId: string): Promise<boolean> {
    const r = parseRemoteRoomId(convId);
    const c = r ? this.clients.get(r.server) : undefined;
    if (!r || !c) return false;
    return (await c.resolveMirror(r.room)) !== undefined;
  }

  async registerMember(convId: string, name: string, registration: string, t: { pid?: number; paneId?: number; gui?: number; orcaTerminal?: string; role?: string }): Promise<RemoteRegisterOutcome> {
    const r = parseRemoteRoomId(convId);
    const c = r ? this.clients.get(r.server) : undefined;
    const m = r && c ? c.getMirror(r.room) : undefined;
    if (!r || !c || !m) return { ok: false, status: 404, error: `Conversation not found: ${convId}` };
    // A summary for the home's conflict answers; never an id.
    const terminalSummary = [
      t.pid ? `pid ${t.pid}` : "",
      t.paneId != null && t.gui != null ? `WezTerm pane ${t.paneId} (gui ${t.gui})` : "",
      t.orcaTerminal ? "Orca terminal" : "",
    ].filter(Boolean).join(", ") || "no terminal";
    // One registration transition of a name at a time: this join holds the
    // lock until it commits or abandons, so a restore can never land after
    // a newer join (gate round 2, finding 2).
    const release = await m.lockName(name);
    try {
      const res = await c.register({ room: r.room, name, host: this.selfName, registration, terminalSummary, ...(t.role ? { role: t.role } : {}) });
      // Nothing is kept here yet: the join may still be superseded (gate
      // round 1, finding 3). The caller commits or abandons.
      const out: RemoteRegistered = { ok: true, online: res.online ?? [], homeRegistration: res.registration, role: t.role, terminalSummary };
      this.joinLocks.set(out, release);
      return out;
    } catch (err) {
      release();
      if (err instanceof PeerRefusedError) {
        const body = err.body as { candidates?: unknown } | undefined;
        return { ok: false, status: err.status, error: err.message, ...(body?.candidates ? { candidates: body.candidates } : {}) };
      }
      return { ok: false, status: 503, error: `the link to ${r.server} is down (${(err as Error).message}); a remote room can be joined only while its home server answers` };
    }
  }

  commitMember(convId: string, name: string, outcome: RemoteRegistered): void {
    const m = this.mirror(convId);
    if (!m) return;
    m.setShadow(name, { homeRegistration: outcome.homeRegistration, role: outcome.role, terminalSummary: outcome.terminalSummary });
    this.joinLocks.get(outcome)?.();
    m.resumeAuthor(name);
  }

  async abandonMember(convId: string, name: string, outcome: RemoteRegistered): Promise<void> {
    const r = parseRemoteRoomId(convId);
    const c = r ? this.clients.get(r.server) : undefined;
    const m = r && c ? c.getMirror(r.room) : undefined;
    if (!r || !c || !m) { this.joinLocks.get(outcome)?.(); return; }
    // Still under this join's lock: the member captured here is the current one.
    const current = m.shadowsForRegister().find((s) => s.name === name);
    try {
      if (current) {
        // The newer join of this name is the member here: the home must
        // hold ITS registration, not the abandoned one (idempotent when it does).
        const res = await c.register({ room: r.room, name, host: this.selfName, registration: current.registration, terminalSummary: current.terminalSummary, ...(current.role ? { role: current.role } : {}) });
        m.setShadow(name, { homeRegistration: res.registration, role: current.role, terminalSummary: current.terminalSummary });
      } else {
        // No member of that name here any more: remove what was registered.
        await c.leave({ room: r.room, name, registration: outcome.homeRegistration });
      }
    } catch (err) {
      console.log(`  [link ${r.server}] could not restore ${name} in ${convId} after a superseded join: ${(err as Error).message}`);
    } finally {
      this.joinLocks.get(outcome)?.();
    }
  }

  async joined(convId: string): Promise<void> {
    const r = parseRemoteRoomId(convId);
    const c = r ? this.clients.get(r.server) : undefined;
    const m = r && c ? c.getMirror(r.room) : undefined;
    if (!r || !c || !m) return;
    try { await c.fill(m); } catch { /* the loop refills */ }
    c.ensureLoop(r.room, true);
  }

  /** The web viewer opened or writes in a remote room: register it there as
   *  this server's human (never woken), so it can post and see its DMs. */
  async ensureHuman(convId: string, viewer: string | undefined): Promise<void> {
    const r = parseRemoteRoomId(convId);
    const c = r ? this.clients.get(r.server) : undefined;
    const m = r && c ? c.getMirror(r.room) : undefined;
    if (!r || !c || !m || !viewer || m.humanName() === viewer || !c.isUp()) return;
    const release = await m.lockName(HUMAN_LOCK);
    try {
      const previous = m.humanRegistration();
      if (previous?.name === viewer) return;
      const res = await c.register({ room: r.room, name: viewer, host: this.selfName, registration: `human:${this.selfName}`, human: true });
      m.setHuman(viewer, res.registration);
      // A renamed viewer gives its old name back (gate round 2, finding 9).
      if (previous) {
        await c.leave({ room: r.room, name: previous.name, registration: previous.registration }).catch((err: unknown) => {
          console.log(`  [link ${r.server}] could not release ${previous.name} in ${convId}: ${(err as Error).message}`);
        });
      }
    } catch { /* not registered: the viewer reads public messages only */ } finally {
      release();
    }
  }

  /** The web UI opened a remote room: fill it now (bounded), then subscribe. */
  async open(convId: string, viewer: string | undefined, waitMs = 3_000): Promise<void> {
    const r = parseRemoteRoomId(convId);
    const c = r ? this.clients.get(r.server) : undefined;
    const m = r && c ? c.getMirror(r.room) : undefined;
    if (!r || !c || !m) return;
    const work = (async () => {
      await this.ensureHuman(convId, viewer);
      try { await c.fill(m); } catch { /* shown as it is; the loop retries */ }
      c.ensureLoop(r.room, true);
    })();
    await Promise.race([work, sleep(waitMs)]);
  }

  /** Route a hosted member's wake to its host. */
  wake(req: HostedWakeRequest): Promise<HostedWakeResult> {
    const c = this.clients.get(req.host);
    if (!c) return Promise.resolve({ ok: false, kind: "unreachable", attempts: 0, reason: `no link to ${req.host} is configured on this server` });
    return c.wake(req);
  }
}

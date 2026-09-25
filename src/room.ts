/**
 * ChatRoom — a single conversation with its own messages, agents, and JSONL file.
 * Multiple ChatRoom instances exist simultaneously, managed by ConversationManager.
 */

import { EventEmitter } from "events";
import { writeFileSync } from "fs";
import { dirname } from "path";
import { inject, WakeFallbackAborted } from "./inject.js";
import { cancelRoomListens } from "./listen.js";
import { WakeCoordinator, type WakeFailureKind, type WakeOutcome } from "./wake.js";

// The base URL an injected prompt tells the woken agent to call back on.
// Must be the address the server actually binds (single-interface): a
// tailnet-bound server that says 127.0.0.1 hands the agent commands that
// are refused.
let INJECT_BASE_URL = "http://127.0.0.1:4200";
export function setInjectBaseUrl(url: string): void {
  if (url && url.startsWith("http")) INJECT_BASE_URL = url.replace(/\/+$/, "");
}
const wakes = new WakeCoordinator();
let roomSeq = 0;
/** What a terminal registration carries: the pid, and when known the
 *  WezTerm pane and the Orca terminal handle. */
export interface TerminalRef { pid: number; weztermPaneId?: number; weztermGui?: number; orcaTerminal?: string }
/** Every identity known for a terminal. A wake holds all of them, so a room
 *  that registered the session pid-only and a room that registered it with
 *  its pane (or Orca handle) still serialize on the shared pid. */
export function terminalKeys(agent: TerminalRef): string[] {
  const keys: string[] = [];
  if (agent.pid > 0) keys.push(`pid:${agent.pid}`);
  // Pane ids are per WezTerm GUI instance, so a pane is only ever the pair
  // (GUI, pane): pane 0 of GUI 10 and pane 0 of GUI 20 are different
  // terminals for locking, identity and "is this still the terminal holding
  // the prompt". There is no key for a bare pane number: a pane whose GUI
  // cannot be determined is never bound (see resolvePaneForJoin and join()).
  if (agent.weztermPaneId != null && agent.weztermGui != null) {
    keys.push(`pane:${agent.weztermGui}:${agent.weztermPaneId}`);
  }
  if (agent.orcaTerminal) keys.push(`orca:${agent.orcaTerminal}`);
  return keys.length > 0 ? keys : ["pid:0"];
}
/** Session identity: any change of pid, pane or Orca handle is a different terminal. */
export function terminalIdentity(agent: TerminalRef): string {
  return terminalKeys(agent).join("|");
}
/** Every live registration across every room, keyed by room scope and name.
 *  It is the only source of terminal equivalence: a pid-only registration in
 *  one room and a pane-only one in another are the same terminal when some
 *  live registration carries both, and the knowledge leaves with them. */
const liveTerminals = new Map<string, TerminalRef>();
/** The keys a wake must hold for `agent`: its own, plus those of every live
 *  registration reachable through a shared key (transitively). */
export function lockKeysFor(
  agent: TerminalRef,
  registry: Iterable<TerminalRef> = liveTerminals.values()
): string[] {
  const keys = new Set(terminalKeys(agent));
  const others = [...registry].map(terminalKeys);
  let grew = true;
  while (grew) {
    grew = false;
    for (const ok of others) {
      if (!ok.some((k) => keys.has(k))) continue;
      for (const k of ok) if (!keys.has(k)) { keys.add(k); grew = true; }
    }
  }
  return [...keys];
}
/** The terminal part of an agent, copied (the registry must not alias it). */
function terminalRefOf(agent: TerminalRef): TerminalRef {
  return { pid: agent.pid, weztermPaneId: agent.weztermPaneId, weztermGui: agent.weztermGui, orcaTerminal: agent.orcaTerminal };
}
/**
 * Is `live` still the terminal an attempt typed into? True when the closure
 * of `live` through the live registrations now (the same equivalence
 * lockKeysFor() uses for locking) shares any key with the COMPLETE lock set
 * the attempt holds, not only the delivered agent's own keys. The held set
 * already contains every key the delivered terminal was reachable through,
 * so a terminal linked to it only through a registration that has since
 * left and rejoined elsewhere (sharing, say, just an Orca handle) is still
 * recognised. The two narrower checks this replaces (a key of `live` in the
 * held set; a delivered key in the current closure) are both special cases.
 */
function sameTerminal(held: ReadonlySet<string>, live: TerminalRef): boolean {
  return lockKeysFor(live).some((k) => held.has(k));
}
import { getWeztermPath, getWeztermEnv } from "./terminals.js";
import { loadMessages, appendMessage, maxId, ensureDir } from "./persist.js";

/**
 * DM visibility: a targeted message is visible only to its sender and its
 * named recipients; public messages are visible to everyone. Fail closed:
 * when no viewer is known, targeted messages are hidden.
 */
export function visibleToViewer(msg: ChatMessage, viewer: string | undefined): boolean {
  if (!msg.to) return true;
  if (viewer === undefined) return false;
  if (msg.sender === viewer) return true;
  return msg.to.includes(viewer);
}

export interface ChatMessage {
  id: number;
  sender: string;
  text: string;
  timestamp: number;
  image?: string;
  replyTo?: number;
  tag?: string;
  pinned?: boolean;
  to?: string[];  // targeted recipients (DM-style visibility)
  choices?: string[];  // inline decision buttons
  choiceResponse?: { value: string; by: string; at: number };
  /** First-class decision request: this message needs an answer from `for`.
   *  Born with the message; resolution persists via the asks sidecar. */
  ask?: { for: string; state: "open" | "resolved"; resolvedBy?: string; resolvedAt?: number };
  /** A line that exists only on this server (a linked server's mirror of a
   *  remote room: "link down", "link restored"). Its id is negative, so it
   *  never collides with the home server's ids and never enters a read cursor. */
  local?: boolean;
}

export interface Agent {
  name: string;
  pid: number;
  joinedAt: number;
  active: boolean;
  role?: string;
  status?: string;
  lastSeen: number;
  /** When the agent last posted a message; presence alone can be a lie
   *  (a hung resident heartbeats forever), a post is proof of life. */
  lastPostAt?: number;
  weztermPaneId?: number;
  /** The WezTerm GUI instance (wezterm-gui pid) that weztermPaneId belongs
   *  to: pane ids are per instance, so wakes use that GUI's own socket. */
  weztermGui?: number;
  /** Orca terminal handle (term_<uuid>), bound only after the join checked it. */
  orcaTerminal?: string;
  /** Linked servers: the peer server this member's terminal lives on. A
   *  hosted member has no terminal on this server (pid 0, no pane, no handle):
   *  it is never injected here, holds no lock key and has no terminal
   *  identity here; its wakes go to the host over the link. Unset for a
   *  member whose terminal is on this server. */
  host?: string;
}

/** A wake request for a hosted member, sent to its host over the link. */
export interface HostedWakeRequest {
  host: string;
  /** The home room id (this server's conversation id). */
  room: string;
  name: string;
  /** The host's own registration id for the member (its shadow registration). */
  hostedRegistration: string;
  sender: string;
  /** Mention context; the host builds the terminal prompt itself, with its
   *  own base URL, since the member reads and replies through the host. */
  prompt: string;
}

/** What the host answered, or "unreachable" when the link could not carry
 *  the request (the host is down, or no link to it is configured). */
export interface HostedWakeResult {
  ok: boolean;
  kind?: WakeFailureKind | "unreachable";
  attempts: number;
  reason?: string;
  /** The host's coordinator decided this failure is worth a line now. */
  warn?: boolean;
}

export type HostedWaker = (req: HostedWakeRequest) => Promise<HostedWakeResult>;

/** The honest line for a wake that did not land. `host` names the peer a
 *  hosted member lives on; without it the text is the local wording. */
export function wakeFailureLine(name: string, kind: WakeFailureKind | "unreachable" | undefined, reason: string | undefined, host?: string): string {
  const where = host ? `their host ${host}` : "this server";
  if (kind === "unreachable") {
    return `Could not wake ${name}: their host ${host ?? "server"} is unreachable (${reason ?? "no answer"}). They will see this when the link returns.`;
  }
  if (kind === "partial") return `Could not submit the prompt to ${name}; the text is in their input box.`;
  if (kind === "no-console" && /^orca /i.test(reason ?? "")) {
    return `Could not wake ${name}: their Orca terminal is not reachable from ${where} (${reason}). They will see mentions only when they read on their own schedule, or after rejoining with a live orcaTerminal.`;
  }
  if (kind === "no-console") {
    return `Could not wake ${name}: no console reachable from ${where} (remote session, or joined without its real terminal pid). They will see mentions only when they read on their own schedule.`;
  }
  return `Could not wake ${name} just now (terminal injection failed after a retry). They will see this on their next read.`;
}

/** What one run of the local wake machinery did. */
interface WakeCoreResult {
  outcome: WakeOutcome;
  /** The text is in the terminal and the registration changed to what is
   *  still that terminal: never replayed, the partial-delivery line is owed. */
  partialLine: boolean;
}

export interface RoomEvent {
  type: "message" | "join" | "leave" | "rename" | "role" | "typing" | "stale" | "presence";
  data:
    | ChatMessage
    | Agent
    | { oldName: string; newName: string; agent: Agent }
    | { name: string; typing: boolean }
    | PresenceUpdate;
}

/** Heartbeat-driven timestamp refresh so pill ages stay live in the UI. */
export interface PresenceUpdate {
  name: string;
  lastSeen: number;
  lastPostAt?: number;
  at: number;
}

export interface ChatRoomOptions {
  chatFilePath?: string;
  getCursor?: (agentName: string) => number;
  onChoice?: (messageId: number, value: string, by: string, at: number) => void;
  onPin?: (messageId: number, pinned: boolean, at: number) => void;
  onTag?: (messageId: number, tag: string, at: number) => void;
  onAskResolve?: (messageId: number, by: string, at: number) => void;
}

// Presence removal grace: an unreachable-pid agent survives this long after
// its last touch before the room declares it dropped. Long P6 operations run
// 15 to 20 minutes with zero chat traffic; removal at the old 120s made the
// room lie ("left the chat") about agents that were merely working. The 120s
// mark now only dims the pill (stale event) for every silent agent.
let DEFAULT_PRESENCE_GRACE_MS = 30 * 60_000;
export function setDefaultPresenceGrace(ms: number): void {
  if (Number.isFinite(ms) && ms >= 120_000) DEFAULT_PRESENCE_GRACE_MS = ms;
}

/** Each room member's registration id (see AgentBindingEntry.registration).
 *  Kept beside the member rather than on it: member objects are served to
 *  web clients, and the id is a caller's proof of its registration. */
const memberRegistrations = new WeakMap<Agent, string>();
/** A hosted member's registration on its host (the host's shadow
 *  registration id), kept beside the member like memberRegistrations: it is
 *  a credential on the host, and member objects reach web clients. */
const hostedRegistrations = new WeakMap<Agent, string>();

export class ChatRoom extends EventEmitter {
  protected messages: ChatMessage[] = [];
  protected agents = new Map<string, Agent>();
  private nextId = 1;
  private typingState = new Map<string, NodeJS.Timeout>();
  private statusTimeouts = new Map<string, NodeJS.Timeout>();
  private pendingMentions = new Map<string, NodeJS.Timeout>(); // batched mention injection
  private wakesInFlight = new Set<string>();  // targets whose wake is executing right now
  private rewakeAfter = new Set<string>();    // mentioned again while in flight: wake once more
  /** Warning state for wake failures is per room and agent, not per name. */
  private readonly wakeScope = `r${++roomSeq}`;
  protected destroyed = false;
  private chatFile: string | null = null;
  /** This room's conversation id on this server (set by the manager). */
  homeId?: string;
  /** The base URL a wake prompt names; the process default when unset. */
  injectBaseUrl?: string;
  /** Carries wakes of hosted members to their host (set by the manager). */
  hostedWaker?: HostedWaker;
  /** Hosted members whose host was unreachable at their last wake: the line
   *  is said once per streak, and a success or a rejoin clears it. */
  private hostedUnreachable = new Set<string>();
  private staleInterval: ReturnType<typeof setInterval> | null = null;
  private agentTurnCount = 0; // consecutive agent turns since last human message
  getCursor: (agentName: string) => number;
  turnGuard: { enabled: boolean; limit: number } | null = null;
  private onChoice?: (messageId: number, value: string, by: string, at: number) => void;
  private onPin?: (messageId: number, pinned: boolean, at: number) => void;
  private onTag?: (messageId: number, tag: string, at: number) => void;
  private onAskResolve?: (messageId: number, by: string, at: number) => void;

  constructor(chatFilePathOrOptions?: string | ChatRoomOptions) {
    super();
    // Support legacy string argument as well as the new options object
    const options: ChatRoomOptions =
      typeof chatFilePathOrOptions === "string"
        ? { chatFilePath: chatFilePathOrOptions }
        : (chatFilePathOrOptions ?? {});

    this.getCursor = options.getCursor ?? (() => 0);
    this.onChoice = options.onChoice;
    this.onPin = options.onPin;
    this.onTag = options.onTag;
    this.onAskResolve = options.onAskResolve;

    if (options.chatFilePath) {
      this.chatFile = options.chatFilePath;
      const loaded = loadMessages<ChatMessage>(options.chatFilePath);
      // Filter out reaction-only entries that may have been persisted incorrectly
      // (they have emoji + messageId but no id or text)
      this.messages = loaded.filter((m) => m.id != null);
      this.nextId = maxId(loaded) + 1;
      if (loaded.length > 0) {
        console.log(`  Loaded ${loaded.length} messages (next ID: ${this.nextId})`);
      }
    }
    this.staleInterval = setInterval(() => this.sweepStale(), 5000);
  }

  private persist(msg: ChatMessage): void {
    if (this.chatFile) {
      appendMessage(this.chatFile, msg);
    }
  }

  /** `weztermPaneId`: a number binds that pane, null clears any pane held
   *  before (the join proved it stale), undefined leaves it as it was.
   *  `orcaTerminal` follows the same rule: a handle binds, null clears,
   *  undefined keeps. */
  join(name: string, pid: number, weztermPaneId?: number | null, persistedRole?: string, orcaTerminal?: string | null, weztermGui?: number, registration?: string): Agent {
    const existing = this.agents.get(name);
    if (existing && registration != null) memberRegistrations.set(existing, registration);
    if (existing?.host) {
      // Routes refuse a local join over a hosted member; defensively, a join
      // that reaches here makes the member local and forgets the host.
      existing.host = undefined;
      hostedRegistrations.delete(existing);
      this.hostedUnreachable.delete(name);
    }
    if (existing) {
      const now = Date.now();
      const previousIdentity = terminalIdentity(existing);
      // A different pid, or a pane replaced by another pane, means a new
      // session resumed the same identity; readers deserve to know it is a
      // fresh worker, not the old one, and the old worker's proof of life
      // does not carry over. Learning a pane for the first time is not a
      // new session.
      // A pane is a pair or nothing: a number without its GUI binds no pane.
      const bindsPane = weztermPaneId != null && weztermGui != null;
      const clearsPane = weztermPaneId === null || (weztermPaneId != null && weztermGui == null);
      // "Nothing learned" (undefined) with a known GUI keeps the old pane
      // only when it is in that same GUI: a rejoin from another GUI must not
      // keep a pane of the old one.
      const keepsOldPane = !bindsPane && !clearsPane && (weztermGui == null || existing.weztermGui === weztermGui);
      const paneReplaced =
        existing.weztermPaneId != null && bindsPane &&
        (existing.weztermPaneId !== weztermPaneId || existing.weztermGui !== weztermGui);
      const orcaReplaced =
        existing.orcaTerminal != null && orcaTerminal != null && existing.orcaTerminal !== orcaTerminal;
      if (existing.pid !== pid || paneReplaced || orcaReplaced) {
        this.addSystem(`${name} rejoined (new session)`);
        existing.joinedAt = now;
        existing.lastPostAt = undefined;
      }
      existing.active = true;
      existing.pid = pid;
      if (bindsPane) { existing.weztermPaneId = weztermPaneId ?? undefined; existing.weztermGui = weztermGui; }
      else if (!keepsOldPane) { existing.weztermPaneId = undefined; existing.weztermGui = undefined; }
      if (orcaTerminal === null) existing.orcaTerminal = undefined;
      else if (orcaTerminal != null) existing.orcaTerminal = orcaTerminal;
      if (!existing.role && persistedRole) existing.role = persistedRole;
      existing.lastSeen = now;
      liveTerminals.set(this.warnKey(name), terminalRefOf(existing));
      // Any change of terminal identity (pid, pane or Orca handle) is a fresh wake path:
      // it earns its own warning if it fails too.
      if (terminalIdentity(existing) !== previousIdentity) wakes.forget(this.warnKey(name));
      this.emit("room", { type: "join", data: existing } as RoomEvent);
      return existing;
    }

    const agent: Agent = {
      name,
      pid,
      joinedAt: Date.now(),
      active: true,
      role: persistedRole,
      lastSeen: Date.now(),
      // A pane is bound only with its GUI.
      weztermPaneId: weztermPaneId != null && weztermGui != null ? weztermPaneId : undefined,
      weztermGui: weztermPaneId != null && weztermGui != null ? weztermGui : undefined,
      orcaTerminal: orcaTerminal ?? undefined,
    };
    if (registration != null) memberRegistrations.set(agent, registration);
    this.agents.set(name, agent);
    liveTerminals.set(this.warnKey(name), terminalRefOf(agent));
    wakes.forget(this.warnKey(name)); // a new session starts with a clean wake record
    this.addSystem(`${name} joined the chat`);
    this.emit("room", { type: "join", data: agent } as RoomEvent);
    return agent;
  }

  /**
   * Register a member whose terminal lives on a linked peer (`host`). It
   * gets no terminal here: pid 0, no pane, no Orca handle, and it is never
   * added to the live terminal registry, so it takes part in no lock set and
   * no terminal identity on this server. `registration` is this server's id
   * for it; `hostedRegistration` is the host's id, sent back with its wakes.
   * A rejoin from the host under a new hosted registration is a new session.
   */
  joinHosted(name: string, host: string, registration: string, hostedRegistration: string, persistedRole?: string): Agent {
    const now = Date.now();
    const existing = this.agents.get(name);
    if (existing) {
      const newSession = existing.host !== host || hostedRegistrations.get(existing) !== hostedRegistration;
      if (newSession) {
        this.addSystem(`${name} rejoined from ${host} (new session)`);
        existing.joinedAt = now;
        existing.lastPostAt = undefined;
        this.hostedUnreachable.delete(name);
      }
      existing.host = host;
      existing.pid = 0;
      existing.weztermPaneId = undefined;
      existing.weztermGui = undefined;
      existing.orcaTerminal = undefined;
      existing.active = true;
      existing.lastSeen = now;
      if (!existing.role && persistedRole) existing.role = persistedRole;
      memberRegistrations.set(existing, registration);
      hostedRegistrations.set(existing, hostedRegistration);
      liveTerminals.delete(this.warnKey(name));
      wakes.release(this.warnKey(name));
      this.emit("room", { type: "join", data: existing } as RoomEvent);
      return existing;
    }
    const agent: Agent = { name, pid: 0, joinedAt: now, active: true, role: persistedRole, lastSeen: now, host };
    memberRegistrations.set(agent, registration);
    hostedRegistrations.set(agent, hostedRegistration);
    this.agents.set(name, agent);
    this.hostedUnreachable.delete(name);
    this.addSystem(`${name} joined the chat from ${host}`);
    this.emit("room", { type: "join", data: agent } as RoomEvent);
    return agent;
  }

  /** The host's registration id of a hosted member (never served to clients). */
  hostedRegistrationOf(name: string): string | undefined {
    const agent = this.agents.get(name);
    return agent?.host ? hostedRegistrations.get(agent) : undefined;
  }

  leave(name: string, reason: "deliberate" | "timeout" = "deliberate"): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.active = false;
      this.agents.delete(name);
      liveTerminals.delete(this.warnKey(name));
      wakes.release(this.warnKey(name));
      this.hostedUnreachable.delete(name);
      // A dropped agent and a departed agent are different facts; say which.
      this.addSystem(
        reason === "timeout"
          ? `${name} lost presence (timed out)`
          : `${name} left the chat`
      );
      this.emit("room", { type: "leave", data: agent } as RoomEvent);
    }
  }

  /** Resolve an open ask on a message. Returns the message, or null when
   *  there is no message or no open ask to resolve. */
  resolveAsk(messageId: number, by: string): ChatMessage | null {
    const msg = this.messages.find((m) => m.id === messageId);
    if (!msg || !msg.ask || msg.ask.state !== "open") return null;
    const at = Date.now();
    msg.ask.state = "resolved";
    msg.ask.resolvedBy = by;
    msg.ask.resolvedAt = at;
    if (this.onAskResolve) this.onAskResolve(messageId, by, at);
    this.emit("room", { type: "ask-resolved", data: { id: messageId, by, at } } as unknown as RoomEvent);
    return msg;
  }

  /** Replay persisted ask resolutions after JSONL load (latest wins). */
  applyAskRecords(records: { messageId: number; resolvedBy: string; at: number }[]): void {
    const latest = new Map<number, { resolvedBy: string; at: number }>();
    for (const r of records) latest.set(r.messageId, { resolvedBy: r.resolvedBy, at: r.at });
    for (const [id, r] of latest) {
      const msg = this.messages.find((m) => m.id === id);
      if (msg?.ask) {
        msg.ask.state = "resolved";
        msg.ask.resolvedBy = r.resolvedBy;
        msg.ask.resolvedAt = r.at;
      }
    }
  }

  /** Open asks, optionally only those addressed to one name. */
  openAsks(forName?: string): ChatMessage[] {
    return this.messages.filter(
      (m) =>
        m.ask?.state === "open" &&
        (!forName || m.ask.for.toLowerCase() === forName.toLowerCase())
    );
  }

  send(sender: string, text: string, opts?: { image?: string; replyTo?: number; to?: string[]; choices?: string[]; askFor?: string }): ChatMessage {
    const msg: ChatMessage = {
      id: this.nextId++,
      sender,
      text,
      timestamp: Date.now(),
    };
    if (opts?.image) msg.image = opts.image;
    if (opts?.replyTo) msg.replyTo = opts.replyTo;
    if (opts?.to && opts.to.length > 0) msg.to = opts.to;
    if (opts?.choices && opts.choices.length > 0) msg.choices = opts.choices;
    if (opts?.askFor && opts.askFor.trim().length > 0) {
      msg.ask = { for: opts.askFor.trim(), state: "open" };
    }

    this.messages.push(msg);
    this.persist(msg);
    this.emit("room", { type: "message", data: msg } as RoomEvent);

    // Update lastSeen + lastPostAt + clear typing
    const senderAgent = this.agents.get(sender);
    if (senderAgent) { senderAgent.lastSeen = Date.now(); senderAgent.lastPostAt = Date.now(); }
    this.setTyping(sender, false);

    // Turn guard: track consecutive agent turns
    if (sender !== "system") {
      if (this.agents.has(sender)) {
        this.agentTurnCount++;
      } else {
        // Human message resets the counter
        this.agentTurnCount = 0;
      }
    }

    // Detect @mentions → inject into agents IN THIS CONVERSATION
    const mentions = this.extractMentions(text);
    const targets = mentions.includes("all")
      ? [...this.agents.keys()].filter((n) => n !== sender)
      : mentions;

    // Turn guard: suppress injection if limit reached
    if (this.turnGuard && this.turnGuard.enabled && this.agentTurnCount >= this.turnGuard.limit) {
      if (targets.length > 0 && sender !== "system") {
        this.addSystem(`Turn limit reached (${this.turnGuard.limit} turns). Send a message to continue.`);
        this.emit("room", { type: "turn-guard", data: { count: this.agentTurnCount, limit: this.turnGuard.limit } } as unknown as RoomEvent);
      }
    } else {
      for (const target of targets) this.queueWake(sender, target);
    }

    console.log(`  [#${msg.id} ${sender}] ${text}`);
    return msg;
  }

  private warnKey(name: string): string {
    return `${this.wakeScope}:${name}`;
  }

  /**
   * Batch mentions: collect for 2s before injecting to reduce noise. A
   * target whose wake is already queued or executing is not queued again;
   * a mention that lands mid-flight earns exactly one follow-up wake, since
   * the injected prompt reads from the agent's cursor and covers everything
   * that arrived meanwhile.
   */
  private queueWake(sender: string, target: string): void {
    if (this.destroyed || this.pendingMentions.has(target)) return;
    if (this.wakesInFlight.has(target)) { this.rewakeAfter.add(target); return; }
    const timeout = setTimeout(() => {
      this.pendingMentions.delete(target);
      this.wakeAgent(sender, target).catch((err) => {
        console.error(`  ✗ Mention injection error: ${err}`);
      });
    }, 2000);
    this.pendingMentions.set(target, timeout);
  }

  protected buildWakePrompt(sender: string, agent: Agent, roomLabel?: string): string {
    const base = this.injectBaseUrl ?? INJECT_BASE_URL;
    const where = roomLabel ? ` in ${roomLabel}` : "";
    const roleHint = agent.role ? ` Your role: ${agent.role}.` : "";
    const pidParam = agent.pid ? `&pid=${agent.pid}` : "";
    // A pane identifies the agent only together with its GUI instance.
    const paneParam = agent.weztermPaneId != null && agent.weztermGui != null ? `&paneId=${agent.weztermPaneId}&weztermGui=${agent.weztermGui}` : "";
    // A handle-only registration is found by its handle (the read and send
    // routes match it before pid and pane); handles are term_<id>, URL-safe.
    const orcaParam = agent.orcaTerminal ? `&orcaTerminal=${encodeURIComponent(agent.orcaTerminal)}` : "";
    const pidBody = (agent.pid ? `,"pid":${agent.pid}` : "") +
      (agent.weztermPaneId != null && agent.weztermGui != null ? `,"paneId":${agent.weztermPaneId},"weztermGui":${agent.weztermGui}` : "") +
      (agent.orcaTerminal ? `,"orcaTerminal":${JSON.stringify(agent.orcaTerminal)}` : "");
    const since = this.getCursor(agent.name);
    return (
      `[joind] @${agent.name} mentioned by ${sender}${where}.${roleHint} ` +
      `Read: curl -s "${base}/api/agent/read?sender=${agent.name}&since=${since}${pidParam}${paneParam}${orcaParam}" then ` +
      `Reply: curl -s -X POST ${base}/api/agent/send -H "Content-Type: application/json" ` +
      `-d '{"sender":"${agent.name}","text":"YOUR_REPLY"${pidBody}}'`
    );
  }

  /**
   * Wake one agent. The terminal and the prompt are resolved when the wake
   * actually executes, not when it was queued: an agent that left meanwhile
   * is skipped, one that rejoined from a new terminal is queued again under
   * that terminal's key, and the prompt always names the pid it goes to.
   */
  private async wakeAgent(sender: string, name: string): Promise<void> {
    if (this.destroyed) return;
    const queued = this.agents.get(name);
    if (!queued?.active || name === sender) return;
    // A hosted member's terminal is on its host: route, never inject here.
    if (queued.host) return this.wakeHostedMember(sender, name, queued);
    this.wakesInFlight.add(name);
    let moved = false;
    try {
      const { outcome, partialLine } = await this.wakeCore(sender, name, queued, (agent) => this.buildWakePrompt(sender, agent));
      if (outcome.ok) {
        moved = outcome.result === "moved";
        if (partialLine && !this.destroyed && this.agents.has(name)) {
          this.addSystem(wakeFailureLine(name, "partial", undefined));
        }
      } else {
        console.error(`  ✗ Injection failed for ${name} (${outcome.kind}, ${outcome.attempts} attempt(s)): ${outcome.reason}`);
        // Tell the room: a mention that did not land must not look landed.
        // (Not after teardown: a late line would recreate the deleted log.)
        if (outcome.warn && !this.destroyed && this.agents.has(name)) {
          this.addSystem(wakeFailureLine(name, outcome.kind, outcome.reason));
        }
      }
    } finally {
      this.wakesInFlight.delete(name);
    }
    if (this.destroyed) return;
    if (moved) return this.wakeAgent(sender, name);
    if (this.rewakeAfter.delete(name)) this.queueWake(sender, name);
  }

  /**
   * One run of the local wake machinery for `queued`, serialized on every
   * key of its terminal, with the pre-type, fallback and post-text guards.
   * The caller says what the room hears; this only reports what happened.
   */
  private async wakeCore(sender: string, name: string, queued: Agent, promptFor: (agent: Agent) => string): Promise<WakeCoreResult> {
    const identity = terminalIdentity(queued);
    const held = new Set(lockKeysFor(queued));
    // Set by the post-text guard: the text is in the terminal and the agent's
    // registration changed to what is still that terminal. Never replay; say so.
    let partialLine = false;
    const outcome = await wakes.run([...held], this.warnKey(name), async () => {
      const agent = this.agents.get(name);
      if (this.destroyed || !agent?.active) return "skip";
      if (terminalIdentity(agent) !== identity) return "moved";
      // Terminal equivalence can grow while a wake waits its turn (a
      // registration pairing this pid with a pane came back). Never inject
      // holding fewer keys than the terminal now needs: queue again under
      // the full set instead.
      if (lockKeysFor(agent).some((k) => !held.has(k))) return "moved";
      const prompt = promptFor(agent);
      partialLine = false;
      console.log(`  → Injecting into ${name} (${identity})...`);
      try {
        await inject(agent.pid, prompt, agent.weztermPaneId, getWeztermPath(), agent.weztermGui != null ? undefined : getWeztermEnv(), undefined, {
          // A pane of a known GUI goes through that GUI's socket only; a GUI
          // that is gone fails the WezTerm route (guarded console fallback).
          weztermGui: agent.weztermGui,
          // Orca's own input path first when the join bound a handle.
          orcaTerminal: agent.orcaTerminal,
          // Between the Orca or WezTerm failure and the console fallback the target
          // must still be this session; otherwise skip or re-queue.
          fallbackGuard: () => {
            const live = this.agents.get(name);
            if (this.destroyed || !live?.active) return "skip";
            if (terminalIdentity(live) !== identity) return "moved";
            // Same rule as before the first attempt: if the terminal now
            // needs locks this wake does not hold, queue again under the full set.
            if (lockKeysFor(live).some((k) => !held.has(k))) return "moved";
            return "proceed";
          },
          // Once the text is in the terminal the same attempt finishes the
          // submission (the delayed second Enter and its one recovery), over
          // the route that typed it, under the locks it already holds.
          //
          // Lock growth is ignored here on purpose. This attempt still holds
          // every lock it took, so no other wake of ours can type into the
          // terminal it typed into until it releases them; a registration
          // that joined meanwhile can only add keys that lead to that same
          // terminal. Stopping now would leave a prompt half-typed, and a
          // later wake for this or another agent would type behind it: the
          // worse outcome. Only two things stop it:
          afterTextGuard: () => {
            const live = this.agents.get(name);
            if (this.destroyed || !live?.active) {
              // The agent left: nobody to submit for. The text stays.
              console.log(`  [wake] ${name} left after the prompt reached ${identity}; the unsent text remains in that terminal`);
              return "skip";
            }
            if (terminalIdentity(live) === identity) return "proceed";
            // The registration changed. Same terminal (by lock equivalence,
            // transitively through live registrations): never replay, warn.
            if (sameTerminal(held, live)) {
              console.log(`  [wake] ${name}'s registration changed (${identity} -> ${terminalIdentity(live)}) but it is the terminal holding the prompt; not typing it again`);
              partialLine = true;
              return "skip";
            }
            // A different terminal: the old one keeps the unsent text; the
            // new one gets a fresh wake once this attempt releases its locks.
            console.log(`  [wake] ${name} moved to a different terminal (${terminalIdentity(live)}) after the prompt reached ${identity}; that terminal keeps the unsent text; waking the new one`);
            return "moved";
          },
        });
      } catch (err) {
        if (err instanceof WakeFallbackAborted) return err.result;
        throw err;
      }
      // Brief delay to let Windows console state settle before the next one
      if (process.platform === "win32") {
        await new Promise((r) => setTimeout(r, 300));
      }
      return "done";
    });
    return { outcome, partialLine };
  }

  /**
   * Wake a hosted member: its terminal is on its host, so the request goes
   * over the link and the host runs its own wake machinery (coordinator,
   * guards, retries, classification). This server holds no lock and types
   * nothing. A failure gets the same honest line as a local wake, naming the
   * host; a host that cannot be reached is said once per streak. Wake
   * requests are never queued: an unroutable mention is said, not kept.
   */
  private async wakeHostedMember(sender: string, name: string, agent: Agent): Promise<void> {
    const host = agent.host ?? "";
    const hostedRegistration = hostedRegistrations.get(agent);
    this.wakesInFlight.add(name);
    let result: HostedWakeResult;
    try {
      if (!this.hostedWaker || !hostedRegistration || !this.homeId) {
        result = { ok: false, kind: "unreachable", attempts: 0, reason: `no link to ${host} is configured on this server` };
      } else {
        console.log(`  -> Routing wake for ${name} to host ${host}...`);
        result = await this.hostedWaker({ host, room: this.homeId, name, hostedRegistration, sender, prompt: `@${name} mentioned by ${sender}` })
          .catch((err: unknown): HostedWakeResult => ({ ok: false, kind: "unreachable", attempts: 1, reason: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      this.wakesInFlight.delete(name);
    }
    if (this.destroyed) return;
    // Only for the session the request was made for: a member that left or
    // rejoined meanwhile is not told about an old session's failure.
    const live = this.agents.get(name);
    const sameSession = live === agent && live.host === host && hostedRegistrations.get(live) === hostedRegistration;
    if (sameSession) {
      if (result.ok) {
        this.hostedUnreachable.delete(name);
      } else {
        console.error(`  x Hosted wake failed for ${name} on ${host} (${result.kind}, ${result.attempts} attempt(s)): ${result.reason}`);
        const unreachable = result.kind === "unreachable";
        const warn = unreachable ? !this.hostedUnreachable.has(name) : result.warn !== false;
        if (unreachable) this.hostedUnreachable.add(name); else this.hostedUnreachable.delete(name);
        if (warn) this.addSystem(wakeFailureLine(name, result.kind, result.reason, host));
      }
    }
    if (this.rewakeAfter.delete(name)) this.queueWake(sender, name);
  }

  /**
   * The host side of a hosted wake: a linked home server asked this server
   * to wake its local member `name`, registered here as `registration` (the
   * id the home server holds as the hosted registration). The member's own
   * terminal, locks, guards and retries apply exactly as for a local
   * mention; nothing is said in this room (the home server posts the line).
   * `roomLabel` names the home room in the prompt.
   */
  async wakeForPeer(sender: string, name: string, registration: string, roomLabel: string): Promise<HostedWakeResult> {
    for (let round = 0; round < 5; round++) {
      const agent = this.agents.get(name);
      if (this.destroyed || !agent?.active || agent.host || memberRegistrations.get(agent) !== registration) {
        return { ok: false, kind: "no-console", attempts: 0, warn: true, reason: `${name} is not registered on this host (left, or rejoined with a new registration)` };
      }
      this.wakesInFlight.add(name);
      let core: WakeCoreResult;
      try {
        core = await this.wakeCore(sender, name, agent, (live) => this.buildWakePrompt(sender, live, roomLabel));
      } finally {
        this.wakesInFlight.delete(name);
      }
      const { outcome, partialLine } = core;
      if (!outcome.ok) {
        return { ok: false, kind: outcome.kind, attempts: outcome.attempts, reason: outcome.reason, warn: outcome.warn };
      }
      if (partialLine) return { ok: false, kind: "partial", attempts: outcome.attempts, warn: true, reason: "the text is in the input box" };
      if (outcome.result === "done") return { ok: true, attempts: outcome.attempts };
      if (outcome.result === "skip") return { ok: false, kind: "no-console", attempts: outcome.attempts, warn: true, reason: `${name} left this host before the wake ran` };
      // "moved": the member now lives in a different terminal; wake that one.
    }
    return { ok: false, kind: "transient", attempts: 5, warn: true, reason: "the member kept moving between terminals" };
  }

  read(since?: number, limit = 50, from?: string, viewer?: string): ChatMessage[] {
    let msgs = this.messages;
    if (since != null) {
      msgs = msgs.filter((m) => m.id > since);
    }
    if (from) {
      msgs = msgs.filter((m) => m.sender === from);
    }
    // Filter DMs (fail closed): targeted messages are shown only to the
    // sender and named recipients; with no viewer they are hidden.
    msgs = msgs.filter((m) => visibleToViewer(m, viewer));
    return msgs.slice(-limit);
  }

  /** Full unfiltered history. Reserved for exports; UI reads must use read(viewer). */
  readAll(limit = 10000, from?: string): ChatMessage[] {
    let msgs = this.messages;
    if (from) {
      msgs = msgs.filter((m) => m.sender === from);
    }
    return msgs.slice(-limit);
  }

  getMessageById(id: number): ChatMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  deleteMessage(id: number): boolean {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.messages.splice(idx, 1);
    // Rewrite JSONL without the deleted message
    if (this.chatFile) {
      ensureDir(dirname(this.chatFile));
      const content = this.messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      writeFileSync(this.chatFile, content, "utf-8");
    }
    this.emit("room", { type: "message-deleted", data: { id } } as unknown as RoomEvent);
    console.log(`  [delete] Message #${id} removed`);
    return true;
  }

  who(): Agent[] {
    return [...this.agents.values()];
  }

  whoNames(): string[] {
    return [...this.agents.keys()];
  }

  getAgent(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  touch(name: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      const now = Date.now();
      const wasStale = (now - agent.lastSeen) > 120000;
      agent.lastSeen = now;
      if (wasStale) {
        // Agent came back from stale: emit join event to refresh pill state
        this.emit("room", { type: "join", data: agent } as RoomEvent);
      } else {
        // Keep the UI's cached timestamps live (pill ages are computed client-side).
        const update: PresenceUpdate = { name, lastSeen: now, lastPostAt: agent.lastPostAt, at: now };
        this.emit("room", { type: "presence", data: update } as RoomEvent);
      }
    }
  }

  setTyping(name: string, isTyping: boolean): void {
    const existing = this.typingState.get(name);
    if (existing) {
      clearTimeout(existing);
      this.typingState.delete(name);
    }

    if (isTyping) {
      const timeout = setTimeout(() => {
        this.typingState.delete(name);
        this.emit("room", { type: "typing", data: { name, typing: false } } as RoomEvent);
      }, 30000);
      this.typingState.set(name, timeout);
    }

    this.emit("room", { type: "typing", data: { name, typing: isTyping } } as RoomEvent);
  }

  protected sweepStale(): void {
    const now = Date.now();
    for (const [name, agent] of this.agents) {
      const elapsed = now - agent.lastSeen;
      if (elapsed <= 120000) continue;
      if (agent.host) {
        // A hosted member's pid is on its host and means nothing here; its
        // host forwards its presence. Silent: dim it. It is never removed
        // here: its host says when it leaves, and a host that went away is
        // announced by the peer monitor instead.
        this.emit("room", { type: "stale", data: agent } as RoomEvent);
        continue;
      }
      // Silent past two minutes: dim the pill either way. A pid the server
      // can verify alive (local process) is never removed; a pid it cannot
      // verify (remote or GUI-resident agent) gets the grace window, not
      // instant eviction, because "working on a long operation" and "gone"
      // look identical from here.
      let pidAlive = false;
      try {
        process.kill(agent.pid, 0); // signal 0 = existence check, doesn't kill
        pidAlive = true;
      } catch { /* unknown or dead pid */ }
      if (pidAlive || elapsed <= DEFAULT_PRESENCE_GRACE_MS) {
        this.emit("room", { type: "stale", data: agent } as RoomEvent);
      } else {
        this.leave(name, "timeout");
      }
    }
  }

  /** The registration id of this room's member of that name (the id the
   *  join issued; it follows the member through a rename). */
  registrationOf(name: string): string | undefined {
    const agent = this.agents.get(name);
    return agent ? memberRegistrations.get(agent) : undefined;
  }

  rename(oldName: string, newName: string): Agent | null {
    const agent = this.agents.get(oldName);
    if (!agent) return null;
    this.agents.delete(oldName);
    agent.name = newName;
    this.agents.set(newName, agent);
    // The wake record follows the agent: the old key is reclaimed, the new
    // one starts clean under the same terminal.
    liveTerminals.delete(this.warnKey(oldName));
    wakes.release(this.warnKey(oldName));
    liveTerminals.set(this.warnKey(newName), terminalRefOf(agent));
    wakes.forget(this.warnKey(newName));
    this.addSystem(`${oldName} is now ${newName}`);
    this.emit("room", { type: "rename", data: { oldName, newName, agent } });
    return agent;
  }

  setRole(name: string, role: string): Agent | null {
    const agent = this.agents.get(name);
    if (!agent) return null;
    agent.role = role || undefined;
    if (role) {
      this.addSystem(`${name} is now: ${role}`);
    } else {
      this.addSystem(`${name} cleared their role`);
    }
    this.emit("room", { type: "role", data: agent });
    return agent;
  }

  setStatus(name: string, status: string): Agent | null {
    const agent = this.agents.get(name);
    if (!agent) return null;
    agent.status = status || undefined;
    // Auto-clear status after 10 minutes
    const existing = this.statusTimeouts.get(name);
    if (existing) clearTimeout(existing);
    if (status) {
      const timeout = setTimeout(() => {
        agent.status = undefined;
        this.statusTimeouts.delete(name);
        this.emit("room", { type: "agent-status", data: agent } as unknown as RoomEvent);
      }, 600000);
      this.statusTimeouts.set(name, timeout);
    } else {
      this.statusTimeouts.delete(name);
    }
    this.emit("room", { type: "agent-status", data: agent } as unknown as RoomEvent);
    return agent;
  }

  search(query: string, limit = 20, viewer?: string): Array<{ message: ChatMessage; matchIndex: number }> {
    const q = query.toLowerCase();
    const results: Array<{ message: ChatMessage; matchIndex: number }> = [];
    // Reverse iteration — newest first
    for (let i = this.messages.length - 1; i >= 0 && results.length < limit; i--) {
      const m = this.messages[i];
      const idx = m.text.toLowerCase().indexOf(q);
      // Fail closed: targeted messages are hidden without a viewer
      if (idx >= 0 && visibleToViewer(m, viewer)) {
        results.push({ message: m, matchIndex: idx });
      }
    }
    return results;
  }

  updateMessageText(messageId: number, newText: string): ChatMessage | null {
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) return null;
    msg.text = newText;
    return msg;
  }

  tagMessage(messageId: number, tag: string): ChatMessage | null {
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) return null;
    msg.tag = tag || undefined;
    this.onTag?.(messageId, tag || "", Date.now());
    return msg;
  }

  /** Replay persisted tags onto loaded messages. Latest record per messageId wins; empty clears. */
  applyTagRecords(records: { messageId: number; tag: string }[]): void {
    const latest = new Map<number, string>();
    for (const r of records) latest.set(r.messageId, r.tag);
    for (const [messageId, tag] of latest) {
      const msg = this.messages.find(m => m.id === messageId);
      if (msg) msg.tag = tag || undefined;
    }
  }

  pinMessage(messageId: number, pinned: boolean): ChatMessage | null {
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) return null;
    msg.pinned = pinned;
    this.onPin?.(messageId, pinned, Date.now());
    this.emit("room", { type: "message-pinned", data: { id: messageId, pinned } } as unknown as RoomEvent);
    return msg;
  }

  /** Replay persisted pin state onto loaded messages. Latest record per messageId wins. */
  applyPinRecords(records: { messageId: number; pinned: boolean }[]): void {
    const latest = new Map<number, boolean>();
    for (const r of records) latest.set(r.messageId, r.pinned);
    for (const [messageId, pinned] of latest) {
      const msg = this.messages.find(m => m.id === messageId);
      if (msg) msg.pinned = pinned;
    }
  }

  chooseMessage(messageId: number, value: string, by: string): ChatMessage | null {
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) return null;
    if (!msg.choices || !msg.choices.includes(value)) return null;
    if (msg.choiceResponse) {
      // First answer wins, but a retry after an interrupted persist may
      // still owe the ask its resolution.
      if (msg.ask?.state === "open") this.resolveAsk(messageId, by);
      return msg;
    }
    const at = Date.now();
    msg.choiceResponse = { value, by, at };
    this.onChoice?.(messageId, value, by, at);
    this.emit("room", { type: "message-choice", data: { id: messageId, response: msg.choiceResponse } } as unknown as RoomEvent);
    // Picking an option IS the decision: a message that carries both choices
    // and an open ask resolves the ask in the same click, so a human never
    // has to answer twice (field report, cpm-engine, 2026-09-22).
    if (msg.ask?.state === "open") this.resolveAsk(messageId, by);
    return msg;
  }

  /** Replay persisted choice resolutions onto loaded messages. First record per messageId wins. */
  applyChoiceRecords(records: { messageId: number; value: string; by: string; at: number }[]): void {
    const seen = new Set<number>();
    for (const r of records) {
      if (seen.has(r.messageId)) continue;
      const msg = this.messages.find(m => m.id === r.messageId);
      if (!msg || !msg.choices || !msg.choices.includes(r.value)) continue;
      msg.choiceResponse = { value: r.value, by: r.by, at: r.at };
      // A recorded choice answers any ask on the same message. The choice
      // sidecar is written before the ask sidecar, so a crash between the
      // two must not replay as "chosen but still open".
      if (msg.ask?.state === "open") {
        msg.ask.state = "resolved";
        msg.ask.resolvedBy = r.by;
        msg.ask.resolvedAt = r.at;
      }
      seen.add(r.messageId);
    }
  }

  getPinnedMessages(): ChatMessage[] {
    return this.messages.filter(m => m.pinned);
  }

  addSessionMarker(markerType: "start" | "end", label?: string): ChatMessage {
    const text = markerType === "start"
      ? `--- Session started${label ? ": " + label : ""} ---`
      : `--- Session ended${label ? ": " + label : ""} ---`;
    return this.addSystem(text);
  }

  messageCount(): number {
    return this.messages.length;
  }

  getAgentTurnCount(): number {
    return this.agentTurnCount;
  }

  resetTurnCount(): void {
    this.agentTurnCount = 0;
  }

  addSystem(text: string): ChatMessage {
    const msg: ChatMessage = {
      id: this.nextId++,
      sender: "system",
      text,
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    this.persist(msg);
    this.emit("room", { type: "message", data: msg } as RoomEvent);
    console.log(`  [system] ${text}`);
    return msg;
  }

  private extractMentions(text: string): string[] {
    const matches = text.match(/@(\w[\w-]*)/g);
    if (!matches) return [];
    return matches.map((m) => m.slice(1));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.staleInterval) clearInterval(this.staleInterval);
    for (const t of this.typingState.values()) clearTimeout(t);
    for (const t of this.statusTimeouts.values()) clearTimeout(t);
    for (const t of this.pendingMentions.values()) clearTimeout(t);
    this.pendingMentions.clear();
    this.rewakeAfter.clear();
    this.wakesInFlight.clear();
    // No queued or in-flight wake may inject, warn or re-queue after this.
    for (const agent of this.agents.values()) {
      agent.active = false;
      liveTerminals.delete(this.warnKey(agent.name));
      wakes.release(this.warnKey(agent.name));
    }
    this.agents.clear();
    cancelRoomListens(this);
  }
}

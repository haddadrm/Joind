/**
 * ChatRoom — a single conversation with its own messages, agents, and JSONL file.
 * Multiple ChatRoom instances exist simultaneously, managed by ConversationManager.
 */

import { EventEmitter } from "events";
import { writeFileSync } from "fs";
import { dirname } from "path";
import { inject } from "./inject.js";
import { cancelRoomListens } from "./listen.js";
import { WakeCoordinator } from "./wake.js";

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
/** Every identity known for a terminal. A wake holds all of them, so a room
 *  that registered the session pid-only and a room that registered it with
 *  its pane still serialize on the shared pid. */
export function terminalKeys(agent: { pid: number; weztermPaneId?: number }): string[] {
  const keys: string[] = [];
  if (agent.pid > 0) keys.push(`pid:${agent.pid}`);
  if (agent.weztermPaneId != null) keys.push(`pane:${agent.weztermPaneId}`);
  return keys.length > 0 ? keys : ["pid:0"];
}
/** Session identity: any change of pid or pane is a different terminal. */
export function terminalIdentity(agent: { pid: number; weztermPaneId?: number }): string {
  return terminalKeys(agent).join("|");
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

export class ChatRoom extends EventEmitter {
  private messages: ChatMessage[] = [];
  private agents = new Map<string, Agent>();
  private nextId = 1;
  private typingState = new Map<string, NodeJS.Timeout>();
  private statusTimeouts = new Map<string, NodeJS.Timeout>();
  private pendingMentions = new Map<string, NodeJS.Timeout>(); // batched mention injection
  private wakesInFlight = new Set<string>();  // targets whose wake is executing right now
  private rewakeAfter = new Set<string>();    // mentioned again while in flight: wake once more
  /** Warning state for wake failures is per room and agent, not per name. */
  private readonly wakeScope = `r${++roomSeq}`;
  private destroyed = false;
  private chatFile: string | null = null;
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

  join(name: string, pid: number, weztermPaneId?: number, persistedRole?: string): Agent {
    const existing = this.agents.get(name);
    if (existing) {
      const now = Date.now();
      const previousIdentity = terminalIdentity(existing);
      const pidChanged = existing.pid !== pid;
      // A different pid means a new session resumed the same identity;
      // readers deserve to know it is a fresh worker, not the old one, and
      // the old worker's proof of life does not carry over.
      if (pidChanged) {
        this.addSystem(`${name} rejoined (new session)`);
        existing.joinedAt = now;
        existing.lastPostAt = undefined;
      }
      existing.active = true;
      existing.pid = pid;
      if (weztermPaneId != null) existing.weztermPaneId = weztermPaneId;
      if (!existing.role && persistedRole) existing.role = persistedRole;
      existing.lastSeen = now;
      // Any change of terminal identity (pid or pane) is a fresh wake path:
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
      weztermPaneId,
    };
    this.agents.set(name, agent);
    wakes.forget(this.warnKey(name)); // a new session starts with a clean wake record
    this.addSystem(`${name} joined the chat`);
    this.emit("room", { type: "join", data: agent } as RoomEvent);
    return agent;
  }

  leave(name: string, reason: "deliberate" | "timeout" = "deliberate"): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.active = false;
      this.agents.delete(name);
      wakes.release(this.warnKey(name));
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

  private buildWakePrompt(sender: string, agent: Agent): string {
    const roleHint = agent.role ? ` Your role: ${agent.role}.` : "";
    const pidParam = agent.pid ? `&pid=${agent.pid}` : "";
    const paneParam = agent.weztermPaneId != null ? `&paneId=${agent.weztermPaneId}` : "";
    const pidBody = agent.pid ? `,"pid":${agent.pid}` : "";
    const since = this.getCursor(agent.name);
    return (
      `[joind] @${agent.name} mentioned by ${sender}.${roleHint} ` +
      `Read: curl -s "${INJECT_BASE_URL}/api/agent/read?sender=${agent.name}&since=${since}${pidParam}${paneParam}" then ` +
      `Reply: curl -s -X POST ${INJECT_BASE_URL}/api/agent/send -H "Content-Type: application/json" ` +
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
    const identity = terminalIdentity(queued);
    this.wakesInFlight.add(name);
    let moved = false;
    try {
      const outcome = await wakes.run(terminalKeys(queued), this.warnKey(name), async () => {
        const agent = this.agents.get(name);
        if (this.destroyed || !agent?.active) return "skip";
        if (terminalIdentity(agent) !== identity) return "moved";
        const prompt = this.buildWakePrompt(sender, agent);
        console.log(`  → Injecting into ${name} (${identity})...`);
        await inject(agent.pid, prompt, agent.weztermPaneId, getWeztermPath(), getWeztermEnv());
        // Brief delay to let Windows console state settle before the next one
        if (process.platform === "win32") {
          await new Promise((r) => setTimeout(r, 300));
        }
        return "done";
      });
      if (outcome.ok) {
        moved = outcome.result === "moved";
      } else {
        console.error(`  ✗ Injection failed for ${name} (${outcome.kind}, ${outcome.attempts} attempt(s)): ${outcome.reason}`);
        // Tell the room: a mention that did not land must not look landed.
        // (Not after teardown: a late line would recreate the deleted log.)
        if (outcome.warn && !this.destroyed && this.agents.has(name)) {
          this.addSystem(
            outcome.kind === "no-console"
              ? `Could not wake ${name}: no console reachable from this server (remote session, or joined without its real terminal pid). They will see mentions only when they read on their own schedule.`
              : `Could not wake ${name} just now (terminal injection failed after a retry). They will see this on their next read.`
          );
        }
      }
    } finally {
      this.wakesInFlight.delete(name);
    }
    if (this.destroyed) return;
    if (moved) return this.wakeAgent(sender, name);
    if (this.rewakeAfter.delete(name)) this.queueWake(sender, name);
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

  private sweepStale(): void {
    const now = Date.now();
    for (const [name, agent] of this.agents) {
      const elapsed = now - agent.lastSeen;
      if (elapsed <= 120000) continue;
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

  rename(oldName: string, newName: string): Agent | null {
    const agent = this.agents.get(oldName);
    if (!agent) return null;
    this.agents.delete(oldName);
    agent.name = newName;
    this.agents.set(newName, agent);
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
      wakes.release(this.warnKey(agent.name));
    }
    this.agents.clear();
    cancelRoomListens(this);
  }
}

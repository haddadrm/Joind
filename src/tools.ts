/**
 * Joind MCP Tools — conversation-scoped chat tools.
 *
 * Agents join a specific conversation. All subsequent tool calls
 * route to that conversation. Different conversations are isolated.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConversationManager, isTerminalLess, newRegistrationId, type AgentBindingEntry, type TerminalAliases } from "./manager.js";
import { waitForMessage, clampListenTimeout } from "./listen.js";
import { visibleToViewer } from "./room.js";
import { MirrorRoom, type WriteResult } from "./mirror.js";
import type { RemoteRegistered, RemoteRooms } from "./peer-types.js";
import type { TaskStore } from "./tasks.js";
import type { ReactionStore } from "./reactions.js";
import type { CursorStore } from "./cursors.js";
import type { EditStore } from "./edits.js";
import { checkWezTerm, discoverWezTerm, getWeztermPath, getWeztermEnv, liveServerSocket, resolveWezTermExe, weztermEnvForGui, listWezTermPaneIds, isInsideWezTerm, isInsideOrca, processTreeOnce, socketForGui, socketGuiPid, weztermGuiOf, type ProcessEntry } from "./terminals.js";
import { listOrcaTerminals, ORCA_HANDLE, type OrcaTerminalState } from "./orca.js";

const execFileAsync = promisify(execFile);

/** Dependencies of resolvePaneForJoin, injectable for tests. */
export interface PaneResolverDeps {
  /** The WezTerm GUI instance the pid runs in (its wezterm-gui pid). */
  guiOf: (pid: number) => Promise<number | false | "unknown">;
  /** That GUI's socket, when the GUI is alive and the socket exists. */
  socketForGui: (gui: number) => string | undefined;
  /** Live panes of one GUI instance, through its socket. */
  listPaneIds: (socket: string) => Promise<Set<number>>;
  /** Auto-detection inside one GUI instance, through its socket, counting
   *  only the panes already claimed in that same instance. */
  autoDetect: (socket: string, gui: number) => Promise<number | undefined>;
  /** Resolve the wezterm executable, independently of any GUI being reachable. */
  ensureExe?: () => Promise<boolean>;
  log?: (line: string) => void;
}

/** Outcome of pane resolution. `paneId` null means: clear any pane this
 *  agent held before (the rejoin proved it stale); undefined means: nothing
 *  learned. `gui` is the GUI instance the pid runs in, when known: a bound
 *  pane always carries it, and with an undefined pane it tells the binding to
 *  keep an old pane only when that pane is in this same GUI. */
export interface PaneResolution {
  paneId: number | null | undefined;
  note?: string;
  gui?: number;
}

/**
 * Decide which WezTerm pane, if any, a joining agent is bound to. A pane is
 * only ever the pair (GUI instance, pane number): pane ids are per WezTerm
 * GUI, so a bare number identifies nothing (gate round 2 on
 * feat/wezterm-submit: every defect it found came from panes whose GUI was
 * unknown sitting beside GUI-keyed ones).
 *
 * The GUI comes from the joining pid's wezterm-gui ancestor, or, for the UI
 * invite route only (`discoveredGui`), from the GUI whose socket the
 * server's discovery ran through. A pane is bound only when that GUI is
 * known, its socket is reachable, and the pane is live in it. A join that
 * names a pane but has no pid, or whose pid has no WezTerm GUI above it,
 * binds no pane (null, so any old pane is cleared). A known GUI whose socket
 * is not reachable fails resolution outright; nothing falls through to the
 * server's default GUI. Auto-detection runs only inside the agent's own GUI.
 */
export async function resolvePaneForJoin(
  name: string, pid: number, requested: number | undefined, deps: PaneResolverDeps, discoveredGui?: number
): Promise<PaneResolution> {
  const log = deps.log ?? ((line: string) => console.log(`  [wezterm] ${line}`));
  const drop = (note: string): PaneResolution => { log(note); return { paneId: null, note }; };
  const pidGui = pid > 0 ? await deps.guiOf(pid) : "unknown";

  if (requested != null) {
    let gui: number;
    if (typeof pidGui === "number") {
      if (discoveredGui != null && discoveredGui !== pidGui) {
        return drop(`pane ${requested} belongs to another WezTerm instance (gui pid ${discoveredGui}); ${name} runs in gui pid ${pidGui}`);
      }
      gui = pidGui;
    } else if (pidGui === "unknown" && discoveredGui != null) {
      gui = discoveredGui;
    } else {
      return drop(`pane ${requested} ignored for ${name}: its WezTerm instance cannot be determined`);
    }
    const own = deps.socketForGui(gui);
    if (!own) return drop(`pane ${requested} ignored for ${name}: its WezTerm instance (gui pid ${gui}) has no reachable socket`);
    if (deps.ensureExe && !(await deps.ensureExe())) return drop(`pane ${requested} ignored for ${name}: no wezterm executable found on this server`);
    const live = await deps.listPaneIds(own);
    if (!live.has(requested)) return drop(`pane ${requested} ignored for ${name}: not a live pane of its WezTerm instance (gui pid ${gui})`);
    return { paneId: requested, gui };
  }

  // No pane requested.
  if (pidGui === false) return { paneId: null };        // provably outside any WezTerm GUI: an old pane is stale
  if (pidGui === "unknown") return { paneId: undefined }; // nothing to go on
  const gui = pidGui;
  const own = deps.socketForGui(gui);
  if (!own) {
    // The agent is in this GUI and it cannot be reached: no pane at all, and
    // certainly not an old pane of another GUI (gate round 2, finding 3).
    const note = `no pane bound for ${name}: its WezTerm instance (gui pid ${gui}) has no reachable socket`;
    log(note);
    return { paneId: null, note };
  }
  if (deps.ensureExe && !(await deps.ensureExe())) return { paneId: undefined, gui };
  const detected = await deps.autoDetect(own, gui);
  return detected != null ? { paneId: detected, gui } : { paneId: undefined, gui };
}

/** Environment for `wezterm cli` aimed at an agent's pane: its own GUI
 *  instance's socket, the server's default when no GUI is known, or null
 *  when the known GUI is gone (never another GUI's socket). */
export function weztermEnvFor(agent: { weztermGui?: number }): Record<string, string> | null {
  return weztermEnvForGui(agent.weztermGui);
}

/** A per-join process table source (see processTreeOnce), so the WezTerm
 *  and Orca checks of one join share a single enumeration. */
export type ProcessTreeSource = () => Promise<Map<number, ProcessEntry> | null>;

export function defaultPaneResolverDeps(manager: ConversationManager, tree: ProcessTreeSource = processTreeOnce()): PaneResolverDeps {
  return {
    guiOf: (pid) => weztermGuiOf(pid, tree),
    socketForGui: (gui) => socketForGui(gui),
    listPaneIds: (socket) => listWezTermPaneIds(socket),
    autoDetect: (socket, gui) => autoDetectWezTermPane(manager, socket, gui),
    ensureExe: () => resolveWezTermExe(),
  };
}

/** Dependencies of resolveOrcaForJoin, injectable for tests. */
export interface OrcaResolverDeps {
  /** Live Orca terminals by handle, or null when Orca cannot be reached. */
  listTerminals: () => Promise<Map<string, OrcaTerminalState> | null>;
  isInsideOrca: (pid: number) => Promise<boolean | "unknown">;
  /** Whether any binding of this name holds an Orca handle today. */
  holdsHandle: (name: string) => boolean;
  log?: (line: string) => void;
}

/** Outcome of Orca handle resolution: a handle binds, null clears any
 *  handle held before, undefined leaves it as it was. */
export interface OrcaResolution { orcaTerminal: string | null | undefined; note?: string; }

/**
 * Decide which Orca terminal, if any, a joining agent is bound to. Same
 * invariant as the WezTerm pane: a handle is accepted only when Orca lists
 * it as connected and writable AND, when the join carries a pid, that pid
 * runs inside Orca on this host. A handle that fails is dropped with a log
 * line and a note; the join still succeeds on the pid. Orca's listing has no
 * pid, so there is no auto-detection: a join without a handle gets none, and
 * one that rejoins from a pid provably outside Orca, or inside Orca without
 * saying which terminal, clears a handle it held before.
 */
export async function resolveOrcaForJoin(
  name: string, pid: number, requested: unknown, deps: OrcaResolverDeps
): Promise<OrcaResolution> {
  const log = deps.log ?? ((line: string) => console.log(`  [orca] ${line}`));
  const handle = typeof requested === "string" && requested.trim() !== "" ? requested.trim() : undefined;
  if (requested != null && typeof requested !== "string") {
    const note = `orcaTerminal ignored for ${name}: not a string`;
    log(note);
    return { orcaTerminal: null, note };
  }
  if (handle === undefined) {
    // Nothing requested. Only a name that holds a handle has anything to lose;
    // skip the process enumeration otherwise.
    if (pid > 0 && deps.holdsHandle(name)) {
      const inside = await deps.isInsideOrca(pid);
      if (inside !== "unknown") return { orcaTerminal: null };
    }
    return { orcaTerminal: undefined };
  }
  if (!ORCA_HANDLE.test(handle)) {
    const note = `Orca terminal ${JSON.stringify(handle.slice(0, 60))} ignored for ${name}: not an Orca terminal handle`;
    log(note);
    return { orcaTerminal: null, note };
  }
  const live = await deps.listTerminals();
  if (!live) {
    const note = `Orca terminal ${handle} ignored for ${name}: no Orca reachable from this server`;
    log(note);
    return { orcaTerminal: null, note };
  }
  const state = live.get(handle);
  if (!state) {
    const note = `Orca terminal ${handle} ignored for ${name}: not a live Orca terminal`;
    log(note);
    return { orcaTerminal: null, note };
  }
  if (!state.connected || !state.writable) {
    const note = `Orca terminal ${handle} ignored for ${name}: not ${!state.connected ? "connected" : "writable"}`;
    log(note);
    return { orcaTerminal: null, note };
  }
  if (pid > 0) {
    const inside = await deps.isInsideOrca(pid);
    if (inside === false) {
      const note = `Orca terminal ${handle} ignored for ${name}: pid ${pid} does not run inside Orca on this host`;
      log(note);
      return { orcaTerminal: null, note };
    }
    if (inside === "unknown") log(`Orca terminal ${handle} accepted for ${name} unverified: this host cannot enumerate processes`);
  }
  return { orcaTerminal: handle };
}

export function defaultOrcaResolverDeps(manager: ConversationManager, tree: ProcessTreeSource = processTreeOnce()): OrcaResolverDeps {
  return {
    listTerminals: () => listOrcaTerminals(),
    isInsideOrca: (pid) => isInsideOrca(pid, tree),
    holdsHandle: (name) => manager.holdsOrcaTerminal(name),
  };
}

/** The handle a join request names, for the freshness token (before validation). */
export function requestedOrcaHandle(requested: unknown): string | undefined {
  return typeof requested === "string" && ORCA_HANDLE.test(requested.trim()) ? requested.trim() : undefined;
}

/** One line for the MCP join text when a pane or handle was dropped. */
export function joinNotesText(notes: Array<string | undefined>): string {
  const kept = notes.filter((n): n is string => !!n);
  return kept.length > 0
    ? `\nNote: ${kept.join("; ")}. Mentions reach you by console injection (pid) if that works here, otherwise only by chat_listen.`
    : "";
}

/**
 * Auto-detect WezTerm pane ID for a newly joining agent.
 * Finds unclaimed panes (not already assigned to another agent) and returns the best match.
 */
/** The pane numbers already claimed in one GUI instance. A pane number
 *  from another GUI, or one with no GUI, is not a claim here. */
export function claimedPaneNumbers(agents: Iterable<{ weztermPaneId?: number; weztermGui?: number }>, gui: number): Set<number> {
  const out = new Set<number>();
  for (const a of agents) if (a.weztermPaneId != null && a.weztermGui === gui) out.add(a.weztermPaneId);
  return out;
}

async function autoDetectWezTermPane(manager: ConversationManager, socket: string, gui: number): Promise<number | undefined> {
  try {
    const panes = await discoverWezTerm(socket);
    console.log(`  [wezterm] Found ${panes.length} panes: ${panes.map(p => `${p.weztermPaneId}:${p.type}:${p.name}`).join(", ")}`);
    // Panes already claimed IN THIS GUI instance, in any conversation: pane
    // numbers of other GUIs are other panes (gate round 2, finding 4).
    const everyone: Array<{ weztermPaneId?: number; weztermGui?: number }> = [];
    for (const conv of manager.listConversations()) {
      const room = manager.getRoom(conv.id);
      if (room) everyone.push(...room.who());
    }
    const claimedPanes = claimedPaneNumbers(everyone, gui);
    console.log(`  [wezterm] Claimed panes: ${[...claimedPanes].join(", ") || "none"}`);
    // Find unclaimed agent-type panes (claude, codex, gemini)
    const unclaimed = panes.filter(
      (p) => p.weztermPaneId != null && !claimedPanes.has(p.weztermPaneId!) && p.type !== "unknown"
    );
    if (unclaimed.length === 1) {
      console.log(`  [wezterm] Auto-detected pane ${unclaimed[0].weztermPaneId} (${unclaimed[0].name})`);
      return unclaimed[0].weztermPaneId!;
    }
    if (unclaimed.length === 0) {
      console.log(`  [wezterm] No unclaimed agent panes found`);
    } else {
      console.log(`  [wezterm] ${unclaimed.length} unclaimed agent panes — cannot auto-detect: ${unclaimed.map(p => `${p.weztermPaneId}:${p.name}`).join(", ")}`);
    }
  } catch (err) {
    console.log(`  [wezterm] Auto-detect error: ${(err as Error).message?.slice(0, 100)}`);
  }
  return undefined;
}

/**
 * Candidates for the REST auto-join (no pid, pane or Orca handle supplied):
 * discovered Claude Code terminals not already registered in any room. A
 * WezTerm row is claimed only by a member in the same pane of the same GUI
 * (the complete pair, gate round 3, finding 2), and a row with a pane but no
 * GUI is no candidate at all, since such a pane cannot be bound. Other rows
 * are claimed by pid.
 */
export function availableForAutoJoin<T extends { type: string; pid: number; weztermPaneId?: number; weztermGui?: number }>(
  terminals: T[],
  rooms: ReadonlyArray<{ who(): ReadonlyArray<{ pid: number; weztermPaneId?: number; weztermGui?: number }> } | undefined>,
): T[] {
  const takenPids = new Set<number>();
  const takenPairs = new Set<string>();
  for (const r of rooms) {
    if (!r) continue;
    for (const a of r.who()) {
      if (a.pid) takenPids.add(a.pid);
      if (a.weztermPaneId != null && a.weztermGui != null) takenPairs.add(`${a.weztermGui}:${a.weztermPaneId}`);
    }
  }
  return terminals.filter((t) => {
    if (t.type !== "claude") return false;
    if (t.weztermPaneId != null) return t.weztermGui != null && !takenPairs.has(`${t.weztermGui}:${t.weztermPaneId}`);
    return !takenPids.has(t.pid);
  });
}

/** What an MCP session registered on chat_join: the room, the name, the
 *  registration id the join issued, and the terminal it joined from. The
 *  session's routing follows this record only: a departure of it means the
 *  session must rejoin, never that it is re-pointed at another registration
 *  of the name (gate rounds 3 and 4, finding 4 and finding 1). */
export interface SessionRegistration extends TerminalAliases {
  convId: string;
  name: string;
}

const sessionBindings = new Map<string | undefined, SessionRegistration>(); // sessionId -> registration

export interface SessionRoute {
  room: NonNullable<ReturnType<ConversationManager["getRoom"]>>;
  convId: string;
  entry: AgentBindingEntry;
}

/**
 * The room an MCP call routes to.
 * - A `registration` id named in the call: that registration of the name,
 *   and nothing else (an id that matches nothing is an answer of null).
 * - A session record: its registration by id, else a binding of the same
 *   name from exactly the same terminal (a pid or the (GUI, pane) pair, an
 *   Orca handle). Never "the only binding left".
 * - No record (a fresh transport after a reconnect, or after chat_leave): no
 *   name lookup, so the agent must chat_join again. One narrow exception, by
 *   design: when exactly one registration of the name exists anywhere and it
 *   is terminal-less (pid 0, no pane, no handle), it is used. That is the
 *   interactive REPL agent, which has no terminal to name and may not have
 *   kept its id; with one such registration there is nothing to confuse it with.
 */
export function routeSessionRoom(
  manager: ConversationManager, reg: SessionRegistration | undefined, senderHint?: string, registration?: string
): SessionRoute | null {
  const name = senderHint ?? reg?.name;
  if (!name) return null;
  let entry: AgentBindingEntry | undefined;
  if (registration != null) {
    entry = manager.bindingsOf(name).find((e) => e.registration === registration);
  } else if (reg) {
    entry = manager.bindingEntryForTerminal(name, reg, reg.convId);
  } else {
    const all = manager.bindingsOf(name);
    if (all.length === 1 && isTerminalLess(all[0])) entry = all[0];
  }
  if (!entry) return null;
  const room = manager.getRoom(entry.conversationId);
  if (!room) return null;
  return { room, convId: entry.conversationId, entry };
}

function getRoom(manager: ConversationManager, extra: { sessionId?: string }, senderHint?: string, registration?: string): SessionRoute | null {
  const reg = sessionBindings.get(extra.sessionId);
  const route = routeSessionRoom(manager, reg, senderHint, registration);
  if (route) {
    // The session now follows the registration it reached (by its record,
    // or proved by the id the call named).
    const e = route.entry;
    sessionBindings.set(extra.sessionId, {
      convId: e.conversationId, name: senderHint ?? reg?.name ?? "", registration: e.registration,
      pid: e.pid, paneId: e.paneId, weztermGui: e.weztermGui, orcaTerminal: e.orcaTerminal,
    });
  }
  return route;
}

/**
 * Whether a departure may act on this registration of `name` in `room`: the
 * registration must be the room's CURRENT member of that name (gate round 5).
 * A registration id the caller named must be the member's own; any other
 * departure must match the member when there is one. A binding whose member
 * is already gone (timed out) may still be cleaned up, unless an id was named.
 */
export function departureIsCurrent(
  room: { getAgent(name: string): unknown; registrationOf(name: string): string | undefined } | undefined,
  name: string, entryRegistration: string | undefined, namedRegistration?: string,
): boolean {
  const memberRegistration = room?.getAgent(name) ? room.registrationOf(name) : undefined;
  if (namedRegistration != null) return memberRegistration != null && memberRegistration === namedRegistration && entryRegistration === namedRegistration;
  if (memberRegistration != null || room?.getAgent(name)) return memberRegistration === entryRegistration;
  return true;
}

/**
 * A local join of `name` into `room` is refused while a linked peer owns the
 * name there: its hosted member or its human (gate round 1, finding 1).
 * Checked when the join begins and again when it commits, since a peer can
 * register during the join's terminal validation (finding 4).
 */
export function peerOwnerRefusal(
  room: { peerOwnerOf(name: string): { peer: string; human: boolean } | undefined },
  convId: string, name: string,
): { error: string; candidates: Array<{ conversation: string; host: string; human?: true }> } | null {
  const owner = room.peerOwnerOf(name);
  if (!owner) return null;
  return {
    error: owner.human
      ? `${name} is taken in this room by the human of ${owner.peer}; pick another name`
      : `${name} is a member of this room hosted on ${owner.peer}; join from there, or pick another name`,
    candidates: [{ conversation: convId, host: owner.peer, ...(owner.human ? { human: true as const } : {}) }],
  };
}

const registrationArg = z.string().optional().describe(
  "The registration id your join returned. Pass it when your name may be registered more than once, and after an MCP reconnect."
);

export function registerTools(
  server: McpServer,
  manager: ConversationManager,
  taskStore?: TaskStore,
  getPersistedRole?: (name: string) => string | undefined,
  reactionStore?: ReactionStore,
  cursorStore?: CursorStore,
  editStore?: EditStore,
  remote?: RemoteRooms,
): void {
  /** In a remote room, what only its home server can do is said, not faked. */
  const remoteOnly = (target: SessionRoute, what: string) =>
    target.room instanceof MirrorRoom
      ? { content: [{ type: "text" as const, text: `${what} is not available in a remote room (${target.convId}); do it on its home server, ${target.room.server}.` }] }
      : null;
  /** Say the outcome of a write through a mirror. */
  const writeText = (r: WriteResult, label: string): string =>
    r.status === "sent"
      ? `${label} #${r.message.id} sent`
      : `${label} queued, not sent yet: ${r.reason}. It goes out in order when the link returns. clientId ${r.clientId}; chat_unsend with it deletes it before then.`;

  server.registerTool(
    "chat_join",
    {
      title: "Join a Joind conversation",
      description:
        "Join a conversation in the Joind chat. Returns immediately — " +
        "your terminal stays interactive. When someone @mentions you, " +
        "a prompt will appear in your terminal.",
      inputSchema: z.object({
        name: z.string().describe("Your display name in the chat"),
        pid: z.number().describe("Your terminal process ID"),
        conversation: z.string().optional().describe(
          "Conversation ID to join. Omit to join the active conversation. A room on a linked server is \"<server>:<room id>\": you join here, mentions there wake you here."
        ),
        weztermPaneId: z.number().optional().describe(
          "WezTerm pane ID (from $WEZTERM_PANE env var). Enables reliable @mention injection."
        ),
        orcaTerminal: z.string().optional().describe(
          "Orca terminal handle, from $env:ORCA_TERMINAL_HANDLE; enables wake-ups inside Orca"
        ),
      }),
    },
    async ({ name, pid, conversation, weztermPaneId, orcaTerminal }, extra) => {
      // Determine which conversation to join
      let convId = conversation || manager.getActiveId();
      // A remote room ("<server>:<room>") resolves through its link first.
      if (convId && remote?.isRemoteId(convId) && !(await remote.prepare(convId))) {
        return { content: [{ type: "text" as const, text: `Conversation not found: ${convId} (its home server has no such room, or cannot be reached)` }] };
      }
      if (!convId) {
        // No active conversation — create one and make it active for web UI
        const meta = manager.createConversation();
        convId = meta.id;
        manager.setActive(convId);
      }

      const found = manager.getRoom(convId);
      if (!found) {
        return { content: [{ type: "text" as const, text: "Conversation not found: " + convId }] };
      }
      const owned = peerOwnerRefusal(found, convId, name);
      if (owned) {
        return { content: [{ type: "text" as const, text: `Could not join: ${owned.error}. Candidates: ${JSON.stringify(owned.candidates)}` }] };
      }
      const joinToken = manager.beginJoin(name, convId, pid, weztermPaneId, requestedOrcaHandle(orcaTerminal));

      // Bind a WezTerm pane or an Orca terminal only when it is live and
      // really this process's (one process enumeration shared by both checks).
      const tree = processTreeOnce();
      const [paneResolution, { orcaTerminal: resolvedOrca, note: orcaNote }] = await Promise.all([
        resolvePaneForJoin(name, pid, weztermPaneId, defaultPaneResolverDeps(manager, tree)),
        resolveOrcaForJoin(name, pid, orcaTerminal, defaultOrcaResolverDeps(manager, tree)),
      ]);
      const { paneId: resolvedPaneId, note: paneNote } = paneResolution;

      // Re-fetch after the await: a conversation deleted meanwhile must not
      // be resurrected by joining its destroyed room, and a newer join or a
      // departure for this name meanwhile wins over this one.
      const room = manager.getRoom(convId);
      if (!room) {
        return { content: [{ type: "text" as const, text: "Conversation not found: " + convId }] };
      }
      const persistedRole = getPersistedRole?.(name);
      const registration = newRegistrationId();
      let remoteReg: RemoteRegistered | undefined;
      if (room instanceof MirrorRoom && remote) {
        // The home server registers this member as hosted here; its wakes
        // come back to this server, where the terminal is. Kept here only if
        // this join is still current below.
        const reg = await remote.registerMember(convId, name, registration, {
          pid, paneId: resolvedPaneId ?? undefined, gui: paneResolution.gui, orcaTerminal: resolvedOrca ?? undefined, role: persistedRole,
        });
        if (!reg.ok) {
          const cands = reg.candidates ? ` Candidates: ${JSON.stringify(reg.candidates)}` : "";
          return { content: [{ type: "text" as const, text: `Could not join ${convId}: ${reg.error}.${cands}` }] };
        }
        remoteReg = reg;
      }
      const ownedNow = peerOwnerRefusal(room, convId, name);
      if (ownedNow || !manager.joinIsCurrent(joinToken, pid, resolvedPaneId ?? undefined, resolvedOrca ?? undefined, paneResolution.gui)) {
        if (remoteReg && remote) await remote.abandonMember(convId, name, remoteReg);
        if (ownedNow) return { content: [{ type: "text" as const, text: `Could not join: ${ownedNow.error}. Candidates: ${JSON.stringify(ownedNow.candidates)}` }] };
        return { content: [{ type: "text" as const, text: `Join superseded: ${name} joined again or left while this join was being validated. Retry if you are the live session.` }] };
      }

      const agent = room.join(name, pid, resolvedPaneId, persistedRole, resolvedOrca, paneResolution.gui, registration);
      manager.bindAgent(name, convId, pid, resolvedPaneId, resolvedOrca, paneResolution.gui, registration);
      sessionBindings.set(extra.sessionId, {
        convId, name, registration, pid,
        paneId: agent.weztermPaneId, weztermGui: agent.weztermGui, orcaTerminal: agent.orcaTerminal,
      });
      room.touch(name);
      if (remoteReg && remote) {
        remote.commitMember(convId, name, remoteReg);
        await remote.joined(convId);
      }

      // Name the WezTerm tab to just the agent name
      if (agent.weztermPaneId != null) {
        const ownEnv = weztermEnvFor(agent);
        // A known GUI that is gone: no tab title, never in another GUI's pane.
        if (ownEnv !== null) {
          const wtEnv = Object.keys(ownEnv).length > 0 ? { ...process.env, ...ownEnv } : undefined;
          execFileAsync(getWeztermPath(), ["cli", "--no-auto-start", "set-tab-title", name, "--pane-id", String(agent.weztermPaneId)], { env: wtEnv })
            .catch(() => {});
        }
      }

      const meta = manager.getMeta(convId);
      const online = room.whoNames();

      // Include last 15 messages so the agent has immediate context
      // (filtered to what this agent may see: public + DMs addressed to them)
      const recent = room.read(undefined, 15, undefined, name);
      const recentText = recent.length > 0
        ? "\n\nRecent messages:\n" + recent.map((m) => `[#${m.id} ${m.sender}] ${m.text}`).join("\n")
        : "";
      const totalCount = room.messageCount();
      const historyHint = totalCount > 15
        ? `\n\n(Showing last 15 of ${totalCount} messages. Use chat_read with since= for more history.)`
        : "";

      return {
        content: [{
          type: "text" as const,
          text:
            `Joined conversation "${meta?.name ?? convId}".\n` +
            (room instanceof MirrorRoom ? `Remote room on ${room.server} (${convId}): you read and write here, mentions there wake you here; messages sent while the link is down are queued.\n` : "") +
            `Online: ${online.join(", ") || "just you"}` +
            `\nRegistration: ${registration} (pass it as \`registration\` when your name may be registered more than once, and after an MCP reconnect)` +
            (agent.weztermPaneId != null && agent.weztermGui != null ? `\nWezTerm pane: ${agent.weztermPaneId} in instance (weztermGui) ${agent.weztermGui}` : "") +
            (agent.orcaTerminal ? `\nOrca terminal: ${agent.orcaTerminal} (mentions arrive through Orca)` : "") +
            joinNotesText([paneNote, orcaNote]) +
            recentText + historyHint,
        }],
      };
    }
  );

  server.registerTool(
    "chat_send",
    {
      title: "Send a chat message",
      description: "Send a message in your current conversation. Use @name to mention agents. Pass choices to render inline decision buttons.",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        text: z.string().describe("Message text. Use @name to mention agents."),
        replyTo: z.number().optional().describe("Message ID to reply to"),
        choices: z.array(z.string()).optional().describe("Inline decision options. Renders clickable buttons; first answer wins."),
        askFor: z.string().optional().describe("Name this message needs a decision from (e.g. Admiral). Creates a first-class open ask, queryable via chat_decisions and the web Decisions pane, resolved with chat_resolve."),
        registration: registrationArg,
      }),
    },
    async ({ sender, text, replyTo, choices, askFor, registration }, extra) => {
      const target = getRoom(manager, extra, sender, registration);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      target.room.touch(sender);
      target.room.setTyping(sender, false);

      if (target.room instanceof MirrorRoom) {
        // The home server names the room, numbers the message and decides mentions.
        try {
          const r = await target.room.writeThrough(sender, text, { replyTo, choices, askFor });
          return { content: [{ type: "text" as const, text: writeText(r, "Message") }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Not sent: ${(err as Error).message}` }] };
        }
      }

      // Auto-name conversation from first non-system message
      manager.autoName(target.convId, text);

      const msg = target.room.send(sender, text, { replyTo, choices, askFor });
      const suffix = choices && choices.length > 0 ? ` with ${choices.length} choices` : "";
      const askNote = msg.ask ? ` (open ask for ${msg.ask.for})` : "";
      return { content: [{ type: "text" as const, text: `Message #${msg.id} sent${suffix}${askNote}` }] };
    }
  );

  server.registerTool(
    "chat_resolve",
    {
      title: "Resolve an open ask",
      description: "Mark a message's open ask as resolved (the decision was made or is no longer needed).",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        messageId: z.number().describe("The message carrying the open ask"),
      }),
    },
    async ({ sender, messageId }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      const msg = target.room.resolveAsk(messageId, sender);
      if (!msg) {
        return { content: [{ type: "text" as const, text: `No open ask on message #${messageId}` }] };
      }
      return { content: [{ type: "text" as const, text: `Ask on #${messageId} resolved by ${sender}` }] };
    }
  );

  server.registerTool(
    "chat_decisions",
    {
      title: "List open decisions",
      description: "List open asks across all conversations, optionally only those addressed to one name.",
      inputSchema: z.object({
        sender: z.string().describe("Your name (DM visibility applies)"),
        forName: z.string().optional().describe("Only asks addressed to this name (omit for all open asks)"),
      }),
    },
    async ({ sender, forName }) => {
      const lines: string[] = [];
      for (const meta of manager.listAllRoomMetas()) {
        const room = manager.getRoom(meta.id);
        if (!room) continue;
        for (const m of room.openAsks(forName)) {
          if (!visibleToViewer(m, sender)) continue;
          const preview = m.text.length > 100 ? m.text.slice(0, 97) + "..." : m.text;
          lines.push(`[${meta.name} #${m.id}] ${m.sender} asks ${m.ask?.for}: ${preview}`);
        }
      }
      return {
        content: [{
          type: "text" as const,
          text: lines.length > 0 ? lines.join("\n") : "No open decisions.",
        }],
      };
    }
  );

  server.registerTool(
    "chat_read",
    {
      title: "Read chat messages",
      description: "Read recent messages from your current conversation.",
      inputSchema: z.object({
        sender: z.string().optional().describe("Your name (for routing to your conversation)"),
        since: z.number().optional().describe("Message ID to read from (exclusive). Omit for latest."),
        limit: z.number().optional().describe("Max messages to return (default 50)"),
        from: z.string().optional().describe("Filter messages by sender name (e.g., 'Admiral')"),
        registration: registrationArg,
      }),
    },
    async ({ sender, since, limit, from, registration }, extra) => {
      const target = getRoom(manager, extra, sender, registration);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      const msgs = target.room.read(since, limit, from, sender);
      // Advance unread cursor
      if (cursorStore && sender && msgs.length > 0) {
        cursorStore.advance(sender, msgs[msgs.length - 1].id);
      }
      const formatted = msgs
        .map((m) => {
          const reply = m.replyTo ? ` [reply to #${m.replyTo}]` : "";
          return `[#${m.id} ${m.sender}${reply}] ${m.text}`;
        })
        .join("\n");
      return { content: [{ type: "text" as const, text: formatted || "(no messages)" }] };
    }
  );

  server.registerTool(
    "chat_listen",
    {
      title: "Wait for the next message (long poll)",
      description:
        "Block until another participant posts a message after your cursor, or until the timeout passes. For resident sessions (GUI harnesses) that cannot receive terminal injection: loop chat_listen, respond to what it returns, then call it again with the returned lastId. A timeout result is normal; just call again.",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        since: z.number().optional().describe("Message ID cursor (exclusive); pass the lastId from the previous listen or read"),
        timeoutSec: z.number().optional().describe("Seconds to wait before returning empty (default 50, max 240)"),
        mentionsOnly: z.boolean().optional().describe("Wake and deliver only messages that address you with @YourName or @all; unaddressed traffic advances the cursor silently (protects your context budget; catch up with chat_read if needed)"),
        registration: registrationArg,
      }),
    },
    async ({ sender, since, timeoutSec, mentionsOnly, registration }, extra) => {
      const target = getRoom(manager, extra, sender, registration);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      const timeoutMs = clampListenTimeout(timeoutSec != null ? timeoutSec * 1000 : undefined);
      target.room.touch(sender);
      const result = await waitForMessage(target.room, sender, since, timeoutMs, {
        mentionsOnly,
        signal: extra.signal,
      });
      target.room.touch(sender);
      if (result.aborted) {
        return { content: [{ type: "text" as const, text: "(listen cancelled)" }] };
      }
      if (cursorStore && result.lastId > 0) {
        cursorStore.advance(sender, result.lastId);
      }
      if (result.messages.length === 0) {
        return { content: [{ type: "text" as const, text: `(no new messages after ${timeoutMs / 1000}s; lastId=${result.lastId}; call chat_listen again)` }] };
      }
      const formatted = result.messages
        .map((m) => {
          const reply = m.replyTo ? ` [reply to #${m.replyTo}]` : "";
          return `[#${m.id} ${m.sender}${reply}] ${m.text}`;
        })
        .join("\n");
      return { content: [{ type: "text" as const, text: `${formatted}\n(lastId=${result.lastId})` }] };
    }
  );

  server.registerTool(
    "chat_who",
    {
      title: "See who is in the conversation",
      description: "List agents in your current conversation.",
      inputSchema: z.object({
        sender: z.string().optional().describe("Your name (for routing to your conversation)"),
      }),
    },
    async ({ sender }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation." }] };
      }
      const names = target.room.whoNames();
      const meta = manager.getMeta(target.convId);
      return {
        content: [{
          type: "text" as const,
          text: `Conversation: ${meta?.name ?? target.convId}\nOnline: ${names.length ? names.join(", ") : "(nobody)"}`,
        }],
      };
    }
  );

  server.registerTool(
    "chat_leave",
    {
      title: "Leave the conversation",
      description: "Disconnect from the Joind conversation.",
      inputSchema: z.object({
        name: z.string().describe("Your name"),
        registration: registrationArg,
      }),
    },
    async ({ name, registration }, extra) => {
      // Even before any binding exists (a first join still validating), a
      // leave must win over that join.
      manager.supersedeJoins(name);
      const target = routeSessionRoom(manager, sessionBindings.get(extra.sessionId), name, registration);
      sessionBindings.delete(extra.sessionId);
      if (!target) {
        // This session's registration is already gone, or nothing names one:
        // another registration of the name is not this session's to remove.
        return { content: [{ type: "text" as const, text: `${name}: no registration of this session to leave (already left, or pass registration)` }] };
      }
      // Exactly the registration it reaches, and only while it is the room's
      // current member of that name (gate round 5).
      if (!departureIsCurrent(target.room, name, target.entry.registration, registration)) {
        return { content: [{ type: "text" as const, text: `${name}: that registration was superseded by a later join; nothing removed` }] };
      }
      try {
        if (target.room.getAgent(name)) target.room.leave(name);
      } catch (err) {
        // A remote room whose release record cannot be written (gate round 8).
        return { content: [{ type: "text" as const, text: `${name}: not disconnected: ${(err as Error).message}` }] };
      }
      manager.unbindRegistration(name, target.entry.registration);
      return { content: [{ type: "text" as const, text: `${name} disconnected` }] };
    }
  );

  server.registerTool(
    "chat_typing",
    {
      title: "Signal typing status",
      description: "Signal that you are typing (or stopped) in the conversation.",
      inputSchema: z.object({
        name: z.string().describe("Your name"),
        typing: z.boolean().describe("true if typing, false if stopped"),
      }),
    },
    async ({ name, typing }, extra) => {
      const target = getRoom(manager, extra, name);
      if (target) {
        target.room.setTyping(name, typing);
      }
      return { content: [{ type: "text" as const, text: `${name} is ${typing ? "now shown as typing" : "no longer typing"}` }] };
    }
  );

  // --- Status tool ---

  server.registerTool(
    "chat_status",
    {
      title: "Set your status",
      description: "Set a custom status visible to all agents (e.g., 'building', 'tracing', 'reviewing'). Empty string clears status. Auto-clears after 10 minutes.",
      inputSchema: z.object({
        name: z.string().describe("Your name"),
        status: z.string().describe("Status text (empty to clear)"),
      }),
    },
    async ({ name, status }, extra) => {
      const target = getRoom(manager, extra, name);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      target.room.setStatus(name, status);
      return { content: [{ type: "text" as const, text: status ? `Status set: ${status}` : "Status cleared" }] };
    }
  );

  // --- Search tool ---

  server.registerTool(
    "chat_search",
    {
      title: "Search messages",
      description: "Search for messages containing specific text in your current conversation. Returns newest matches first.",
      inputSchema: z.object({
        sender: z.string().optional().describe("Your name (for routing)"),
        query: z.string().describe("Text to search for (case-insensitive)"),
        limit: z.number().optional().describe("Max results (default 20)"),
      }),
    },
    async ({ sender, query, limit }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      const results = target.room.search(query, limit ?? 20, sender);
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No messages found matching "${query}"` }] };
      }
      const formatted = results.map(r => `[#${r.message.id} ${r.message.sender}] ${r.message.text}`).join("\n");
      return { content: [{ type: "text" as const, text: `Found ${results.length} matches:\n${formatted}` }] };
    }
  );

  // --- Tag tool ---

  server.registerTool(
    "chat_tag",
    {
      title: "Tag a message",
      description: "Classify a message with a tag: status, question, evidence, decision, revert, handoff, or any custom label.",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        messageId: z.number().describe("Message ID to tag"),
        tag: z.string().describe("Tag label (e.g., 'decision', 'status', 'question', 'evidence', 'handoff')"),
      }),
    },
    async ({ sender, messageId, tag }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      const msg = target.room instanceof MirrorRoom ? target.room.tagAs(sender, messageId, tag) : target.room.tagMessage(messageId, tag);
      if (!msg) {
        return { content: [{ type: "text" as const, text: `Message #${messageId} not found` }] };
      }
      return { content: [{ type: "text" as const, text: `Message #${messageId} tagged as: ${tag}` }] };
    }
  );

  // --- Pin tool ---

  server.registerTool(
    "chat_pin",
    {
      title: "Pin or unpin a message",
      description: "Pin an important message so it can be quickly found. Unpin by setting pinned=false.",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        messageId: z.number().describe("Message ID to pin/unpin"),
        pinned: z.boolean().optional().describe("true to pin (default), false to unpin"),
      }),
    },
    async ({ sender, messageId, pinned }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      const msg = target.room instanceof MirrorRoom ? target.room.pinAs(sender, messageId, pinned !== false) : target.room.pinMessage(messageId, pinned !== false);
      if (!msg) {
        return { content: [{ type: "text" as const, text: `Message #${messageId} not found` }] };
      }
      return { content: [{ type: "text" as const, text: `Message #${messageId} ${pinned !== false ? "pinned" : "unpinned"}` }] };
    }
  );

  // --- Session marker tool ---

  server.registerTool(
    "chat_session_marker",
    {
      title: "Mark session start or end",
      description: "Insert a session boundary marker. Helps agents joining late find where the current working session began.",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        markerType: z.enum(["start", "end"]).describe("Session start or end"),
        label: z.string().optional().describe("Optional label (e.g., 'Phase 60 debugging')"),
      }),
    },
    async ({ sender, markerType, label }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      const refused = remoteOnly(target, "A session marker");
      if (refused) return refused;
      target.room.addSessionMarker(markerType, label);
      return { content: [{ type: "text" as const, text: `Session ${markerType} marker added${label ? ": " + label : ""}` }] };
    }
  );

  // --- Reaction tool ---

  if (reactionStore) {
    server.registerTool(
      "chat_react",
      {
        title: "React to a message",
        description: "Add or remove an emoji reaction on a message. Same sender+emoji+message toggles off.",
        inputSchema: z.object({
          sender: z.string().describe("Your name"),
          messageId: z.number().describe("Message ID to react to"),
          emoji: z.string().describe("Emoji to react with"),
        }),
      },
      async ({ sender, messageId, emoji }, extra) => {
        const target = getRoom(manager, extra, sender);
        if (!target) {
          return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
        }
        const refused = remoteOnly(target, "Reacting");
        if (refused) return refused;
        const result = reactionStore.toggle(target.convId, messageId, emoji, sender);
        return { content: [{ type: "text" as const, text: `Reaction ${result.action}: ${emoji} on message #${messageId}` }] };
      }
    );
  }

  // --- Edit tool ---

  if (editStore) {
    server.registerTool(
      "chat_edit",
      {
        title: "Edit a sent message",
        description: "Edit the text of a message you previously sent. Only the original sender can edit.",
        inputSchema: z.object({
          sender: z.string().describe("Your name (must be the original sender)"),
          messageId: z.number().describe("Message ID to edit"),
          newText: z.string().describe("New message text"),
        }),
      },
      async ({ sender, messageId, newText }, extra) => {
        const target = getRoom(manager, extra, sender);
        if (!target) {
          return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
        }
        const refused = remoteOnly(target, "Editing a message");
        if (refused) return refused;
        const msg = target.room.getMessageById(messageId);
        if (!msg) {
          return { content: [{ type: "text" as const, text: `Message #${messageId} not found` }] };
        }
        if (msg.sender !== sender) {
          return { content: [{ type: "text" as const, text: "Only the original sender can edit a message" }] };
        }
        editStore.edit(target.convId, messageId, newText, sender, msg.text);
        target.room.updateMessageText(messageId, newText);
        return { content: [{ type: "text" as const, text: `Message #${messageId} edited` }] };
      }
    );
  }

  // --- Unread tool ---

  if (cursorStore) {
    server.registerTool(
      "chat_unread",
      {
        title: "Check unread messages",
        description: "Check how many unread messages you have and who sent them.",
        inputSchema: z.object({
          name: z.string().describe("Your name"),
        }),
      },
      async ({ name }, extra) => {
        const target = getRoom(manager, extra, name);
        if (!target) {
          return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
        }
        const cursor = cursorStore.get(name);
        const newMsgs = target.room.read(cursor, 100000, undefined, name);
        const unread = cursorStore.getUnreadCount(name, newMsgs);
        if (unread.count === 0) {
          return { content: [{ type: "text" as const, text: "No unread messages" }] };
        }
        return { content: [{ type: "text" as const, text: `${unread.count} unread messages from: ${unread.senders.join(", ")}` }] };
      }
    );
  }

  // --- Scratchpad tool ---

  server.registerTool(
    "chat_notes",
    {
      title: "Read or write your scratchpad",
      description: "Each agent has a private scratchpad per conversation for tracking hypotheses, progress notes, etc. Read by omitting 'notes', write by providing 'notes'.",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        notes: z.string().optional().describe("Notes to save (omit to read current notes)"),
      }),
    },
    async ({ sender, notes }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      const baseUrl = "http://127.0.0.1:4200";
      if (notes !== undefined) {
        // Write
        const resp = await fetch(`${baseUrl}/api/agent/scratchpad`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender, notes, conversation: target.convId }),
        });
        if (!resp.ok) return { content: [{ type: "text" as const, text: "Failed to save notes" }] };
        return { content: [{ type: "text" as const, text: "Notes saved" }] };
      }
      // Read
      const resp = await fetch(`${baseUrl}/api/agent/scratchpad?sender=${encodeURIComponent(sender)}&conversation=${target.convId}`);
      const data = await resp.json() as { notes: string };
      return { content: [{ type: "text" as const, text: data.notes || "(empty scratchpad)" }] };
    }
  );

  // --- State block tool ---

  server.registerTool(
    "chat_state",
    {
      title: "Read or update conversation state",
      description: "Read or update structured state blocks for the conversation (baseline, hypothesis, gates, parked, etc.).",
      inputSchema: z.object({
        sender: z.string().optional().describe("Your name (for routing)"),
        key: z.string().optional().describe("State key to set (e.g., 'baseline', 'hypothesis', 'gates', 'parked'). Omit to read all."),
        value: z.string().optional().describe("Value to set (omit key and value to read all state)"),
      }),
    },
    async ({ sender, key, value }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      const baseUrl = "http://127.0.0.1:4200";
      if (key) {
        // Write
        const resp = await fetch(`${baseUrl}/api/state`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation: target.convId, key, value: value || "" }),
        });
        const data = await resp.json();
        return { content: [{ type: "text" as const, text: `State updated:\n${JSON.stringify(data, null, 2)}` }] };
      }
      // Read all
      const resp = await fetch(`${baseUrl}/api/state?conversation=${target.convId}`);
      const data = await resp.json();
      const entries = Object.entries(data as Record<string, string>);
      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: "(no state blocks set)" }] };
      }
      const formatted = entries.map(([k, v]) => `**${k}**: ${v}`).join("\n");
      return { content: [{ type: "text" as const, text: formatted }] };
    }
  );

  // --- DM / targeted send tool ---

  server.registerTool(
    "chat_dm",
    {
      title: "Send a targeted message",
      description: "Send a message visible only to specific recipients. Others won't see it in their chat_read output.",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        to: z.array(z.string()).describe("List of recipient names"),
        text: z.string().describe("Message text"),
      }),
    },
    async ({ sender, to, text }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      target.room.touch(sender);
      target.room.setTyping(sender, false);
      if (target.room instanceof MirrorRoom) {
        try {
          const r = await target.room.writeThrough(sender, text, { to });
          return { content: [{ type: "text" as const, text: writeText(r, `DM to ${to.join(", ")}`) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Not sent: ${(err as Error).message}` }] };
        }
      }
      const msg = target.room.send(sender, text, { to });
      return { content: [{ type: "text" as const, text: `DM #${msg.id} sent to ${to.join(", ")}` }] };
    }
  );

  // --- Undelivered messages in a remote room ---

  server.registerTool(
    "chat_unsend",
    {
      title: "Delete an undelivered message",
      description: "In a remote room (a room on a linked server), a message sent while the link is down waits in a queue. Its author may delete it with the clientId the send returned, until it is sent.",
      inputSchema: z.object({
        sender: z.string().describe("Your name (the message's author)"),
        clientId: z.string().describe("The clientId your queued send returned"),
        registration: registrationArg,
      }),
    },
    async ({ sender, clientId, registration }, extra) => {
      const target = getRoom(manager, extra, sender, registration);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      if (!(target.room instanceof MirrorRoom)) {
        return { content: [{ type: "text" as const, text: "Nothing to unsend: this room is on this server, so messages are never queued." }] };
      }
      const r = target.room.deleteUndelivered(clientId, sender);
      return { content: [{ type: "text" as const, text: r.ok ? `Undelivered message ${clientId} deleted` : `Not deleted: ${r.error}` }] };
    }
  );

  // --- Inline decision choice tool ---

  server.registerTool(
    "chat_choose",
    {
      title: "Resolve an inline decision",
      description: "Pick one of the options on a message that has `choices`. First answer wins; subsequent calls are no-ops.",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        messageId: z.number().describe("Message ID with choices"),
        value: z.string().describe("One of the message's choice values"),
      }),
    },
    async ({ sender, messageId, value }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      const msg = target.room.chooseMessage(messageId, value, sender);
      if (!msg) {
        return { content: [{ type: "text" as const, text: `Cannot choose: message #${messageId} not found, has no choices, or value is not one of the options.` }] };
      }
      const r = msg.choiceResponse!;
      return { content: [{ type: "text" as const, text: `Message #${messageId} resolved by ${r.by}: ${r.value}` }] };
    }
  );

  // --- File upload tool ---

  server.registerTool(
    "chat_upload",
    {
      title: "Upload a file to the conversation",
      description: "Upload a file (text, code, data, etc.) and optionally post it as a message with a link. The file is stored on the Joind server and accessible via URL.",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        filename: z.string().describe("Filename with extension (e.g., 'report.md', 'data.csv')"),
        content: z.string().describe("File content as text"),
        message: z.string().optional().describe("Optional message to post with the file link"),
      }),
    },
    async ({ sender, filename, content, message }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      // Determine content type from extension
      const ext = filename.split(".").pop()?.toLowerCase() || "txt";
      const mimeMap: Record<string, string> = {
        md: "text/markdown", txt: "text/plain", json: "application/json",
        csv: "text/csv", html: "text/html", xml: "text/xml",
        js: "text/javascript", ts: "text/typescript", py: "text/x-python",
        rs: "text/x-rust", toml: "text/x-toml", yaml: "text/yaml", yml: "text/yaml",
      };
      const contentType = mimeMap[ext] || "text/plain";
      try {
        const resp = await fetch("http://127.0.0.1:4200/api/upload", {
          method: "POST",
          headers: { "Content-Type": contentType },
          body: content,
        });
        const data = await resp.json() as { url: string; filename: string };
        if (message) {
          const text = `${message}\n\n📎 [${filename}](${data.url})`;
          if (target.room instanceof MirrorRoom) await target.room.writeThrough(sender, text);
          else target.room.send(sender, text);
        }
        return { content: [{ type: "text" as const, text: `File uploaded: ${data.url} (${content.length} bytes)` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Upload failed: ${(err as Error).message}` }] };
      }
    }
  );

  // --- Handoff tool ---

  server.registerTool(
    "chat_handoff",
    {
      title: "Post a handoff note",
      description: "Post a structured handoff note capturing current state, open questions, next steps, and blockers for session transitions.",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        currentState: z.string().describe("Where things stand now"),
        openQuestions: z.string().optional().describe("Unresolved questions"),
        nextSteps: z.string().describe("What should happen next"),
        blockers: z.string().optional().describe("What's blocking progress"),
      }),
    },
    async ({ sender, currentState, openQuestions, nextSteps, blockers }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      let text = `**Handoff from ${sender}**\n`;
      text += `**Current state:** ${currentState}\n`;
      if (openQuestions) text += `**Open questions:** ${openQuestions}\n`;
      text += `**Next steps:** ${nextSteps}\n`;
      if (blockers) text += `**Blockers:** ${blockers}`;
      if (target.room instanceof MirrorRoom) {
        try {
          const r = await target.room.writeThrough(sender, text);
          if (r.status === "sent") {
            target.room.tagAs(sender, r.message.id, "handoff");
            target.room.pinAs(sender, r.message.id, true);
          }
          return { content: [{ type: "text" as const, text: writeText(r, "Handoff note") + (r.status === "sent" ? " (tag and pin asked of the home server)" : "") }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Not sent: ${(err as Error).message}` }] };
        }
      }
      const msg = target.room.send(sender, text);
      target.room.tagMessage(msg.id, "handoff");
      target.room.pinMessage(msg.id, true);
      return { content: [{ type: "text" as const, text: `Handoff note posted and pinned as message #${msg.id}` }] };
    }
  );

  // --- Task tools ---

  if (taskStore) {
    server.registerTool(
      "chat_task",
      {
        title: "Create a task / request input",
        description:
          "Request input, a decision, or action from someone. Creates a visible task " +
          "that won't get lost in chat flow. Use for decisions, approvals, and questions.",
        inputSchema: z.object({
          sender: z.string().describe("Your name"),
          title: z.string().describe("Short title: what you need"),
          description: z.string().optional().describe("Details or context"),
          assignee: z.string().optional().describe("Who should respond (omit for anyone)"),
          priority: z.enum(["normal", "urgent"]).optional().describe("Urgency level"),
        }),
      },
      async ({ sender, title, description, assignee, priority }, extra) => {
        const target = getRoom(manager, extra, sender);
        if (!target) {
          return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
        }
        const refused = remoteOnly(target, "Creating a task");
        if (refused) return refused;
        const task = taskStore.create(target.convId, {
          title, description, creator: sender, assignee, priority,
        });
        // Post system message so other agents see it via chat_read
        const assignText = task.assignee ? ` for ${task.assignee}` : "";
        const urgentText = task.priority === "urgent" ? " (urgent)" : "";
        target.room.send("system",
          `[Task #${task.id}${assignText}] ${sender} needs: ${task.title}${urgentText}`
        );
        return {
          content: [{
            type: "text" as const,
            text: `Task #${task.id} created${assignText}${urgentText}: ${task.title}`,
          }],
        };
      }
    );

    server.registerTool(
      "chat_tasks",
      {
        title: "Check tasks and responses",
        description:
          "List tasks in the conversation, or resolve a specific task. " +
          "Provide id + response to mark a task as done with your answer.",
        inputSchema: z.object({
          sender: z.string().optional().describe("Your name (for routing)"),
          status: z.enum(["open", "done", "all"]).optional().describe("Filter (default: open)"),
          id: z.number().optional().describe("Get or resolve a specific task"),
          response: z.string().optional().describe("Response text — resolves the task as done"),
        }),
      },
      async ({ sender, status, id, response }, extra) => {
        const target = getRoom(manager, extra, sender);
        if (!target) {
          return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
        }
        const refused = remoteOnly(target, "Tasks");
        if (refused) return refused;

        // Resolve a task
        if (id != null && response != null) {
          const task = taskStore.update(target.convId, id, {
            status: "done", response, respondedBy: sender ?? "agent",
          });
          if (!task) {
            return { content: [{ type: "text" as const, text: `Task #${id} not found` }] };
          }
          target.room.send("system",
            `[Task #${task.id} done] ${task.respondedBy} responded: ${response.slice(0, 200)}`
          );
          return { content: [{ type: "text" as const, text: `Task #${id} resolved` }] };
        }

        // Get single task
        if (id != null) {
          const task = taskStore.get(target.convId, id);
          if (!task) {
            return { content: [{ type: "text" as const, text: `Task #${id} not found` }] };
          }
          const lines = [
            `[Task #${task.id} ${task.status.toUpperCase()}${task.priority === "urgent" ? " URGENT" : ""}] ${task.title}`,
          ];
          if (task.description) lines.push(`  ${task.description}`);
          lines.push(`  Created by: ${task.creator}${task.assignee ? ` | Assigned to: ${task.assignee}` : ""}`);
          if (task.response) lines.push(`  Response (${task.respondedBy}): ${task.response}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        // List tasks
        const tasks = taskStore.list(target.convId, { status: status ?? "open" });
        if (tasks.length === 0) {
          return { content: [{ type: "text" as const, text: `No ${status ?? "open"} tasks` }] };
        }
        const formatted = tasks.map((t) => {
          const urgent = t.priority === "urgent" ? " URGENT" : "";
          const assign = t.assignee ? ` → ${t.assignee}` : "";
          const resp = t.response ? ` | Response: ${t.response.slice(0, 100)}` : "";
          return `[#${t.id} ${t.status.toUpperCase()}${urgent}] ${t.title}${assign}${resp}`;
        }).join("\n");
        return { content: [{ type: "text" as const, text: formatted }] };
      }
    );
  }

  server.registerPrompt(
    "join",
    {
      title: "Join Joind conversation",
      description: "Connect to a Joind conversation",
      argsSchema: {
        name: z.string().describe("Your display name"),
      },
    },
    ({ name }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `Join the Joind chat as "${name}". ` +
            `First find your terminal PID by running echo $PPID. ` +
            `Also check for WezTerm: echo $WEZTERM_PANE — if set, pass it as weztermPaneId. ` +
            `Then call chat_join with name="${name}", your PID, and weztermPaneId if available.`,
        },
      }],
    })
  );
}

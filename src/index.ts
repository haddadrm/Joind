/**
 * Joind — Universal agent chat via MCP.
 *
 * Multiple isolated conversations, each with its own agents and messages.
 * ConversationManager holds all conversations.
 * Web UI views one conversation at a time.
 * Agents are bound to specific conversations via chat_join.
 */

import { createServer } from "http";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { promisify } from "util";
import express from "express";

const execFileAsync = promisify(execFile);
import { randomUUID } from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { ensureDir } from "./persist.js";
import { waitForMessage, clampListenTimeout } from "./listen.js";
import { NotificationStore, TaskTracker, classifyMessage, isNotifiable, type Classified } from "./notifications.js";
import { initFileLog } from "./log.js";
import { collectDmThread, collectDmPartners, resolveDmTargetConversation } from "./dms.js";
import { setDefaultPresenceGrace, setInjectBaseUrl } from "./room.js";
import { injectBaseUrlFor } from "./wake.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConversationManager, newRegistrationId, isTerminalLess } from "./manager.js";
import { visibleToViewer, type ChatMessage } from "./room.js";
import { registerTools, resolvePaneForJoin, defaultPaneResolverDeps, resolveOrcaForJoin, defaultOrcaResolverDeps, requestedOrcaHandle, weztermEnvFor, availableForAutoJoin, departureIsCurrent } from "./tools.js";
import { TaskStore } from "./tasks.js";
import { ReactionStore } from "./reactions.js";
import { CursorStore } from "./cursors.js";
import { EditStore } from "./edits.js";
import { discoverTerminals, renameTabTitle, checkWezTerm, discoverWezTerm, getWeztermPath, getWeztermEnv, processTreeOnce } from "./terminals.js";
import CrewStore, { detectIdentityFile, validateCrewFolder, initCrewStore } from "./crew.js";
import { loadConfig, acquireLock, tokensEqual, injectWebToken, loadWebName, webNamePath, validWebName, canRegister } from "./config.js";
import type { CrewFolder } from "./crew.js";
import { scaffoldCrewMember } from "./scaffold.js";
import { buildIdentityKit } from "./identity-kit.js";
import { getHarnesses, pickBestExePath } from "./harnesses.js";
import { listSessionsForHarness } from "./launch-sessions.js";
import LaunchService from "./launcher.js";
import {
  loadTemplates,
  getTemplates,
  getTemplate,
  startSession,
  onMessage as sessionOnMessage,
  getActiveSessions,
  cancelSession,
} from "./sessions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG = loadConfig();
initFileLog(CONFIG.logFile);
setDefaultPresenceGrace(CONFIG.presenceGraceMs);
setInjectBaseUrl(injectBaseUrlFor(CONFIG.host, CONFIG.port));
const PORT = CONFIG.port;
const HOST = CONFIG.host;
const DATA_DIR = CONFIG.dataDir;
const INSTANCE_NAME = CONFIG.instance;
initCrewStore(DATA_DIR);
const releaseLock = acquireLock(CONFIG);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => { releaseLock(); process.exit(0); });
}
process.once("exit", () => releaseLock());

// --- WT_SESSION → agent name persistence (survives shell prompt title resets) ---
const TAB_NAMES_FILE = join(DATA_DIR, "tab-names.json");

function loadTabNames(): Record<string, string> {
  try {
    if (existsSync(TAB_NAMES_FILE)) {
      return JSON.parse(readFileSync(TAB_NAMES_FILE, "utf8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveTabNames(names: Record<string, string>): void {
  try { writeFileSync(TAB_NAMES_FILE, JSON.stringify(names, null, 2)); } catch { /* ignore */ }
}

const tabNames = loadTabNames();

// --- Turn guard settings (global) ---
const TURN_GUARD_FILE = join(DATA_DIR, "turn-guard.json");

interface TurnGuardSettings {
  enabled: boolean;
  limit: number;
}

function loadTurnGuard(): TurnGuardSettings {
  try {
    if (existsSync(TURN_GUARD_FILE)) {
      return JSON.parse(readFileSync(TURN_GUARD_FILE, "utf8"));
    }
  } catch { /* ignore */ }
  return { enabled: false, limit: 20 };
}

function saveTurnGuard(settings: TurnGuardSettings): void {
  try { writeFileSync(TURN_GUARD_FILE, JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
}

let turnGuard = loadTurnGuard();

// --- Role persistence ---
const ROLES_FILE = join(DATA_DIR, "roles.json");
const AGENT_ROLES_FILE = join(DATA_DIR, "agent-roles.json");

interface CustomRole { emoji: string; label: string; }

const PRESET_ROLES: CustomRole[] = [
  { emoji: "\uD83D\uDD0D", label: "reviewer" },
  { emoji: "\uD83C\uDFD7\uFE0F", label: "architect" },
  { emoji: "\u2B50", label: "lead" },
  { emoji: "\uD83D\uDCCA", label: "analyst" },
  { emoji: "\u26A0\uFE0F", label: "critic" },
  { emoji: "\uD83D\uDCA1", label: "creative" },
  { emoji: "\uD83D\uDEE0\uFE0F", label: "builder" },
  { emoji: "\uD83C\uDFAF", label: "moderator" },
  { emoji: "\uD83D\uDD2C", label: "researcher" },
  { emoji: "\uD83C\uDFBC", label: "orchestrator" },
  { emoji: "\uD83D\uDC1B", label: "debugger" },
  { emoji: "\uD83E\uDDEA", label: "tester" },
  { emoji: "\uD83D\uDCDD", label: "planner" },
  { emoji: "\uD83D\uDCD6", label: "scribe" },
  { emoji: "\uD83D\uDE08", label: "devil-advocate" },
];

function loadCustomRoles(): CustomRole[] {
  try {
    if (existsSync(ROLES_FILE)) {
      const data = JSON.parse(readFileSync(ROLES_FILE, "utf8"));
      return data.custom ?? [];
    }
  } catch { /* ignore */ }
  return [];
}

function saveCustomRoles(roles: CustomRole[]): void {
  try { writeFileSync(ROLES_FILE, JSON.stringify({ custom: roles }, null, 2)); } catch { /* ignore */ }
}

function loadAgentRoles(): Record<string, string> {
  try {
    if (existsSync(AGENT_ROLES_FILE)) {
      return JSON.parse(readFileSync(AGENT_ROLES_FILE, "utf8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveAgentRoles(roles: Record<string, string>): void {
  try { writeFileSync(AGENT_ROLES_FILE, JSON.stringify(roles, null, 2)); } catch { /* ignore */ }
}

let customRoles = loadCustomRoles();
const agentRoles = loadAgentRoles();

/** Push turn guard settings to all loaded rooms */
function applyTurnGuard(): void {
  for (const conv of manager.listConversations()) {
    const room = manager.getRoom(conv.id);
    if (room) room.turnGuard = turnGuard.enabled ? turnGuard : null;
  }
}

// --- Conversation manager + stores ---
const manager = new ConversationManager(DATA_DIR);

// Resolve a launch's target room for the presence probe below. `conversation` may be a
// conversation id (the common case for MCP callers) or a conversation NAME (the join
// prompt and chat_join both accept "join <conversation> as <name>" by name), so an id
// lookup alone would miss a name-carrying launch and report a spurious join-timeout.
function resolveProbeRoom(conversation?: string) {
  if (!conversation) return manager.getActiveRoom();
  const byId = manager.getRoom(conversation);
  if (byId) return byId;
  const lower = conversation.toLowerCase();
  const byName = manager.listConversations().find((c) => c.name.toLowerCase() === lower);
  if (byName) return manager.getRoom(byName.id);
  return manager.getActiveRoom();
}

// Presence probe for launch join verification: is `joinAs` active in the target room?
LaunchService.setPresenceProbe((joinAs, conversation) => {
  const room = resolveProbeRoom(conversation);
  const agents = room?.who() ?? [];
  return agents.some((a) => a.name === joinAs && a.active);
});

const taskStore = new TaskStore(DATA_DIR);
const reactionStore = new ReactionStore(join(DATA_DIR, "conversations"));
const cursorStore = new CursorStore(DATA_DIR);
const editStore = new EditStore(join(DATA_DIR, "conversations"));

// --- HTTP + WebSocket server ---
const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// Load session templates
loadTemplates();

// Apply turn guard to existing and future rooms
applyTurnGuard();

// Apply cursor provider to all existing and future rooms
function applyCursorProvider(): void {
  for (const conv of manager.listConversations()) {
    const room = manager.getRoom(conv.id);
    if (room) room.getCursor = (name) => cursorStore.get(name);
  }
}
applyCursorProvider();

manager.on("room-created", (room) => {
  if (turnGuard.enabled) room.turnGuard = turnGuard;
  room.getCursor = (name: string) => cursorStore.get(name);
});

// --- Notification bell: high-signal feed for the human ---
const notificationStore = new NotificationStore();
const taskTracker = new TaskTracker();

function pushNotification(classified: Classified | null, conversationId: string): void {
  if (!classified) return;
  const name = manager.listConversations().find((c) => c.id === conversationId)?.name;
  const n = notificationStore.add(classified, conversationId, name);
  const msg = JSON.stringify({ type: "notification", generation: notificationStore.generation, data: n });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

manager.on("room", (event) => {
  if (event.type === "message" && event.data) {
    if (!isNotifiable(event.data as Parameters<typeof classifyMessage>[0])) return;
    pushNotification(
      classifyMessage(event.data as Parameters<typeof classifyMessage>[0], CONFIG.humanNames),
      event.conversationId as string
    );
  }
});

taskStore.on("task", (event) => {
  if ((event.type === "task-created" || event.type === "task-updated") && event.data) {
    pushNotification(
      taskTracker.classify(event.type, event.data, CONFIG.humanNames),
      event.conversationId
    );
  }
});

app.get("/api/notifications", (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json({
    generation: notificationStore.generation,
    notifications: notificationStore.list(Number.isFinite(limit) ? limit : 50),
    unread: notificationStore.unreadCount(),
  });
});

app.post("/api/notifications/read", express.json(), (req, res) => {
  const { upToId } = (req.body ?? {}) as { upToId?: number };
  const changed = notificationStore.markRead(
    typeof upToId === "number" && Number.isSafeInteger(upToId) ? upToId : undefined
  );
  res.json({ changed, unread: notificationStore.unreadCount() });
});

// Forward conversation room events to WebSocket clients (scoped by active conversation)
// Human viewer name per WebSocket client (from the ?name= connect param); used to
// skip targeted messages that client is not allowed to see.
const clientNames = new Map<WebSocket, string>();

// The human viewer name registered for this token (POST /api/web/register).
// Loaded at startup; the WS handshake rejects any other ?name=.
let registeredWebName: string | null = loadWebName(DATA_DIR);

manager.on("room", (event) => {
  // Include conversationId so the web UI can filter
  const msg = JSON.stringify(event);
  const data = event.data as { to?: unknown; id?: number } | undefined;
  const targeted = event.type === "message" && Array.isArray(data?.to) && (data!.to as unknown[]).length > 0;
  // Choice resolutions carry selected text; they follow the visibility of the
  // original message. The event payload is { id, response } (room.ts
  // chooseMessage). Missing original: fail closed, broadcast to no one.
  const choiceOrig =
    event.type === "message-choice"
      ? manager.getRoom(event.conversationId)?.getMessageById(data?.id as number)
      : undefined;
  // Ask resolutions follow the visibility of the asked message, exactly like
  // choice resolutions: a private ask's lifecycle is private too.
  const askOrig =
    event.type === "ask-resolved"
      ? manager.getRoom(event.conversationId)?.getMessageById(data?.id as number)
      : undefined;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    // Targeted messages reach only the sender and named recipients (fail closed)
    if (targeted && !visibleToViewer(event.data as ChatMessage, clientNames.get(client))) continue;
    if (event.type === "message-choice" && (!choiceOrig || !visibleToViewer(choiceOrig, clientNames.get(client)))) continue;
    if (event.type === "ask-resolved" && (!askOrig || !visibleToViewer(askOrig, clientNames.get(client)))) continue;
    client.send(msg);
  }

  // Hook session engine into message stream
  if (event.type === "message" && event.data.sender !== "system") {
    const convId = event.conversationId;
    const room = manager.getRoom(convId);
    if (room) sessionOnMessage(event.data.sender, room);
  }
});

// Forward task events to WebSocket clients
taskStore.on("task", (event) => {
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
});

// Forward reaction events to WebSocket clients
reactionStore.on("reaction", (event) => {
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
});

// Forward edit events to WebSocket clients
editStore.on("edit", (event) => {
  // Edits carry the new message text, so a targeted message's edit may only
  // reach clients allowed to see the original. Unknown message: fail closed.
  const room = event.conversationId ? manager.getRoom(event.conversationId) : undefined;
  const orig = room
    ? room.getMessageById((event.data as { messageId: number }).messageId)
    : undefined;
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!orig || !visibleToViewer(orig, clientNames.get(client))) continue;
    client.send(msg);
  }
});

// Forward global events (conversation created/renamed/deleted)
manager.on("global", (event) => {
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
});

// Send current state on new WebSocket connection
// Thin wiring: token check, then name-vs-registration check (all decision
// logic lives in the helpers below so the server boot path stays readable).
wss.on("connection", (ws, req) => {
  // Authenticate the browser before anything else: no valid web token, no
  // socket (and therefore no DM content). 4401 = unauthorized.
  let providedToken: string | undefined;
  try {
    providedToken = new URL(req.url ?? "", "http://localhost").searchParams.get("token") ?? undefined;
  } catch {
    providedToken = undefined;
  }
  if (!tokensEqual(providedToken, CONFIG.webToken)) {
    ws.close(4401, "unauthorized");
    return;
  }
  // The viewer name must match the name registered for this token; a token
  // holder cannot claim to be someone else. 4403 = forbidden.
  const viewerName = registeredViewerName(req);
  if (viewerName === null) {
    ws.close(4403, "forbidden");
    return;
  }
  clientNames.set(ws, viewerName);
  ws.on("close", () => clientNames.delete(ws));
  ws.on("message", (raw) => handleWebControl(ws, raw));
  // Lazy loading: only send conversation index on connect.
  // Messages load when the user selects a conversation.
  const activeMeta = manager.getActiveMeta();
  const activeRoom = activeMeta ? manager.getActiveRoom() : undefined;
  const activeId = activeMeta?.id;
  ws.send(
    JSON.stringify({
      type: "init",
      data: {
        serverNow: Date.now(),
        agents: activeRoom?.who() ?? [],
        messages: activeRoom ? activeRoom.read(undefined, 100, undefined, viewerName) : [],
        conversations: manager.listConversations(),
        activeConversation: activeMeta,
        openTaskCount: activeId ? taskStore.countOpen(activeId) : 0,
        hasUrgentTask: activeId ? taskStore.hasUrgent(activeId) : false,
        turnGuard,
        roles: { preset: PRESET_ROLES, custom: customRoles },
        reactions: activeId ? reactionStore.getForConversation(activeId) : [],
      },
    })
  );
});

/**
 * Resolve the ?name= claim against the registered web name. Returns the
 * viewer name when it matches exactly, null otherwise (fail closed: no
 * registered name, or any mismatch).
 */
function registeredViewerName(req: { url?: string }): string | null {
  let claimed: string | undefined;
  try {
    claimed = new URL(req.url ?? "", "http://localhost").searchParams.get("name") ?? undefined;
  } catch {
    claimed = undefined;
  }
  if (!claimed || registeredWebName === null) return null;
  return claimed === registeredWebName ? registeredWebName : null;
}

/**
 * Control messages from an authenticated browser socket. Currently only
 * "web-rename": re-register the human viewer name without a reconnect.
 * Only sockets that passed the token+name handshake may rename. Other tabs
 * holding sockets under the old name keep working until they reconnect
 * (single-human UI, acceptable).
 */
function handleWebControl(ws: WebSocket, raw: unknown): void {
  let parsed: { type?: string; name?: unknown };
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (!parsed || parsed.type !== "web-rename") return;
  const reply = (obj: object): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  if (!clientNames.has(ws)) { reply({ type: "web-rename-error", error: "socket not bound" }); return; }
  const valid = validWebName(parsed.name);
  if (valid === null) { reply({ type: "web-rename-error", error: "invalid name" }); return; }
  registeredWebName = valid;
  clientNames.set(ws, valid);
  try {
    writeFileSync(webNamePath(DATA_DIR), valid + "\n", { mode: 0o600 });
  } catch {
    // In-memory registration still holds for this run.
  }
  reply({ type: "web-rename-ok", name: valid });
}

// --- MCP sessions ---
const mcpSessions = new Map<
  string,
  { transport: StreamableHTTPServerTransport; server: McpServer }
>();

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "joind", version: "0.2.0" });
  registerTools(server, manager, taskStore, (name) => agentRoles[name], reactionStore, cursorStore, editStore);
  return server;
}

app.post("/mcp", express.json({ strict: false }), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let session = sessionId ? mcpSessions.get(sessionId) : undefined;

  if (sessionId && !session) {
    // Stale session (e.g. after server restart).
    // Strip the header so the transport treats this as a fresh connection.
    // If the request body is "initialize" → new session created seamlessly.
    // If it's a tool call → transport returns standard "not initialized"
    // error which Claude Code handles by auto-reinitializing.
    console.log(`  Stale session ${sessionId.slice(0, 8)}… stripped, falling through`);
    delete req.headers["mcp-session-id"];
  }

  if (!session) {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        mcpSessions.set(id, { transport, server });
        console.log(`  MCP session ${id.slice(0, 8)}… connected`);
      },
    });
    transport.onclose = () => {
      const id = [...mcpSessions.entries()].find(
        ([, s]) => s.transport === transport
      )?.[0];
      if (id) {
        mcpSessions.delete(id);
        console.log(`  MCP session ${id.slice(0, 8)}… disconnected`);
      }
    };
    await server.connect(transport);
    session = { transport, server };
  }

  await session.transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const session = sessionId ? mcpSessions.get(sessionId) : undefined;
  if (!session) {
    // No session or stale — return 400 so client re-initializes
    res.status(400).json({ error: "Session not found. POST /mcp to initialize." });
    return;
  }
  await session.transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const session = mcpSessions.get(sessionId);
  if (session) {
    await session.transport.close();
    mcpSessions.delete(sessionId);
  }
  res.json({ ok: true });
});

// --- File upload (images + any file type) ---
app.post("/api/upload", express.raw({ type: "*/*", limit: "25mb" }), (req, res) => {
  const contentType = req.headers["content-type"] || "application/octet-stream";
  const ext = contentType.split("/")[1]?.split(";")[0] || "bin";
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const fileDir = join(DATA_DIR, "files");
  ensureDir(fileDir);
  writeFileSync(join(fileDir, filename), req.body);
  res.json({ url: `/data/files/${filename}`, filename, contentType, size: (req.body as Buffer).length });
});

// Only uploaded files are web-accessible under /data; never the whole
// data dir (it holds conversation JSONL and other server-side state).
app.use("/data/files", express.static(join(DATA_DIR, "files")));

// --- REST API (scoped to active conversation) ---

/** Helper: get the active conversation's room, or 404 */
function activeRoom(res: express.Response) {
  const room = manager.getActiveRoom();
  if (!room) {
    res.status(400).json({ error: "No active conversation. Create or select one." });
    return null;
  }
  return room;
}

/** Gate for browser REST calls that can return DM content: no valid web token, no data. */
function webAuthorized(provided: string | undefined): boolean {
  return tokensEqual(provided, CONFIG.webToken);
}

/**
 * The viewer for DM filtering on web routes. ALWAYS the server-side
 * registered name; a caller-supplied viewer is ignored so a token holder
 * cannot read another viewer's DMs. Null (nothing registered yet) fails
 * closed: visibleToViewer hides targeted messages from an undefined viewer.
 */
function webViewer(): string | undefined {
  return registeredWebName ?? undefined;
}

// Browser clients register the human viewer name for first boot. The WS
// handshake only accepts ?name= equal to this registration, so a token
// holder cannot impersonate another viewer. Once registered, HTTP allows
// only idempotent re-registration of the SAME name; renames go over the
// authenticated WebSocket channel (web-rename), so a token holder cannot
// overwrite the name and lock the human out.
app.post("/api/web/register", express.json(), (req, res) => {
  const { token, name } = (req.body ?? {}) as { token?: string; name?: unknown };
  if (!webAuthorized(token)) { res.status(403).json({ error: "unauthorized" }); return; }
  const valid = validWebName(name);
  if (valid === null) { res.status(400).json({ error: "invalid name" }); return; }
  const decision = canRegister(registeredWebName, valid);
  if (decision === "reject-conflict") {
    res.status(409).json({ error: "name already registered; renames use the websocket" });
    return;
  }
  if (decision === "accept-first") {
    registeredWebName = valid;
    try {
      writeFileSync(webNamePath(DATA_DIR), valid + "\n", { mode: 0o600 });
    } catch {
      // In-memory registration still holds for this run.
    }
  }
  res.json({ ok: true, name: valid });
});

app.post("/api/send", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const { sender, text, image, replyTo, choices, to, token, askFor } = req.body as {
    sender?: string; text?: string; image?: string; replyTo?: number; choices?: string[]; to?: string[]; token?: string; askFor?: string;
  };
  if (!webAuthorized(token)) { res.status(403).json({ error: "unauthorized" }); return; }
  if (!sender || !text) {
    res.status(400).json({ error: "sender and text required" });
    return;
  }
  if (to !== undefined && (!Array.isArray(to) || !to.every((t) => typeof t === "string"))) {
    res.status(400).json({ error: "to must be an array of strings" });
    return;
  }
  // Auto-name conversation from first user message. Never from a DM: the
  // name is broadcast to every client, party or not.
  const activeId = manager.getActiveId();
  const targeted = Array.isArray(to) && to.length > 0;
  if (activeId && sender !== "system" && !targeted) manager.autoName(activeId, text);

  const msg = room.send(sender, text, {
    image, replyTo, choices, to,
    askFor: typeof askFor === "string" ? askFor : undefined,
  });
  res.json({ id: msg.id, sender: msg.sender, text: msg.text, choices: msg.choices, ask: msg.ask });
});

app.get("/api/messages", (req, res) => {
  if (!webAuthorized(req.query.token as string | undefined)) { res.status(403).json({ error: "unauthorized" }); return; }
  const room = manager.getActiveRoom();
  const from = req.query.from as string | undefined;
  // Viewer is the registered web name, never the request (fails closed).
  res.json(room?.read(undefined, 100, from, webViewer()) ?? []);
});

app.post("/api/messages/delete", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const { id } = req.body as { id?: number };
  if (id == null) { res.status(400).json({ error: "id required" }); return; }
  const ok = room.deleteMessage(id);
  res.json({ ok });
});

app.get("/api/who", (_req, res) => {
  const room = manager.getActiveRoom();
  res.json(room?.who() ?? []);
});

app.get("/api/instance", (_req, res) => {
  res.json({ name: INSTANCE_NAME, port: PORT, dataDir: DATA_DIR });
});

app.get("/api/export", (req, res) => {
  if (!webAuthorized(req.query.token as string | undefined)) { res.status(403).json({ error: "unauthorized" }); return; }
  const room = manager.getActiveRoom();
  if (!room) { res.status(400).send("No active conversation"); return; }
  const meta = manager.getActiveMeta();
  // Deliberate full-conversation dump by the human; intentionally includes DMs.
  const messages = room.readAll(10000);
  const agents = room.who();
  const now = new Date();

  let md = `# ${meta?.name ?? "Joind Chat Export"}\n`;
  md += `**Date**: ${now.toISOString().split("T")[0]}\n`;
  md += `**Messages**: ${messages.length}\n`;
  if (agents.length > 0) {
    md += `**Participants**: ${agents.map((a) => a.name).join(", ")}\n`;
  }
  md += `\n---\n\n`;

  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    if (msg.sender === "system") { md += `*${time} — ${msg.text}*\n\n`; continue; }
    if (msg.replyTo) {
      const orig = room.getMessageById(msg.replyTo);
      if (orig) md += `> *replying to ${orig.sender}*: ${orig.text.slice(0, 80)}${orig.text.length > 80 ? "…" : ""}\n\n`;
    }
    md += `**${msg.sender}** (${time}):\n${msg.text}\n`;
    if (msg.image) md += `\n![image](${msg.image})\n`;
    md += `\n`;
  }

  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="joind-export-${now.toISOString().split("T")[0]}.md"`);
  res.send(md);
});

// Structured JSON export — round-trippable bundle for importing into another instance.
app.get("/api/conversations/:id/export.json", (req, res) => {
  if (!webAuthorized(req.query.token as string | undefined)) { res.status(403).json({ error: "unauthorized" }); return; }
  const convId = req.params.id;
  const meta = manager.getMeta(convId);
  const room = manager.getRoom(convId);
  if (!meta || !room) { res.status(404).json({ error: "Conversation not found" }); return; }
  // Deliberate full-conversation dump for import/backup; intentionally includes DMs.
  const messages = room.readAll(1000000);
  const tasks = taskStore.list(convId, { status: "all" });
  const bundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    instance: INSTANCE_NAME,
    conversation: { id: meta.id, name: meta.name, createdAt: meta.createdAt, messageCount: meta.messageCount },
    messages,
    tasks,
  };
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${meta.name.replace(/[^a-z0-9-]/gi, "_")}.joind.json"`);
  res.send(JSON.stringify(bundle, null, 2));
});

app.post("/api/conversations/import", express.json({ limit: "50mb" }), (req, res) => {
  const bundle = req.body as {
    version?: number;
    conversation?: { name?: string };
    messages?: unknown;
    tasks?: Array<{ title: string; description?: string; creator: string; assignee?: string; priority?: "normal" | "urgent" }>;
  };
  if (!bundle || bundle.version !== 1) { res.status(400).json({ error: "Unsupported or missing bundle version (expected 1)" }); return; }
  if (!bundle.conversation || !bundle.conversation.name) { res.status(400).json({ error: "conversation.name required" }); return; }
  if (!Array.isArray(bundle.messages)) { res.status(400).json({ error: "messages array required" }); return; }
  const meta = manager.importConversation(bundle.conversation.name, bundle.messages as never);
  let importedTasks = 0;
  if (Array.isArray(bundle.tasks)) {
    for (const t of bundle.tasks) {
      if (!t || !t.title || !t.creator) continue;
      taskStore.create(meta.id, { title: t.title, description: t.description, creator: t.creator, assignee: t.assignee, priority: t.priority });
      importedTasks++;
    }
  }
  res.json({ ok: true, conversation: meta, imported: { messages: (bundle.messages as unknown[]).length, tasks: importedTasks } });
});

app.post("/api/join", express.json(), async (req, res) => {
  // Capture the conversation with the room BEFORE any await: the active
  // conversation can change while pane resolution runs, and membership and
  // routing must land in the same room.
  const convId = manager.getActiveId();
  if (!convId) { res.status(400).json({ error: "No active conversation. Create or select one." }); return; }
  const { name, pid, wtSession, weztermPaneId: requestedPane, weztermGui: discoveredGui, orcaTerminal: requestedOrca } = req.body as {
    name?: string; pid?: number; wtSession?: string; weztermPaneId?: number; weztermGui?: number; orcaTerminal?: unknown;
  };
  if (!name || (!pid && requestedPane == null && requestedOrcaHandle(requestedOrca) === undefined)) {
    res.status(400).json({ error: "name and pid (or weztermPaneId, or orcaTerminal) required" }); return;
  }
  if (!manager.getRoom(convId)) { res.status(404).json({ error: "Conversation not found" }); return; }
  const joinToken = manager.beginJoin(name, convId, pid, requestedPane, requestedOrcaHandle(requestedOrca), typeof discoveredGui === "number" ? discoveredGui : undefined);
  // Same invariant as the agent joins: a pane or Orca terminal is bound only when it is live and this process's.
  const tree = processTreeOnce();
  const [paneResolution, orcaResolution] = await Promise.all([
    // The UI invite names the GUI whose socket its scan ran through: a pane is a pair.
    resolvePaneForJoin(name, pid || 0, requestedPane, defaultPaneResolverDeps(manager, tree), typeof discoveredGui === "number" ? discoveredGui : undefined),
    resolveOrcaForJoin(name, pid || 0, requestedOrca, defaultOrcaResolverDeps(manager, tree)),
  ]);
  const weztermPaneId = paneResolution.paneId;
  const boundOrca = orcaResolution.orcaTerminal;
  const room = manager.getRoom(convId);
  if (!room) { res.status(404).json({ error: "Conversation not found" }); return; }
  if (!manager.joinIsCurrent(joinToken, pid, weztermPaneId ?? undefined, boundOrca ?? undefined, paneResolution.gui)) { res.status(409).json({ error: "Join superseded by a newer join or a departure for this name" }); return; }
  const registration = newRegistrationId();
  const agent = room.join(name, pid || 0, weztermPaneId, agentRoles[name], boundOrca, paneResolution.gui, registration);
  manager.bindAgent(name, convId, pid, weztermPaneId, boundOrca, paneResolution.gui, registration);
  if (pid) renameTabTitle(pid, name).catch(() => {});
  if (wtSession) { tabNames[wtSession] = name; saveTabNames(tabNames); }
  res.json({
    name: agent.name, registration, pid: agent.pid, weztermPaneId: agent.weztermPaneId, weztermGui: agent.weztermGui, orcaTerminal: agent.orcaTerminal, online: room.whoNames(),
    ...(paneResolution.note ? { paneNote: paneResolution.note } : {}),
    ...(orcaResolution.note ? { orcaNote: orcaResolution.note } : {}),
  });
});

app.post("/api/leave", express.json(), (req, res) => {
  const { name, conversation } = req.body as { name?: string; conversation?: string };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  // The UI removes a member from the conversation it has selected, and only
  // that conversation's registration: the same name elsewhere (another GUI,
  // another room) is another registration (gate round 3, finding 3).
  const convId = conversation ?? manager.getActiveId() ?? undefined;
  const room = convId ? manager.getRoom(convId) : undefined;
  if (!convId || !room) { res.status(404).json({ error: "Conversation not found" }); return; }
  manager.supersedeJoins(name);
  room.leave(name);
  manager.unbindAgent(name, convId);
  res.json({ ok: true });
});

app.post("/api/rename", express.json(), (req, res) => {
  const { oldName, newName, conversation } = req.body as { oldName?: string; newName?: string; conversation?: string };
  const convId = conversation ?? manager.getActiveId() ?? undefined;
  const room = convId ? manager.getRoom(convId) : undefined;
  if (!convId || !room) { res.status(400).json({ error: "No active conversation. Create or select one." }); return; }
  if (!oldName || !newName) { res.status(400).json({ error: "oldName and newName required" }); return; }
  // The registration being renamed is this conversation's, from the member's
  // own terminal; never a name-only lookup, which is ambiguous when the name
  // is registered elsewhere too (gate round 3, finding 5).
  // The member's registration id names it, terminal or not (gate round 4,
  // finding 2: a terminal-less registration has nothing else to match).
  const registration = room.registrationOf(oldName);
  const bound = registration != null && manager.bindingsOf(oldName).some((e) => e.conversationId === convId && e.registration === registration);
  const agent = room.rename(oldName, newName);
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  if (bound && registration != null) {
    // The same registration under its new name: same id, same terminal.
    manager.unbindRegistration(oldName, registration);
    manager.bindAgent(newName, convId, agent.pid, agent.weztermPaneId, agent.orcaTerminal, agent.weztermGui, registration);
  }
  res.json({ name: agent.name, pid: agent.pid });
});

app.post("/api/heartbeat", express.json(), (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const convId = manager.getAgentBinding(name);
  const room = convId ? manager.getRoom(convId) : manager.getActiveRoom();
  if (room) room.touch(name);
  const agent = room?.getAgent(name);
  res.json({ ok: true, lastSeen: agent?.lastSeen ?? Date.now() });
});

app.post("/api/role", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const { name, role } = req.body as { name?: string; role?: string };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const agent = room.setRole(name, role ?? "");
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  // Persist agent role assignment
  if (role) {
    agentRoles[name] = role;
  } else {
    delete agentRoles[name];
  }
  saveAgentRoles(agentRoles);
  res.json({ name: agent.name, role: agent.role });
});

// --- Role definitions CRUD ---
app.get("/api/roles", (_req, res) => {
  res.json({ preset: PRESET_ROLES, custom: customRoles });
});

app.post("/api/roles", express.json(), (req, res) => {
  const { emoji, label } = req.body as { emoji?: string; label?: string };
  if (!emoji || !label) { res.status(400).json({ error: "emoji and label required" }); return; }
  const cleanLabel = label.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 30);
  if (!cleanLabel) { res.status(400).json({ error: "Invalid label" }); return; }
  const allLabels = [...PRESET_ROLES.map(r => r.label), ...customRoles.map(r => r.label)];
  if (allLabels.includes(cleanLabel)) {
    res.status(409).json({ error: "Role already exists" }); return;
  }
  const role: CustomRole = { emoji: emoji.trim(), label: cleanLabel };
  customRoles.push(role);
  saveCustomRoles(customRoles);
  // Broadcast to web UI
  const msg = JSON.stringify({ type: "roles-updated", data: { preset: PRESET_ROLES, custom: customRoles } });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
  res.json({ ok: true, role });
});

app.delete("/api/roles/:label", (req, res) => {
  const label = req.params.label;
  const idx = customRoles.findIndex(r => r.label === label);
  if (idx === -1) { res.status(404).json({ error: "Custom role not found" }); return; }
  customRoles.splice(idx, 1);
  saveCustomRoles(customRoles);
  const msg = JSON.stringify({ type: "roles-updated", data: { preset: PRESET_ROLES, custom: customRoles } });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
  res.json({ ok: true });
});

// --- Reactions ---
app.post("/api/message/:id/react", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const messageId = Number(req.params.id);
  if (!Number.isInteger(messageId) || messageId < 1) { res.status(400).json({ error: "Invalid message id" }); return; }
  const { sender, emoji } = req.body as { sender?: string; emoji?: string };
  if (!sender || !emoji) { res.status(400).json({ error: "sender and emoji required" }); return; }
  const msg = room.getMessageById(messageId);
  if (!msg) { res.status(404).json({ error: "Message not found" }); return; }
  const activeId = manager.getActiveId();
  if (!activeId) { res.status(400).json({ error: "No active conversation" }); return; }
  const result = reactionStore.toggle(activeId, messageId, emoji, sender);
  res.json(result);
});

// --- Message editing ---
// Resolve an open ask. Agents resolve via their bound name; the browser
// includes the web token and resolves as the registered viewer.
app.post("/api/message/:id/resolve", express.json(), (req, res) => {
  const messageId = Number(req.params.id);
  if (!Number.isInteger(messageId) || messageId < 1) { res.status(400).json({ error: "Invalid message id" }); return; }
  const { sender, token, pid, paneId, conversation } = (req.body ?? {}) as {
    sender?: string; token?: string; pid?: number; paneId?: number; conversation?: string;
  };
  let room; let by: string;
  if (token !== undefined) {
    if (!webAuthorized(token)) { res.status(403).json({ error: "unauthorized" }); return; }
    // Message ids are per conversation; the panel resolves across rooms, so
    // an explicit conversation id wins over whatever room happens to be active.
    room = conversation ? manager.getRoom(conversation) : manager.getActiveRoom();
    const viewer = webViewer();
    if (!viewer) { res.status(409).json({ error: "no viewer registered" }); return; }
    by = viewer;
    // The viewer may only resolve asks on messages they can see.
    const orig = room?.getMessageById(messageId);
    if (!orig || !visibleToViewer(orig, viewer)) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
  } else {
    if (!sender) { res.status(400).json({ error: "sender required" }); return; }
    const ctx = agentRoom(sender, res, pid, paneId, orcaOf(req), weztermGuiOf(req), registrationOf(req));
    if (!ctx) return;
    room = ctx.room;
    by = sender;
  }
  if (!room) { res.status(400).json({ error: "No active conversation" }); return; }
  const msg = room.resolveAsk(messageId, by);
  if (!msg) { res.status(404).json({ error: "No open ask on that message" }); return; }
  res.json({ id: msg.id, ask: msg.ask });
});

// --- DM mailboxes (web viewer) ---
// GET /api/dms            -> partner summaries (sidebar), newest first
// GET /api/dms?with=Name  -> the full cross-conversation thread with Name
app.get("/api/dms", (req, res) => {
  if (!webAuthorized(req.query.token as string | undefined)) { res.status(403).json({ error: "unauthorized" }); return; }
  const viewer = webViewer();
  if (!viewer) { res.status(409).json({ error: "no viewer registered" }); return; }
  const partner = req.query.with as string | undefined;
  if (partner) {
    res.json({ partner, messages: collectDmThread(manager, viewer, partner) });
    return;
  }
  res.json({ partners: collectDmPartners(manager, viewer) });
});

// Send a DM as the registered viewer, routed into a room the recipient
// actually reads (their bound conversation, else the pair's last DM room,
// else the active room). Returns where it landed.
app.post("/api/dm/send", express.json(), (req, res) => {
  const { to, text, token, image, replyTo, replyConversationId } = (req.body ?? {}) as {
    to?: string; text?: string; token?: string; image?: string; replyTo?: number; replyConversationId?: string;
  };
  if (!webAuthorized(token)) { res.status(403).json({ error: "unauthorized" }); return; }
  const viewer = webViewer();
  if (!viewer) { res.status(409).json({ error: "no viewer registered" }); return; }
  if (!to || typeof to !== "string" || !text || typeof text !== "string") {
    res.status(400).json({ error: "to and text required" });
    return;
  }
  const convId = resolveDmTargetConversation(manager, viewer, to);
  const room = convId ? manager.getRoom(convId) : undefined;
  if (!convId || !room) { res.status(400).json({ error: "No conversation available for this DM" }); return; }
  // A reply target only survives when the quoted message lives in the room
  // the DM is routed to; message ids are per room, so anything else would
  // quote a stranger.
  const safeReplyTo =
    typeof replyTo === "number" && replyConversationId === convId && room.getMessageById(replyTo)
      ? replyTo
      : undefined;
  const msg = room.send(viewer, text, {
    to: [to],
    image: typeof image === "string" ? image : undefined,
    replyTo: safeReplyTo,
  });
  res.json({ id: msg.id, conversationId: convId, sender: msg.sender, to: msg.to, text: msg.text, timestamp: msg.timestamp, replyTo: msg.replyTo });
});

// Agent-facing decisions listing: same name-trust model as the other
// /api/agent/* routes (the sender must hold an existing binding, i.e. have
// joined), with DM visibility applied using the SENDER as viewer. The web
// variant below stays token-gated for the registered human viewer.
app.get("/api/agent/decisions", (req, res) => {
  const sender = req.query.sender as string | undefined;
  if (!sender) { res.status(400).json({ error: "sender param required" }); return; }
  const pid = req.query.pid != null ? Number(req.query.pid) : undefined;
  const paneId = req.query.paneId != null ? Number(req.query.paneId) : undefined;
  const bound = agentRoom(sender, res, pid, paneId, orcaOf(req), weztermGuiOf(req), registrationOf(req));
  if (!bound) return;
  const forName = req.query.for as string | undefined;
  const out: unknown[] = [];
  for (const meta of manager.listConversations()) {
    const room = manager.getRoom(meta.id);
    if (!room) continue;
    for (const m of room.openAsks(forName)) {
      if (!visibleToViewer(m, sender)) continue;
      out.push({
        conversationId: meta.id,
        conversationName: meta.name,
        messageId: m.id,
        sender: m.sender,
        text: m.text,
        ask: m.ask,
        to: m.to,
        timestamp: m.timestamp,
      });
    }
  }
  out.sort((a, b) => (b as { timestamp: number }).timestamp - (a as { timestamp: number }).timestamp);
  res.json({ decisions: out, for: forName ?? null, state: "open" });
});

// Open decisions across every conversation, newest first. Web-token gated;
// the viewer is always the registered name (agents use the chat_decisions
// MCP tool instead). DM visibility applies to the message bodies.
app.get("/api/decisions", (req, res) => {
  if (!webAuthorized(req.query.token as string | undefined)) { res.status(403).json({ error: "unauthorized" }); return; }
  const state = (req.query.state as string | undefined) ?? "open";
  const viewer = webViewer();
  const forName = (req.query.for as string | undefined) ?? viewer;
  const out: unknown[] = [];
  for (const meta of manager.listConversations()) {
    const room = manager.getRoom(meta.id);
    if (!room) continue;
    for (const m of state === "open" ? room.openAsks(forName) : []) {
      if (!visibleToViewer(m, viewer)) continue;
      out.push({
        conversationId: meta.id,
        conversationName: meta.name,
        messageId: m.id,
        sender: m.sender,
        text: m.text,
        ask: m.ask,
        to: m.to,
        timestamp: m.timestamp,
      });
    }
  }
  out.sort((a, b) => (b as { timestamp: number }).timestamp - (a as { timestamp: number }).timestamp);
  res.json({ decisions: out, for: forName ?? null, state });
});

app.post("/api/message/:id/edit", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const { sender, newText, token } = req.body as { sender?: string; newText?: string; token?: string };
  if (!webAuthorized(token)) { res.status(403).json({ error: "unauthorized" }); return; }
  const messageId = Number(req.params.id);
  if (!Number.isInteger(messageId) || messageId < 1) { res.status(400).json({ error: "Invalid message id" }); return; }
  if (!sender || !newText) { res.status(400).json({ error: "sender and newText required" }); return; }
  const msg = room.getMessageById(messageId);
  if (!msg) { res.status(404).json({ error: "Message not found" }); return; }
  if (msg.sender !== sender) { res.status(403).json({ error: "Only the original sender can edit" }); return; }
  const activeId = manager.getActiveId();
  if (!activeId) { res.status(400).json({ error: "No active conversation" }); return; }
  const record = editStore.edit(activeId, messageId, newText, sender, msg.text);
  room.updateMessageText(messageId, newText);
  res.json(record);
});

// --- Unread ---
app.get("/api/agent/unread", (req, res) => {
  const sender = req.query.sender as string;
  if (!sender) { res.status(400).json({ error: "sender param required" }); return; }
  const pid = req.query.pid != null ? Number(req.query.pid) : undefined;
  const paneId = req.query.paneId != null ? Number(req.query.paneId) : undefined;
  const ctx = agentRoom(sender, res, pid, paneId, orcaOf(req), weztermGuiOf(req), registrationOf(req));
  if (!ctx) return;
  const cursor = cursorStore.get(sender);
  const newMsgs = ctx.room.read(cursor, 100000, undefined, sender);
  const unread = cursorStore.getUnreadCount(sender, newMsgs);
  res.json(unread);
});

// --- Message tags ---
app.post("/api/message/:id/tag", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const messageId = Number(req.params.id);
  if (!Number.isInteger(messageId) || messageId < 1) { res.status(400).json({ error: "Invalid message id" }); return; }
  const { tag } = req.body as { tag?: string };
  if (!tag) { res.status(400).json({ error: "tag required" }); return; }
  const msg = room.tagMessage(messageId, tag);
  if (!msg) { res.status(404).json({ error: "Message not found" }); return; }
  res.json({ id: msg.id, tag: msg.tag });
});

// --- Pinning ---
app.post("/api/message/:id/pin", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const messageId = Number(req.params.id);
  if (!Number.isInteger(messageId) || messageId < 1) { res.status(400).json({ error: "Invalid message id" }); return; }
  const { pinned } = req.body as { pinned?: boolean };
  const msg = room.pinMessage(messageId, pinned !== false);
  if (!msg) { res.status(404).json({ error: "Message not found" }); return; }
  res.json({ id: msg.id, pinned: msg.pinned });
});

app.get("/api/pins", (req, res) => {
  if (!webAuthorized(req.query.token as string | undefined)) { res.status(403).json({ error: "unauthorized" }); return; }
  const room = manager.getActiveRoom();
  if (!room) { res.json([]); return; }
  // Viewer is the registered web name, never the request (fails closed).
  res.json(room.getPinnedMessages().filter((m) => visibleToViewer(m, webViewer())));
});

// --- Inline decision choices ---
app.post("/api/message/:id/choose", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const { value, by, token } = req.body as { value?: string; by?: string; token?: string };
  if (!webAuthorized(token)) { res.status(403).json({ error: "unauthorized" }); return; }
  const messageId = Number(req.params.id);
  if (!Number.isInteger(messageId) || messageId < 1) { res.status(400).json({ error: "Invalid message id" }); return; }
  if (!value || !by) { res.status(400).json({ error: "value and by required" }); return; }
  const msg = room.chooseMessage(messageId, value, by);
  if (!msg) { res.status(400).json({ error: "Message not found, has no choices, or value not in choices" }); return; }
  res.json({ id: msg.id, choiceResponse: msg.choiceResponse });
});

// --- Session markers ---
app.post("/api/session-marker", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const { type, label } = req.body as { type?: "start" | "end"; label?: string };
  if (type !== "start" && type !== "end") { res.status(400).json({ error: "type must be 'start' or 'end'" }); return; }
  const msg = room.addSessionMarker(type, label);
  res.json({ id: msg.id });
});

// --- Agent scratchpad ---
const SCRATCHPAD_FILE = join(DATA_DIR, "scratchpads.json");

function loadScratchpads(): Record<string, string> {
  try {
    if (existsSync(SCRATCHPAD_FILE)) return JSON.parse(readFileSync(SCRATCHPAD_FILE, "utf8"));
  } catch { /* ignore */ }
  return {};
}
function saveScratchpads(data: Record<string, string>): void {
  try { writeFileSync(SCRATCHPAD_FILE, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
}
const scratchpads = loadScratchpads();

app.get("/api/agent/scratchpad", (req, res) => {
  const sender = req.query.sender as string;
  if (!sender) { res.status(400).json({ error: "sender param required" }); return; }
  const convId = (req.query.conversation as string) || manager.getActiveId() || "";
  const key = `${convId}:${sender}`;
  res.json({ notes: scratchpads[key] || "" });
});

app.post("/api/agent/scratchpad", express.json(), (req, res) => {
  const { sender, notes, conversation } = req.body as { sender?: string; notes?: string; conversation?: string };
  if (!sender) { res.status(400).json({ error: "sender required" }); return; }
  const convId = conversation || manager.getActiveId() || "";
  const key = `${convId}:${sender}`;
  if (notes) {
    scratchpads[key] = notes;
  } else {
    delete scratchpads[key];
  }
  saveScratchpads(scratchpads);
  res.json({ ok: true });
});

// --- Per-conversation state blocks ---
const STATE_BLOCKS_FILE = join(DATA_DIR, "state-blocks.json");

function loadStateBlocks(): Record<string, Record<string, string>> {
  try {
    if (existsSync(STATE_BLOCKS_FILE)) return JSON.parse(readFileSync(STATE_BLOCKS_FILE, "utf8"));
  } catch { /* ignore */ }
  return {};
}
function saveStateBlocks(data: Record<string, Record<string, string>>): void {
  try { writeFileSync(STATE_BLOCKS_FILE, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
}
const stateBlocks = loadStateBlocks();

app.get("/api/state", (req, res) => {
  const convId = (req.query.conversation as string) || manager.getActiveId() || "";
  res.json(stateBlocks[convId] || {});
});

app.post("/api/state", express.json(), (req, res) => {
  const { conversation, key, value } = req.body as { conversation?: string; key?: string; value?: string };
  if (!key) { res.status(400).json({ error: "key required" }); return; }
  const convId = conversation || manager.getActiveId() || "";
  if (!stateBlocks[convId]) stateBlocks[convId] = {};
  if (value) {
    stateBlocks[convId][key] = value;
  } else {
    delete stateBlocks[convId][key];
  }
  saveStateBlocks(stateBlocks);
  // Broadcast state update
  const msg = JSON.stringify({ type: "state-updated", conversationId: convId, data: stateBlocks[convId] });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
  res.json(stateBlocks[convId]);
});

// --- Search ---
app.get("/api/search", (req, res) => {
  if (!webAuthorized(req.query.token as string | undefined)) { res.status(403).json({ error: "unauthorized" }); return; }
  const room = manager.getActiveRoom();
  if (!room) { res.json([]); return; }
  const q = (req.query.q as string) || "";
  const limit = Number(req.query.limit ?? 20);
  if (!q) { res.json([]); return; }
  // Viewer is the registered web name, never the request (fails closed).
  res.json(room.search(q, limit, webViewer()));
});

app.get("/api/message/:id", (req, res) => {
  if (!webAuthorized(req.query.token as string | undefined)) { res.status(403).json({ error: "unauthorized" }); return; }
  const room = manager.getActiveRoom();
  if (!room) { res.status(400).json({ error: "No active conversation" }); return; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid message id" }); return; }
  const msg = room.getMessageById(id);
  // Viewer is the registered web name, never the request (fails closed).
  if (!msg || !visibleToViewer(msg, webViewer())) { res.status(404).json({ error: "Message not found" }); return; }
  res.json(msg);
});

// --- Export: decision log ---
app.get("/api/export/decisions", (req, res) => {
  if (!webAuthorized(req.query.token as string | undefined)) { res.status(403).json({ error: "unauthorized" }); return; }
  const room = manager.getActiveRoom();
  if (!room) { res.status(400).send("No active conversation"); return; }
  const meta = manager.getActiveMeta();
  // Deliberate full-conversation dump; intentionally includes DMs.
  const messages = room.readAll(100000);
  const decisions = messages.filter(m => m.tag === "decision" || m.tag === "handoff" || m.pinned);
  let md = `# Decision Log — ${meta?.name ?? "Joind"}\n\n`;
  for (const msg of decisions) {
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const tags = [msg.tag, msg.pinned ? "pinned" : ""].filter(Boolean).join(", ");
    md += `### #${msg.id} — ${msg.sender} (${time}) [${tags}]\n${msg.text}\n\n`;
  }
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.send(md);
});

// --- Export: session summary ---
app.get("/api/export/summary", (req, res) => {
  if (!webAuthorized(req.query.token as string | undefined)) { res.status(403).json({ error: "unauthorized" }); return; }
  const room = manager.getActiveRoom();
  if (!room) { res.status(400).send("No active conversation"); return; }
  const meta = manager.getActiveMeta();
  // Deliberate full-conversation dump; intentionally includes DMs.
  const messages = room.readAll(100000);
  const agents = room.who();
  const pinned = room.getPinnedMessages();
  const tagged = messages.filter(m => m.tag);
  const tagCounts: Record<string, number> = {};
  for (const m of tagged) { tagCounts[m.tag!] = (tagCounts[m.tag!] || 0) + 1; }

  let md = `# Session Summary — ${meta?.name ?? "Joind"}\n\n`;
  md += `- **Messages**: ${messages.length}\n`;
  md += `- **Participants**: ${agents.map(a => a.name + (a.role ? ` (${a.role})` : "")).join(", ")}\n`;
  md += `- **Pinned**: ${pinned.length}\n`;
  if (Object.keys(tagCounts).length > 0) {
    md += `- **Tags**: ${Object.entries(tagCounts).map(([k, v]) => `${k} (${v})`).join(", ")}\n`;
  }
  md += `\n## Pinned Messages\n\n`;
  for (const msg of pinned) {
    md += `- **#${msg.id} ${msg.sender}**: ${msg.text.slice(0, 120)}${msg.text.length > 120 ? "..." : ""}\n`;
  }
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.send(md);
});

// --- Conversation management ---
app.get("/api/conversations", (req, res) => {
  // Metadata only, but gating it closes the unauthenticated id-enumeration path.
  if (!webAuthorized(req.query.token as string | undefined)) { res.status(403).json({ error: "unauthorized" }); return; }
  res.json({
    conversations: manager.listConversations(),
    active: manager.getActiveMeta(),
  });
});

app.post("/api/conversations/new", express.json(), (req, res) => {
  const { name } = (req.body || {}) as { name?: string };
  const meta = manager.createConversation(name);
  res.json({ conversation: meta });
});

app.post("/api/conversations/select", express.json(), (req, res) => {
  const { id, token } = (req.body ?? {}) as { id?: string; token?: string };
  if (!id) { res.status(400).json({ error: "id required" }); return; }
  if (!webAuthorized(token)) { res.status(403).json({ error: "unauthorized" }); return; }
  const ok = manager.setActive(id);
  if (!ok) { res.status(404).json({ error: "Conversation not found" }); return; }
  const room = manager.getActiveRoom();
  res.json({
    conversation: manager.getActiveMeta(),
    // Viewer is the registered web name, never the request (fails closed).
    messages: room?.read(undefined, 100, undefined, webViewer()) ?? [],
    agents: room?.who() ?? [],
  });
});

app.post("/api/conversations/rename", express.json(), (req, res) => {
  const { id, name } = req.body as { id?: string; name?: string };
  if (!id || !name) { res.status(400).json({ error: "id and name required" }); return; }
  const ok = manager.renameConversation(id, name);
  res.json({ ok });
});

app.post("/api/conversations/star", express.json(), (req, res) => {
  const { id, starred } = req.body as { id?: string; starred?: boolean };
  if (!id) { res.status(400).json({ error: "id required" }); return; }
  const ok = manager.starConversation(id, starred ?? true);
  res.json({ ok });
});

app.post("/api/conversations/delete", express.json(), (req, res) => {
  const { id } = req.body as { id?: string };
  if (!id) { res.status(400).json({ error: "id required" }); return; }
  const ok = manager.deleteConversation(id);
  if (ok) {
    taskStore.deleteForConversation(id);
    reactionStore.deleteForConversation(id);
    editStore.deleteForConversation(id);
    taskTracker.clearConversation(id);
  }
  res.json({ ok });
});

app.get("/api/conversations/search", (req, res) => {
  const q = (req.query.q as string) || "";
  res.json(manager.searchConversations(q));
});

// --- Task management ---

app.get("/api/tasks", (req, res) => {
  const convId = (req.query.conversation as string) || manager.getActiveId();
  if (!convId) { res.json([]); return; }
  const status = (req.query.status as string) || "open";
  const assignee = req.query.assignee as string | undefined;
  res.json(taskStore.list(convId, { status, assignee }));
});

app.get("/api/tasks/count", (req, res) => {
  const convId = (req.query.conversation as string) || manager.getActiveId();
  if (!convId) { res.json({ count: 0, hasUrgent: false }); return; }
  res.json({
    count: taskStore.countOpen(convId),
    hasUrgent: taskStore.hasUrgent(convId),
  });
});

app.post("/api/tasks", express.json(), (req, res) => {
  const { title, description, creator, assignee, priority, conversation } = req.body as {
    title?: string; description?: string; creator?: string;
    assignee?: string; priority?: "normal" | "urgent"; conversation?: string;
  };
  if (!title || !creator) { res.status(400).json({ error: "title and creator required" }); return; }
  const convId = conversation || manager.getActiveId();
  if (!convId) { res.status(400).json({ error: "No active conversation" }); return; }

  const task = taskStore.create(convId, { title, description, creator, assignee, priority });

  // Post system message to chat
  const room = manager.getRoom(convId);
  if (room) {
    const assignText = task.assignee ? ` for ${task.assignee}` : "";
    const urgentText = task.priority === "urgent" ? " (urgent)" : "";
    room.send("system", `[Task #${task.id}${assignText}] ${creator} needs: ${task.title}${urgentText}`);
  }

  res.json(task);
});

app.post("/api/tasks/update", express.json(), (req, res) => {
  const { id, status, response, respondedBy, assignee, priority, conversation } = req.body as {
    id?: number; status?: "open" | "done"; response?: string;
    respondedBy?: string; assignee?: string; priority?: "normal" | "urgent";
    conversation?: string;
  };
  if (id == null) { res.status(400).json({ error: "id required" }); return; }
  const convId = conversation || manager.getActiveId();
  if (!convId) { res.status(400).json({ error: "No active conversation" }); return; }

  const task = taskStore.update(convId, id, { status, response, respondedBy, assignee, priority });
  if (!task) { res.status(404).json({ error: "Task not found" }); return; }

  // Post system message if task was resolved
  if (status === "done" && response) {
    const room = manager.getRoom(convId);
    if (room) {
      room.send("system", `[Task #${task.id} done] ${respondedBy ?? "someone"} responded: ${response.slice(0, 200)}`);
    }
  }

  res.json(task);
});

// --- Turn guard settings ---

app.get("/api/turn-guard", (_req, res) => {
  res.json(turnGuard);
});

app.post("/api/turn-guard", express.json(), (req, res) => {
  const { enabled, limit } = req.body as { enabled?: boolean; limit?: number };
  if (enabled !== undefined) turnGuard.enabled = enabled;
  if (limit !== undefined) turnGuard.limit = Math.max(1, Math.min(100, Math.round(limit)));
  saveTurnGuard(turnGuard);
  applyTurnGuard();
  // Broadcast to all WS clients
  const msg = JSON.stringify({ type: "turn-guard", data: turnGuard });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
  res.json(turnGuard);
});

// --- Agent REST API (MCP-free path for Claude Code agents) ---

/** The Orca handle a callback names (query for GETs, body for POSTs), used
 *  only to pick among bindings; never a credential on its own. */
function orcaOf(req: express.Request): string | undefined {
  const q = req.query?.orcaTerminal;
  if (typeof q === "string" && q.trim()) return q.trim();
  const b = (req.body as { orcaTerminal?: unknown } | undefined)?.orcaTerminal;
  return typeof b === "string" && b.trim() ? b.trim() : undefined;
}

/** The WezTerm GUI instance a request names (query or body): a pane number
 *  identifies a registration only together with it. */
function weztermGuiOf(req: express.Request): number | undefined {
  const raw = req.query?.weztermGui ?? (req.body as { weztermGui?: unknown } | undefined)?.weztermGui;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The registration id a request names (query or body `registration`). */
function registrationOf(req: express.Request): string | undefined {
  const raw = req.query?.registration ?? (req.body as { registration?: unknown } | undefined)?.registration;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/** The candidates of a name registered more than once, for a 403 or 409:
 *  where each is and the terminal it answers on (never the ids). */
function registrationCandidates(name: string) {
  return manager.bindingsOf(name).map((e) => ({
    conversation: e.conversationId,
    ...(e.pid ? { pid: e.pid } : {}),
    ...(e.paneId != null && e.weztermGui != null ? { paneId: e.paneId, weztermGui: e.weztermGui } : {}),
    ...(e.orcaTerminal ? { orcaTerminal: e.orcaTerminal } : {}),
    ...(isTerminalLess(e) ? { terminalLess: true } : {}),
  }));
}

/** Helper: get agent's room by name binding (with optional pid, pane with
 *  its GUI, or Orca handle disambiguation) */
function agentRoom(name: string, res: express.Response, pid?: number, paneId?: number, orcaTerminal?: string, weztermGui?: number, registration?: string) {
  // Security gate: an existing binding is the credential. getAgentBinding is a
  // pure lookup and never creates one; bindings exist only after a join flow
  // (MCP chat_join, /api/agent/join, or the UI invite /api/join). A local HTTP
  // client claiming an unbound name gets nothing.
  const convId = manager.getAgentBinding(name, pid, paneId, orcaTerminal, weztermGui, registration);
  if (convId) {
    const room = manager.getRoom(convId);
    if (room) {
      // Add rate limit headers
      const turns = room.getAgentTurnCount();
      const guard = room.turnGuard;
      if (guard) {
        res.setHeader("X-RateLimit-Limit", guard.limit);
        res.setHeader("X-RateLimit-Remaining", Math.max(0, guard.limit - turns));
        res.setHeader("X-RateLimit-Enabled", guard.enabled ? "true" : "false");
      }
      return { room, convId };
    }
  }
  // No binding, no service: 403 (not 400) so scanners don't mistake this for
  // a malformed request, and so the credential requirement is explicit.
  const candidates = registrationCandidates(name);
  if (registration == null && candidates.length > 1) {
    // Several registrations of this name and nothing in the request names
    // one: serve none of them (gate round 4, finding 2).
    res.status(403).json({ error: "Ambiguous: this name is registered more than once. Pass registration (from your join reply), pid, or paneId with weztermGui.", candidates });
    return null;
  }
  res.status(403).json({ error: "No binding for this agent. Join first (chat_join), then retry." });
  return null;
}

app.post("/api/agent/join", express.json(), async (req, res) => {
  let { name, pid, conversation, wtSession, weztermPaneId } = req.body as {
    name?: string; pid?: number; conversation?: string; wtSession?: string; weztermPaneId?: number;
  };
  const requestedOrca = (req.body as { orcaTerminal?: unknown }).orcaTerminal;
  if (!name) { res.status(400).json({ error: "name required" }); return; }

  // Auto-detect PID/paneId if not provided (an Orca handle names its terminal already)
  let discoveredGui: number | undefined;
  if (!pid && weztermPaneId == null && requestedOrcaHandle(requestedOrca) === undefined) {
    try {
      const terminals = await discoverTerminals();
      const available = availableForAutoJoin(terminals, manager.listConversations().map(c => manager.getRoom(c.id)));
      if (available.length === 1) {
        pid = available[0].pid;
        weztermPaneId = available[0].weztermPaneId;
        // The pane is the pair: keep the GUI its discovery row was found in
        // (gate round 3, finding 1), for resolution, freshness and the binding.
        discoveredGui = available[0].weztermPaneId != null ? available[0].weztermGui : undefined;
      } else if (available.length > 1) {
        res.status(300).json({
          error: "Multiple Claude Code processes found. Specify pid or weztermPaneId.",
          terminals: available,
        });
        return;
      }
    } catch { /* ignore discovery errors */ }
  }

  // Resolve conversation
  let convId = conversation;
  if (!convId) {
    convId = manager.getActiveId() ?? undefined;
  }
  if (!convId) {
    const meta = manager.createConversation();
    convId = meta.id;
    manager.setActive(convId); // First conversation — make it active for web UI
  }

  if (!manager.getRoom(convId)) { res.status(404).json({ error: "Conversation not found" }); return; }
  const joinToken = manager.beginJoin(name, convId, pid, weztermPaneId, requestedOrcaHandle(requestedOrca), discoveredGui);

  // Bind a WezTerm pane or an Orca terminal only when it is live and really
  // this process's (one process enumeration shared by both checks).
  const tree = processTreeOnce();
  const [paneResolution, orcaResolution] = await Promise.all([
    resolvePaneForJoin(name, pid || 0, weztermPaneId, defaultPaneResolverDeps(manager, tree), discoveredGui),
    resolveOrcaForJoin(name, pid || 0, requestedOrca, defaultOrcaResolverDeps(manager, tree)),
  ]);
  const boundPane = paneResolution.paneId;
  const boundOrca = orcaResolution.orcaTerminal;

  // Re-fetch after the await: a conversation deleted meanwhile must not be
  // resurrected by joining its destroyed room, and a newer join or a
  // departure for this name meanwhile wins over this one.
  const room = manager.getRoom(convId);
  if (!room) { res.status(404).json({ error: "Conversation not found" }); return; }
  if (!manager.joinIsCurrent(joinToken, pid, boundPane ?? undefined, boundOrca ?? undefined, paneResolution.gui)) { res.status(409).json({ error: "Join superseded by a newer join or a departure for this name" }); return; }

  const registration = newRegistrationId();
  const agent = room.join(name, pid || 0, boundPane, agentRoles[name], boundOrca, paneResolution.gui, registration);
  manager.bindAgent(name, convId, pid, boundPane, boundOrca, paneResolution.gui, registration);
  room.touch(name);
  if (wtSession) { tabNames[wtSession] = name; saveTabNames(tabNames); }

  // Name the WezTerm tab if available
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
  // Filtered to what this agent may see: public messages + DMs addressed to them
  const recent = room.read(undefined, 15, undefined, name);
  const lastId = recent.length > 0 ? recent[recent.length - 1].id : 0;

  res.json({
    ok: true,
    registration,
    conversation: { id: convId, name: meta?.name ?? convId },
    online: room.whoNames(),
    lastMessageId: lastId,
    recentMessages: recent,
    totalMessages: room.messageCount(),
    weztermPaneId: agent.weztermPaneId,
    weztermGui: agent.weztermGui,
    orcaTerminal: agent.orcaTerminal,
    ...(paneResolution.note ? { paneNote: paneResolution.note } : {}),
    ...(orcaResolution.note ? { orcaNote: orcaResolution.note } : {}),
  });
});

// Cheap presence keepalive an agent can fire between long operations
// without holding a connection. Pairs with the presence grace window.
app.post("/api/agent/heartbeat", express.json(), (req, res) => {
  const { name, pid, paneId } = (req.body ?? {}) as { name?: string; pid?: number; paneId?: number };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const ctx = agentRoom(name, res, pid, paneId, orcaOf(req), weztermGuiOf(req), registrationOf(req));
  if (!ctx) return;
  ctx.room.touch(name);
  res.json({ ok: true, at: Date.now() });
});

app.get("/api/agent/listen", async (req, res) => {
  const sender = req.query.sender as string;
  if (!sender) { res.status(400).json({ error: "sender param required" }); return; }
  const pid = req.query.pid != null ? Number(req.query.pid) : undefined;
  const paneId = req.query.paneId != null ? Number(req.query.paneId) : undefined;
  const ctx = agentRoom(sender, res, pid, paneId, orcaOf(req), weztermGuiOf(req), registrationOf(req));
  if (!ctx) return;
  const since = req.query.since != null ? Number(req.query.since) : undefined;
  const timeoutMs = clampListenTimeout(
    req.query.timeoutMs != null ? Number(req.query.timeoutMs) : undefined
  );
  const mentionsOnly = req.query.mentionsOnly === "true" || req.query.mentionsOnly === "1";
  // A vanished client (curl --max-time, closed tab) aborts the wait so the
  // room listener, timers, and slot free immediately and the cursor is not
  // advanced for messages that were never delivered.
  const abort = new AbortController();
  req.on("close", () => abort.abort());
  ctx.room.touch(sender);
  const result = await waitForMessage(ctx.room, sender, since, timeoutMs, {
    mentionsOnly,
    signal: abort.signal,
  });
  ctx.room.touch(sender);
  if (result.aborted) return;
  if (result.lastId > 0) cursorStore.advance(sender, result.lastId);
  res.json(result);
});

app.get("/api/agent/read", (req, res) => {
  const sender = req.query.sender as string;
  if (!sender) { res.status(400).json({ error: "sender param required" }); return; }
  const pid = req.query.pid != null ? Number(req.query.pid) : undefined;
  const paneId = req.query.paneId != null ? Number(req.query.paneId) : undefined;
  const ctx = agentRoom(sender, res, pid, paneId, orcaOf(req), weztermGuiOf(req), registrationOf(req));
  if (!ctx) return;
  const since = req.query.since != null ? Number(req.query.since) : undefined;
  const limit = Number(req.query.limit ?? 50);
  const from = req.query.from as string | undefined;
  ctx.room.touch(sender);
  const messages = ctx.room.read(since, limit, from, sender);
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : (since ?? 0);
  if (lastId > 0) cursorStore.advance(sender, lastId);
  res.json({ messages, lastId });
});

app.post("/api/agent/send", express.json(), (req, res) => {
  const { sender, text, replyTo, choices, pid, paneId, askFor, to } = req.body as {
    sender?: string; text?: string; replyTo?: number; choices?: string[]; pid?: number; paneId?: number; askFor?: string; to?: unknown;
  };
  if (!sender || !text) { res.status(400).json({ error: "sender and text required" }); return; }
  // Targeted send over REST: the same DM semantics as chat_dm, for agents
  // that live on the REST loop (a DM read through listen can be answered
  // in kind instead of leaking into the room).
  let recipients: string[] | undefined;
  if (to !== undefined) {
    if (!Array.isArray(to) || to.length === 0 || !to.every((t) => typeof t === "string" && t.trim().length > 0)) {
      res.status(400).json({ error: "to must be a non-empty array of names" });
      return;
    }
    recipients = [...new Set((to as string[]).map((t) => t.trim()).filter((t) => t !== sender))];
    if (recipients.length === 0) { res.status(400).json({ error: "to must name someone other than the sender" }); return; }
  }
  const ctx = agentRoom(sender, res, pid, paneId, orcaOf(req), weztermGuiOf(req), registrationOf(req));
  if (!ctx) return;
  ctx.room.touch(sender);
  ctx.room.setTyping(sender, false);
  // A DM must never title the room: auto-naming copies the first 60 chars
  // into a name that is broadcast to every client, party or not.
  if (!recipients) manager.autoName(ctx.convId, text);
  const msg = ctx.room.send(sender, text, {
    replyTo, choices,
    askFor: typeof askFor === "string" ? askFor : undefined,
    to: recipients,
  });
  res.json({ id: msg.id, sender: msg.sender, text: msg.text, choices: msg.choices, to: msg.to, ask: msg.ask });
});

app.post("/api/agent/leave", express.json(), (req, res) => {
  const { name, pid, paneId } = req.body as { name?: string; pid?: number; paneId?: number };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const registration = registrationOf(req);
  const convId = manager.getAgentBinding(name, pid, paneId, orcaOf(req), weztermGuiOf(req), registration);
  if (!convId && registration != null) {
    // A named registration that does not exist is not a reason to remove another.
    res.status(404).json({ error: "No such registration for this name (already left, or rejoined with a new id)" });
    return;
  }
  if (!convId) {
    const candidates = manager.bindingsOf(name);
    if (candidates.length > 1) {
      // Several registrations and nothing in the request names one: remove
      // none of them (gate round 3, finding 3). The caller names its
      // terminal: pid, the pair (paneId with weztermGui), or orcaTerminal.
      res.status(409).json({
        error: "Ambiguous departure: this name is registered more than once. Pass registration (from your join reply), pid, paneId with weztermGui, or orcaTerminal.",
        candidates: registrationCandidates(name),
      });
      return;
    }
  }
  const room = convId ? manager.getRoom(convId) : undefined;
  const entry = convId ? manager.bindingsOf(name).find((e) => e.conversationId === convId) : undefined;
  if (convId && !departureIsCurrent(room, name, entry?.registration, registration)) {
    // The registration is not the room's current member of that name (it was
    // superseded by a later join): remove nothing (gate round 5).
    res.status(404).json({ error: "No such registration for this name (already left, or rejoined with a new id)" });
    return;
  }
  manager.supersedeJoins(name);
  if (room) room.leave(name);
  if (entry) manager.unbindRegistration(name, entry.registration);
  res.json({ ok: true });
});

app.post("/api/agent/typing", express.json(), (req, res) => {
  const { name, typing, pid, paneId } = req.body as { name?: string; typing?: boolean; pid?: number; paneId?: number };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const ctx = agentRoom(name, res, pid, paneId, orcaOf(req), weztermGuiOf(req), registrationOf(req));
  if (!ctx) return;
  ctx.room.setTyping(name, typing ?? true);
  res.json({ ok: true });
});

app.post("/api/agent/heartbeat", express.json(), (req, res) => {
  const { name, pid, paneId } = req.body as { name?: string; pid?: number; paneId?: number };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const ctx = agentRoom(name, res, pid, paneId, orcaOf(req), weztermGuiOf(req), registrationOf(req));
  if (!ctx) return;
  ctx.room.touch(name);
  res.json({ ok: true });
});

app.post("/api/agent/status", express.json(), (req, res) => {
  const { name, status, pid, paneId } = req.body as { name?: string; status?: string; pid?: number; paneId?: number };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const ctx = agentRoom(name, res, pid, paneId, orcaOf(req), weztermGuiOf(req), registrationOf(req));
  if (!ctx) return;
  const agent = ctx.room.setStatus(name, status ?? "");
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json({ name: agent.name, status: agent.status });
});

// --- Workflow sessions ---
app.get("/api/templates", (_req, res) => {
  res.json(getTemplates());
});

app.get("/api/sessions", (_req, res) => {
  res.json(getActiveSessions());
});

app.post("/api/session/start", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const { templateId, cast, goal, startedBy } = req.body as {
    templateId?: string; cast?: Record<string, string>;
    goal?: string; startedBy?: string;
  };
  if (!templateId || !cast) { res.status(400).json({ error: "templateId and cast required" }); return; }
  const tmpl = getTemplate(templateId);
  if (!tmpl) { res.status(404).json({ error: "Template not found" }); return; }
  const missing = tmpl.roles.filter((r) => !cast[r]);
  if (missing.length > 0) { res.status(400).json({ error: "Missing roles", missing }); return; }
  const session = startSession(templateId, cast, goal ?? "", startedBy ?? "human", room, (name) => cursorStore.get(name));
  if (!session) { res.status(500).json({ error: "Failed" }); return; }
  res.json(session);
});

app.post("/api/session/cancel", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const { id } = req.body as { id?: number };
  if (!id) { res.status(400).json({ error: "id required" }); return; }
  const ok = cancelSession(id, room);
  res.json({ ok });
});

app.get("/api/terminals", async (_req, res) => {
  try {
    const terminals = await discoverTerminals();
    // Build pid→name from all rooms (most reliable — room already knows invited agents)
    const pidToName = new Map<number, string>();
    for (const conv of manager.listConversations()) {
      const r = manager.getRoom(conv.id);
      if (r) for (const a of r.who()) if (a.pid) pidToName.set(a.pid, a.name);
    }
    for (const t of terminals) {
      if (!t.tabTitle) {
        if (t.wtSession && tabNames[t.wtSession]) t.tabTitle = tabNames[t.wtSession];
        else if (pidToName.has(t.pid)) t.tabTitle = pidToName.get(t.pid);
      }
    }
    res.json(terminals);
  } catch { res.json([]); }
});

// --- Crew management ---

app.get("/api/crew", (_req, res) => {
  const crew = CrewStore.getAll();
  const enriched = crew.map((entry) => {
    const identityExists =
      entry.identityFile
        ? existsSync(join(entry.path, entry.identityFile))
        : false;
    const mcpConfig = {
      claude:
        existsSync(join(entry.path, ".claude", "settings.json")) ||
        existsSync(join(entry.path, ".claude", "settings.local.json")),
      codex: existsSync(join(entry.path, ".codex")),
      gemini: existsSync(join(entry.path, ".gemini")),
      openclaw: existsSync(join(entry.path, ".openclaw")),
    };
    // Legacy boolean for backward compat
    const hasMcpConfig = mcpConfig.claude;
    return { ...entry, identityExists, hasMcpConfig, mcpConfig };
  });
  res.json(enriched);
});

app.post("/api/crew", express.json(), (req, res) => {
  const { name, path: folderPath, defaultHarness, defaultConversation, joinAs } =
    req.body as {
      name?: string;
      path?: string;
      defaultHarness?: string;
      defaultConversation?: string;
      joinAs?: string;
    };

  if (!name || !folderPath) {
    res.status(400).json({ error: "name and path required" });
    return;
  }

  const entry: CrewFolder = { name, path: folderPath };
  if (defaultHarness) entry.defaultHarness = defaultHarness;
  if (defaultConversation) entry.defaultConversation = defaultConversation;

  // Auto-detect identity file if not provided
  const detected = detectIdentityFile(folderPath);
  if (detected) {
    entry.identityFile = detected.file;
    entry.joinAs = joinAs ?? detected.joinAs;
  } else if (joinAs) {
    entry.joinAs = joinAs;
  }

  const { valid, errors } = validateCrewFolder(entry);
  if (!valid) {
    res.status(400).json({ error: errors.join("; ") });
    return;
  }

  CrewStore.add(entry);
  res.json(entry);
});

function publicServerUrl(): string {
  const shown = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  return `http://${shown}:${PORT}`;
}

app.post("/api/crew/scaffold", express.json(), (req, res) => {
  const body = req.body as {
    name?: string; parentDir?: string; joinAs?: string; role?: string;
    emoji?: string; defaultHarness?: string; defaultConversation?: string;
  };
  if (!body.name || typeof body.name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const parentDir = typeof body.parentDir === "string" && body.parentDir.trim().length > 0
    ? body.parentDir.trim()
    : CONFIG.crewHome;
  try {
    const result = scaffoldCrewMember({
      name: body.name,
      parentDir: parentDir,
      joinAs: typeof body.joinAs === "string" ? body.joinAs : undefined,
      role: typeof body.role === "string" ? body.role : undefined,
      emoji: typeof body.emoji === "string" ? body.emoji : undefined,
      defaultHarness: typeof body.defaultHarness === "string" ? body.defaultHarness : undefined,
      defaultConversation: typeof body.defaultConversation === "string" ? body.defaultConversation : undefined,
      serverUrl: publicServerUrl(),
    });
    res.json(result);
  } catch (err) {
    const e = err as Error & { code?: string };
    res.status(e.code === "DUPLICATE" ? 409 : 400).json({ error: e.message });
  }
});

app.post("/api/crew/kit", express.json(), (req, res) => {
  const body = req.body as {
    name?: string; joinAs?: string; role?: string; emoji?: string; conversation?: string;
  };
  if (!body.name || typeof body.name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }
  res.json(buildIdentityKit({
    name: body.name,
    joinAs: typeof body.joinAs === "string" ? body.joinAs : body.name,
    role: typeof body.role === "string" ? body.role : undefined,
    emoji: typeof body.emoji === "string" ? body.emoji : undefined,
    serverUrl: publicServerUrl(),
    conversation: typeof body.conversation === "string" ? body.conversation : undefined,
  }));
});

app.get("/api/crew/meta", (_req, res) => {
  res.json({ crewHome: CONFIG.crewHome, serverUrl: publicServerUrl() });
});

app.delete("/api/crew/:name", (req, res) => {
  const removed = CrewStore.remove(req.params.name);
  if (!removed) {
    res.status(404).json({ error: "Crew entry not found" });
    return;
  }
  res.json({ ok: true });
});

app.patch("/api/crew/:name", express.json(), (req, res) => {
  const body = req.body as Partial<CrewFolder>;
  const allowed: Partial<Omit<CrewFolder, "name">> = {};
  if (typeof body.path === "string") allowed.path = body.path;
  if (typeof body.joinAs === "string") allowed.joinAs = body.joinAs;
  if (typeof body.defaultHarness === "string") allowed.defaultHarness = body.defaultHarness;
  if (typeof body.defaultConversation === "string") allowed.defaultConversation = body.defaultConversation;
  if (typeof body.role === "string") allowed.role = body.role;
  if (typeof body.emoji === "string") allowed.emoji = body.emoji;
  if (body.defaultFlags && typeof body.defaultFlags === "object") allowed.defaultFlags = body.defaultFlags;

  if (allowed.path !== undefined) {
    const check = validateCrewFolder({ name: req.params.name, path: allowed.path });
    if (!check.valid) {
      res.status(400).json({ error: check.errors.join("; ") });
      return;
    }
  }

  const updated = CrewStore.update(req.params.name, allowed);
  if (!updated) {
    res.status(404).json({ error: `Unknown crew member: ${req.params.name}` });
    return;
  }
  res.json(updated);
});

// --- Launcher terminal picker ---

/** Resolve a command name via where/which, preferring .exe/.cmd/.bat on Windows. */
async function resolveExe(command: string): Promise<string | null> {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(whichCmd, [command], { timeout: 3000 });
    const lines = stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return pickBestExePath(lines);
  } catch {
    return null;
  }
}

app.get("/api/launcher/terminals", async (_req, res) => {
  try {
    const [weztermPath, wtPath] = await Promise.all([
      resolveExe("wezterm"),
      process.platform === "win32" ? resolveExe("wt") : Promise.resolve(null),
    ]);

    const weztermRunning = weztermPath ? await checkWezTerm() : false;

    res.json({
      wezterm: {
        available: weztermPath !== null,
        running: weztermRunning,
        path: weztermPath ?? undefined,
      },
      wt: {
        available: wtPath !== null,
        path: wtPath ?? undefined,
      },
      manual: {
        available: true,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Harness registry ---

app.get("/api/harnesses", async (_req, res) => {
  try {
    const harnesses = await getHarnesses();
    res.json(harnesses);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Agent launcher ---

app.get("/api/launcher/sessions", async (req, res) => {
  const harnessId = String(req.query.harness ?? "").trim();
  const cwd = String(req.query.cwd ?? "").trim();
  const limitRaw = parseInt(String(req.query.limit ?? "30"), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 30;

  if (!harnessId || !cwd) {
    res.status(400).json({ error: "harness and cwd query parameters are required" });
    return;
  }

  try {
    const sessions = await listSessionsForHarness(harnessId, cwd, limit);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/launch", express.json(), async (req, res) => {
  const { crewName, crewPath, harness: harnessId, flags, conversation, joinAs, injectDelay, terminal, initialPrompt, resumeSessionId } =
    req.body as {
      crewName?: string;
      crewPath?: string;
      harness?: string;
      flags?: Record<string, string | string[] | boolean>;
      conversation?: string;
      joinAs?: string;
      injectDelay?: number;
      terminal?: "wezterm" | "wt" | "manual";
      initialPrompt?: string;
      resumeSessionId?: string;
    };

  if (!crewName || !crewPath || !harnessId || !joinAs) {
    res.status(400).json({ error: "crewName, crewPath, harness, and joinAs are required" });
    return;
  }

  const harnesses = await getHarnesses();
  const harness = harnesses.find((h) => h.id === harnessId);
  if (!harness) {
    res.status(400).json({ error: `Unknown harness: ${harnessId}` });
    return;
  }

  const resolvedDelay =
    typeof injectDelay === "number" && injectDelay >= 0
      ? injectDelay
      : harness.defaultDelay;

  const resolvedTerminal: "wezterm" | "wt" | "manual" = terminal ?? "wezterm";

  // Resolve wt.exe path if needed
  let wtExe: string | undefined;
  if (resolvedTerminal === "wt" && process.platform === "win32") {
    wtExe = (await resolveExe("wt")) ?? "wt";
  }

  try {
    const result = await LaunchService.launch(
      {
        crewName,
        crewPath,
        harness: harnessId,
        flags: flags ?? {},
        conversation,
        joinAs,
        injectDelay: resolvedDelay,
        terminal: resolvedTerminal,
        initialPrompt,
        resumeSessionId,
      },
      harness,
      getWeztermPath(),
      getWeztermEnv(),
      wtExe
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/launch/:launchId/inject", async (req, res) => {
  const { launchId } = req.params;
  const current = LaunchService.getLaunchStatus(launchId);
  if (!current) {
    res.status(404).json({ error: `Launch ${launchId} not found` });
    return;
  }
  try {
    await LaunchService.inject(launchId);
    const updated = LaunchService.getLaunchStatus(launchId);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/launch/:launchId", (req, res) => {
  const result = LaunchService.getLaunchStatus(req.params.launchId);
  if (!result) {
    res.status(404).json({ error: `Launch ${req.params.launchId} not found` });
    return;
  }
  res.json(result);
});

// Serve index.html with the web token injected, before static so the
// injection cannot be bypassed. Cache disabled: the token must be fresh.
// A USER-SET token is deliberately NOT injected: the browser prompts for it
// once per tab session (sessionStorage) instead of every requester getting it.
app.get("/", (_req, res) => {
  const htmlPath = join(__dirname, "..", "public", "index.html");
  res.setHeader("Cache-Control", "no-store");
  const html = readFileSync(htmlPath, "utf8");
  res.type("html").send(CONFIG.webTokenUserSet ? html : injectWebToken(html, CONFIG.webToken));
});

// --- Static files ---
app.use(express.static(join(__dirname, "..", "public")));

// --- Start ---
httpServer.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║  Joind v0.2.0 — Agent Chat via MCP    ║`);
  console.log(`  ║  MCP:  http://${shown}:${PORT}/mcp`);
  console.log(`  ║  Web:  http://${shown}:${PORT}/`);
  console.log(`  ║  Bind: ${HOST}`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
  if (HOST !== "127.0.0.1") {
    console.log(`  [network] Bound to ${HOST} — reachable by remote agents. Ensure this is a private (e.g. Tailscale) interface, not the public internet.\n`);
  }
  if (!CONFIG.webTokenUserSet) {
    console.log(`  [web] Generated web token is served to any requester of /; on a multi-user or non-loopback host, set JOIND_WEB_TOKEN or --web-token to keep it out of the page.`);
  }
});

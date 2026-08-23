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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConversationManager } from "./manager.js";
import { registerTools } from "./tools.js";
import { TaskStore } from "./tasks.js";
import { ReactionStore } from "./reactions.js";
import { CursorStore } from "./cursors.js";
import { EditStore } from "./edits.js";
import { discoverTerminals, renameTabTitle, checkWezTerm, discoverWezTerm, getWeztermPath, getWeztermEnv } from "./terminals.js";
import CrewStore, { detectIdentityFile, validateCrewFolder, initCrewStore } from "./crew.js";
import { loadConfig, acquireLock } from "./config.js";
import type { CrewFolder } from "./crew.js";
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

// Forward conversation room events to WebSocket clients (scoped by active conversation)
manager.on("room", (event) => {
  // Include conversationId so the web UI can filter
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
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
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
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
wss.on("connection", (ws) => {
  // Lazy loading: only send conversation index on connect.
  // Messages load when the user selects a conversation.
  const activeMeta = manager.getActiveMeta();
  const activeRoom = activeMeta ? manager.getActiveRoom() : undefined;
  const activeId = activeMeta?.id;
  ws.send(
    JSON.stringify({
      type: "init",
      data: {
        agents: activeRoom?.who() ?? [],
        messages: activeRoom ? activeRoom.read(undefined, 100) : [],
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

app.use("/data", express.static(DATA_DIR));

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

app.post("/api/send", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const { sender, text, image, replyTo, choices } = req.body as {
    sender?: string; text?: string; image?: string; replyTo?: number; choices?: string[];
  };
  if (!sender || !text) {
    res.status(400).json({ error: "sender and text required" });
    return;
  }
  // Auto-name conversation from first user message
  const activeId = manager.getActiveId();
  if (activeId && sender !== "system") manager.autoName(activeId, text);

  const msg = room.send(sender, text, { image, replyTo, choices });
  res.json({ id: msg.id, sender: msg.sender, text: msg.text, choices: msg.choices });
});

app.get("/api/messages", (req, res) => {
  const room = manager.getActiveRoom();
  const from = req.query.from as string | undefined;
  res.json(room?.read(undefined, 100, from) ?? []);
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

app.get("/api/export", (_req, res) => {
  const room = manager.getActiveRoom();
  if (!room) { res.status(400).send("No active conversation"); return; }
  const meta = manager.getActiveMeta();
  const messages = room.read(undefined, 10000);
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
  const convId = req.params.id;
  const meta = manager.getMeta(convId);
  const room = manager.getRoom(convId);
  if (!meta || !room) { res.status(404).json({ error: "Conversation not found" }); return; }
  const messages = room.read(undefined, 1000000);
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

app.post("/api/join", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const { name, pid, wtSession, weztermPaneId } = req.body as {
    name?: string; pid?: number; wtSession?: string; weztermPaneId?: number;
  };
  if (!name || (!pid && weztermPaneId == null)) { res.status(400).json({ error: "name and pid (or weztermPaneId) required" }); return; }
  const agent = room.join(name, pid || 0, weztermPaneId, agentRoles[name]);
  const activeId = manager.getActiveId();
  if (activeId) manager.bindAgent(name, activeId, pid, weztermPaneId);
  if (pid) renameTabTitle(pid, name).catch(() => {});
  if (wtSession) { tabNames[wtSession] = name; saveTabNames(tabNames); }
  res.json({ name: agent.name, pid: agent.pid, weztermPaneId: agent.weztermPaneId, online: room.whoNames() });
});

app.post("/api/leave", express.json(), (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  // Leave from whichever conversation they're in
  const convId = manager.getAgentBinding(name);
  const room = convId ? manager.getRoom(convId) : manager.getActiveRoom();
  if (room) room.leave(name);
  if (convId) {
    manager.unbindAgent(name, convId);
  } else {
    manager.unbindAgent(name);
  }
  res.json({ ok: true });
});

app.post("/api/rename", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const { oldName, newName } = req.body as { oldName?: string; newName?: string };
  if (!oldName || !newName) { res.status(400).json({ error: "oldName and newName required" }); return; }
  const agent = room.rename(oldName, newName);
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  // Update binding
  const convId = manager.getAgentBinding(oldName);
  if (convId) {
    manager.unbindAgent(oldName, convId);
    manager.bindAgent(newName, convId, agent.pid, agent.weztermPaneId);
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
app.post("/api/message/:id/edit", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const messageId = Number(req.params.id);
  if (!Number.isInteger(messageId) || messageId < 1) { res.status(400).json({ error: "Invalid message id" }); return; }
  const { sender, newText } = req.body as { sender?: string; newText?: string };
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
  const ctx = agentRoom(sender, res, pid, paneId);
  if (!ctx) return;
  const cursor = cursorStore.get(sender);
  const newMsgs = ctx.room.read(cursor, 100000);
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

app.get("/api/pins", (_req, res) => {
  const room = manager.getActiveRoom();
  if (!room) { res.json([]); return; }
  res.json(room.getPinnedMessages());
});

// --- Inline decision choices ---
app.post("/api/message/:id/choose", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const messageId = Number(req.params.id);
  if (!Number.isInteger(messageId) || messageId < 1) { res.status(400).json({ error: "Invalid message id" }); return; }
  const { value, by } = req.body as { value?: string; by?: string };
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
  const room = manager.getActiveRoom();
  if (!room) { res.json([]); return; }
  const q = (req.query.q as string) || "";
  const limit = Number(req.query.limit ?? 20);
  if (!q) { res.json([]); return; }
  res.json(room.search(q, limit));
});

app.get("/api/message/:id", (req, res) => {
  const room = manager.getActiveRoom();
  if (!room) { res.status(400).json({ error: "No active conversation" }); return; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid message id" }); return; }
  const msg = room.getMessageById(id);
  if (!msg) { res.status(404).json({ error: "Message not found" }); return; }
  res.json(msg);
});

// --- Export: decision log ---
app.get("/api/export/decisions", (_req, res) => {
  const room = manager.getActiveRoom();
  if (!room) { res.status(400).send("No active conversation"); return; }
  const meta = manager.getActiveMeta();
  const messages = room.read(undefined, 100000);
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
app.get("/api/export/summary", (_req, res) => {
  const room = manager.getActiveRoom();
  if (!room) { res.status(400).send("No active conversation"); return; }
  const meta = manager.getActiveMeta();
  const messages = room.read(undefined, 100000);
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
app.get("/api/conversations", (_req, res) => {
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
  const { id } = req.body as { id?: string };
  if (!id) { res.status(400).json({ error: "id required" }); return; }
  const ok = manager.setActive(id);
  if (!ok) { res.status(404).json({ error: "Conversation not found" }); return; }
  const room = manager.getActiveRoom();
  res.json({
    conversation: manager.getActiveMeta(),
    messages: room?.read(undefined, 100) ?? [],
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

/** Helper: get agent's room by name binding (with optional pid/paneId disambiguation) */
function agentRoom(name: string, res: express.Response, pid?: number, paneId?: number) {
  const convId = manager.getAgentBinding(name, pid, paneId);
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
  // No fallback — agent must join first to avoid cross-conversation pollution
  res.status(400).json({ error: "Not in a conversation. Call /api/agent/join first." });
  return null;
}

app.post("/api/agent/join", express.json(), async (req, res) => {
  let { name, pid, conversation, wtSession, weztermPaneId } = req.body as {
    name?: string; pid?: number; conversation?: string; wtSession?: string; weztermPaneId?: number;
  };
  if (!name) { res.status(400).json({ error: "name required" }); return; }

  // Auto-detect PID/paneId if not provided
  if (!pid && weztermPaneId == null) {
    try {
      const terminals = await discoverTerminals();
      const allRooms = manager.listConversations().map(c => manager.getRoom(c.id)).filter(Boolean);
      const takenPids = new Set<number>();
      const takenPanes = new Set<number>();
      for (const r of allRooms) { if (r) for (const a of r.who()) {
        if (a.pid) takenPids.add(a.pid);
        if (a.weztermPaneId != null) takenPanes.add(a.weztermPaneId);
      }}
      const available = terminals.filter(t =>
        t.type === "claude" &&
        (t.weztermPaneId != null ? !takenPanes.has(t.weztermPaneId) : !takenPids.has(t.pid))
      );
      if (available.length === 1) {
        pid = available[0].pid;
        weztermPaneId = available[0].weztermPaneId;
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

  const room = manager.getRoom(convId);
  if (!room) { res.status(404).json({ error: "Conversation not found" }); return; }

  // Auto-detect WezTerm pane if not provided
  if (weztermPaneId == null && await checkWezTerm()) {
    try {
      const panes = await discoverWezTerm();
      const claimedPanes = new Set<number>();
      for (const c of manager.listConversations()) {
        const r = manager.getRoom(c.id);
        if (r) for (const a of r.who()) if (a.weztermPaneId != null) claimedPanes.add(a.weztermPaneId);
      }
      const unclaimed = panes.filter(p => p.weztermPaneId != null && !claimedPanes.has(p.weztermPaneId!) && p.type !== "unknown");
      if (unclaimed.length === 1) {
        weztermPaneId = unclaimed[0].weztermPaneId;
        console.log(`  [wezterm] Auto-detected pane ${weztermPaneId} for ${name}`);
      }
    } catch { /* best effort */ }
  }

  const agent = room.join(name, pid || 0, weztermPaneId, agentRoles[name]);
  manager.bindAgent(name, convId, pid, weztermPaneId);
  room.touch(name);
  if (wtSession) { tabNames[wtSession] = name; saveTabNames(tabNames); }

  // Name the WezTerm tab if available
  if (weztermPaneId != null) {
    const wtEnv = Object.keys(getWeztermEnv()).length > 0 ? { ...process.env, ...getWeztermEnv() } : undefined;
    execFileAsync(getWeztermPath(), ["cli", "set-tab-title", name, "--pane-id", String(weztermPaneId)], { env: wtEnv })
      .catch(() => {});
  }

  const meta = manager.getMeta(convId);
  const recent = room.read(undefined, 15);
  const lastId = recent.length > 0 ? recent[recent.length - 1].id : 0;

  res.json({
    ok: true,
    conversation: { id: convId, name: meta?.name ?? convId },
    online: room.whoNames(),
    lastMessageId: lastId,
    recentMessages: recent,
    totalMessages: room.messageCount(),
  });
});

app.get("/api/agent/read", (req, res) => {
  const sender = req.query.sender as string;
  if (!sender) { res.status(400).json({ error: "sender param required" }); return; }
  const pid = req.query.pid != null ? Number(req.query.pid) : undefined;
  const paneId = req.query.paneId != null ? Number(req.query.paneId) : undefined;
  const ctx = agentRoom(sender, res, pid, paneId);
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
  const { sender, text, replyTo, choices, pid, paneId } = req.body as {
    sender?: string; text?: string; replyTo?: number; choices?: string[]; pid?: number; paneId?: number;
  };
  if (!sender || !text) { res.status(400).json({ error: "sender and text required" }); return; }
  const ctx = agentRoom(sender, res, pid, paneId);
  if (!ctx) return;
  ctx.room.touch(sender);
  ctx.room.setTyping(sender, false);
  manager.autoName(ctx.convId, text);
  const msg = ctx.room.send(sender, text, { replyTo, choices });
  res.json({ id: msg.id, sender: msg.sender, text: msg.text, choices: msg.choices });
});

app.post("/api/agent/leave", express.json(), (req, res) => {
  const { name, pid, paneId } = req.body as { name?: string; pid?: number; paneId?: number };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const convId = manager.getAgentBinding(name, pid, paneId);
  const room = convId ? manager.getRoom(convId) : undefined;
  if (room) room.leave(name);
  if (convId) {
    manager.unbindAgent(name, convId);
  } else {
    manager.unbindAgent(name);
  }
  res.json({ ok: true });
});

app.post("/api/agent/typing", express.json(), (req, res) => {
  const { name, typing, pid, paneId } = req.body as { name?: string; typing?: boolean; pid?: number; paneId?: number };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const ctx = agentRoom(name, res, pid, paneId);
  if (!ctx) return;
  ctx.room.setTyping(name, typing ?? true);
  res.json({ ok: true });
});

app.post("/api/agent/heartbeat", express.json(), (req, res) => {
  const { name, pid, paneId } = req.body as { name?: string; pid?: number; paneId?: number };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const ctx = agentRoom(name, res, pid, paneId);
  if (!ctx) return;
  ctx.room.touch(name);
  res.json({ ok: true });
});

app.post("/api/agent/status", express.json(), (req, res) => {
  const { name, status, pid, paneId } = req.body as { name?: string; status?: string; pid?: number; paneId?: number };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const ctx = agentRoom(name, res, pid, paneId);
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
});

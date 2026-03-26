/**
 * Joind — Universal agent chat via MCP.
 *
 * Multiple isolated conversations, each with its own agents and messages.
 * ConversationManager holds all conversations.
 * Web UI views one conversation at a time.
 * Agents are bound to specific conversations via chat_join.
 */

import { createServer } from "http";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import express from "express";
import { randomUUID } from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { ensureDir } from "./persist.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConversationManager } from "./manager.js";
import { registerTools } from "./tools.js";
import { discoverTerminals } from "./terminals.js";
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
const PORT = Number(process.env.JOIND_PORT ?? 4200);
const DATA_DIR = join(__dirname, "..", "data");

// --- Conversation manager ---
const manager = new ConversationManager(DATA_DIR);

// --- HTTP + WebSocket server ---
const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// Load session templates
loadTemplates();

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
  ws.send(
    JSON.stringify({
      type: "init",
      data: {
        agents: activeRoom?.who() ?? [],
        messages: activeRoom ? activeRoom.read(undefined, 100) : [],
        conversations: manager.listConversations(),
        activeConversation: activeMeta,
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
  registerTools(server, manager);
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

// --- Image upload ---
app.post("/api/upload", express.raw({ type: "image/*", limit: "10mb" }), (req, res) => {
  const ext = (req.headers["content-type"] || "").split("/")[1] || "png";
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const imgDir = join(DATA_DIR, "images");
  ensureDir(imgDir);
  writeFileSync(join(imgDir, filename), req.body);
  res.json({ url: `/data/images/${filename}` });
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
  const { sender, text, image, replyTo } = req.body as {
    sender?: string; text?: string; image?: string; replyTo?: number;
  };
  if (!sender || !text) {
    res.status(400).json({ error: "sender and text required" });
    return;
  }
  // Auto-name conversation from first user message
  const activeId = manager.getActiveId();
  if (activeId && sender !== "system") manager.autoName(activeId, text);

  const msg = room.send(sender, text, { image, replyTo });
  res.json({ id: msg.id, sender: msg.sender, text: msg.text });
});

app.get("/api/messages", (_req, res) => {
  const room = manager.getActiveRoom();
  res.json(room?.read(undefined, 100) ?? []);
});

app.get("/api/who", (_req, res) => {
  const room = manager.getActiveRoom();
  res.json(room?.who() ?? []);
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

app.post("/api/join", express.json(), (req, res) => {
  const room = activeRoom(res);
  if (!room) return;
  const { name, pid } = req.body as { name?: string; pid?: number };
  if (!name || !pid) { res.status(400).json({ error: "name and pid required" }); return; }
  const agent = room.join(name, pid);
  const activeId = manager.getActiveId();
  if (activeId) manager.bindAgent(name, activeId);
  res.json({ name: agent.name, pid: agent.pid, online: room.whoNames() });
});

app.post("/api/leave", express.json(), (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  // Leave from whichever conversation they're in
  const convId = manager.getAgentBinding(name);
  const room = convId ? manager.getRoom(convId) : manager.getActiveRoom();
  if (room) room.leave(name);
  manager.unbindAgent(name);
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
  if (convId) { manager.unbindAgent(oldName); manager.bindAgent(newName, convId); }
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
  res.json({ name: agent.name, role: agent.role });
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
  res.json({ ok });
});

app.get("/api/conversations/search", (req, res) => {
  const q = (req.query.q as string) || "";
  res.json(manager.searchConversations(q));
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
  const session = startSession(templateId, cast, goal ?? "", startedBy ?? "human", room);
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
  try { res.json(await discoverTerminals()); } catch { res.json([]); }
});

// --- Static files ---
app.use(express.static(join(__dirname, "..", "public")));

// --- Start ---
httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║  Joind v0.2.0 — Agent Chat via MCP    ║`);
  console.log(`  ║  MCP:  http://127.0.0.1:${PORT}/mcp${" ".repeat(Math.max(0, 9 - String(PORT).length))}║`);
  console.log(`  ║  Web:  http://127.0.0.1:${PORT}/${" ".repeat(Math.max(0, 12 - String(PORT).length))}║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
});

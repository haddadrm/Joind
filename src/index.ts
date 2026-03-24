/**
 * Joind — Universal agent chat via MCP.
 *
 * Each connecting agent gets its own McpServer + transport instance,
 * all sharing the same ChatRoom for message passing.
 * WebSocket broadcasts real-time updates to the web UI.
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
import { ChatRoom } from "./room.js";
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
const CONTINUE = process.env.JOIND_CONTINUE === "1" || process.argv.includes("--continue");

// --- Chat room (session-aware persistence) ---
const room = new ChatRoom(DATA_DIR, CONTINUE);

// --- HTTP + WebSocket server ---
const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// Load session templates
loadTemplates();

// Hook session engine into message stream
room.on("room", (event) => {
  if (event.type === "message" && event.data.sender !== "system") {
    sessionOnMessage(event.data.sender, room);
  }
});

// Broadcast room events to all connected web clients
room.on("room", (event) => {
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
});

// Send current state on new WebSocket connection
wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "init",
      data: {
        agents: room.who(),
        messages: room.read(undefined, 100),
        session: room.sessionStore?.getActiveSession() ?? null,
        conversations: room.sessionStore?.listSessions() ?? [],
      },
    })
  );
});

// --- MCP sessions ---
const sessions = new Map<
  string,
  { transport: StreamableHTTPServerTransport; server: McpServer }
>();

function createSessionServer(): McpServer {
  const server = new McpServer({ name: "joind", version: "0.1.0" });
  registerTools(server, room);
  return server;
}

app.post("/mcp", express.json({ strict: false }), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let session = sessionId ? sessions.get(sessionId) : undefined;

  if (sessionId && !session) {
    // Stale session — tell the client to reconnect with a fresh handshake.
    // Return 404 which signals MCP clients to drop their session and re-init.
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session expired. Please reconnect." },
      id: null,
    });
    return;
  }

  if (!session) {
    const server = createSessionServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, server });
        console.log(`  MCP session ${id.slice(0, 8)}… connected`);
      },
    });
    transport.onclose = () => {
      const id = [...sessions.entries()].find(
        ([, s]) => s.transport === transport
      )?.[0];
      if (id) {
        sessions.delete(id);
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
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session expired. Please reconnect." });
    return;
  }
  await session.transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const session = sessions.get(sessionId);
  if (session) {
    await session.transport.close();
    sessions.delete(sessionId);
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

// --- Serve data directory (images, etc.) ---
app.use("/data", express.static(DATA_DIR));

// --- REST API ---
app.post("/api/send", express.json(), (req, res) => {
  const { sender, text, image, replyTo } = req.body as {
    sender?: string;
    text?: string;
    image?: string;
    replyTo?: number;
  };
  if (!sender || !text) {
    res.status(400).json({ error: "sender and text required" });
    return;
  }
  const msg = room.send(sender, text, { image, replyTo });
  res.json({ id: msg.id, sender: msg.sender, text: msg.text });
});

app.get("/api/messages", (_req, res) => {
  res.json(room.read(undefined, 100));
});

app.get("/api/who", (_req, res) => {
  res.json(room.who());
});

// --- Chat Export ---
app.get("/api/export", (_req, res) => {
  const messages = room.read(undefined, 10000);
  const agents = room.who();
  const now = new Date();

  let md = `# Joind Chat Export\n`;
  md += `**Date**: ${now.toISOString().split("T")[0]}\n`;
  md += `**Messages**: ${messages.length}\n`;
  if (agents.length > 0) {
    md += `**Participants**: ${agents.map((a) => a.name).join(", ")}\n`;
  }
  md += `\n---\n\n`;

  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    if (msg.sender === "system") {
      md += `*${time} — ${msg.text}*\n\n`;
      continue;
    }

    // Reply context
    if (msg.replyTo) {
      const orig = room.getMessageById(msg.replyTo);
      if (orig) {
        md += `> *replying to ${orig.sender}*: ${orig.text.slice(0, 80)}${orig.text.length > 80 ? "…" : ""}\n\n`;
      }
    }

    md += `**${msg.sender}** (${time}):\n${msg.text}\n`;

    if (msg.image) {
      md += `\n![image](${msg.image})\n`;
    }

    md += `\n`;
  }

  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="joind-export-${now.toISOString().split("T")[0]}.md"`
  );
  res.send(md);
});

app.post("/api/join", express.json(), (req, res) => {
  const { name, pid } = req.body as { name?: string; pid?: number };
  if (!name || !pid) {
    res.status(400).json({ error: "name and pid required" });
    return;
  }
  const agent = room.join(name, pid);
  res.json({ name: agent.name, pid: agent.pid, online: room.whoNames() });
});

app.post("/api/leave", express.json(), (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  room.leave(name);
  res.json({ ok: true, online: room.whoNames() });
});

app.post("/api/rename", express.json(), (req, res) => {
  const { oldName, newName } = req.body as { oldName?: string; newName?: string };
  if (!oldName || !newName) {
    res.status(400).json({ error: "oldName and newName required" });
    return;
  }
  const agent = room.rename(oldName, newName);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json({ name: agent.name, pid: agent.pid });
});

app.post("/api/heartbeat", express.json(), (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  room.touch(name);
  const agent = room.getAgent(name);
  res.json({ ok: true, lastSeen: agent?.lastSeen ?? Date.now() });
});

app.post("/api/role", express.json(), (req, res) => {
  const { name, role } = req.body as { name?: string; role?: string };
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const agent = room.setRole(name, role ?? "");
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json({ name: agent.name, role: agent.role });
});

// --- Conversation session management ---
app.get("/api/conversations", (_req, res) => {
  if (!room.sessionStore) {
    res.json({ sessions: [], active: null });
    return;
  }
  res.json({
    sessions: room.sessionStore.listSessions(),
    active: room.sessionStore.getActiveSession(),
  });
});

app.post("/api/conversations/new", express.json(), (req, res) => {
  const { name } = (req.body || {}) as { name?: string };
  room.newSession(name);
  res.json({ session: room.sessionStore?.getActiveSession() });
});

app.post("/api/conversations/switch", express.json(), (req, res) => {
  const { id } = req.body as { id?: string };
  if (!id) {
    res.status(400).json({ error: "id required" });
    return;
  }
  const ok = room.switchToSession(id);
  if (!ok) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({ session: room.sessionStore?.getActiveSession(), messages: room.read(undefined, 100) });
});

app.post("/api/conversations/rename", express.json(), (req, res) => {
  const { id, name } = req.body as { id?: string; name?: string };
  if (!id || !name) {
    res.status(400).json({ error: "id and name required" });
    return;
  }
  const ok = room.sessionStore?.renameSession(id, name);
  res.json({ ok: !!ok });
});

// --- Workflow session API ---
app.get("/api/templates", (_req, res) => {
  res.json(getTemplates());
});

app.get("/api/sessions", (_req, res) => {
  res.json(getActiveSessions());
});

app.post("/api/session/start", express.json(), (req, res) => {
  const { templateId, cast, goal, startedBy } = req.body as {
    templateId?: string;
    cast?: Record<string, string>;
    goal?: string;
    startedBy?: string;
  };
  if (!templateId || !cast) {
    res.status(400).json({ error: "templateId and cast required" });
    return;
  }
  const tmpl = getTemplate(templateId);
  if (!tmpl) {
    res.status(404).json({ error: "Template not found", available: getTemplates().map(t => t.id) });
    return;
  }
  // Validate all roles are assigned
  const missing = tmpl.roles.filter((r) => !cast[r]);
  if (missing.length > 0) {
    res.status(400).json({ error: "Missing role assignments", missing, roles: tmpl.roles });
    return;
  }
  const session = startSession(templateId, cast, goal ?? "", startedBy ?? "human", room);
  if (!session) {
    res.status(500).json({ error: "Failed to start session" });
    return;
  }
  res.json(session);
});

app.post("/api/session/cancel", express.json(), (req, res) => {
  const { id } = req.body as { id?: number };
  if (!id) {
    res.status(400).json({ error: "id required" });
    return;
  }
  const ok = cancelSession(id, room);
  res.json({ ok });
});

app.get("/api/terminals", async (_req, res) => {
  try {
    const terminals = await discoverTerminals();
    res.json(terminals);
  } catch {
    res.json([]);
  }
});

// --- Static files (web UI) ---
app.use(express.static(join(__dirname, "..", "public")));

// --- Start ---
httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║  Joind v0.1.0 — Agent Chat via MCP    ║`);
  console.log(`  ║  MCP:  http://127.0.0.1:${PORT}/mcp${" ".repeat(Math.max(0, 9 - String(PORT).length))}║`);
  console.log(`  ║  Web:  http://127.0.0.1:${PORT}/${" ".repeat(Math.max(0, 12 - String(PORT).length))}║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
});

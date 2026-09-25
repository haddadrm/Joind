import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn, type ChildProcess } from "child_process";

// Codex gate round 4 on feat/wezterm-submit (0ad2844): registration ids.
// Finding 1 (an MCP session with no record, after a reconnect or after
// chat_leave, fell back to the name) drives the real MCP tool callbacks.
// Finding 2 (terminal-less registrations could not be matched) runs through
// the real server for REST and through the callbacks for MCP.
//
// Safety: fake pids are odd (no Windows process has one); the terminal-less
// REST joins name a well-formed but nonexistent Orca handle, which skips the
// server's terminal auto-detection, and the server runs with ORCA_CLI
// pointing at a file that does not exist, so no Orca is ever asked. Nothing
// mentions anyone, so nothing is injected.

vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => async () => new Map(), weztermGuiOf: async () => false as const };
});

import * as tools from "../src/tools.js";
import { ConversationManager } from "../src/manager.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const P1 = 999_991;
const P2 = 999_993;

type ToolResult = { content: Array<{ text: string }> };
type ToolHandler = (args: Record<string, unknown>, extra: { sessionId?: string }) => Promise<ToolResult>;

function mcp() {
  const dir = mkdtempSync(join(tmpdir(), "joind-g4m-"));
  const manager = new ConversationManager(dir);
  const handlers = new Map<string, ToolHandler>();
  const fake = { registerTool: (n: string, _d: unknown, h: ToolHandler) => { handlers.set(n, h); }, registerPrompt: () => {}, registerResource: () => {} };
  tools.registerTools(fake as unknown as McpServer, manager);
  const call = async (tool: string, args: Record<string, unknown>, sessionId: string) => (await handlers.get(tool)!(args, { sessionId })).content[0].text;
  const done = () => {
    for (const c of manager.listConversations()) manager.getRoom(c.id)?.destroy();
    rmSync(dir, { recursive: true, force: true });
  };
  return { manager, call, done };
}

const regOf = (joinText: string) => /Registration: (reg-[A-Za-z0-9-]+)/.exec(joinText)?.[1];

describe("finding 1: an MCP session with no record gets 'join first', never another registration by name", () => {
  it("after A departs, a reinitialized transport (new session id) cannot read or write B's room", async () => {
    const t = mcp();
    try {
      const a = t.manager.createConversation("a");
      const b = t.manager.createConversation("b");
      await t.call("chat_join", { name: "Codex", pid: P1, conversation: a.id }, "sA");
      const bJoin = await t.call("chat_join", { name: "Codex", pid: P2, conversation: b.id }, "sB");
      t.manager.getRoom(b.id)!.send("Rami", "only-in-room-B");
      // A's registration departs (the REST leave naming P1).
      t.manager.getRoom(a.id)!.leave("Codex");
      t.manager.unbindAgent("Codex", a.id);

      const read = await t.call("chat_read", { sender: "Codex" }, "sA-reinit");
      expect(read).not.toContain("only-in-room-B");
      expect(read).toMatch(/chat_join/);
      const before = t.manager.getRoom(b.id)!.messageCount();
      expect(await t.call("chat_send", { sender: "Codex", text: "from-A-reinit" }, "sA-reinit")).toMatch(/chat_join/);
      expect(t.manager.getRoom(b.id)!.messageCount()).toBe(before);
      expect(await t.call("chat_listen", { sender: "Codex", timeoutSec: 1 }, "sA-reinit")).toMatch(/chat_join/);

      // B's own reinitialized transport proves itself with B's registration id.
      const idB = regOf(bJoin);
      expect(idB).toBeDefined();
      expect(await t.call("chat_read", { sender: "Codex", registration: idB }, "sB-reinit")).toContain("only-in-room-B");
      // And from then on that session follows B's record without the id.
      expect(await t.call("chat_read", { sender: "Codex" }, "sB-reinit")).toContain("only-in-room-B");
    } finally { t.done(); }
  }, 20_000);

  it("chat_leave then chat_read on the same session: 'join first'; a second leave removes nothing", async () => {
    const t = mcp();
    try {
      const a = t.manager.createConversation("a");
      const b = t.manager.createConversation("b");
      await t.call("chat_join", { name: "Codex", pid: P1, conversation: a.id }, "sA");
      await t.call("chat_join", { name: "Codex", pid: P2, conversation: b.id }, "sB");
      t.manager.getRoom(b.id)!.send("Rami", "only-in-room-B");
      expect(await t.call("chat_leave", { name: "Codex" }, "sA")).toMatch(/disconnected/);
      expect(await t.call("chat_read", { sender: "Codex" }, "sA")).toMatch(/chat_join/);
      await t.call("chat_leave", { name: "Codex" }, "sA");
      expect(t.manager.bindingsOf("Codex").map((e) => [e.conversationId, e.pid])).toEqual([[b.id, P2]]);
      expect(t.manager.getRoom(b.id)!.getAgent("Codex")).toBeDefined();
    } finally { t.done(); }
  }, 20_000);
});

describe("finding 2 (MCP): a terminal-less registration is identified by its registration id", () => {
  it("join with pid 0, then read, send and leave through the same session; the leave removes it", async () => {
    const t = mcp();
    try {
      const a = t.manager.createConversation("a");
      const joined = await t.call("chat_join", { name: "Repl", pid: 0, conversation: a.id }, "sR");
      t.manager.getRoom(a.id)!.send("Rami", "hello-repl");
      expect(await t.call("chat_read", { sender: "Repl" }, "sR")).toContain("hello-repl");
      expect(regOf(joined)).toBeDefined();
      const before = t.manager.getRoom(a.id)!.messageCount();
      await t.call("chat_send", { sender: "Repl", text: "from-repl" }, "sR");
      expect(t.manager.getRoom(a.id)!.messageCount()).toBe(before + 1);
      // The narrow, by-design fallback: one terminal-less registration of the
      // name anywhere serves a session that has no record.
      expect(await t.call("chat_read", { sender: "Repl" }, "sR-reinit")).toContain("hello-repl");
      expect(await t.call("chat_leave", { name: "Repl" }, "sR")).toMatch(/disconnected/);
      expect(t.manager.bindingsOf("Repl")).toEqual([]);
      expect(t.manager.getRoom(a.id)!.getAgent("Repl")).toBeUndefined();
    } finally { t.done(); }
  }, 20_000);

  it("two terminal-less registrations of one name: no session record means no route; the id picks one", async () => {
    const t = mcp();
    try {
      const a = t.manager.createConversation("a");
      const b = t.manager.createConversation("b");
      await t.call("chat_join", { name: "Repl", pid: 0, conversation: a.id }, "s1");
      const jb = await t.call("chat_join", { name: "Repl", pid: 0, conversation: b.id }, "s2");
      t.manager.getRoom(b.id)!.send("Rami", "only-in-room-B");
      expect(await t.call("chat_read", { sender: "Repl" }, "s-new")).toMatch(/chat_join/);
      expect(await t.call("chat_read", { sender: "Repl", registration: regOf(jb) }, "s-new2")).toContain("only-in-room-B");
      // Each session still follows its own registration.
      expect(await t.call("chat_read", { sender: "Repl" }, "s1")).not.toContain("only-in-room-B");
    } finally { t.done(); }
  }, 20_000);
});

// ---- the real server, for finding 2 over REST

const DIST = join(__dirname, "..", "dist", "index.js");
const TOKEN = "gate4-test-token";
const FAKE_ORCA = "term_gate4_nonexistent";
let server: ChildProcess | undefined;
let base = "";
let dataDir = "";

async function call(path: string, body?: object): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { text }; }
  return { status: res.status, json };
}
const newConversation = async (name: string) => ((await call("/api/conversations/new", { name })).json.conversation as { id: string }).id;
const select = async (id: string) => { expect((await call("/api/conversations/select", { id, token: TOKEN })).status).toBe(200); };
/** A terminal-less REST join: no pid, no pane, and a handle that is dropped. */
async function joinTerminalLess(name: string, conversation: string): Promise<string | undefined> {
  const r = await call("/api/agent/join", { name, conversation, orcaTerminal: FAKE_ORCA });
  expect(r.status).toBe(200);
  return typeof r.json.registration === "string" ? r.json.registration : undefined;
}
const read = async (name: string, registration?: string) =>
  call(`/api/agent/read?sender=${encodeURIComponent(name)}&limit=5${registration ? `&registration=${encodeURIComponent(registration)}` : ""}`);

describe.skipIf(!existsSync(DIST))("finding 2 (REST, the real server): terminal-less registrations", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "joind-g4-"));
    const port = 44000 + Math.floor(Math.random() * 900);
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [DIST, "--host", "127.0.0.1", "--port", String(port), "--data-dir", join(dataDir, "data"), "--web-token", TOKEN], {
      stdio: "ignore", windowsHide: true, env: { ...process.env, ORCA_CLI: join(dataDir, "no-orca-here.exe") },
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/api/instance")).ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("test server did not start");
  }, 20_000);

  afterAll(async () => {
    server?.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("join, read, send, UI rename and leave all work, by the single-registration name rule", async () => {
    const a = await newConversation(`a-${Date.now()}`);
    const id = await joinTerminalLess("Repl", a);
    expect((await read("Repl")).status).toBe(200);
    expect((await call("/api/agent/send", { sender: "Repl", text: "hi" })).status).toBe(200);
    await select(a);
    expect((await call("/api/rename", { oldName: "Repl", newName: "Repl-2", conversation: a })).status).toBe(200);
    expect((await read("Repl-2")).status).toBe(200);
    expect(id).toMatch(/^reg-/);
    expect((await read("Repl-2", id)).status).toBe(200); // the rename keeps the registration
    expect((await read("Repl")).status).toBe(403);
    expect((await call("/api/agent/leave", { name: "Repl-2" })).status).toBe(200);
    expect((await read("Repl-2")).status).toBe(403);
  }, 20_000);

  it("two terminal-less registrations of one name: 403 and 409 with the candidates, and the id picks one", async () => {
    const a = await newConversation(`a-${Date.now()}`);
    const b = await newConversation(`b-${Date.now()}`);
    const idA = await joinTerminalLess("Twin", a);
    const idB = await joinTerminalLess("Twin", b);
    const amb = await read("Twin");
    expect(amb.status).toBe(403);
    expect((amb.json.candidates as Array<{ conversation: string; terminalLess?: boolean }>).map((c) => `${c.conversation}|${c.terminalLess}`).sort())
      .toEqual([`${a}|true`, `${b}|true`].sort());
    expect((await call("/api/agent/send", { sender: "Twin", text: "which room?" })).status).toBe(403);
    expect((await read("Twin", idA)).status).toBe(200);
    expect((await call("/api/agent/send", { sender: "Twin", text: "room A", registration: idA })).status).toBe(200);
    expect((await call("/api/agent/leave", { name: "Twin" })).status).toBe(409);
    expect((await call("/api/agent/leave", { name: "Twin", registration: idA })).status).toBe(200);
    expect((await read("Twin", idA)).status).toBe(403);
    // One left: the name alone names it again.
    expect((await read("Twin")).status).toBe(200);
    expect((await call("/api/agent/leave", { name: "Twin", registration: idB })).status).toBe(200);
  }, 20_000);
});

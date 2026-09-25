import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn, type ChildProcess } from "child_process";

// Codex gate round 5 on feat/wezterm-submit (8d353f6): a cross-room rejoin
// left the replaced registration id valid. The Twin sequence: Twin joins A
// from P1, B from P2 (and C from P3, unrelated), then P1 rejoins B. B's P2
// registration is superseded: its id must resolve nothing, and a leave with
// it must remove nothing. Run through the real server (REST) and the real
// MCP callbacks. Fake pids are odd (no Windows process has one); nothing
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
const P3 = 999_995;

// ---- REST, the real server

const DIST = join(__dirname, "..", "dist", "index.js");
const TOKEN = "gate5-test-token";
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
async function joinAs(pid: number, conversation: string): Promise<string> {
  const r = await call("/api/agent/join", { name: "Twin", pid, conversation });
  expect(r.status).toBe(200);
  return String(r.json.registration);
}
const readWith = async (registration: string) => (await call(`/api/agent/read?sender=Twin&limit=5&registration=${encodeURIComponent(registration)}`)).status;
async function membersOf(id: string): Promise<string[]> {
  expect((await call("/api/conversations/select", { id, token: TOKEN })).status).toBe(200);
  return ((await (await fetch(base + "/api/who")).json()) as Array<{ name: string }>).map((a) => a.name);
}

describe.skipIf(!existsSync(DIST))("the Twin sequence over REST (the real server)", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "joind-g5-"));
    const port = 45000 + Math.floor(Math.random() * 900);
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

  it("the superseded id reads nothing (403) and leaves nothing (404); the replacement and room C are intact", async () => {
    const a = await newConversation(`a-${Date.now()}`);
    const b = await newConversation(`b-${Date.now()}`);
    const c = await newConversation(`c-${Date.now()}`);
    await joinAs(P1, a);
    const idB = await joinAs(P2, b);
    const idC = await joinAs(P3, c);
    const idB2 = await joinAs(P1, b); // P1 rejoins B: B's P2 registration is superseded

    expect(await readWith(idB)).toBe(403);
    expect((await call("/api/agent/send", { sender: "Twin", text: "stale", registration: idB })).status).toBe(403);
    expect((await call("/api/agent/leave", { name: "Twin", registration: idB })).status).toBe(404);

    // The replacement member and its registration are intact.
    expect(await readWith(idB2)).toBe(200);
    expect(await membersOf(b)).toContain("Twin");
    // The unrelated room C is untouched.
    expect(await readWith(idC)).toBe(200);
    expect(await membersOf(c)).toContain("Twin");

    // The current id leaves exactly B's registration.
    expect((await call("/api/agent/leave", { name: "Twin", registration: idB2 })).status).toBe(200);
    expect(await membersOf(b)).not.toContain("Twin");
    expect(await readWith(idC)).toBe(200);
    await call("/api/agent/leave", { name: "Twin", registration: idC });
  }, 30_000);
});

// ---- MCP, the real callbacks

type ToolHandler = (args: Record<string, unknown>, extra: { sessionId?: string }) => Promise<{ content: Array<{ text: string }> }>;
const regOf = (joinText: string) => /Registration: (reg-[A-Za-z0-9-]+)/.exec(joinText)?.[1];

describe("the Twin sequence through MCP", () => {
  it("the superseded id routes nowhere and its leave removes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g5m-"));
    const manager = new ConversationManager(dir);
    const handlers = new Map<string, ToolHandler>();
    const fake = { registerTool: (n: string, _d: unknown, h: ToolHandler) => { handlers.set(n, h); }, registerPrompt: () => {}, registerResource: () => {} };
    const call = async (tool: string, args: Record<string, unknown>, sessionId: string) => (await handlers.get(tool)!(args, { sessionId })).content[0].text;
    try {
      tools.registerTools(fake as unknown as McpServer, manager);
      const a = manager.createConversation("a");
      const b = manager.createConversation("b");
      const c = manager.createConversation("c");
      await call("chat_join", { name: "Twin", pid: P1, conversation: a.id }, "s1");
      const idB = regOf(await call("chat_join", { name: "Twin", pid: P2, conversation: b.id }, "s2"));
      await call("chat_join", { name: "Twin", pid: P3, conversation: c.id }, "s3");
      const idB2 = regOf(await call("chat_join", { name: "Twin", pid: P1, conversation: b.id }, "s1"));
      manager.getRoom(b.id)!.send("Rami", "only-in-room-B");

      expect(await call("chat_read", { sender: "Twin", registration: idB }, "s-stale")).toMatch(/chat_join/);
      expect(await call("chat_leave", { name: "Twin", registration: idB }, "s-stale")).not.toMatch(/disconnected/);
      expect(manager.getRoom(b.id)!.getAgent("Twin")).toBeDefined();
      expect(manager.bindingsOf("Twin").map((e) => e.conversationId).sort()).toEqual([b.id, c.id].sort());
      expect(await call("chat_read", { sender: "Twin", registration: idB2 }, "s-new")).toContain("only-in-room-B");
      expect(manager.getRoom(c.id)!.getAgent("Twin")).toBeDefined();
    } finally {
      for (const conv of manager.listConversations()) manager.getRoom(conv.id)?.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

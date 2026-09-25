import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn, type ChildProcess } from "child_process";

// Codex gate round 3 on feat/wezterm-submit (92a5fb1). One group per finding,
// each failing on 92a5fb1 and passing now. Findings 3 and 5 run against the
// real server (dist/index.js, a temp data dir, loopback, a random port);
// finding 4 drives the real MCP tool callbacks.
//
// Fake pids are odd: Windows pids are multiples of 4, so no real process can
// ever be named (and nothing is injected: no message mentions anyone).

vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return {
    ...actual,
    // No process enumeration in the MCP test: nothing runs inside WezTerm or Orca.
    processTreeOnce: () => async () => new Map(),
    weztermGuiOf: async () => false as const,
  };
});

import * as tools from "../src/tools.js";
import { ConversationManager } from "../src/manager.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const P1 = 999_991;
const P2 = 999_993;

describe("finding 1: the REST auto-join carries the GUI its discovery row was found in", () => {
  it("the discovered GUI reaches the freshness token, pane resolution and so the binding", () => {
    const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf-8");
    const route = src.slice(src.indexOf('app.post("/api/agent/join"'), src.indexOf("// Name the WezTerm tab if available", src.indexOf('app.post("/api/agent/join"')));
    expect(route).toMatch(/discoveredGui = available\[0\]\.weztermPaneId != null \? available\[0\]\.weztermGui : undefined/);
    expect(route).toMatch(/manager\.beginJoin\(name, convId, pid, weztermPaneId, requestedOrcaHandle\(requestedOrca\), discoveredGui\)/);
    expect(route).toMatch(/resolvePaneForJoin\(name, pid \|\| 0, weztermPaneId, defaultPaneResolverDeps\(manager, tree\), discoveredGui\)/);
    // The binding gets the resolved pair (resolution returns the GUI it used).
    expect(route).toMatch(/manager\.bindAgent\(name, convId, pid, boundPane, boundOrca, paneResolution\.gui, registration\)/);
  });

  it("a discovery row (pid 0, GUI 200, pane 0) resolves to the pair through the discovered GUI", async () => {
    const r = await tools.resolvePaneForJoin("Claude", 0, 0, {
      guiOf: async () => "unknown",
      socketForGui: (g) => `/s/gui-sock-${g}`,
      listPaneIds: async () => new Set([0]),
      autoDetect: async () => undefined,
      log: () => {},
    }, 200);
    expect(r).toEqual({ paneId: 0, gui: 200 });
  });
});

describe("finding 2: the REST auto-join counts claims by the complete (GUI, pane) pair", () => {
  const avail = (): typeof tools.availableForAutoJoin => {
    const f = (tools as Record<string, unknown>).availableForAutoJoin;
    expect(typeof f).toBe("function");
    return f as typeof tools.availableForAutoJoin;
  };
  const rows = [
    { type: "claude", pid: 0, weztermPaneId: 0, weztermGui: 200 },
    { type: "claude", pid: 0, weztermPaneId: 1, weztermGui: 200 },
  ];

  it("GUI 100's claimed pane 0 leaves GUI 200's panes 0 and 1 both available (two candidates, not one)", () => {
    const rooms = [{ who: () => [{ pid: 111, weztermPaneId: 0, weztermGui: 100 }] }];
    expect(avail()(rows, rooms)).toEqual(rows);
  });

  it("a claim of GUI 200's pane 0 takes exactly that row; a pane with no GUI is no candidate", () => {
    const rooms = [{ who: () => [{ pid: 111, weztermPaneId: 0, weztermGui: 200 }] }, undefined];
    expect(avail()([...rows, { type: "claude", pid: 0, weztermPaneId: 4 }], rooms)).toEqual([rows[1]]);
  });
});

// ---- the real server, for findings 3 and 5

const DIST = join(__dirname, "..", "dist", "index.js");
const TOKEN = "gate3-test-token";
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

async function newConversation(name: string): Promise<string> {
  const r = await call("/api/conversations/new", { name });
  return (r.json.conversation as { id: string }).id;
}

async function select(id: string): Promise<void> {
  expect((await call("/api/conversations/select", { id, token: TOKEN })).status).toBe(200);
}

/** "Codex" registered twice: in room A from P1, in room B from P2. */
async function twoRegistrations(): Promise<{ a: string; b: string }> {
  const a = await newConversation(`a-${Date.now()}`);
  const b = await newConversation(`b-${Date.now()}`);
  expect((await call("/api/agent/join", { name: "Codex", pid: P1, conversation: a })).status).toBe(200);
  expect((await call("/api/agent/join", { name: "Codex", pid: P2, conversation: b })).status).toBe(200);
  return { a, b };
}

async function readAs(name: string, pid: number): Promise<number> {
  return (await call(`/api/agent/read?sender=${encodeURIComponent(name)}&pid=${pid}&limit=1`)).status;
}

async function members(convId: string): Promise<string[]> {
  await select(convId);
  const res = await fetch(base + "/api/who");
  const list = (await res.json()) as Array<{ name: string }>;
  return list.map((x) => x.name);
}

describe.skipIf(!existsSync(DIST))("the real server: findings 3 and 5", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "joind-g3-"));
    const port = 43000 + Math.floor(Math.random() * 900);
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [DIST, "--host", "127.0.0.1", "--port", String(port), "--data-dir", join(dataDir, "data"), "--web-token", TOKEN], { stdio: "ignore", windowsHide: true });
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

  describe("finding 3: an ambiguous departure removes nothing; the UI leave is the selected conversation's only", () => {
    it("/api/agent/leave naming only paneId 0: 409 with both candidates, and both registrations still work", async () => {
      const { a, b } = await twoRegistrations();
      const r = await call("/api/agent/leave", { name: "Codex", paneId: 0 });
      expect(r.status).toBe(409);
      const convs = (r.json.candidates as Array<{ conversation: string; pid?: number }>).map((c) => `${c.conversation}|${c.pid}`).sort();
      expect(convs).toEqual([`${a}|${P1}`, `${b}|${P2}`].sort());
      expect(await readAs("Codex", P1)).toBe(200);
      expect(await readAs("Codex", P2)).toBe(200);
      // Naming the terminal leaves exactly that registration.
      expect((await call("/api/agent/leave", { name: "Codex", pid: P1 })).status).toBe(200);
      expect(await readAs("Codex", P2)).toBe(200);
      expect((await call("/api/agent/leave", { name: "Codex", pid: P2 })).status).toBe(200);
    }, 20_000);

    it("the UI leave in room A removes A's member and A's binding, never B's", async () => {
      const { a } = await twoRegistrations();
      await select(a);
      expect((await call("/api/leave", { name: "Codex", conversation: a })).status).toBe(200);
      expect(await readAs("Codex", P2)).toBe(200);
      expect((await call("/api/agent/leave", { name: "Codex", pid: P2 })).status).toBe(200);
    }, 20_000);
  });

  describe("finding 5: the UI rename re-binds the selected conversation's registration", () => {
    it("renaming Codex in room A binds the new name to A, and B's registration is untouched", async () => {
      const { a } = await twoRegistrations();
      await select(a);
      const r = await call("/api/rename", { oldName: "Codex", newName: "Codex-A", conversation: a });
      expect(r.status).toBe(200);
      expect(await readAs("Codex-A", P1)).toBe(200);
      expect(await readAs("Codex", P2)).toBe(200);
      expect(await members(a)).toContain("Codex-A");
      await call("/api/agent/leave", { name: "Codex-A", pid: P1 });
      await call("/api/agent/leave", { name: "Codex", pid: P2 });
    }, 20_000);
  });
});

// ---- finding 4: the real MCP tool callbacks

type ToolHandler = (args: Record<string, unknown>, extra: { sessionId?: string }) => Promise<{ content: Array<{ text: string }> }>;

describe("finding 4: an MCP session routes by its own registration; after its departure it must rejoin", () => {
  it("session A is not re-pointed at room B when A's registration departs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g3m-"));
    const manager = new ConversationManager(dir);
    const handlers = new Map<string, ToolHandler>();
    const fake = { registerTool: (name: string, _def: unknown, h: ToolHandler) => { handlers.set(name, h); }, registerPrompt: () => {}, registerResource: () => {} };
    try {
      tools.registerTools(fake as unknown as McpServer, manager);
      const a = manager.createConversation("a");
      const b = manager.createConversation("b");
      const join = handlers.get("chat_join")!;
      const read = handlers.get("chat_read")!;
      const send = handlers.get("chat_send")!;
      await join({ name: "Codex", pid: P1, conversation: a.id }, { sessionId: "sA" });
      await join({ name: "Codex", pid: P2, conversation: b.id }, { sessionId: "sB" });
      manager.getRoom(b.id)!.send("Rami", "only-in-room-B");
      expect((await read({ sender: "Codex" }, { sessionId: "sA" })).content[0].text).not.toContain("only-in-room-B");

      // A legitimate departure of A's registration (the REST leave naming P1).
      manager.getRoom(a.id)!.leave("Codex");
      manager.unbindAgent("Codex", a.id);

      const after = (await read({ sender: "Codex" }, { sessionId: "sA" })).content[0].text;
      expect(after).not.toContain("only-in-room-B");
      expect(after).toMatch(/chat_join/);
      const before = manager.getRoom(b.id)!.messageCount();
      await send({ sender: "Codex", text: "from-session-A" }, { sessionId: "sA" });
      expect(manager.getRoom(b.id)!.messageCount()).toBe(before);
      // Session B still routes to B.
      expect((await read({ sender: "Codex" }, { sessionId: "sB" })).content[0].text).toContain("only-in-room-B");
    } finally {
      for (const c of manager.listConversations()) manager.getRoom(c.id)?.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("the terminal match is exact: pid or the (GUI, pane) pair, never the only binding left", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g3m-"));
    const manager = new ConversationManager(dir);
    try {
      const b = manager.createConversation("b");
      manager.bindAgent("Codex", b.id, P2, 0, undefined, 200);
      expect(manager.bindingForTerminal("Codex", { pid: P1, paneId: 0, weztermGui: 100 })).toBeUndefined();
      expect(manager.bindingForTerminal("Codex", { paneId: 0, weztermGui: 200 })).toBe(b.id);
      expect(manager.bindingForTerminal("Codex", { pid: P2 })).toBe(b.id);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

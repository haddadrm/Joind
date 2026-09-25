/**
 * Linked servers, Codex gate round 9: one test per finding, each failing on
 * 1e3ed7b. chat_leave through the MCP tool callbacks on a real registry;
 * member registration intents through the mirror's recovery path.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: vi.fn(async () => undefined) };
});
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});

import * as tools from "../src/tools.js";
import { LinkRegistry, type FetchLike } from "../src/link.js";
import { MirrorRoom, type MirrorTransport } from "../src/mirror.js";
import { ConversationManager } from "../src/manager.js";
import { LinkDownError, PeerRefusedError } from "../src/peer-types.js";
import type { ChatMessage } from "../src/room.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 3_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("gate round 9, finding 1: chat_leave keeps the session when the departure fails", () => {
  it("a failed departure says so, keeps everything, and a plain retry leaves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g9-a-"));
    const members = new Map<string, string>();
    let n = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      const body = JSON.parse(init.body ?? "{}") as Record<string, string>;
      const ok = (o: unknown) => ({ status: 200, text: async () => JSON.stringify(o) });
      if (url.includes("/api/peer/rooms")) return ok({ server: "home", rooms: [{ id: "c-1", name: "ops", createdAt: 1, messageCount: 0, starred: false }] });
      if (url.includes("/api/peer/register")) { const reg = `H${++n}`; members.set(body.name, reg); return ok({ ok: true, registration: reg, online: [] }); }
      if (url.includes("/api/peer/leave")) {
        if (members.get(body.name) !== body.registration) return { status: 404, text: async () => "{}" };
        members.delete(body.name);
        return ok({ ok: true });
      }
      if (url.includes("/api/peer/messages")) return ok({ server: "home", room: "c-1", name: "ops", messages: [], members: [], cursor: 0, complete: true });
      return ok({});
    };
    const manager = new ConversationManager(join(dir, "data"));
    const reg = new LinkRegistry([{ name: "home", url: "http://127.0.0.1:1", token: "tok-12345678" }], { selfName: "here", linksDir: join(dir, "links"), manager, fetchImpl, pollTimeoutMs: 50 });
    type ToolHandler = (args: Record<string, unknown>, extra: { sessionId?: string }) => Promise<{ content: Array<{ text: string }> }>;
    const handlers = new Map<string, ToolHandler>();
    const fake = { registerTool: (name: string, _d: unknown, h: ToolHandler) => { handlers.set(name, h); }, registerPrompt: () => {}, registerResource: () => {} };
    tools.registerTools(fake as unknown as McpServer, manager, undefined, undefined, undefined, undefined, undefined, reg);
    const call = async (tool: string, args: Record<string, unknown>) => (await handlers.get(tool)!(args, { sessionId: "curzon-session" })).content[0].text;
    try {
      await reg.get("home")!.discover();
      expect(await call("chat_join", { name: "Curzon", pid: 999_991, conversation: "home:c-1" })).toContain("Joined conversation");
      const m = manager.getRoom("home:c-1") as MirrorRoom;
      const tmp = join(dir, "links", "home", "c-1.releases.json.tmp");
      mkdirSync(tmp, { recursive: true });                    // the release record cannot be written
      expect(await call("chat_leave", { name: "Curzon" })).toMatch(/^Curzon: not disconnected: /);
      expect(m.getAgent("Curzon")).toBeDefined();
      expect(manager.bindingsOf("Curzon")).toHaveLength(1);
      expect(members.has("Curzon")).toBe(true);
      rmSync(tmp, { recursive: true, force: true });
      expect(await call("chat_leave", { name: "Curzon" })).toBe("Curzon disconnected");   // a plain retry
      expect(m.getAgent("Curzon")).toBeUndefined();
      expect(manager.bindingsOf("Curzon")).toEqual([]);
      await waitFor("the home released", () => !members.has("Curzon"));
    } finally {
      reg.stop();
      for (const r of manager.listRemote()) r.room.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gate round 9, finding 2: member registrations are write-ahead", () => {
  it("a recovery reply that lands after the member left, with the record unwritable and the release failing, is released after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g9-b-"));
    // The home: members by name, idempotent for the same host registration.
    const members = new Map<string, { reg: string; hosted: string }>();
    const st = { down: false, n: 1, hold: null as Promise<void> | null, held: false };
    const transport: MirrorTransport = {
      isUp: () => !st.down,
      register: async (b) => {
        if (st.down) throw new LinkDownError("down");
        const existing = members.get(b.name);
        const reg = existing && existing.hosted === b.registration ? existing.reg : `H${++st.n}`;
        members.set(b.name, { reg, hosted: b.registration });
        if (st.hold) { st.held = true; await st.hold; }
        if (st.down) throw new LinkDownError("the reply was lost");
        return { ok: true, registration: reg, online: [] };
      },
      leave: async (b) => {
        if (st.down) throw new LinkDownError("down");
        if (members.get(b.name)?.reg !== b.registration) throw new PeerRefusedError(404, "No such registration");
        members.delete(b.name);
      },
      send: async (): Promise<ChatMessage> => { throw new Error("unused"); },
      act: async () => undefined,
      failed: () => undefined,
    };
    const file = join(dir, "c-1.queue.jsonl");
    const m1 = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: file, transport, selfName: "here" });
    let m2: MirrorRoom | null = null;
    try {
      m1.join("Curzon", 999_993, undefined, undefined, undefined, undefined, "reg-local");
      m1.setShadow("Curzon", { homeRegistration: "H1" });
      members.set("Curzon", { reg: "H1", hosted: "reg-local-old" });
      members.clear();                                         // the home restarts
      let release!: () => void;
      st.hold = new Promise<void>((r) => { release = r; });
      const recovering = m1.reregisterAll();                   // the home registers H2; the reply pauses
      await waitFor("H2 in flight", () => st.held);
      m1.leave("Curzon");                                      // departure: H1 recorded, member removed
      mkdirSync(join(dir, "c-1.releases.json.tmp"));           // the disk becomes unwritable
      st.down = true;                                          // and the release will fail
      st.hold = null;
      release();
      await recovering;
      expect(members.has("Curzon")).toBe(true);               // H2 is still held at the home
      m1.destroy();
      rmSync(join(dir, "c-1.releases.json.tmp"), { recursive: true, force: true });
      st.down = false;
      m2 = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: file, transport, selfName: "here" });  // restart
      await m2.reregisterAll();                                // production recovery
      expect(members.has("Curzon")).toBe(false);
      expect(m2.pendingMemberReleases()).toEqual([]);
    } finally { m1.destroy(); m2?.destroy(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("a member registration whose intent cannot be written is not sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g9-c-"));
    let registers = 0;
    const transport: MirrorTransport = {
      isUp: () => true,
      register: async () => { registers++; return { ok: true, registration: "H9", online: [] }; },
      leave: async () => undefined,
      send: async (): Promise<ChatMessage> => { throw new Error("unused"); },
      act: async () => undefined,
      failed: () => undefined,
    };
    const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: join(dir, "c-1.queue.jsonl"), transport, selfName: "here" });
    try {
      m.join("Curzon", 999_995, undefined, undefined, undefined, undefined, "reg-local");
      m.setShadow("Curzon", { homeRegistration: "H1" });
      mkdirSync(join(dir, "c-1.releases.json.tmp"));
      await m.reregisterAll();
      expect(registers).toBe(0);
      expect(m.homeRegistrationOf("Curzon")).toBe("H1");
    } finally { m.destroy(); rmSync(dir, { recursive: true, force: true }); }
  });
});

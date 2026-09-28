/**
 * Unauthenticated web writes: every state-changing browser route requires
 * the web token (X-Joind-Token header, a JSON `token`, or a `token` query
 * parameter) and answers 403 without it, before any state changes.
 * POST /api/messages/delete also deletes in the named conversation, not the
 * active one. Agent routes stay open (they identify by name, pid and
 * registration, as the open /mcp tools do).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "net";

vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";

const WEB = "e".repeat(64);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

interface Answer { status: number; json: unknown }

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

/** Every web write that requires the token, with a body that would otherwise act. */
const GUARDED: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [
  { method: "POST", path: "/api/messages/delete", body: { id: 1 } },
  { method: "POST", path: "/api/notifications/read", body: {} },
  { method: "POST", path: "/api/conversations/import", body: { version: 1, conversation: { name: "imp" }, messages: [] } },
  { method: "POST", path: "/api/join", body: { name: "Intruder", pid: 999_901 } },
  { method: "POST", path: "/api/leave", body: { name: "Kira" } },
  { method: "POST", path: "/api/rename", body: { oldName: "Kira", newName: "Mallory" } },
  { method: "POST", path: "/api/role", body: { name: "Kira", role: "owned" } },
  { method: "POST", path: "/api/roles", body: { emoji: "x", label: "intruder" } },
  { method: "DELETE", path: "/api/roles/reviewer" },
  { method: "POST", path: "/api/conversations/new", body: { name: "intruder-room" } },
  { method: "POST", path: "/api/conversations/rename", body: { id: "ROOM", name: "owned" } },
  { method: "POST", path: "/api/conversations/star", body: { id: "ROOM", starred: true } },
  { method: "POST", path: "/api/conversations/delete", body: { id: "ROOM" } },
  { method: "POST", path: "/api/turn-guard", body: { enabled: true, limit: 1 } },
  { method: "POST", path: "/api/session/start", body: { templateId: "debate", cast: {} } },
  { method: "POST", path: "/api/session/cancel", body: { id: 1 } },
  { method: "POST", path: "/api/crew", body: { name: "intruder", path: "C:/" } },
  { method: "POST", path: "/api/crew/scaffold", body: { name: "intruder" } },
  { method: "PATCH", path: "/api/crew/anyone", body: { role: "owned" } },
  { method: "DELETE", path: "/api/crew/anyone" },
  { method: "POST", path: "/api/launch", body: { crewName: "intruder", harness: "claude" } },
  { method: "POST", path: "/api/launch/abc/inject" },
];

describe("web writes require the web token", { timeout: 30_000 }, () => {
  let dir: string;
  let S: JoindHandle;
  let room: string, other: string;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "joind-webauth-"));
    const port = await freePort();
    const cfg: JoindConfig = {
      port, host: "127.0.0.1", dataDir: join(dir, "data"), instance: "webauth", crewHome: join(dir, "crew"),
      humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
      webToken: WEB, webTokenUserSet: true, links: [],
    };
    S = await startJoind(cfg);
    room = S.manager.createConversation("ops").id;
    other = S.manager.createConversation("other").id;
    const r = S.manager.getRoom(room)!;
    for (let n = 1; n <= 5; n++) r.send("Kira", `ops ${n}`);
    const o = S.manager.getRoom(other)!;
    for (let n = 1; n <= 5; n++) o.send("Kira", `other ${n}`);
    S.manager.setActive(room);
  }, 30_000);

  afterAll(async () => {
    await S?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const bodyFor = (b: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
    b === undefined ? undefined : JSON.parse(JSON.stringify(b).replace(/"ROOM"/g, JSON.stringify(room))) as Record<string, unknown>;

  it("answers 403 to every guarded route without a token, and with a wrong one", async () => {
    const convsBefore = S.manager.listConversations().map((c) => `${c.id}:${c.name}:${String(c.starred)}`).sort();
    for (const r of GUARDED) {
      const none = await call(S.baseUrl, r.method, r.path, bodyFor(r.body));
      expect(none.status, `${r.method} ${r.path} without a token`).toBe(403);
      const wrongBody = r.body === undefined ? undefined : { ...bodyFor(r.body), token: "f".repeat(64) };
      const wrong = await call(S.baseUrl, r.method, `${r.path}?token=${"0".repeat(64)}`, wrongBody, { "X-Joind-Token": "1".repeat(64) });
      expect(wrong.status, `${r.method} ${r.path} with a wrong token`).toBe(403);
    }
    // Nothing changed: messages, conversations, membership.
    expect(S.manager.getRoom(room)!.read(undefined, 100).map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    expect(S.manager.listConversations().map((c) => `${c.id}:${c.name}:${String(c.starred)}`).sort()).toEqual(convsBefore);
    expect(S.manager.getRoom(room)!.getAgent("Intruder")).toBeUndefined();
    expect(S.manager.listConversations().some((c) => c.name === "intruder-room" || c.name === "imp")).toBe(false);
  });

  it("accepts the token from the header, a JSON body or the query", async () => {
    expect((await call(S.baseUrl, "POST", "/api/notifications/read", {}, { "X-Joind-Token": WEB })).status).toBe(200);
    expect((await call(S.baseUrl, "POST", "/api/notifications/read", { token: WEB })).status).toBe(200);
    expect((await call(S.baseUrl, "POST", `/api/notifications/read?token=${WEB}`, {})).status).toBe(200);
    expect((await call(S.baseUrl, "POST", "/api/turn-guard", { enabled: false, limit: 20 }, { "X-Joind-Token": WEB })).status).toBe(200);
  });

  it("deletes in the named conversation, never the active one in its place", async () => {
    const h = { "X-Joind-Token": WEB };
    const r = await call(S.baseUrl, "POST", "/api/messages/delete", { id: 2, conversation: other }, h);
    expect(r).toEqual({ status: 200, json: { ok: true } });
    expect(S.manager.getRoom(other)!.read(undefined, 100).map((m) => m.id)).toEqual([1, 3, 4, 5]);
    expect(S.manager.getRoom(room)!.read(undefined, 100).map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    expect((await call(S.baseUrl, "POST", "/api/messages/delete", { id: 3, conversation: "no-such-room" }, h)).status).toBe(404);
    expect((await call(S.baseUrl, "POST", "/api/messages/delete", { id: 3, conversation: "" }, h)).status).toBe(404);
    expect((await call(S.baseUrl, "POST", "/api/messages/delete", { conversation: room }, h)).status).toBe(400);
    expect((await call(S.baseUrl, "POST", "/api/messages/delete", { id: "x", conversation: room }, h)).status).toBe(400);
    // Without a conversation: the active room, as before.
    expect((await call(S.baseUrl, "POST", "/api/messages/delete", { id: 5 }, h)).json).toEqual({ ok: true });
    expect(S.manager.getRoom(room)!.read(undefined, 100).map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(S.manager.getRoom(other)!.read(undefined, 100).map((m) => m.id)).toEqual([1, 3, 4, 5]);
  });

  it("leaves the agent routes open (agents hold no web token)", async () => {
    const j = await call(S.baseUrl, "POST", "/api/agent/join", { name: "Worf", pid: 999_902, conversation: room });
    expect(j.status).toBe(200);
    const send = await call(S.baseUrl, "POST", "/api/agent/send", { sender: "Worf", text: "agent line", pid: 999_902 });
    expect(send.status).toBe(200);
    // Documented agent REST fallbacks that mirror an open MCP tool.
    expect((await call(S.baseUrl, "POST", "/api/message/1/tag", { tag: "status" })).status).toBe(200);
    expect((await call(S.baseUrl, "POST", "/api/state", { conversation: room, key: "k", value: "v" })).status).toBe(200);
  });
});

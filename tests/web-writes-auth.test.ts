/**
 * Unauthenticated web writes: every state-changing browser route requires
 * the web token (X-Joind-Token header, a JSON `token`, or a `token` query
 * parameter) and answers 403 without it, before any state changes.
 * POST /api/messages/delete also deletes in the named conversation, not the
 * active one. Agent routes stay open (they identify by name, pid and
 * registration, as the open /mcp tools do).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Launches are recorded, never started: the launch service's launch,
// inject and status are replaced by spies on its singleton (beforeAll).
const fakeLaunch = {
  launched: [] as LaunchRequest[],
  injected: [] as string[],
  status: new Map<string, LaunchResult>(),
};
// One known harness, no detection on this machine.
vi.mock("../src/harnesses.js", async () => {
  const actual = await vi.importActual<typeof import("../src/harnesses.js")>("../src/harnesses.js");
  return { ...actual, getHarnesses: async () => [{ id: "test-harness", name: "Test", defaultDelay: 0 } as unknown as import("../src/harnesses.js").HarnessDefinition] };
});

// No wake may reach a terminal: keystroke injection is a no-op here.
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  const target = await vi.importActual<typeof import("../src/target.js")>("../src/target.js");
  return {
    ...actual,
    inject: (pid: number, text: string, pane?: number, exe?: string, env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) =>
      actual.inject(pid, text, pane, exe, env, {
        orca: async () => undefined,
        wezterm: async () => { throw new Error("no wezterm in this test"); },
        windows: async () => { throw new Error("no console in this test"); },
        unix: async () => undefined,
        platform: "linux",
        classify: async () => target.CODEX_PLAN,
      }, options),
  };
});

vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()), getWeztermPath: () => "wezterm-test", getWeztermEnv: () => ({}) };
});

import { MirrorRoom, type MirrorTransport } from "../src/mirror.js";
import LaunchService, { type LaunchRequest, type LaunchResult } from "../src/launcher.js";
import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";

const WEB = "e".repeat(64);

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
  // Guarded before this lane (their token checks are kept, and tested here too).
  { method: "POST", path: "/api/web/register", body: { name: "Mallory" } },
  { method: "POST", path: "/api/send", body: { sender: "Mallory", text: "owned", conversation: "ROOM" } },
  { method: "POST", path: "/api/dm/send", body: { to: "Kira", text: "owned" } },
  { method: "POST", path: "/api/message/1/edit", body: { sender: "Kira", newText: "owned" } },
  { method: "POST", path: "/api/message/1/choose", body: { value: "a", by: "Mallory" } },
  { method: "POST", path: "/api/conversations/select", body: { id: "ROOM" } },
  { method: "POST", path: "/api/pending/delete", body: { conversation: "ROOM", clientId: "c1" } },
];

describe("web writes require the web token", { timeout: 30_000 }, () => {
  let dir: string;
  let S: JoindHandle;
  let room: string, other: string;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "joind-webauth-"));
    const cfg: JoindConfig = {
      port: 0, host: "127.0.0.1", dataDir: join(dir, "data"), instance: "webauth", crewHome: join(dir, "crew"),
      humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
      webToken: WEB, webTokenUserSet: true, links: [],
    };
    vi.spyOn(LaunchService, "launch").mockImplementation(async (req: LaunchRequest) => {
      fakeLaunch.launched.push(req);
      const r: LaunchResult = { launchId: `launch-${fakeLaunch.launched.length}`, status: "spawned", command: "recorded, not run" };
      fakeLaunch.status.set(r.launchId, r);
      return r;
    });
    vi.spyOn(LaunchService, "inject").mockImplementation(async (launchId: string) => {
      fakeLaunch.injected.push(launchId);
      const r = fakeLaunch.status.get(launchId);
      if (r) r.status = "done";
    });
    vi.spyOn(LaunchService, "getLaunchStatus").mockImplementation((launchId: string) => fakeLaunch.status.get(launchId) ?? null);
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
    expect(S.manager.getRoom(room)!.getMessageById(1)!.text).toBe("ops 1");
    // Resolve is two-path: without a token it is the agent path (as MCP
    // chat_resolve); a wrong web token is refused.
    expect((await call(S.baseUrl, "POST", "/api/message/1/resolve", { token: "f".repeat(64), conversation: room })).status).toBe(403);
  });

  it("answers /api/send without a token the same for a real and an unknown room", async () => {
    const real = await call(S.baseUrl, "POST", "/api/send", { sender: "Rami", text: "x", conversation: room });
    const unknown = await call(S.baseUrl, "POST", "/api/send", { sender: "Rami", text: "x", conversation: "no-such-room" });
    expect(real.status).toBe(403);
    expect(unknown).toEqual(real);
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

  it("serves uploads sandboxed and never as an active page from this origin", async () => {
    const up = async (type: string, body: string): Promise<{ url: string; filename: string }> => {
      const r = await fetch(`${S.baseUrl}/api/upload`, { method: "POST", headers: { "Content-Type": type }, body });
      expect(r.status).toBe(200);
      return await r.json() as { url: string; filename: string };
    };
    const html = await up("text/html", "<script>parent.pwned = 1</script>");
    expect(html.filename.endsWith(".html")).toBe(true);
    const h = await fetch(`${S.baseUrl}${html.url}`);
    expect(h.status).toBe(200);
    expect(h.headers.get("content-disposition")).toBe("attachment");
    expect(h.headers.get("content-security-policy")).toContain("sandbox");
    expect(h.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(h.headers.get("x-content-type-options")).toBe("nosniff");
    const svg = await up("image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>");
    expect(svg.filename.endsWith(".svg")).toBe(true);
    const sv = await fetch(`${S.baseUrl}${svg.url}`);
    expect(sv.headers.get("content-disposition")).toBe("attachment");
    expect(sv.headers.get("content-security-policy")).toContain("sandbox");
    const png = await up("image/png", "not really a png");
    const p = await fetch(`${S.baseUrl}${png.url}`);
    expect(p.headers.get("content-disposition")).toBeNull();
    expect(p.headers.get("content-security-policy")).toContain("sandbox");
    expect(p.headers.get("x-content-type-options")).toBe("nosniff");
    const txt = await up("text/plain", "notes");
    expect((await fetch(`${S.baseUrl}${txt.url}`)).headers.get("content-disposition")).toBeNull();
  });

  it("keeps an upload inside the files directory whatever its content type says", async () => {
    // Backslashes are path separators on Windows; a subtype must never become a path.
    const BS = "\\";
    const back1 = `a/x${BS}..${BS}..${BS}evil1`;
    const back2 = `a/x${BS}..${BS}evil2`;
    const types = [back1, back2, "text/html;x=../../evil3", "weird", "a/b.c-d"];
    const accepted: string[] = [];
    for (const type of types) {
      const r = await fetch(`${S.baseUrl}/api/upload`, { method: "POST", headers: { "Content-Type": type }, body: "x" });
      // A content type the body parser refuses writes nothing at all.
      if (r.status !== 200) { expect(r.status, type).toBeGreaterThanOrEqual(400); continue; }
      const j = await r.json() as { url: string; filename: string };
      expect(j.filename, type).toMatch(/^\d+-[a-z0-9]+\.[a-z0-9]{1,10}$/);
      expect(existsSync(join(dir, "data", "files", j.filename)), type).toBe(true);
      accepted.push(type);
    }
    // The body parser refuses a subtype with separators (not a media-type
    // token), so the handler never sees one; what it does accept is kept to
    // letters and digits.
    expect(accepted).not.toContain(back1);
    expect(accepted).not.toContain(back2);
    expect(accepted).toContain("a/b.c-d");
    for (const where of [dir, join(dir, "data")]) {
      for (const n of ["evil1", "evil2", "evil3"]) expect(existsSync(join(where, n)), `${where} ${n}`).toBe(false);
    }
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
  // Last: with the token each guarded write is made for real and checked,
  // on conversations of its own. The launch service is an isolated fake (a
  // real launch starts an agent process), and the undelivered message lives
  // in a remote room's mirror whose link is down (a stub transport).
  it("lets each guarded write succeed with the token, and the write lands", async () => {
    const h = { "X-Joind-Token": WEB };
    // Routes guarded before this lane read the token from the body; the page sends both.
    const send = (method: string, path: string, body?: Record<string, unknown>): Promise<Answer> =>
      call(S.baseUrl, method, path, body === undefined ? undefined : { ...body, token: WEB }, h);
    const ok = async (method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const a = await send(method, path, body);
      expect(a.status, `${method} ${path}: ${JSON.stringify(a.json)}`).toBe(200);
      return (a.json ?? {}) as Record<string, unknown>;
    };
    const seen = new Set<string>();
    const done = (method: string, path: string): void => { seen.add(`${method} ${path}`); };

    // Nobody registered while the 403 checks ran, so this is the first name.
    await ok("POST", "/api/web/register", { name: "Rami" }); done("POST", "/api/web/register");
    const flow = ((await ok("POST", "/api/conversations/new", { name: "flow" })).conversation as { id: string }).id; done("POST", "/api/conversations/new");
    expect(S.manager.getRoom(flow)).toBeDefined();
    await ok("POST", "/api/conversations/select", { id: flow }); done("POST", "/api/conversations/select");
    expect(S.manager.getActiveId()).toBe(flow);
    const flowRoom = () => S.manager.getRoom(flow)!;

    const m1 = (await ok("POST", "/api/send", { sender: "Rami", text: "first", conversation: flow })).id as number; done("POST", "/api/send");
    await ok("POST", `/api/message/${m1}/edit`, { sender: "Rami", newText: "first, edited" }); done("POST", "/api/message/1/edit");
    expect(flowRoom().getMessageById(m1)!.text).toBe("first, edited");
    const m2 = (await ok("POST", "/api/send", { sender: "Rami", text: "pick", choices: ["a", "b"], conversation: flow })).id as number;
    await ok("POST", `/api/message/${m2}/choose`, { value: "a", by: "Rami" }); done("POST", "/api/message/1/choose");
    expect(flowRoom().getMessageById(m2)!.choiceResponse?.value).toBe("a");
    const m3 = (await ok("POST", "/api/send", { sender: "Rami", text: "decide?", askFor: "Rami", conversation: flow })).id as number;
    await ok("POST", `/api/message/${m3}/resolve`, { conversation: flow });
    expect(flowRoom().getMessageById(m3)!.ask?.state).toBe("resolved");

    expect((await call(S.baseUrl, "POST", "/api/agent/join", { name: "Worf", pid: 999_904, conversation: flow })).status).toBe(200);
    await ok("POST", "/api/dm/send", { to: "Worf", text: "psst" }); done("POST", "/api/dm/send");
    expect(flowRoom().read(undefined, 100, undefined, "Rami").some((m) => m.text === "psst" && m.to?.includes("Worf") === true)).toBe(true);

    await ok("POST", "/api/join", { name: "Invitee", pid: 999_905 }); done("POST", "/api/join");
    expect(flowRoom().getAgent("Invitee")).toBeDefined();
    await ok("POST", "/api/role", { name: "Invitee", role: "reviewer" }); done("POST", "/api/role");
    expect(flowRoom().getAgent("Invitee")!.role).toBe("reviewer");
    await ok("POST", "/api/rename", { oldName: "Invitee", newName: "Invitee2", conversation: flow }); done("POST", "/api/rename");
    expect(flowRoom().getAgent("Invitee2")).toBeDefined();
    await ok("POST", "/api/leave", { name: "Invitee2", conversation: flow }); done("POST", "/api/leave");
    expect(flowRoom().getAgent("Invitee2")).toBeUndefined();

    await ok("POST", "/api/roles", { emoji: "x", label: "lane-probe" }); done("POST", "/api/roles");
    await ok("DELETE", "/api/roles/lane-probe"); done("DELETE", "/api/roles/reviewer");
    const tg = await ok("POST", "/api/turn-guard", { enabled: true, limit: 5 }); done("POST", "/api/turn-guard");
    expect(tg).toMatchObject({ enabled: true, limit: 5 });
    await ok("POST", "/api/turn-guard", { enabled: false, limit: 20 });
    await ok("POST", "/api/notifications/read", {}); done("POST", "/api/notifications/read");

    const sess = await ok("POST", "/api/session/start", { templateId: "brainstorm", cast: { facilitator: "Rami", creative_a: "Rami", creative_b: "Rami" }, goal: "g" }); done("POST", "/api/session/start");
    expect(typeof sess.id).toBe("number");
    // The list answers while a session is active (its live timer is not serialized).
    const list = await call(S.baseUrl, "GET", `/api/sessions?token=${WEB}`);
    expect(list.status).toBe(200);
    expect((list.json as Array<{ id: number; timeoutHandle?: unknown }>).some((x) => x.id === sess.id && x.timeoutHandle === undefined)).toBe(true);
    expect(await ok("POST", "/api/session/cancel", { id: sess.id as number })).toEqual({ ok: true }); done("POST", "/api/session/cancel");

    expect(await ok("POST", "/api/messages/delete", { id: m1, conversation: flow })).toEqual({ ok: true }); done("POST", "/api/messages/delete");
    expect(flowRoom().getMessageById(m1)).toBeUndefined();

    const imp = ((await ok("POST", "/api/conversations/import", { version: 1, conversation: { name: "imported" }, messages: [] })).conversation as { id: string }).id; done("POST", "/api/conversations/import");
    expect(S.manager.getRoom(imp)).toBeDefined();
    await ok("POST", "/api/conversations/rename", { id: imp, name: "imported-2" }); done("POST", "/api/conversations/rename");
    await ok("POST", "/api/conversations/star", { id: imp, starred: true }); done("POST", "/api/conversations/star");
    const impMeta = S.manager.listConversations().find((c) => c.id === imp)!;
    expect(impMeta.name).toBe("imported-2");
    expect(impMeta.starred).toBe(true);
    await ok("POST", "/api/conversations/delete", { id: imp }); done("POST", "/api/conversations/delete");
    expect(S.manager.listConversations().some((c) => c.id === imp)).toBe(false);

    const crewDir = join(dir, "crew-folder");
    mkdirSync(crewDir, { recursive: true });
    await ok("POST", "/api/crew", { name: "crewa", path: crewDir }); done("POST", "/api/crew");
    await ok("PATCH", "/api/crew/crewa", { role: "builder" }); done("PATCH", "/api/crew/anyone");
    await ok("DELETE", "/api/crew/crewa"); done("DELETE", "/api/crew/anyone");
    const parent = join(dir, "scaffold-parent");
    mkdirSync(parent, { recursive: true });
    await ok("POST", "/api/crew/scaffold", { name: "scaf", parentDir: parent }); done("POST", "/api/crew/scaffold");
    expect(existsSync(join(parent, "scaf"))).toBe(true);

    // Launch and inject, through the isolated launch service.
    const launched = await ok("POST", "/api/launch", { crewName: "crewb", crewPath: crewDir, harness: "test-harness", joinAs: "Crewb", terminal: "manual", conversation: flow }); done("POST", "/api/launch");
    expect(launched).toEqual({ launchId: "launch-1", status: "spawned", command: "recorded, not run" });
    expect(fakeLaunch.launched).toEqual([expect.objectContaining({ crewName: "crewb", crewPath: crewDir, harness: "test-harness", joinAs: "Crewb", conversation: flow, terminal: "manual" })]);
    const injected = await ok("POST", "/api/launch/launch-1/inject"); done("POST", "/api/launch/abc/inject");
    expect(injected).toEqual({ launchId: "launch-1", status: "done", command: "recorded, not run" });
    expect(fakeLaunch.injected).toEqual(["launch-1"]);

    // An undelivered message of a remote room (its link is down), deleted by its author.
    const transport: MirrorTransport = {
      isUp: () => false,
      send: async () => { throw new Error("the link is down in this test"); },
      leave: async () => {}, act: async () => {},
      register: async () => { throw new Error("the link is down in this test"); },
      wakeVerdict: async () => ({ ok: true, accepted: false }),
      failed: () => {},
    };
    const mirror = new MirrorRoom({ server: "alpha", homeId: "c-remote", name: "remote", queueFile: null, transport, selfName: "webauth" });
    S.manager.registerRemoteRoom({ id: mirror.id, server: "alpha", homeId: "c-remote", room: mirror, meta: () => ({ ...mirror.meta(), remote: true } as unknown as ReturnType<typeof S.manager.listConversations>[number]) });
    const queued = await mirror.writeThrough("Rami", "waiting line", {}, { asHuman: true });
    expect(queued.status).toBe("queued");
    const clientId = (queued as { clientId: string }).clientId;
    expect(mirror.pendingFor("Rami").map((q) => q.clientId)).toEqual([clientId]);
    expect(await ok("POST", "/api/pending/delete", { conversation: mirror.id, clientId })).toEqual({ ok: true }); done("POST", "/api/pending/delete");
    expect(mirror.pendingFor("Rami")).toEqual([]);

    // Every route in the guarded table was exercised with the token.
    expect([...seen].sort()).toEqual(GUARDED.map((r) => `${r.method} ${r.path}`).sort());
  });
});

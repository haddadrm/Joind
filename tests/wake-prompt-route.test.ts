/**
 * Hygiene batch, item 4: the wake prompt follows the member's join route. A
 * member that joined through the MCP tools holds chat_read and chat_send,
 * so its prompt names them (with sender, room, role and the message to read
 * from); a REST joiner, or one whose route is unknown, keeps the full curl
 * recipe. The route is stamped at every join, and a hosted member carries
 * it home through the link, re-registration included.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "net";

const injected: Array<{ pid: number; prompt: string }> = [];
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return {
    ...actual,
    inject: vi.fn(async (pid: number, prompt: string) => { injected.push({ pid, prompt }); }),
  };
});
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});

import { ChatRoom, parseJoinRoute, type Agent } from "../src/room.js";
import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";
import type { FetchLike } from "../src/link.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const TOKEN = "link-token-for-tests-hygiene-0123";
const WEB = "d".repeat(64);

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

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 12_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

type ToolHandler = (args: Record<string, unknown>, extra: { sessionId?: string }) => Promise<{ content: Array<{ text: string }> }>;
async function mcpTools(S: JoindHandle, withLinks: boolean): Promise<(tool: string, args: Record<string, unknown>, session: string) => Promise<string>> {
  const handlers = new Map<string, ToolHandler>();
  const fake = { registerTool: (n: string, _d: unknown, h: ToolHandler) => { handlers.set(n, h); }, registerPrompt: () => {}, registerResource: () => {} };
  const tools = await import("../src/tools.js");
  tools.registerTools(fake as unknown as McpServer, S.manager, undefined, undefined, undefined, undefined, undefined, withLinks ? S.links : undefined);
  return async (tool, args, session) => (await handlers.get(tool)!(args, { sessionId: session })).content[0].text;
}

function promptOf(room: ChatRoom, name: string, label?: string, mention?: number): string {
  const r = room as unknown as { buildWakePrompt(sender: string, agent: Agent, roomLabel?: string, mentionId?: number): string };
  return r.buildWakePrompt("Rami", room.getAgent(name)!, label, mention);
}

describe("the wake prompt follows the join route (room)", () => {
  it("an MCP joiner gets chat_read and chat_send; REST and unknown get the curl recipe", () => {
    const room = new ChatRoom();
    room.homeId = "conv-1";
    room.displayName = () => "ops";
    room.join("Kira", 999_801, undefined, "reviewer", undefined, undefined, "reg-kira", undefined, undefined, "mcp");
    room.join("Odo", 999_802, undefined, undefined, undefined, undefined, "reg-odo", undefined, undefined, "rest");
    room.join("Worf", 999_803, undefined, undefined, undefined, undefined, "reg-worf");
    const kira = promptOf(room, "Kira", undefined, 41);
    expect(kira).toBe(`[joind] @Kira mentioned by Rami in ops. Your role: reviewer. Read from message 41 with chat_read(sender="Kira", since=40, registration="reg-kira"), then reply with chat_send(sender="Kira", registration="reg-kira").`);
    expect(kira).not.toMatch(/curl/);
    for (const name of ["Odo", "Worf"]) {
      const p = promptOf(room, name, undefined, 41);
      expect(p).toMatch(/Read: curl -s "/);
      expect(p).toMatch(/\/api\/agent\/send/);
      expect(p).not.toMatch(/chat_send/);
    }
  });

  it("a rejoin restamps the route, both ways, and a join naming none clears it", () => {
    const room = new ChatRoom();
    room.join("Kira", 999_801, undefined, undefined, undefined, undefined, "reg-1", undefined, undefined, "mcp");
    expect(promptOf(room, "Kira")).toMatch(/chat_send/);
    room.join("Kira", 999_801, undefined, undefined, undefined, undefined, "reg-2", undefined, undefined, "rest");
    expect(room.getAgent("Kira")!.joinRoute).toBe("rest");
    expect(promptOf(room, "Kira")).toMatch(/curl/);
    room.join("Kira", 999_801, undefined, undefined, undefined, undefined, "reg-3", undefined, undefined, "mcp");
    expect(promptOf(room, "Kira")).toMatch(/chat_send/);
    room.join("Kira", 999_801, undefined, undefined, undefined, undefined, "reg-4");
    expect(room.getAgent("Kira")!.joinRoute).toBeUndefined();
    expect(promptOf(room, "Kira")).toMatch(/curl/);
  });

  it("a hosted member keeps the route its host sent, and a hosted wake names the home room", () => {
    const room = new ChatRoom();
    room.joinHosted("Curzon", "bravo", "reg-home", "reg-host", undefined, "mcp");
    expect(room.getAgent("Curzon")!.joinRoute).toBe("mcp");
    room.joinHosted("Curzon", "bravo", "reg-home2", "reg-host2", undefined, "rest");
    expect(room.getAgent("Curzon")!.joinRoute).toBe("rest");
    room.setJoinRoute("Curzon", "mcp");
    expect(room.getAgent("Curzon")!.joinRoute).toBe("mcp");
    // On a host, the label of the home room is the room the prompt names.
    const host = new ChatRoom();
    host.join("Jadzia", 999_804, undefined, undefined, undefined, undefined, "reg-j", undefined, undefined, "mcp");
    expect(promptOf(host, "Jadzia", `"ops" on alpha (conversation alpha:c1)`, 7)).toContain(`in "ops" on alpha (conversation alpha:c1). Read from message 7 with chat_read(sender="Jadzia", since=6`);
  });

  it("parses only the two routes from the wire", () => {
    expect(parseJoinRoute("mcp")).toBe("mcp");
    expect(parseJoinRoute("rest")).toBe("rest");
    for (const v of ["MCP", "", null, undefined, 1, {}]) expect(parseJoinRoute(v)).toBeUndefined();
  });
});

describe("the wake prompt follows the join route (servers)", { timeout: 30_000 }, () => {
  let dirA: string, dirB: string;
  let A: JoindHandle, B: JoindHandle;
  let netB: { fetchImpl: FetchLike; cut: (v: boolean) => void };
  let room: string;
  let remote: string;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dirA = mkdtempSync(join(tmpdir(), "joind-route-a-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-route-b-"));
    const [pa, pb] = [await freePort(), await freePort()];
    let down = false;
    netB = {
      fetchImpl: async (url, init) => {
        if (down) throw new Error("connect ECONNREFUSED (link cut by the test)");
        const res = await fetch(url, init);
        return { status: res.status, text: () => res.text() };
      },
      cut: (v) => { down = v; },
    };
    const plain: FetchLike = async (url, init) => { const res = await fetch(url, init); return { status: res.status, text: () => res.text() }; };
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 60_000 };
    const cfg = (dir: string, instance: string, port: number, peer: string, peerPort: number): JoindConfig => ({
      port, host: "127.0.0.1", dataDir: join(dir, "data"), instance, crewHome: join(dir, "crew"),
      humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
      webToken: WEB, webTokenUserSet: true,
      links: [{ name: peer, url: `http://127.0.0.1:${peerPort}`, token: TOKEN }],
    });
    A = await startJoind(cfg(dirA, "alpha", pa, "bravo", pb), { link: { ...tuning, fetchImpl: plain } });
    B = await startJoind(cfg(dirB, "bravo", pb, "alpha", pa), { link: { ...tuning, fetchImpl: netB.fetchImpl } });
    room = A.manager.createConversation("ops").id;
    A.manager.setActive(room);
    remote = `alpha:${room}`;
  }, 30_000);

  afterAll(async () => {
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("local joins: an MCP joiner is woken with chat_send, a REST joiner with curl", async () => {
    const call = await mcpTools(A, false);
    expect(await call("chat_join", { name: "Kira", pid: 999_811, conversation: room }, "kira-local")).toContain("Joined conversation");
    expect((await post(A.baseUrl, "/api/agent/join", { name: "Odo", pid: 999_812, conversation: room })).status).toBe(200);
    expect(A.manager.getRoom(room)!.getAgent("Kira")!.joinRoute).toBe("mcp");
    expect(A.manager.getRoom(room)!.getAgent("Odo")!.joinRoute).toBe("rest");
    injected.length = 0;
    expect((await post(A.baseUrl, "/api/send", { sender: "Rami", text: "@Kira @Odo status?", token: WEB, conversation: room })).status).toBe(200);
    const kira = await waitFor("Kira's wake", () => injected.find((i) => i.pid === 999_811));
    const odo = await waitFor("Odo's wake", () => injected.find((i) => i.pid === 999_812));
    expect(kira.prompt).toMatch(/^\[joind\] @Kira mentioned by Rami in ops\. Read from message \d+ with chat_read\(sender="Kira", since=\d+, registration="reg-[^"]+"\), then reply with chat_send\(sender="Kira", registration="reg-[^"]+"\)\.$/);
    expect(odo.prompt).toContain(`Read: curl -s "${A.baseUrl}/api/agent/read?sender=Odo`);
  });

  it("a hosted MCP joiner carries its route home; its host wakes it with chat_send naming the home room", async () => {
    const call = await mcpTools(B, true);
    expect(await call("chat_join", { name: "Curzon", pid: 999_821, conversation: remote }, "curzon-b")).toContain("Joined conversation");
    const home = A.manager.getRoom(room)!.getAgent("Curzon")!;
    expect(home.host).toBe("bravo");
    expect(home.joinRoute).toBe("mcp");
    injected.length = 0;
    expect((await post(A.baseUrl, "/api/send", { sender: "Rami", text: "@Curzon over the link", token: WEB, conversation: room })).status).toBe(200);
    const w = await waitFor("Curzon's wake on B", () => injected.find((i) => i.pid === 999_821));
    expect(w.prompt).toContain(`@Curzon mentioned by Rami in "ops" on alpha`);
    expect(w.prompt).toContain(`reply with chat_send(sender="Curzon"`);
    expect(w.prompt).not.toMatch(/curl/);
  });

  it("the route survives the link going down and coming back (re-registration)", async () => {
    // The home forgets the route (as a home that restarted would hold
    // nothing): the host's re-registration on recovery must carry it again.
    A.manager.getRoom(room)!.setJoinRoute("Curzon", undefined);
    netB.cut(true);
    await waitFor("down", () => B.links.get("alpha")!.info().state === "down");
    netB.cut(false);
    await waitFor("the route back at home", () => A.manager.getRoom(room)!.getAgent("Curzon")!.joinRoute === "mcp");
  });

  it("a REST rejoin on the host restamps the route at home too", async () => {
    const r = await post(B.baseUrl, "/api/agent/join", { name: "Curzon", pid: 999_821, conversation: remote });
    expect(r.status).toBe(200);
    await waitFor("rest at home", () => A.manager.getRoom(room)!.getAgent("Curzon")!.joinRoute === "rest");
    injected.length = 0;
    expect((await post(A.baseUrl, "/api/send", { sender: "Rami", text: "@Curzon again", token: WEB, conversation: room })).status).toBe(200);
    const w = await waitFor("Curzon's second wake", () => injected.find((i) => i.pid === 999_821));
    expect(w.prompt).toContain(`Read: curl -s "${B.baseUrl}/api/agent/read?sender=Curzon`);
  });
});

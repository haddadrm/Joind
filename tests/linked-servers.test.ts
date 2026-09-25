/**
 * Linked servers, end to end in one process: two real servers (A is the
 * home of a room, B hosts a member of it) on loopback ports with their own
 * temp data dirs, linked both ways. The injector is replaced by a fake that
 * records every prompt, and each link's network can be cut from the test.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "net";

const injected: Array<{ pid: number; prompt: string }> = [];
const injectFailures: string[] = [];
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return {
    ...actual,
    inject: vi.fn(async (pid: number, prompt: string) => {
      injected.push({ pid, prompt });
      const fail = injectFailures.shift();
      if (fail) throw new Error(fail);
    }),
  };
});

// The joins here use fake pids and no pane or handle: the process
// enumeration each join runs has nothing to find, so it is stubbed (it spawns
// a system query per join, load that slows other timing-bound tests).
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";
import type { FetchLike } from "../src/link.js";
import type { MirrorNotice } from "../src/mirror.js";
import type { ChatMessage } from "../src/room.js";

const TOKEN = "link-token-for-tests-0123456789";
const WEB = "a".repeat(64);
const PID = 999_991;      // odd fake pids no Windows process can have
const PID_JADZIA = 999_993;

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

/** A fetch whose network can be cut, standing in for a dropped link. */
function switchableFetch(): { fetchImpl: FetchLike; cut: (v: boolean) => void } {
  let down = false;
  const fetchImpl: FetchLike = async (url, init) => {
    if (down) throw new Error("connect ECONNREFUSED (link cut by the test)");
    const res = await fetch(url, init);
    return { status: res.status, text: () => res.text() };
  };
  return { fetchImpl, cut: (v) => { down = v; } };
}

function config(dir: string, instance: string, port: number, peer: string, peerPort: number): JoindConfig {
  return {
    port, host: "127.0.0.1", dataDir: join(dir, "data"), instance, crewHome: join(dir, "crew"),
    humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
    webToken: WEB, webTokenUserSet: true,
    links: [{ name: peer, url: `http://127.0.0.1:${peerPort}`, token: TOKEN }],
  };
}

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function get(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("linked servers: two servers in one process", () => {
  let dirA: string, dirB: string;
  let A: JoindHandle, B: JoindHandle;
  let netA: ReturnType<typeof switchableFetch>, netB: ReturnType<typeof switchableFetch>;
  let room: string;        // A's room id
  let remote: string;      // "alpha:<room>" on B
  let curzonReg: string;
  const noticesB: MirrorNotice[] = [];

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), "joind-link-a-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-link-b-"));
    const [pa, pb] = [await freePort(), await freePort()];
    netA = switchableFetch();
    netB = switchableFetch();
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 60_000 };
    A = await startJoind(config(dirA, "alpha", pa, "bravo", pb), { link: { ...tuning, fetchImpl: netA.fetchImpl }, peerGraceMs: 6_000, peerMonitorEveryMs: 200 });
    B = await startJoind(config(dirB, "bravo", pb, "alpha", pa), { link: { ...tuning, fetchImpl: netB.fetchImpl } });
    B.links.on("notice", (n: MirrorNotice) => noticesB.push(n));
    room = A.manager.createConversation("ops").id;
    remote = `alpha:${room}`;
  }, 30_000);

  afterAll(async () => {
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
  });

  it("a member joins A's room from B and is registered on A as hosted on B", async () => {
    const r = await post(B.baseUrl, "/api/agent/join", { name: "Curzon", pid: PID, conversation: remote });
    expect(r.status).toBe(200);
    expect((r.json.conversation as { id: string; server: string }).id).toBe(remote);
    curzonReg = r.json.registration as string;
    expect(curzonReg).toMatch(/^reg-/);
    const member = A.manager.getRoom(room)!.getAgent("Curzon")!;
    expect(member.host).toBe("bravo");
    expect(member.pid).toBe(0);
    // Hosted: no terminal on A, and its host registration is not on the member object.
    expect(JSON.stringify(member)).not.toContain(curzonReg);
    // A name-only lookup on A never reaches a hosted registration.
    expect(A.manager.getAgentBinding("Curzon")).toBeUndefined();
  }, 20_000);

  it("a mention on A reaches B as a wake request and B's injector gets a prompt naming A's room and B's URL", async () => {
    injected.length = 0;
    const s = await post(A.baseUrl, "/api/send", { sender: "Rami", text: "@Curzon ping from home", token: WEB, conversation: room });
    expect(s.status).toBe(200);
    const call = await waitFor("B's injector", () => injected[0]);
    expect(call.pid).toBe(PID);
    expect(call.prompt).toContain(`in "ops" on alpha (conversation ${remote})`);
    expect(call.prompt).toContain(`${B.baseUrl}/api/agent/read?sender=Curzon`);
    expect(call.prompt).not.toContain(A.baseUrl);
    // The mention was a success: no honest-failure line on A.
    await new Promise((r) => setTimeout(r, 300));
    expect(A.manager.getRoom(room)!.read().some((m) => /Could not wake Curzon/.test(m.text))).toBe(false);
    // The member reads through its own server, with the home's ids.
    const read = await get(B.baseUrl, `/api/agent/read?sender=Curzon&pid=${PID}`);
    const msgs = read.json.messages as ChatMessage[];
    const ping = msgs.find((m) => m.text === "@Curzon ping from home")!;
    expect(ping.id).toBe(s.json.id);
  }, 20_000);

  it("a reply written on B lands on A under A's id and is mirrored back", async () => {
    const r = await post(B.baseUrl, "/api/agent/send", { sender: "Curzon", text: "pong from the host", pid: PID });
    expect(r.status).toBe(200);
    const home = A.manager.getRoom(room)!.read().find((m) => m.text === "pong from the host")!;
    expect(home.sender).toBe("Curzon");
    expect(r.json.id).toBe(home.id);
  }, 20_000);

  it("a failed injection on B comes back as A's honest line, worded as for a local wake", async () => {
    injectFailures.push("AttachConsole failed: error 87");
    await post(A.baseUrl, "/api/send", { sender: "Rami", text: "@Curzon are you there", token: WEB, conversation: room });
    const line = await waitFor("the honest line on A", () =>
      A.manager.getRoom(room)!.read().find((m) => m.sender === "system" && /Could not wake Curzon/.test(m.text)));
    expect(line.text).toBe("Could not wake Curzon: no console reachable from their host bravo (remote session, or joined without its real terminal pid). They will see mentions only when they read on their own schedule.");
  }, 20_000);

  it("register and send are idempotent on retry", async () => {
    const hosted = A.manager.getRoom(room)!.hostedRegistrationOf("Curzon")!;
    const homeReg = A.manager.getRoom(room)!.registrationOf("Curzon")!;
    const again = await post(A.baseUrl, "/api/peer/register", { room, name: "Curzon", host: "bravo", registration: hosted }, auth);
    expect(again.status).toBe(200);
    expect(again.json.registration).toBe(homeReg);
    const count = A.manager.getRoom(room)!.messageCount();
    const body = { room, sender: "Curzon", text: "sent twice, stored once", clientId: "retry-1", registration: homeReg };
    const one = await post(A.baseUrl, "/api/peer/send", body, auth);
    const two = await post(A.baseUrl, "/api/peer/send", body, auth);
    expect(one.status).toBe(200);
    expect(two.json.duplicate).toBe(true);
    expect((two.json.message as ChatMessage).id).toBe((one.json.message as ChatMessage).id);
    expect(A.manager.getRoom(room)!.messageCount()).toBe(count + 1);
  });

  it("a name registered on A from a local terminal is refused to B with 409 and the candidates", async () => {
    const j = await post(A.baseUrl, "/api/agent/join", { name: "Jadzia", pid: PID_JADZIA, conversation: room });
    expect(j.status).toBe(200);
    const r = await post(B.baseUrl, "/api/agent/join", { name: "Jadzia", pid: PID + 2, conversation: remote });
    expect(r.status).toBe(409);
    expect(r.json.candidates).toEqual([{ conversation: room, host: "alpha", pid: PID_JADZIA }]);
    // Nothing was registered on B for the refused name.
    expect(B.manager.getRoom(remote)!.getAgent("Jadzia")).toBeUndefined();
    // And a local join on A over the hosted member is refused too.
    const over = await post(A.baseUrl, "/api/agent/join", { name: "Curzon", pid: PID + 4, conversation: room });
    expect(over.status).toBe(409);
    // A wrong token is 401.
    const bad = await get(A.baseUrl, "/api/peer/rooms", { Authorization: "Bearer nope-nope-nope" });
    expect(bad.status).toBe(401);
  }, 20_000);

  it("a DM not addressed to the hosted member never crosses the link; one addressed to it does", async () => {
    const mirror = B.manager.getRoom(remote)!;
    await post(A.baseUrl, "/api/send", { sender: "Rami", text: "secret for Jadzia only", to: ["Jadzia"], token: WEB, conversation: room });
    await post(A.baseUrl, "/api/send", { sender: "Rami", text: "for Curzon only", to: ["Curzon"], token: WEB, conversation: room });
    await post(A.baseUrl, "/api/send", { sender: "Rami", text: "public marker after the DMs", token: WEB, conversation: room });
    await waitFor("the marker on B", () => mirror.readAll().some((m) => m.text === "public marker after the DMs"));
    expect(mirror.readAll().some((m) => m.text === "secret for Jadzia only")).toBe(false);
    expect(mirror.readAll().some((m) => m.text === "for Curzon only")).toBe(true);
    // Asking the home to filter as someone the peer does not host changes nothing.
    const snap = await get(A.baseUrl, `/api/peer/messages?room=${room}&viewers=Jadzia`, auth);
    expect((snap.json.messages as ChatMessage[]).some((m) => m.text === "secret for Jadzia only")).toBe(false);
    const sub = await get(A.baseUrl, `/api/peer/subscribe?room=${room}&since=0&viewers=Jadzia,Rami&timeoutMs=1000`, auth);
    const texts = JSON.stringify(sub.json);
    expect(texts).not.toContain("secret for Jadzia only");
  }, 20_000);

  it("while the link is down a send from B queues; its author may delete it, no one else; on recovery it is sent once under A's id", async () => {
    const link = B.links.get("alpha")!;
    const mirror = B.manager.getRoom(remote)!;
    netB.cut(true);
    await waitFor("B to see the link down", () => link.info().state === "down");
    const down = (mirror as unknown as { readForView(n: number, v?: string): ChatMessage[] }).readForView(100, undefined)
      .find((m) => m.local && /^link to alpha down since .* UTC; messages you send here will be queued$/.test(m.text));
    expect(down?.id).toBeLessThan(0);

    const q1 = await post(B.baseUrl, "/api/agent/send", { sender: "Curzon", text: "written offline, keep", pid: PID });
    const q2 = await post(B.baseUrl, "/api/agent/send", { sender: "Curzon", text: "written offline, delete", pid: PID });
    expect(q1.status).toBe(202);
    expect(q2.status).toBe(202);
    const keep = q1.json.clientId as string;
    const drop = q2.json.clientId as string;
    expect(noticesB.filter((n) => n.type === "pending").map((n) => n.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: remote, clientId: keep, sender: "Curzon", text: "written offline, keep" }),
    ]));
    const queueFile = join(dirB, "data", "links", "alpha", `${room}.queue.jsonl`);
    expect(readFileSync(queueFile, "utf-8").trim().split("\n")).toHaveLength(2);

    // Only the author may delete an undelivered message.
    const other = await post(B.baseUrl, "/api/pending/delete", { conversation: remote, clientId: drop, token: WEB });
    expect(other.status).toBe(409); // no web viewer registered on B: refused before any lookup
    const byOther = (mirror as unknown as { deleteUndelivered(c: string, by: string): { ok: boolean; status?: number } }).deleteUndelivered(drop, "Jadzia");
    expect(byOther).toEqual({ ok: false, status: 403, error: "Only its author may delete an undelivered message" });
    const byAuthor = await post(B.baseUrl, "/api/agent/pending/delete", { name: "Curzon", clientId: drop, pid: PID });
    expect(byAuthor.status).toBe(200);
    expect(noticesB.some((n) => n.type === "pending-deleted" && n.data.clientId === drop)).toBe(true);
    expect(readFileSync(queueFile, "utf-8").trim().split("\n")).toHaveLength(1);

    netB.cut(false);
    await waitFor("B to see the link up", () => link.info().state === "up", 10_000);
    const landed = await waitFor("the queued message on A", () =>
      A.manager.getRoom(room)!.read().filter((m) => m.text === "written offline, keep"));
    await new Promise((r) => setTimeout(r, 500));
    expect(A.manager.getRoom(room)!.read().filter((m) => m.text === "written offline, keep")).toHaveLength(1);
    expect(A.manager.getRoom(room)!.read().some((m) => m.text === "written offline, delete")).toBe(false);
    const dispatched = noticesB.find((n) => n.type === "pending-dispatched" && n.data.clientId === keep);
    expect(dispatched && dispatched.type === "pending-dispatched" ? dispatched.data.id : undefined).toBe(landed[0].id);
    const restored = await waitFor("the restore line", () => (mirror as unknown as { readForView(n: number, v?: string): ChatMessage[] }).readForView(100, undefined)
      .find((m) => m.local && m.text === "link to alpha restored; 1 queued message sent"));
    expect(restored.id).toBeLessThan(0);
    expect(existsSync(queueFile) ? readFileSync(queueFile, "utf-8").trim() : "").toBe("");
  }, 30_000);

  it("a mention while A cannot reach B is not queued: A says so once", async () => {
    injected.length = 0;
    netA.cut(true);
    await post(A.baseUrl, "/api/send", { sender: "Rami", text: "@Curzon while unreachable", token: WEB, conversation: room });
    const line = await waitFor("the unreachable line", () =>
      A.manager.getRoom(room)!.read().find((m) => m.sender === "system" && /their host bravo is unreachable/.test(m.text)));
    expect(line.text).toMatch(/^Could not wake Curzon: their host bravo is unreachable \(.+\)\. They will see this when the link returns\.$/);
    expect(injected).toHaveLength(0);
    netA.cut(false);
  }, 20_000);

  it("a peer silent past the grace is announced once on A, and so is its return", async () => {
    netB.cut(true);
    const gone = await waitFor("the unreachable announcement", () =>
      A.manager.getRoom(room)!.read().find((m) => m.text === "bravo unreachable; members hosted there cannot be woken until it returns"), 20_000);
    expect(gone.sender).toBe("system");
    netB.cut(false);
    await waitFor("the return", () =>
      A.manager.getRoom(room)!.read().find((m) => m.text === "bravo is reachable again; members hosted there can be woken"), 15_000);
    expect(A.manager.getRoom(room)!.read().filter((m) => m.text.startsWith("bravo unreachable"))).toHaveLength(1);
  }, 45_000);

  it("MCP: chat_join takes \"<server>:<room>\", and chat_send, chat_read and chat_unsend work through the mirror", async () => {
    type ToolHandler = (args: Record<string, unknown>, extra: { sessionId?: string }) => Promise<{ content: Array<{ text: string }> }>;
    const handlers = new Map<string, ToolHandler>();
    const fake = { registerTool: (n: string, _d: unknown, h: ToolHandler) => { handlers.set(n, h); }, registerPrompt: () => {}, registerResource: () => {} };
    const tools = await import("../src/tools.js");
    tools.registerTools(fake as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, B.manager, undefined, undefined, undefined, undefined, undefined, B.links);
    const call = async (tool: string, args: Record<string, unknown>) => (await handlers.get(tool)!(args, { sessionId: "kira-session" })).content[0].text;

    const joined = await call("chat_join", { name: "Kira", pid: PID + 6, conversation: remote });
    expect(joined).toContain(`Joined conversation "ops"`);
    expect(joined).toContain(`Remote room on alpha (${remote})`);
    expect(A.manager.getRoom(room)!.getAgent("Kira")?.host).toBe("bravo");

    const sent = await call("chat_send", { sender: "Kira", text: "hello from MCP on the host" });
    const home = A.manager.getRoom(room)!.read().find((m) => m.text === "hello from MCP on the host")!;
    expect(sent).toBe(`Message #${home.id} sent`);
    const read = await call("chat_read", { sender: "Kira", limit: 5 });
    expect(read).toContain(`[#${home.id} Kira] hello from MCP on the host`);

    netB.cut(true);
    await waitFor("down", () => B.links.get("alpha")!.info().state === "down");
    const queued = await call("chat_send", { sender: "Kira", text: "MCP offline draft" });
    expect(queued).toMatch(/^Message queued, not sent yet: the link to alpha is down\. .* clientId (\S+);/);
    const clientId = /clientId (\S+);/.exec(queued)![1];
    expect(await call("chat_unsend", { sender: "Kira", clientId })).toBe(`Undelivered message ${clientId} deleted`);
    expect(await call("chat_unsend", { sender: "Kira", clientId })).toBe("Not deleted: No such undelivered message (already sent, or deleted)");
    netB.cut(false);
    await waitFor("up", () => B.links.get("alpha")!.info().state === "up", 10_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(A.manager.getRoom(room)!.read().some((m) => m.text === "MCP offline draft")).toBe(false);
    expect(await call("chat_leave", { name: "Kira" })).toBe("Kira disconnected");
    await waitFor("Kira gone on A", () => !A.manager.getRoom(room)!.getAgent("Kira"));
  }, 30_000);

  it("web contract: pending with both ids, dispatch and message both sent, pending in list, select and init, discovery refetch events, no remote admin", async () => {
    const { default: WebSocket } = await import("ws");
    expect((await post(B.baseUrl, "/api/web/register", { token: WEB, name: "Rami" })).status).toBe(200);
    const events: Array<{ type: string; conversationId?: string; data?: Record<string, unknown> }> = [];
    const wsUrl = `${B.baseUrl.replace("http", "ws")}/ws?token=${WEB}&name=Rami`;
    const ws = new WebSocket(wsUrl);
    ws.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await waitFor("ws init", () => events.find((e) => e.type === "init"));
    try {
      netB.cut(true);
      await waitFor("down", () => B.links.get("alpha")!.info().state === "down");
      const q = await post(B.baseUrl, "/api/agent/send", { sender: "Curzon", text: "queued for the web contract", pid: PID });
      expect(q.status).toBe(202);
      const clientId = q.json.clientId as string;
      const pending = await waitFor("pending event", () => events.find((e) => e.type === "pending" && e.data?.clientId === clientId));
      expect(pending.conversationId).toBe(remote);
      expect(pending.data?.conversationId).toBe(remote);
      expect(events.some((e) => e.type === "link" && e.data?.state === "down")).toBe(true);

      const list = await get(B.baseUrl, `/api/conversations?token=${WEB}`);
      expect(list.json.links).toEqual([expect.objectContaining({ name: "alpha", state: "down" })]);
      expect(list.json.remoteConversations).toEqual(expect.arrayContaining([expect.objectContaining({ id: remote, server: "alpha", name: "ops", state: "down" })]));
      expect(list.json.pending).toEqual([expect.objectContaining({ conversationId: remote, clientId, sender: "Curzon", text: "queued for the web contract" })]);
      const sel = await post(B.baseUrl, "/api/conversations/select", { id: remote, token: WEB });
      expect(sel.status).toBe(200);
      expect(sel.json.pending).toEqual([expect.objectContaining({ clientId, queuedAt: expect.any(Number) })]);
      const ws2 = new WebSocket(wsUrl);
      const init = await new Promise<{ data: Record<string, unknown> }>((resolve) => ws2.once("message", (raw) => resolve(JSON.parse(String(raw)))));
      ws2.close();
      expect(init.data.pending).toEqual([expect.objectContaining({ clientId })]);
      expect(init.data.links).toBeDefined();
      expect(init.data.remoteConversations).toBeDefined();
      // The viewer is not the author.
      expect((await post(B.baseUrl, "/api/pending/delete", { conversation: remote, clientId, token: WEB })).status).toBe(403);

      netB.cut(false);
      const dispatched = await waitFor("pending-dispatched", () => events.find((e) => e.type === "pending-dispatched" && e.data?.clientId === clientId), 10_000);
      expect(dispatched.conversationId).toBe(remote);
      await waitFor("the real message on B's socket", () => events.find((e) => e.type === "message" && e.conversationId === remote && e.data?.id === dispatched.data?.id));

      // A room created on A after startup reaches B's UI as a refetch signal.
      const later = A.manager.createConversation("later").id;
      await B.links.get("alpha")!.discover();
      await waitFor("conversation-created for the new remote room", () => events.find((e) => e.type === "conversation-created" && e.data?.id === `alpha:${later}`));

      for (const route of ["rename", "star", "delete"]) {
        expect((await post(B.baseUrl, `/api/conversations/${route}`, { id: remote, name: "x", starred: true })).status).toBe(400);
      }
    } finally {
      ws.close();
      netB.cut(false);
    }
  }, 40_000);

  it("the member leaves from B and is removed on A", async () => {
    const r = await post(B.baseUrl, "/api/agent/leave", { name: "Curzon", pid: PID });
    expect(r.status).toBe(200);
    await waitFor("Curzon gone on A", () => !A.manager.getRoom(room)!.getAgent("Curzon"));
  }, 20_000);
});

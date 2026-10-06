/**
 * Room-scoped read cursors through a real server (one process, a loopback
 * port, its own data dir): REST reads, listens and unread counts keep one
 * cursor per room, a since from another room is never stored, and a legacy
 * name-only cursor file does not stop startup.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: async () => undefined };
});
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, listProcesses: async () => new Map(), anyLiveGuiSocket: () => false };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";

const WEB = "b".repeat(64);
const PID_BIG = 999_971;
const PID_SMALL = 999_973;

async function call(base: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

describe("room-scoped cursors through the server", { timeout: 20_000 }, () => {
  let dir: string;
  let S: JoindHandle;
  let big: string, small: string;
  let smallUnread = 0;
  const logs: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "joind-cursors-srv-"));
    // A legacy name-only file from before cursors were per room.
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "agent-cursors.json"), JSON.stringify({ Scotty: 10029 }));
    vi.spyOn(console, "log").mockImplementation((l: unknown) => { logs.push(String(l)); });
    const config: JoindConfig = {
      port: 0, host: "127.0.0.1", dataDir: join(dir, "data"), instance: "solo", crewHome: join(dir, "crew"),
      humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
      webToken: WEB, webTokenUserSet: true, links: [],
    };
    S = await startJoind(config);
    big = S.manager.createConversation("big").id;
    small = S.manager.createConversation("small").id;
    expect((await call(S.baseUrl, "POST", "/api/agent/join", { name: "Scotty", pid: PID_BIG, conversation: big })).status).toBe(200);
    expect((await call(S.baseUrl, "POST", "/api/agent/join", { name: "Scotty", pid: PID_SMALL, conversation: small })).status).toBe(200);
    const bigRoom = S.manager.getRoom(big)!;
    for (let i = 0; i < 30; i++) bigRoom.send("Rami", `big ${i}`);
    const smallRoom = S.manager.getRoom(small)!;
    for (let i = 0; i < 3; i++) smallRoom.send("Rami", `small ${i}`);
    // Everything in the small room not written by Scotty (the join lines too).
    smallUnread = smallRoom.read(0, 100000, undefined, "Scotty").filter((m) => m.sender !== "Scotty").length;
  }, 30_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await S?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const unreadIn = async (pid: number): Promise<number> =>
    (await call(S.baseUrl, "GET", `/api/agent/unread?sender=Scotty&pid=${pid}`)).json.count as number;

  it("the legacy name-only file did not stop startup and was not used", async () => {
    expect(logs.some((l) => /legacy name-only cursor\(s\); ignored and kept in the file untouched/.test(l))).toBe(true);
    expect(await unreadIn(PID_SMALL)).toBe(smallUnread);
  });

  it("reading all of the big room leaves the small room unread", async () => {
    const r = await call(S.baseUrl, "GET", `/api/agent/read?sender=Scotty&pid=${PID_BIG}&limit=100`);
    expect((r.json.messages as unknown[]).length).toBeGreaterThan(0);
    expect(await unreadIn(PID_BIG)).toBe(0);
    expect(await unreadIn(PID_SMALL)).toBe(smallUnread);
  });

  it("an empty read with a since from another room is literal and marks nothing read", async () => {
    const r = await call(S.baseUrl, "GET", `/api/agent/read?sender=Scotty&pid=${PID_SMALL}&since=10029`);
    expect(r.json).toEqual({ messages: [], lastId: 10029 });
    expect(await unreadIn(PID_SMALL)).toBe(smallUnread);
  });

  it("a listen with a since from another room moves the cursor only to what it delivered", async () => {
    const r = await call(S.baseUrl, "GET", `/api/agent/listen?sender=Scotty&pid=${PID_SMALL}&since=10029&timeoutMs=300`);
    expect(r.json.messages).toEqual([]);
    expect(await unreadIn(PID_SMALL)).toBe(smallUnread);
  });

  it("follow-up: a listen without since and with no cursor in the room starts at the room's end, not at message 1", async () => {
    const roomId = S.manager.createConversation("fresh").id;
    const room = S.manager.getRoom(roomId)!;
    for (let i = 0; i < 10; i++) room.send("Rami", `old ${i}`);
    expect((await call(S.baseUrl, "POST", "/api/agent/join", { name: "Kira", pid: 999_977, conversation: roomId })).status).toBe(200);
    const quiet = await call(S.baseUrl, "GET", `/api/agent/listen?sender=Kira&pid=999_977&timeoutMs=300`.replace("999_977", "999977"));
    expect(quiet.json.messages).toEqual([]);
    const waiting = call(S.baseUrl, "GET", `/api/agent/listen?sender=Kira&pid=999977&timeoutMs=5000`);
    await new Promise((r) => setTimeout(r, 200));
    const fresh = room.send("Rami", "new after the listen started");
    const got = await waiting;
    expect((got.json.messages as Array<{ id: number }>).map((m) => m.id)).toEqual([fresh.id]);
  });

  it("a read that returns messages advances the small room's cursor, and only it", async () => {
    expect(smallUnread).toBeGreaterThan(0);
    await call(S.baseUrl, "GET", `/api/agent/read?sender=Scotty&pid=${PID_SMALL}&limit=100`);
    expect(await unreadIn(PID_SMALL)).toBe(0);
    S.manager.getRoom(small)!.send("Rami", "one more");
    expect(await unreadIn(PID_SMALL)).toBe(1);
    expect(await unreadIn(PID_BIG)).toBe(0);
  });
});

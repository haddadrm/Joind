/**
 * The field case, exactly (Y530, 27 Sep 2026; ruling in cpm-engine #1907).
 *
 * Scotty's stored cursor was 10029, and one of his rooms held 10,044
 * messages. He was mentioned in cpm-engine, whose last id was about 1900.
 * Every wake prompt there said since=10029, and the callback read
 * GET /api/agent/read?since=10029 returned nothing: a wake that landed read
 * nothing. The origin of 10029 is not proven; it is consistent with the big
 * room. Both sources are set up here: a legacy name-only file holding 10029,
 * and a real read in a 10,044-message room that leaves him at 10029.
 *
 * Two servers in one process, loopback ports, their own data dirs. inject()
 * is replaced by a recorder (nothing is typed anywhere): the test takes the
 * prompt's since, makes the callback read the prompt asks for, and checks
 * that the mention comes back. First for a member local to the room's
 * server, then for a hosted member reading through the mirror on its host.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "net";

const prompts: Array<{ pid: number; text: string }> = [];
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: async (pid: number, text: string) => { prompts.push({ pid, text }); } };
});
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, anyLiveGuiSocket: () => false };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";
import type { FetchLike } from "../src/link.js";
import type { ChatMessage, ChatRoom } from "../src/room.js";

const TOKEN = "link-token-for-tests-0123456789";
const WEB = "c".repeat(64);
const PID_BIG = 999_961;      // odd fake pids no Windows process can have
const PID_CPM = 999_963;
const PID_HOSTED = 999_967;
const PID_NO_CURSOR_LOCAL = 999_969;
const PID_NO_CURSOR_HOSTED = 999_979;
const BIG_ROOM_SIZE = 10_044;
const FIELD_CURSOR = 10_029;
const CPM_LAST_ID = 1_900;

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

const fetchImpl: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, text: () => res.text() };
};

function config(dir: string, instance: string, port: number, peer: string, peerPort: number): JoindConfig {
  return {
    port, host: "127.0.0.1", dataDir: join(dir, "data"), instance, crewHome: join(dir, "crew"),
    humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
    webToken: WEB, webTokenUserSet: true,
    links: [{ name: peer, url: `http://127.0.0.1:${peerPort}`, token: TOKEN }],
  };
}

async function call(base: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  // A fresh connection per call: filling a 10,044-message room blocks the
  // event loop for seconds, past the server's keep-alive timeout, and a
  // pooled connection closed meanwhile would read ECONNRESET.
  const headers: Record<string, string> = { Connection: "close" };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
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

/** Fill a room with ordinary traffic until its last id is `lastId`. */
function fillTo(room: ChatRoom, lastId: number): void {
  while (room.highWaterId() < lastId) room.send("Rami", `traffic ${room.highWaterId() + 1}`);
}

/** Put Scotty's cursor in `roomId` at exactly `at`, by a real read through
 *  the server while the room ends there, then let the room grow on. */
async function readUpTo(base: string, room: ChatRoom, pid: number, at: number, end: number): Promise<void> {
  fillTo(room, at);
  const r = await call(base, "GET", `/api/agent/read?sender=Scotty&pid=${pid}&limit=50`);
  const got = r.json.messages as ChatMessage[];
  expect(got[got.length - 1].id).toBe(at);
  fillTo(room, end);
}

const sinceOf = (prompt: string): number => Number(/since=(\d+)/.exec(prompt)?.[1] ?? NaN);

describe("field case (Y530, cpm-engine #1907): cursor 10029 from a 10,044-message room, mention in a room ending near 1900", { timeout: 60_000 }, () => {
  let dirA: string, dirB: string;
  let A: JoindHandle, B: JoindHandle;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    dirA = mkdtempSync(join(tmpdir(), "joind-field-a-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-field-b-"));
    // Both servers start with the legacy name-only file of the field.
    for (const d of [dirA, dirB]) {
      mkdirSync(join(d, "data"), { recursive: true });
      writeFileSync(join(d, "data", "agent-cursors.json"), JSON.stringify({ Scotty: FIELD_CURSOR }));
    }
    const [pa, pb] = [await freePort(), await freePort()];
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 60_000 };
    A = await startJoind(config(dirA, "alpha", pa, "bravo", pb), { link: { ...tuning, fetchImpl } });
    B = await startJoind(config(dirB, "bravo", pb, "alpha", pa), { link: { ...tuning, fetchImpl } });
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
  });

  it("a local member: the wake prompt's since and the callback read return the mention", async () => {
    const bigId = A.manager.createConversation("big").id;
    const cpmId = A.manager.createConversation("cpm-engine").id;
    const big = A.manager.getRoom(bigId)!;
    const cpm = A.manager.getRoom(cpmId)!;
    expect((await call(A.baseUrl, "POST", "/api/agent/join", { name: "Scotty", pid: PID_BIG, conversation: bigId })).status).toBe(200);
    await readUpTo(A.baseUrl, big, PID_BIG, FIELD_CURSOR, BIG_ROOM_SIZE);
    expect(big.highWaterId()).toBe(BIG_ROOM_SIZE);

    expect((await call(A.baseUrl, "POST", "/api/agent/join", { name: "Scotty", pid: PID_CPM, conversation: cpmId })).status).toBe(200);
    fillTo(cpm, CPM_LAST_ID - 1);
    const mention = cpm.send("Rami", "@Scotty the field case");
    expect(mention.id).toBe(CPM_LAST_ID);

    const prompt = await waitFor("the wake prompt", () => prompts.find((p) => p.pid === PID_CPM));
    const since = sinceOf(prompt.text);
    expect(since).toBeLessThan(mention.id);
    expect(since).not.toBe(FIELD_CURSOR);
    const read = await call(A.baseUrl, "GET", `/api/agent/read?sender=Scotty&pid=${PID_CPM}&since=${since}`);
    expect((read.json.messages as ChatMessage[]).map((m) => m.id)).toContain(mention.id);
  });

  it("follow-up (Curzon after his rejoin): a local member with no cursor at all gets since = mention - 1 and the read returns the mention", async () => {
    const roomId = A.manager.createConversation("cpm-engine, no cursor").id;
    const room = A.manager.getRoom(roomId)!;
    fillTo(room, CPM_LAST_ID - 1);
    expect((await call(A.baseUrl, "POST", "/api/agent/join", { name: "Curzon", pid: PID_NO_CURSOR_LOCAL, conversation: roomId })).status).toBe(200);
    const mention = room.send("Rami", "@Curzon first wake, no cursor anywhere");
    const prompt = await waitFor("the wake prompt", () => prompts.find((p) => p.pid === PID_NO_CURSOR_LOCAL));
    expect(sinceOf(prompt.text)).toBe(mention.id - 1);
    const read = await call(A.baseUrl, "GET", `/api/agent/read?sender=Curzon&pid=${PID_NO_CURSOR_LOCAL}&since=${sinceOf(prompt.text)}`);
    const ids = (read.json.messages as ChatMessage[]).map((m) => m.id);
    expect(ids[0]).toBe(mention.id);
  });

  it("follow-up: a hosted member with no cursor at all gets since = mention - 1 on its host, and the first read through the host returns the mention", async () => {
    const homeId = A.manager.createConversation("cpm-engine home, no cursor").id;
    const home = A.manager.getRoom(homeId)!;
    fillTo(home, CPM_LAST_ID - 1);
    const join = await call(B.baseUrl, "POST", "/api/agent/join", { name: "Curzon", pid: PID_NO_CURSOR_HOSTED, conversation: `alpha:${homeId}` });
    expect(join.status).toBe(200);
    await waitFor("the hosted member on the home", () => home.getAgent("Curzon")?.host === "bravo");
    const mention = home.send("Rami", "@Curzon first hosted wake, no cursor anywhere");
    const prompt = await waitFor("the host's wake prompt", () => prompts.find((p) => p.pid === PID_NO_CURSOR_HOSTED));
    expect(sinceOf(prompt.text)).toBe(mention.id - 1);
    const read = await call(B.baseUrl, "GET", `/api/agent/read?sender=Curzon&pid=${PID_NO_CURSOR_HOSTED}&since=${sinceOf(prompt.text)}`);
    expect((read.json.messages as ChatMessage[]).map((m) => m.id)[0]).toBe(mention.id);
  });

  it("a hosted member through the mirror: the host's prompt and the read through the host return the home's mention", async () => {
    // The member's own server (B) holds the big room he read to 10029.
    const bigId = B.manager.createConversation("big").id;
    const big = B.manager.getRoom(bigId)!;
    expect((await call(B.baseUrl, "POST", "/api/agent/join", { name: "Scotty", pid: PID_BIG, conversation: bigId })).status).toBe(200);
    await readUpTo(B.baseUrl, big, PID_BIG, FIELD_CURSOR, BIG_ROOM_SIZE);

    // cpm-engine lives on A (the home); Scotty joins it from B.
    const homeId = A.manager.createConversation("cpm-engine home").id;
    const home = A.manager.getRoom(homeId)!;
    fillTo(home, CPM_LAST_ID - 1);
    const remote = `alpha:${homeId}`;
    const join = await call(B.baseUrl, "POST", "/api/agent/join", { name: "Scotty", pid: PID_HOSTED, conversation: remote });
    expect(join.status).toBe(200);
    await waitFor("the hosted member on the home", () => home.getAgent("Scotty")?.host === "bravo");

    const mention = home.send("Rami", "@Scotty the field case, hosted");
    const prompt = await waitFor("the host's wake prompt", () => prompts.find((p) => p.pid === PID_HOSTED));
    const since = sinceOf(prompt.text);
    expect(since).toBeLessThan(mention.id);
    expect(since).not.toBe(FIELD_CURSOR);
    // The callback read goes to the host, which serves it from its mirror.
    // The first read, no retry: the host waited for the mention to reach
    // its mirror before typing the prompt.
    const read = await call(B.baseUrl, "GET", `/api/agent/read?sender=Scotty&pid=${PID_HOSTED}&since=${since}`);
    expect((read.json.messages as ChatMessage[]).map((m) => m.id)).toContain(mention.id);
  });
});

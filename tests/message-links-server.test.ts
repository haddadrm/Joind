/**
 * Web routes for message links and room search, on real servers:
 *   GET /api/message/:id?conversation=   the viewed room, never the active one in its place
 *   GET /api/messages?conversation=&around=&limit=   the window around a message
 *   GET /api/search?conversation=&q=&page=1&before=&limit=   the grammar, paged
 * on a local room and on a linked server's mirror of a remote room. The
 * viewer is always the registered web name; DMs fail closed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "net";

// Fake pids and no pane: nothing here types into a terminal.
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";
import type { ChatMessage } from "../src/room.js";

const TOKEN = "link-token-for-tests-0123456789";
const WEB = "c".repeat(64);

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

function config(dir: string, instance: string, port: number, peer: string, peerPort: number): JoindConfig {
  return {
    port, host: "127.0.0.1", dataDir: join(dir, "data"), instance, crewHome: join(dir, "crew"),
    humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
    webToken: WEB, webTokenUserSet: true,
    links: [{ name: peer, url: `http://127.0.0.1:${peerPort}`, token: TOKEN }],
  };
}

interface Answer { status: number; body: unknown }

async function get(base: string, path: string, params: Record<string, string>, token: string | null = WEB): Promise<Answer> {
  const q = new URLSearchParams(params);
  if (token !== null) q.set("token", token);
  const res = await fetch(`${base}${path}?${q.toString()}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as unknown : null };
}

async function post(base: string, path: string, body: unknown): Promise<Answer> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as unknown : null };
}

interface Page { results: Array<{ message: ChatMessage }>; nextBefore: number | null; coverage?: { complete: boolean; oldestId: number | null } }
interface Win { conversation: string; anchor: number; messages: ChatMessage[]; hasOlder: boolean; hasNewer: boolean }

const ids = (p: Page): number[] => p.results.map((r) => r.message.id);

describe("message links and room search over the web routes", { timeout: 30_000 }, () => {
  let dirA: string, dirB: string;
  let A: JoindHandle, B: JoindHandle;
  let ops: string, other: string, remote: string;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dirA = mkdtempSync(join(tmpdir(), "joind-links-a-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-links-b-"));
    const [pa, pb] = [await freePort(), await freePort()];
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 60_000 };
    A = await startJoind(config(dirA, "alpha", pa, "bravo", pb), { link: tuning });
    B = await startJoind(config(dirB, "bravo", pb, "alpha", pa), { link: tuning });
    for (const s of [A, B]) expect((await post(s.baseUrl, "/api/web/register", { token: WEB, name: "Rami" })).status).toBe(200);

    ops = A.manager.createConversation("ops").id;
    other = A.manager.createConversation("other").id;
    const room = A.manager.getRoom(ops)!;
    for (let n = 1; n <= 60; n++) room.send("Kira", `alpha ${n}`);
    room.send("Kira", "secret plan alpha", { to: ["Odo"] }); // 61
    room.send("Kira", "for Rami alpha", { to: ["Rami"] }); // 62
    room.send("Worf", "@Odo please check #12"); // 63
    room.send("Worf", "@all standup"); // 64
    const o = A.manager.getRoom(other)!;
    for (let n = 1; n <= 5; n++) o.send("Kira", `bravo ${n}`);
    A.manager.setActive(ops);

    remote = `alpha:${ops}`;
    const sel = await post(B.baseUrl, "/api/conversations/select", { id: remote, token: WEB });
    expect(sel.status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("GET /api/message/:id", () => {
    it("reads the named room, not the active one", async () => {
      const r = await get(A.baseUrl, "/api/message/3", { conversation: other });
      expect(r.status).toBe(200);
      expect((r.body as ChatMessage).text).toBe("bravo 3");
      const active = await get(A.baseUrl, "/api/message/3", {});
      expect((active.body as ChatMessage).text).toBe("alpha 3");
    });

    it("never falls back to the active room for an unknown or empty conversation", async () => {
      expect((await get(A.baseUrl, "/api/message/3", { conversation: "no-such-room" })).status).toBe(404);
      expect((await get(A.baseUrl, "/api/message/3", { conversation: "" })).status).toBe(404);
      expect((await get(A.baseUrl, "/api/message/3", { conversation: "alpha:no-such-room" })).status).toBe(404);
    });

    it("answers a hidden DM exactly as a missing message", async () => {
      const hidden = await get(A.baseUrl, "/api/message/61", { conversation: ops });
      const missing = await get(A.baseUrl, "/api/message/9999", { conversation: ops });
      expect(hidden).toEqual(missing);
      expect(hidden.status).toBe(404);
      expect((await get(A.baseUrl, "/api/message/62", { conversation: ops })).status).toBe(200);
    });

    it("refuses without the web token and rejects a bad id", async () => {
      expect((await get(A.baseUrl, "/api/message/3", { conversation: ops }, null)).status).toBe(403);
      expect((await get(A.baseUrl, "/api/message/3", { conversation: ops }, "x".repeat(64))).status).toBe(403);
      expect((await get(A.baseUrl, "/api/message/0", { conversation: ops })).status).toBe(400);
      expect((await get(A.baseUrl, "/api/message/1e3", { conversation: ops })).status).toBe(404);
      expect((await get(A.baseUrl, "/api/message/2.5", { conversation: ops })).status).toBe(400);
    });
  });

  describe("GET /api/messages?around=", () => {
    it("returns the window around an id in the named room", async () => {
      const r = await get(A.baseUrl, "/api/messages", { conversation: ops, around: "30", limit: "11" });
      expect(r.status).toBe(200);
      const w = r.body as Win;
      expect(w.conversation).toBe(ops);
      expect(w.anchor).toBe(30);
      expect(w.messages.map((m) => m.id)).toEqual([25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
      expect(w.hasOlder && w.hasNewer).toBe(true);
    });

    it("skips DMs the viewer may not see and 404s on a hidden target", async () => {
      const w = (await get(A.baseUrl, "/api/messages", { conversation: ops, around: "64", limit: "5" })).body as Win;
      expect(w.messages.map((m) => m.id)).toEqual([59, 60, 62, 63, 64]);
      expect(w.hasNewer).toBe(false);
      const hidden = await get(A.baseUrl, "/api/messages", { conversation: ops, around: "61" });
      const missing = await get(A.baseUrl, "/api/messages", { conversation: ops, around: "9999" });
      expect(hidden.status).toBe(404);
      expect(hidden).toEqual(missing);
    });

    it("validates its input and fails closed on the room", async () => {
      expect((await get(A.baseUrl, "/api/messages", { conversation: ops, around: "abc" })).status).toBe(400);
      expect((await get(A.baseUrl, "/api/messages", { conversation: "no-such-room", around: "3" })).status).toBe(404);
      expect((await get(A.baseUrl, "/api/messages", { conversation: ops, around: "3" }, null)).status).toBe(403);
      const huge = (await get(A.baseUrl, "/api/messages", { conversation: ops, around: "30", limit: "100000" })).body as Win;
      expect(huge.messages.length).toBeLessThanOrEqual(200);
    });

    it("keeps the plain latest read unchanged", async () => {
      const r = await get(A.baseUrl, "/api/messages", { conversation: ops });
      const list = r.body as ChatMessage[];
      expect(Array.isArray(list)).toBe(true);
      expect(list.some((m) => m.id === 61)).toBe(false);
      expect(list[list.length - 1].id).toBe(64);
    });
  });

  describe("GET /api/search", () => {
    it("pages the named room with a before cursor, no skip, no repeat", async () => {
      const seen: number[] = [];
      let before: string | undefined;
      const sizes: number[] = [];
      for (let i = 0; i < 10; i++) {
        const params: Record<string, string> = { conversation: ops, q: "alpha", page: "1", limit: "20" };
        if (before) params.before = before;
        const p = (await get(A.baseUrl, "/api/search", params)).body as Page;
        sizes.push(p.results.length);
        seen.push(...ids(p));
        if (p.nextBefore === null) break;
        before = String(p.nextBefore);
      }
      expect(sizes).toEqual([20, 20, 20, 1]);
      expect(new Set(seen).size).toBe(61);
      expect(seen).not.toContain(61);
    });

    it("applies from:, @name, mentions:, a range and words", async () => {
      const q = async (text: string): Promise<number[]> => ids((await get(A.baseUrl, "/api/search", { conversation: ops, q: text, page: "1" })).body as Page);
      expect(await q("from:worf")).toEqual([64, 63]);
      expect(await q("@Odo")).toEqual([63]);
      expect(await q("mentions:all")).toEqual([64]);
      expect(await q("#10-12 alpha")).toEqual([12, 11, 10]);
      expect(await q("#12-10 alpha")).toEqual([12, 11, 10]);
      expect(await q("secret")).toEqual([]);
      expect(await q("for rami")).toEqual([62]);
    });

    it("searches the viewed room, not the active one", async () => {
      const p = (await get(A.baseUrl, "/api/search", { conversation: other, q: "bravo", page: "1" })).body as Page;
      expect(ids(p)).toEqual([5, 4, 3, 2, 1]);
      expect((await get(A.baseUrl, "/api/search", { conversation: "no-such-room", q: "alpha", page: "1" })).status).toBe(404);
      expect((await get(A.baseUrl, "/api/search", { conversation: "no-such-room", q: "alpha" })).body).toEqual([]);
    });

    it("answers the legacy array without page=1, and nothing for a blank query", async () => {
      const legacy = (await get(A.baseUrl, "/api/search", { q: "alpha" })).body as Array<{ message: ChatMessage }>;
      expect(Array.isArray(legacy)).toBe(true);
      expect(legacy.length).toBe(20);
      expect((await get(A.baseUrl, "/api/search", { conversation: ops, q: "  ", page: "1" })).body).toEqual({ results: [], nextBefore: null });
      expect((await get(A.baseUrl, "/api/search", { conversation: ops, q: "alpha", page: "1" }, null)).status).toBe(403);
    });
  });

  describe("a remote room on the linked server", () => {
    const mirror = () => B.links.get("alpha")!.getMirror(ops)!;

    it("holds the home's messages visible to this server, and reads them by id", async () => {
      const r = await get(B.baseUrl, "/api/message/63", { conversation: remote });
      expect(r.status).toBe(200);
      expect((r.body as ChatMessage).text).toBe("@Odo please check #12");
      // The home never sent the DM to Odo; the DM to Rami is here.
      expect((await get(B.baseUrl, "/api/message/61", { conversation: remote })).status).toBe(404);
      expect((await get(B.baseUrl, "/api/message/62", { conversation: remote })).status).toBe(200);
    });

    it("filters a cached DM for another local viewer, by id, in the window and in search", async () => {
      // A DM for a local member here is cached (the home sends what this
      // server's viewers may see); the human viewer must still not see it.
      const m = mirror();
      const cached = m.read(undefined, 1000, undefined, "Rami");
      m.fill({ server: "alpha", room: ops, name: "ops", members: [], cursor: 0, complete: true,
        messages: [...cached, { id: 65, sender: "Kira", text: "curzon only alpha", timestamp: Date.now(), to: ["Curzon"] }, { id: 66, sender: "Kira", text: "tail alpha", timestamp: Date.now() + 1 }] });
      expect((await get(B.baseUrl, "/api/message/65", { conversation: remote })).status).toBe(404);
      expect((await get(B.baseUrl, "/api/messages", { conversation: remote, around: "65" })).status).toBe(404);
      const w = (await get(B.baseUrl, "/api/messages", { conversation: remote, around: "66", limit: "3" })).body as Win;
      expect(w.messages.map((x) => x.id)).toEqual([63, 64, 66]);
      const p = (await get(B.baseUrl, "/api/search", { conversation: remote, q: "curzon", page: "1" })).body as Page;
      expect(p.results).toEqual([]);
      const tail = (await get(B.baseUrl, "/api/search", { conversation: remote, q: "alpha", page: "1", limit: "3" })).body as Page;
      expect(ids(tail)).toEqual([66, 62, 60]);
      expect(tail.coverage).toEqual({ complete: true, oldestId: 1 });
    });

    it("pages a mirror search and says when older history is not held", async () => {
      const m = mirror();
      // Drop the oldest cached messages, as a window-only cache would lack them.
      for (let id = 1; id < 40; id++) m.applyEvent({ seq: 0, type: "message-deleted", data: { id } });
      const cached = m.read(undefined, 1000, undefined, "Rami");
      m.fill({ server: "alpha", room: ops, name: "ops", members: [], cursor: 0, complete: false, messages: cached });
      const seen: number[] = [];
      let before: string | undefined;
      for (let i = 0; i < 10; i++) {
        const params: Record<string, string> = { conversation: remote, q: "alpha", page: "1", limit: "10" };
        if (before) params.before = before;
        const p = (await get(B.baseUrl, "/api/search", params)).body as Page;
        expect(p.coverage).toEqual({ complete: false, oldestId: 40 });
        seen.push(...ids(p));
        if (p.nextBefore === null) break;
        before = String(p.nextBefore);
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(Math.min(...seen)).toBe(40);
      expect(seen).not.toContain(65);
      const old = await get(B.baseUrl, "/api/message/12", { conversation: remote });
      expect(old.status).toBe(404);
      expect(old.body).toEqual({ error: "Message not found", reason: "older-than-cache", oldestId: 40 });
      const oldWin = await get(B.baseUrl, "/api/messages", { conversation: remote, around: "12" });
      expect(oldWin.body).toEqual({ error: "Message not found", reason: "older-than-cache", oldestId: 40 });
    });
  });
});

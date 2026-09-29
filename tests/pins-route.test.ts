/**
 * GET /api/pins?conversation= (redesign lane 2): the members and pins side
 * panel asks for the room on screen, which can differ from the server's
 * active room while a switch is in flight. The named room answers; an
 * unknown or empty name is a 404, never the active room in its place;
 * without the parameter the active room answers as before; hidden DMs stay
 * hidden; the web token is required.
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
import type { ChatMessage } from "../src/room.js";

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

interface Answer { status: number; body: unknown }

async function get(base: string, params: Record<string, string>, token: string | null = WEB): Promise<Answer> {
  const q = new URLSearchParams(params);
  if (token !== null) q.set("token", token);
  const res = await fetch(`${base}/api/pins?${q.toString()}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as unknown : null };
}

const pinnedIds = (a: Answer): number[] => (a.body as ChatMessage[]).map((m) => m.id).sort((x, y) => x - y);

describe("GET /api/pins?conversation=", { timeout: 30_000 }, () => {
  let dir: string;
  let S: JoindHandle;
  let ops: string, other: string;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "joind-pins-"));
    const port = await freePort();
    const cfg: JoindConfig = {
      port, host: "127.0.0.1", dataDir: join(dir, "data"), instance: "pins", crewHome: join(dir, "crew"),
      humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
      webToken: WEB, webTokenUserSet: true, links: [],
    };
    S = await startJoind(cfg);
    const reg = await fetch(`${S.baseUrl}/api/web/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: WEB, name: "Rami" }) });
    expect(reg.status).toBe(200);
    ops = S.manager.createConversation("ops").id;
    other = S.manager.createConversation("other").id;
    const a = S.manager.getRoom(ops)!;
    a.send("Kira", "ops one");               // 1
    a.send("Kira", "ops two");               // 2
    a.send("Kira", "for Odo only", { to: ["Odo"] }); // 3, hidden from Rami
    a.pinMessage(1, true);
    a.pinMessage(3, true);
    const b = S.manager.getRoom(other)!;
    b.send("Worf", "other one");             // 1
    b.send("Worf", "other two");             // 2
    b.pinMessage(2, true);
    S.manager.setActive(ops);
  }, 30_000);

  afterAll(async () => {
    await S?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("answers for the named room, not the active one", async () => {
    const r = await get(S.baseUrl, { conversation: other });
    expect(r.status).toBe(200);
    expect(pinnedIds(r)).toEqual([2]);
    expect((r.body as ChatMessage[])[0].text).toBe("other two");
  });

  it("without the parameter answers for the active room, hidden DMs left out", async () => {
    const r = await get(S.baseUrl, {});
    expect(r.status).toBe(200);
    expect(pinnedIds(r)).toEqual([1]);
    expect(pinnedIds(await get(S.baseUrl, { conversation: ops }))).toEqual([1]);
  });

  it("never falls back to the active room for an unknown or empty name", async () => {
    expect((await get(S.baseUrl, { conversation: "no-such-room" })).status).toBe(404);
    expect((await get(S.baseUrl, { conversation: "" })).status).toBe(404);
  });

  it("refuses without the web token", async () => {
    expect((await get(S.baseUrl, { conversation: ops }, null)).status).toBe(403);
    expect((await get(S.baseUrl, { conversation: ops }, "x".repeat(64))).status).toBe(403);
  });
});

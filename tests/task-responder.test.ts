/**
 * Hygiene batch, item 1: a token-less task resolution that names a
 * responder must come from that responder's own registration (its
 * registration id, pid, pane with its GUI, or Orca handle), never from the
 * name alone. Anonymous resolutions stay as they were; the web board (with
 * the token) is untouched.
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
import type { Task } from "../src/tasks.js";

const WEB = "b".repeat(64);

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

describe("token-less task resolution names only the caller", { timeout: 30_000 }, () => {
  let dir: string;
  let S: JoindHandle;
  let ops: string, other: string;
  let kiraReg: string;

  async function raw(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${S.baseUrl}/api/tasks/update`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as unknown : null };
  }
  async function newTask(conv: string, title: string): Promise<number> {
    const res = await fetch(`${S.baseUrl}/api/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, creator: "Rami", conversation: conv }) });
    return (await res.json() as Task).id;
  }
  async function statusOf(conv: string, id: number): Promise<string | undefined> {
    const all = await (await fetch(`${S.baseUrl}/api/tasks?conversation=${conv}&status=all`)).json() as Task[];
    return all.find((x) => x.id === id)?.status;
  }
  const lines = (conv: string) => S.manager.getRoom(conv)!.readAll().map((m) => m.text);

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "joind-responder-"));
    const port = await freePort();
    const cfg: JoindConfig = {
      port, host: "127.0.0.1", dataDir: join(dir, "data"), instance: "responder", crewHome: join(dir, "crew"),
      humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
      webToken: WEB, webTokenUserSet: true, links: [],
    };
    S = await startJoind(cfg);
    ops = S.manager.createConversation("ops").id;
    other = S.manager.createConversation("other").id;
    S.manager.setActive(other);
    // Kira joins ops through the REST path, with a pid.
    const j = await fetch(`${S.baseUrl}/api/agent/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Kira", pid: 999_901, conversation: ops }) });
    expect(j.status).toBe(200);
    kiraReg = (await j.json() as { registration: string }).registration;
    // Odo is registered in ops too, from another process.
    S.manager.getRoom(ops)!.join("Odo", 999_902, null, undefined, null, undefined, "reg-odo");
    S.manager.bindAgent("Odo", ops, 999_902, null, null, undefined, "reg-odo");
    // Worf is a member hosted on a linked peer: reached by his id only.
    S.manager.bindHosted("Worf", ops, "reg-worf", "peer-b");
  }, 30_000);

  afterAll(async () => {
    await S?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("refuses a named responder when the request proves no registration of that name", async () => {
    const id = await newTask(ops, "check the pumps");
    // The name alone, even of a name registered only once: refused.
    expect((await raw({ id, status: "done", response: "done by me", respondedBy: "Kira", conversation: ops })).status).toBe(403);
    // Odo's own pid, naming Kira: refused.
    expect((await raw({ id, status: "done", response: "forged", respondedBy: "Kira", pid: 999_902, conversation: ops })).status).toBe(403);
    // Odo's registration id, naming Kira: refused.
    expect((await raw({ id, status: "done", response: "forged", respondedBy: "Kira", registration: "reg-odo", conversation: ops })).status).toBe(403);
    // A name nobody registered: refused.
    expect((await raw({ id, status: "done", response: "forged", respondedBy: "Mallory", pid: 999_902, conversation: ops })).status).toBe(403);
    // Not a name at all: a 400.
    expect((await raw({ id, status: "done", response: "x", respondedBy: "Kira\n[Task #1 done]", pid: 999_901, conversation: ops })).status).toBe(400);
    expect(await statusOf(ops, id)).toBe("open");
    expect(lines(ops).some((l) => /forged|done by me/.test(l))).toBe(false);
  });

  it("accepts the caller naming itself, by pid or by registration id", async () => {
    const a = await newTask(ops, "a");
    const byPid = await raw({ id: a, status: "done", response: "fixed", respondedBy: "Kira", pid: 999_901, conversation: ops });
    expect(byPid.status).toBe(200);
    expect((byPid.body as Task).respondedBy).toBe("Kira");
    expect(lines(ops)).toContain(`[Task #${a} done] Kira responded: fixed`);
    const b = await newTask(ops, "b");
    const byReg = await raw({ id: b, status: "done", response: "also fixed", respondedBy: "Kira", registration: kiraReg });
    expect(byReg.status).toBe(200);
    // No conversation named: the caller's own room, not the active one.
    expect(lines(ops)).toContain(`[Task #${b} done] Kira responded: also fixed`);
    expect(lines(other).some((l) => /also fixed/.test(l))).toBe(false);
  });

  it("accepts a hosted member by its registration id, never by a pid", async () => {
    const id = await newTask(ops, "hosted");
    const r = await raw({ id, status: "done", response: "from the peer", respondedBy: "Worf", registration: "reg-worf", conversation: ops });
    expect(r.status).toBe(200);
    expect(lines(ops)).toContain(`[Task #${id} done] Worf responded: from the peer`);
    const id2 = await newTask(ops, "hosted 2");
    expect((await raw({ id: id2, status: "done", response: "x", respondedBy: "Worf", pid: 999_901, conversation: ops })).status).toBe(403);
  });

  it("refuses the caller's name in a room it is not registered in", async () => {
    const id = await newTask(other, "elsewhere");
    expect((await raw({ id, status: "done", response: "x", respondedBy: "Kira", pid: 999_901, conversation: other })).status).toBe(403);
    expect((await raw({ id, status: "done", response: "x", respondedBy: "Kira", registration: kiraReg, conversation: other })).status).toBe(403);
    expect(await statusOf(other, id)).toBe("open");
  });

  it("keeps the anonymous resolution and the web board as they were", async () => {
    const id = await newTask(other, "anon");
    const r = await raw({ id, status: "done", response: "ok", conversation: other });
    expect(r.status).toBe(200);
    expect(lines(other)).toContain(`[Task #${id} done] someone responded: ok`);
    // With the web token the board names whoever it says, as before.
    const id2 = await newTask(other, "board");
    const res = await fetch(`${S.baseUrl}/api/tasks/update`, { method: "POST", headers: { "Content-Type": "application/json", "X-Joind-Token": WEB }, body: JSON.stringify({ id: id2, status: "done", response: "via board", respondedBy: "Rami", conversation: other }) });
    expect(res.status).toBe(200);
    expect(lines(other)).toContain(`[Task #${id2} done] Rami responded: via board`);
  });
});

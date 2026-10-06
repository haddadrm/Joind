/**
 * Hygiene batch, item 2: a `conversation` parameter that is present but
 * empty (or blank, or not a string) names no room. It is a 404, never the
 * active room read or written in its place. Absent still means the active
 * room, as before.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";
import type { Task } from "../src/tasks.js";

const WEB = "c".repeat(64);

describe("an empty conversation names no room", { timeout: 30_000 }, () => {
  let dir: string;
  let S: JoindHandle;
  let active: string;

  async function get(path: string, q: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const url = `${S.baseUrl}${path}?${new URLSearchParams(q).toString()}`;
    const res = await fetch(url);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as unknown : null };
  }
  async function post(path: string, body: unknown, token = true): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${S.baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Joind-Token": WEB } : {}) }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as unknown : null };
  }
  const activeLines = () => S.manager.getRoom(active)!.readAll().map((m) => m.text);

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "joind-convparam-"));
    const cfg: JoindConfig = {
      port: 0, host: "127.0.0.1", dataDir: join(dir, "data"), instance: "convparam", crewHome: join(dir, "crew"),
      humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
      webToken: WEB, webTokenUserSet: true, links: [],
    };
    S = await startJoind(cfg);
    const reg = await fetch(`${S.baseUrl}/api/web/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: WEB, name: "Rami" }) });
    expect(reg.status).toBe(200);
    active = S.manager.createConversation("ops").id;
    S.manager.setActive(active);
    S.manager.getRoom(active)!.send("Rami", "active room secret");
    expect((await post("/api/tasks", { title: "active task", creator: "Rami" })).status).toBe(200);
    S.manager.getRoom(active)!.join("Kira", 999_911, null, undefined, null, undefined, "reg-kira");
    S.manager.bindAgent("Kira", active, 999_911, null, null, undefined, "reg-kira");
  }, 30_000);

  afterAll(async () => {
    await S?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("GET /api/messages: empty or blank is a 404, an unknown room is a 404, absent is the active room", async () => {
    for (const conversation of ["", "   "]) {
      const r = await get("/api/messages", { conversation, token: WEB });
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/active room secret/);
    }
    expect((await get("/api/messages", { conversation: "no-such-room", token: WEB })).status).toBe(404);
    const ok = await get("/api/messages", { token: WEB });
    expect(ok.status).toBe(200);
    expect((ok.body as Array<{ text: string }>).some((m) => m.text === "active room secret")).toBe(true);
    const named = await get("/api/messages", { conversation: active, token: WEB });
    expect((named.body as Array<{ text: string }>).some((m) => m.text === "active room secret")).toBe(true);
  });

  it("the task routes refuse an empty conversation", async () => {
    expect((await get("/api/tasks", { conversation: "" })).status).toBe(404);
    expect((await get("/api/tasks/count", { conversation: "" })).status).toBe(404);
    expect((await post("/api/tasks", { title: "stray", creator: "Rami", conversation: "" })).status).toBe(404);
    expect((await post("/api/tasks/update", { id: 1, status: "done", response: "x", conversation: "" }, false)).status).toBe(404);
    expect((await post("/api/tasks/update", { id: 1, status: "done", response: "x", conversation: "" })).status).toBe(404);
    const t = await get("/api/tasks", { status: "all" });
    expect((t.body as Task[]).map((x) => `${x.title}:${x.status}`)).toEqual(["active task:open"]);
  });

  it("send, resolve, leave and rename refuse an empty conversation", async () => {
    const before = activeLines().length;
    expect((await post("/api/send", { sender: "Rami", text: "stray", token: WEB, conversation: "" })).status).toBe(404);
    expect(activeLines().length).toBe(before);
    expect((await post("/api/message/1/resolve", { token: WEB, conversation: "" })).status).toBe(404);
    expect((await post("/api/leave", { name: "Kira", conversation: "" })).status).toBe(404);
    expect((await post("/api/leave", { name: "Kira", conversation: null })).status).toBe(404);
    expect((await post("/api/rename", { oldName: "Kira", newName: "Nerys", conversation: "" })).status).toBe(404);
    expect(S.manager.getRoom(active)!.getAgent("Kira")).toBeTruthy();
  });

  it("scratchpad and state refuse an empty conversation", async () => {
    expect((await get("/api/agent/scratchpad", { sender: "Kira", conversation: "" })).status).toBe(404);
    expect((await post("/api/agent/scratchpad", { sender: "Kira", notes: "n", conversation: "" }, false)).status).toBe(404);
    expect((await get("/api/state", { conversation: "" })).status).toBe(404);
    expect((await post("/api/state", { key: "k", value: "v", conversation: "" }, false)).status).toBe(404);
    const state = await get("/api/state", {});
    expect(state.body).toEqual({});
  });

  it("an agent join with an empty conversation joins nothing", async () => {
    const j = await post("/api/agent/join", { name: "Odo", pid: 999_912, conversation: "" }, false);
    expect(j.status).toBe(404);
    expect(S.manager.getRoom(active)!.getAgent("Odo")).toBeUndefined();
  });
});

/**
 * Redesign lane 4: the decisions page reads GET /api/decisions with
 * state=open|resolved|all (choices and the answer included) and answers
 * across rooms through POST /api/message/:id/choose with a named
 * conversation: the named room answers, never the active one in its
 * place; the viewer answers as themselves, only on messages they can see.
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

const WEB = "f".repeat(64);

interface Decision {
  conversationId: string; messageId: number; sender: string; text: string;
  ask: { for: string; state: string; resolvedBy?: string };
  choices?: string[]; choiceResponse?: { value: string; by: string };
}
interface Answer { status: number; body: unknown }

describe("decisions across rooms", { timeout: 30_000 }, () => {
  let dir: string;
  let S: JoindHandle;
  let ops: string, other: string;

  async function get(params: Record<string, string>, token: string | null = WEB): Promise<Answer> {
    const q = new URLSearchParams(params);
    if (token !== null) q.set("token", token);
    const res = await fetch(`${S.baseUrl}/api/decisions?${q.toString()}`);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as unknown : null };
  }
  async function choose(id: number, body: Record<string, unknown>): Promise<Answer> {
    const res = await fetch(`${S.baseUrl}/api/message/${id}/choose`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Joind-Token": WEB }, body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as unknown : null };
  }
  const list = (a: Answer): Decision[] => (a.body as { decisions: Decision[] }).decisions;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "joind-decisions-"));
    const cfg: JoindConfig = {
      port: 0, host: "127.0.0.1", dataDir: join(dir, "data"), instance: "decisions", crewHome: join(dir, "crew"),
      humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
      webToken: WEB, webTokenUserSet: true, links: [],
    };
    S = await startJoind(cfg);
    const reg = await fetch(`${S.baseUrl}/api/web/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: WEB, name: "Rami" }) });
    expect(reg.status).toBe(200);
    ops = S.manager.createConversation("ops").id;
    other = S.manager.createConversation("other").id;
    const a = S.manager.getRoom(ops)!;
    a.send("Kira", "Ship now?", { choices: ["Yes", "No"], askFor: "Rami" });           // 1, open, for Rami
    a.send("Kira", "Worf decides", { choices: ["A", "B"], askFor: "Worf" });            // 2, open, for Worf
    a.send("Kira", "Secret ask", { choices: ["X"], askFor: "Odo", to: ["Odo"] });       // 3, hidden from Rami
    const b = S.manager.getRoom(other)!;
    b.send("Worf", "Rename the room?", { choices: ["Keep", "Rename"], askFor: "Rami" }); // 1 in other
    b.send("Worf", "Old question", { choices: ["Done"], askFor: "Rami" });               // 2 in other
    b.resolveAsk(2, "Rami");
    S.manager.setActive(ops);
  }, 30_000);

  afterAll(async () => {
    await S?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("lists the viewer's open asks across rooms, with choices", async () => {
    const r = await get({ state: "open" });
    expect(r.status).toBe(200);
    const ds = list(r);
    expect(ds.map((d) => d.text).sort()).toEqual(["Rename the room?", "Ship now?"]);
    expect(ds.find((d) => d.text === "Ship now?")?.choices).toEqual(["Yes", "No"]);
  });

  it("lists everyone's open asks with an empty for, hidden DMs left out", async () => {
    const texts = list(await get({ state: "open", for: "" })).map((d) => d.text).sort();
    expect(texts).toEqual(["Rename the room?", "Ship now?", "Worf decides"]);
  });

  it("lists resolved asks, and all of them", async () => {
    expect(list(await get({ state: "resolved" })).map((d) => d.text)).toEqual(["Old question"]);
    expect(list(await get({ state: "all" })).map((d) => d.text).sort()).toEqual(["Old question", "Rename the room?", "Ship now?"]);
    // Anything else is the open list, as before.
    expect(list(await get({ state: "junk" })).length).toBe(2);
  });

  it("answers in a named room that is not the active one, as the viewer", async () => {
    const r = await choose(1, { value: "Rename", by: "Mallory", conversation: other });
    expect(r.status).toBe(200);
    expect((r.body as { choiceResponse: { value: string; by: string } }).choiceResponse).toMatchObject({ value: "Rename", by: "Rami" });
    // The active room's message 1 is untouched.
    expect(S.manager.getRoom(ops)!.getMessageById(1)?.choiceResponse).toBeUndefined();
    const after = list(await get({ state: "resolved" })).map((d) => d.text).sort();
    expect(after).toEqual(["Old question", "Rename the room?"]);
  });

  it("never falls back to the active room, and hides what the viewer cannot see", async () => {
    expect((await choose(1, { value: "Yes", conversation: "no-such-room" })).status).toBe(404);
    expect((await choose(1, { value: "Yes", conversation: "" })).status).toBe(404);
    expect((await choose(3, { value: "X", conversation: ops })).status).toBe(404);
    expect(S.manager.getRoom(ops)!.getMessageById(1)?.choiceResponse).toBeUndefined();
  });

  it("keeps the old active-room answer path", async () => {
    const r = await choose(1, { value: "Yes", by: "Rami" });
    expect(r.status).toBe(200);
    expect(S.manager.getRoom(ops)!.getMessageById(1)?.choiceResponse?.value).toBe("Yes");
  });

  it("refuses without the web token", async () => {
    expect((await get({ state: "open" }, null)).status).toBe(403);
    const res = await fetch(`${S.baseUrl}/api/message/2/choose`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "A", conversation: ops }) });
    expect(res.status).toBe(403);
  });
});

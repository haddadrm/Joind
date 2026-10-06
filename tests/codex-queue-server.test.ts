/**
 * codexThread through real servers: the REST join validates it strictly,
 * /api/who shows it, and a member joined on a host (B) for a room homed on A
 * is woken on B with the thread from B's own registration. The injector is
 * a recording fake: nothing here runs codex or types a key.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const injected: Array<{ pid: number; codexThread?: string; codexHome?: string; queueGuard: boolean }> = [];
const prompts: string[] = [];
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return {
    ...actual,
    inject: vi.fn(async (pid: number, prompt: string, _pane?: number, _exe?: string, _env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) => {
      prompts.push(prompt);
      injected.push({ pid, codexThread: options?.codexThread, codexHome: options?.codexHome, queueGuard: typeof options?.queueGuard === "function" });
    }),
  };
});
// Fake pids: nothing for the process enumeration a join runs to find.
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import { PeerRoutes } from "./peer-routes.js";
import type { JoindConfig } from "../src/config.js";
import type { FetchLike } from "../src/link.js";

const TOKEN = "link-token-for-tests-0123456789";
const WEB = "c".repeat(64);
const PID = 999_983;
const THREAD = "01a0e156-de0a-7bb0-909e-32d39d9b172f";

// Each server binds port 0; its link names the peer by a placeholder URL that
// resolves once the peer is up (tests/peer-routes.ts).
const routes = new PeerRoutes();
const fetchImpl: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, text: () => res.text() };
};
function config(dir: string, instance: string, peer: string): JoindConfig {
  return {
    port: 0, host: "127.0.0.1", dataDir: join(dir, "data"), instance, crewHome: join(dir, "crew"),
    humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
    webToken: WEB, webTokenUserSet: true,
    links: [{ name: peer, url: routes.url(peer), token: TOKEN }],
  };
}
async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 12_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
/** The read URL and the reply body a wake prompt tells the agent to use. */
function callbacks(prompt: string): { readQuery: string; replyBody: Record<string, unknown> } {
  const read = /Read: curl -s "([^"]+)"/.exec(prompt);
  const reply = /-d '(\{.*\})'$/.exec(prompt);
  if (!read || !reply) throw new Error(`no callbacks in: ${prompt}`);
  return { readQuery: new URL(read[1]).search, replyBody: JSON.parse(reply[1]) as Record<string, unknown> };
}
async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

describe("codexThread through the servers", { timeout: 20_000 }, () => {
  let dirA: string, dirB: string, home: string;
  let A: JoindHandle, B: JoindHandle;
  let room: string;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    dirA = mkdtempSync(join(tmpdir(), "joind-cq-a-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-cq-b-"));
    // A stand-in Codex home: an absolute directory with a sessions directory.
    home = join(dirB, "codex-home");
    mkdirSync(join(home, "sessions"), { recursive: true });
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 60_000, fetchImpl };
    A = await startJoind(config(dirA, "alpha", "bravo"), { link: { ...tuning, fetchImpl: routes.wrap() } });
    routes.set("alpha", A.baseUrl);
    B = await startJoind(config(dirB, "bravo", "alpha"), { link: { ...tuning, fetchImpl: routes.wrap() } });
    routes.set("bravo", B.baseUrl);
    room = A.manager.createConversation("ops").id;
  }, 30_000);

  afterAll(async () => {
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("the REST join refuses a session name, injection attempts, a non-string and a home without a thread", async () => {
    const bad: Array<Record<string, unknown>> = [
      { codexThread: "my-session" },
      { codexThread: `${THREAD} --message=evil` },
      { codexThread: `${THREAD}&calc` },
      { codexThread: "$(calc)" },
      { codexThread: 42 },
      { codexThread: THREAD, codexHome: "relative\\home" },
      { codexThread: THREAD, codexHome: join(dirB, "not-a-codex-home") },
      { codexHome: home },
    ];
    for (const extra of bad) {
      const r = await post(A.baseUrl, "/api/agent/join", { name: "Probe", pid: 999_981, conversation: room, ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect(A.manager.getRoom(room)!.getAgent("Probe")).toBeUndefined();
  });

  it("a local join stores the thread, answers it, and /api/who shows it; no room line names it", async () => {
    const local = A.manager.createConversation("local").id;
    A.manager.setActive(local);
    const r = await post(A.baseUrl, "/api/agent/join", { name: "Data", pid: 999_979, conversation: local, codexThread: THREAD.toUpperCase(), codexHome: home });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ codexThread: THREAD, codexHome: home });
    const who = await (await fetch(`${A.baseUrl}/api/who`)).json() as Array<{ name: string; codexThread?: string }>;
    expect(who.find((a) => a.name === "Data")?.codexThread).toBe(THREAD);
    expect(A.manager.getRoom(local)!.read(undefined, 50).some((m) => m.text.includes(THREAD))).toBe(false);
  });

  it("hosted: joined on B for A's room, a mention on A is woken on B with the thread and home of B's registration", async () => {
    const r = await post(B.baseUrl, "/api/agent/join", { name: "Curzon", pid: PID, conversation: `alpha:${room}`, codexThread: THREAD, codexHome: home });
    expect(r.status).toBe(200);
    const member = A.manager.getRoom(room)!.getAgent("Curzon")!;
    expect(member.host).toBe("bravo");
    injected.length = 0;
    const s = await post(A.baseUrl, "/api/send", { sender: "Rami", text: "@Curzon ping", token: WEB, conversation: room });
    expect(s.status).toBe(200);
    const call = await waitFor("B's injector", () => injected[0]);
    expect(call).toEqual({ pid: PID, codexThread: THREAD, codexHome: home, queueGuard: true });
    // Finding 3, hosted: both callbacks carry B's own registration (the one
    // B's join answered), never A's id for the hosted member, and resolve on B.
    const cb = callbacks(prompts[0]);
    expect(cb.readQuery).toContain(`&registration=${r.json.registration as string}`);
    expect(cb.replyBody.registration).toBe(r.json.registration);
    const read = await fetch(`${B.baseUrl}/api/agent/read${cb.readQuery}`);
    expect(read.status).toBe(200);
    const reply = await post(B.baseUrl, "/api/agent/send", { ...cb.replyBody, text: "hosted reply" });
    expect(reply.status).toBe(200);
  });

  // Codex review of b6da6f6, finding 2 (its probe, kept as is).
  it("REVIEW: a same-pid REST rejoin can disable the queue route", async () => {
    const local = A.manager.createConversation("opt-out").id;
    const base = { name: "ReviewOptOut", pid: 999975, conversation: local };
    await post(A.baseUrl, "/api/agent/join", { ...base, codexThread: THREAD, codexHome: home });
    const kept: Array<{ mode: string; thread: unknown }> = [];
    for (const [mode, extra] of [["omitted", {}], ["null", { codexThread: null }], ["empty", { codexThread: "" }]] as const) {
      const r = await post(A.baseUrl, "/api/agent/join", { ...base, ...extra });
      expect(r.status).toBe(200);
      kept.push({ mode, thread: r.json.codexThread });
    }
    expect(kept.some((x) => x.thread === undefined)).toBe(true);
  });

  it("finding 2, the contract: omitted and blank keep the thread, null clears thread and home, and the next wake is typed", async () => {
    const local = A.manager.createConversation("opt-out-contract").id;
    const base = { name: "OptOut", pid: 999_969, conversation: local };
    expect((await post(A.baseUrl, "/api/agent/join", { ...base, codexThread: THREAD, codexHome: home })).json).toMatchObject({ codexThread: THREAD, codexHome: home });
    expect((await post(A.baseUrl, "/api/agent/join", base)).json).toMatchObject({ codexThread: THREAD, codexHome: home });
    expect((await post(A.baseUrl, "/api/agent/join", { ...base, codexThread: "  " })).json).toMatchObject({ codexThread: THREAD, codexHome: home });
    const cleared = await post(A.baseUrl, "/api/agent/join", { ...base, codexThread: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json.codexThread).toBeUndefined();
    expect(cleared.json.codexHome).toBeUndefined();
    // A home with the clear is refused: a home needs a thread.
    expect((await post(A.baseUrl, "/api/agent/join", { ...base, codexThread: null, codexHome: home })).status).toBe(400);
    injected.length = 0;
    A.manager.getRoom(local)!.send("Rami", "@OptOut ping");
    const call = await waitFor("the injector", () => injected[0]);
    expect(call).toMatchObject({ pid: 999_969, codexThread: undefined, codexHome: undefined });
  });

  // Codex review of b6da6f6, finding 3 (its probe, kept, with the reply added).
  it("REVIEW: thread-only registrations receive a room-disambiguated callback", async () => {
    const one = A.manager.createConversation("callback-one").id;
    const two = A.manager.createConversation("callback-two").id;
    await post(A.baseUrl, "/api/agent/join", { name: "ReviewTwin", pid: 0, conversation: one, codexThread: THREAD, codexHome: home });
    await post(A.baseUrl, "/api/agent/join", { name: "ReviewTwin", pid: 0, conversation: two, codexThread: "0199aa11-2222-7333-8444-555566667777", codexHome: home });
    const r = A.manager.getRoom(one)!;
    const prompt = (r as unknown as { buildWakePrompt(sender: string, agent: unknown): string }).buildWakePrompt("Rami", r.getAgent("ReviewTwin"));
    const cb = callbacks(prompt);
    const result = await fetch(A.baseUrl + "/api/agent/read" + cb.readQuery);
    expect(result.status).toBe(200);
    const reply = await post(A.baseUrl, "/api/agent/send", { ...cb.replyBody, text: "twin reply" });
    expect(reply.status).toBe(200);
    // It landed in room one, the room whose prompt it was, not room two.
    expect(A.manager.getRoom(one)!.read(undefined, 50).some((m) => m.text === "twin reply")).toBe(true);
    expect(A.manager.getRoom(two)!.read(undefined, 50).some((m) => m.text === "twin reply")).toBe(false);
  });
});

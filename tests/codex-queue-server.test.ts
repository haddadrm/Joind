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
import { createServer } from "net";

const injected: Array<{ pid: number; codexThread?: string; codexHome?: string; queueGuard: boolean }> = [];
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return {
    ...actual,
    inject: vi.fn(async (pid: number, _prompt: string, _pane?: number, _exe?: string, _env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) => {
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
import type { JoindConfig } from "../src/config.js";
import type { FetchLike } from "../src/link.js";

const TOKEN = "link-token-for-tests-0123456789";
const WEB = "c".repeat(64);
const PID = 999_983;
const THREAD = "01a0e156-de0a-7bb0-909e-32d39d9b172f";

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
async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 12_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
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
    const [pa, pb] = [await freePort(), await freePort()];
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 60_000, fetchImpl };
    A = await startJoind(config(dirA, "alpha", pa, "bravo", pb), { link: tuning });
    B = await startJoind(config(dirB, "bravo", pb, "alpha", pa), { link: tuning });
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
  });
});

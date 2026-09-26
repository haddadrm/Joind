/**
 * Remote join latency (trace of 26 Sep 2026). On a Windows host with no
 * WezTerm GUI running, a pid-only join spent 1.6 to 4.4 s in the process
 * table query before its registration went to the home server, although no
 * pane could be bound. With no live WezTerm GUI and no pane requested, the
 * pane resolution now answers without the enumeration.
 *
 * The bound test runs two real servers in one process with a process table
 * that takes 3 s; it fails on master (df8f9d7), where every join waits it.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "net";

const table = { calls: 0, delayMs: 3_000, liveGui: false };
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: vi.fn(async () => undefined) };
});
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return {
    ...actual,
    // A slow process table, counted; the pid is in no WezTerm or Orca tree.
    processTreeOnce: () => {
      let p: Promise<Map<number, never>> | null = null;
      return () => (p ??= (table.calls++, new Promise((r) => setTimeout(() => r(new Map()), table.delayMs))));
    },
    anyLiveGuiSocket: () => table.liveGui,
  };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";
import { resolvePaneForJoin, type PaneResolverDeps } from "../src/tools.js";

const TOKEN = "latency-link-token-0123456789";
const WEB = "a".repeat(64);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); const port = typeof a === "object" && a ? a.port : 0; s.close(() => resolve(port)); });
  });
}

function config(dir: string, instance: string, port: number, peer: string, peerPort: number): JoindConfig {
  return {
    port, host: "127.0.0.1", dataDir: join(dir, "data"), instance, crewHome: join(dir, "crew"),
    humanNames: [], presenceGraceMs: 1_800_000, logFile: "none", webToken: WEB, webTokenUserSet: true,
    links: [{ name: peer, url: `http://127.0.0.1:${peerPort}`, token: TOKEN }],
  };
}

async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 5_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("pane resolution without a live WezTerm GUI", () => {
  const deps = (live: boolean, calls: { guiOf: number }): PaneResolverDeps => ({
    guiOf: async () => { calls.guiOf++; return false; },
    socketForGui: () => undefined,
    listPaneIds: async () => new Set(),
    autoDetect: async () => undefined,
    anyLiveGui: () => live,
    log: () => {},
  });

  it("a join naming no pane binds none and does not ask for the process's GUI", async () => {
    const calls = { guiOf: 0 };
    expect(await resolvePaneForJoin("A", 999_001, undefined, deps(false, calls))).toEqual({ paneId: null });
    expect(calls.guiOf).toBe(0);
  });

  it("with a live GUI, or a pane named, the process's GUI is still asked", async () => {
    const calls = { guiOf: 0 };
    await resolvePaneForJoin("A", 999_001, undefined, deps(true, calls));
    await resolvePaneForJoin("A", 999_001, 3, deps(false, calls));
    expect(calls.guiOf).toBe(2);
  });

  it("a live GUI is one whose gui-sock file is listed and whose pid is alive", async () => {
    const { anyLiveGuiSocket: realAnyLiveGuiSocket } = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
    const list = () => ["gui-sock-10", "gui-sock-20", "other"];
    expect(realAnyLiveGuiSocket({ dir: "/s", list, alive: (p) => p === 20 })).toBe(true);
    expect(realAnyLiveGuiSocket({ dir: "/s", list, alive: () => false })).toBe(false);
    expect(realAnyLiveGuiSocket({ dir: "/s", list: () => [], alive: () => true })).toBe(false);
  });
});

describe("a remote REST join with a real pid, no pane, no handle", { timeout: 20_000 }, () => {
  let dirA: string, dirB: string;
  let A: JoindHandle, B: JoindHandle;
  let room: string;

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), "joind-lat-a-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-lat-b-"));
    const [pa, pb] = [await freePort(), await freePort()];
    A = await startJoind(config(dirA, "alpha", pa, "bravo", pb));
    room = A.manager.createConversation("latency").id;
    B = await startJoind(config(dirB, "bravo", pb, "alpha", pa));
    await waitFor("B to mirror the room", () => B.manager.getRoom(`alpha:${room}`));
  }, 30_000);

  afterAll(async () => {
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
  });

  async function timedJoin(name: string, pid: number): Promise<{ status: number; ms: number }> {
    const t = Date.now();
    const res = await fetch(`${B.baseUrl}/api/agent/join`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, pid, conversation: `alpha:${room}` }),
    });
    await res.text();
    return { status: res.status, ms: Date.now() - t };
  }

  it("with no live WezTerm GUI it registers at the home without waiting for the process table", async () => {
    table.calls = 0; table.delayMs = 3_000; table.liveGui = false;
    const j = await timedJoin("Agent-fast", 999_011);
    expect(j.status).toBe(200);
    expect(j.ms).toBeLessThan(1_000);
    expect(table.calls).toBe(0);
    expect(A.manager.getRoom(room)!.getAgent("Agent-fast")?.host).toBe("bravo");
  });

  it("with a live WezTerm GUI the process table is still consulted (the pane may be auto-detected)", async () => {
    table.calls = 0; table.delayMs = 50; table.liveGui = true;
    const j = await timedJoin("Agent-wez", 999_013);
    expect(j.status).toBe(200);
    expect(table.calls).toBe(1);
  });
});

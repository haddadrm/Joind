import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveOrcaForJoin, type OrcaResolverDeps } from "../src/tools.js";
import { inject, WakeFallbackAborted, type InjectBackends } from "../src/inject.js";
import { injectOrca, type OrcaResult, type OrcaEnvelope } from "../src/orca.js";
import { ConversationManager } from "../src/manager.js";

// Codex gate round 1 on feat/orca-backend: one block per finding.
const H1 = "term_aaaaaaaa-0000-0000-0000-000000000001";
const H2 = "term_bbbbbbbb-0000-0000-0000-000000000002";

function withManager<T>(fn: (m: ConversationManager) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "joind-gate1-"));
  const manager = new ConversationManager(dir);
  return Promise.resolve(fn(manager)).finally(() => {
    for (const c of manager.listConversations()) manager.getRoom(c.id)?.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("finding 1: a rejoin cannot keep another session's Orca handle through a room registration", () => {
  it("clears H1 in room A when A is rejoined from a pid outside Orca after the binding moved to room B", async () => {
    await withManager(async (manager) => {
      const a = manager.createConversation("a");
      const b = manager.createConversation("b");
      const inside = new Set([100]);
      const ancestryAsked: number[] = [];
      const deps: OrcaResolverDeps = {
        listTerminals: async () => new Map([[H1, { connected: true, writable: true }]]),
        isInsideOrca: async (pid) => { ancestryAsked.push(pid); return inside.has(pid); },
        holdsHandle: (name) => manager.holdsOrcaTerminal(name),
        log: () => {},
      };
      // The join flow as the routes run it: resolve, then room.join and bindAgent.
      const joinVia = async (convId: string, pid: number, handle: string | undefined) => {
        const { orcaTerminal } = await resolveOrcaForJoin("C", pid, handle, deps);
        manager.getRoom(convId)!.join("C", pid, undefined, undefined, orcaTerminal);
        manager.bindAgent("C", convId, pid, undefined, orcaTerminal);
      };
      await joinVia(a.id, 100, H1);
      expect(manager.getRoom(a.id)!.getAgent("C")?.orcaTerminal).toBe(H1);
      await joinVia(b.id, 100, undefined); // binding moves to B and drops H1; room A keeps its registration
      expect(manager.getRoom(a.id)!.getAgent("C")?.orcaTerminal).toBe(H1);
      ancestryAsked.length = 0;
      await joinVia(a.id, 200, undefined); // a new session outside Orca
      expect(ancestryAsked).toEqual([200]);
      expect(manager.getRoom(a.id)!.getAgent("C")?.orcaTerminal).toBeUndefined();
    });
  });

  it("holdsOrcaTerminal sees a room registration even when no binding holds a handle", async () => {
    await withManager((manager) => {
      const a = manager.createConversation("a");
      manager.getRoom(a.id)!.join("C", 100, undefined, undefined, H1);
      expect(manager.holdsOrcaTerminal("C")).toBe(true);
      expect(manager.holdsOrcaTerminal("Nobody")).toBe(false);
    });
  });
});

describe("finding 2: Orca's internal retry asks the guard first", () => {
  const ambiguous: OrcaEnvelope = { ok: false, error: { code: "transport_error", message: "reset", data: { orchestrationRequestId: "req-9" } } };
  const accepted: OrcaEnvelope = { ok: true, result: { send: { accepted: true } } };
  const res = (json: OrcaEnvelope): OrcaResult => ({ json, code: json.ok ? 0 : 1, stdout: JSON.stringify(json), stderr: "" });

  function run(verdict: "proceed" | "skip" | "moved") {
    const calls: string[][] = [];
    const typed: number[] = [];
    let guardCalls = 0;
    const backends: InjectBackends = {
      orca: (h, t, o) => injectOrca(h, t, { ...o, run: async (args) => { calls.push(args); return res(calls.length === 1 ? ambiguous : accepted); } }),
      wezterm: async () => { throw new Error("not used"); },
      windows: async (p) => { typed.push(p); },
      unix: async (p) => { typed.push(p); },
      platform: "linux",
    };
    const done = inject(100, "hi", undefined, undefined, undefined, backends, {
      orcaTerminal: H1,
      fallbackGuard: () => { guardCalls++; return verdict; },
    });
    return { done, calls, typed, guard: () => guardCalls };
  }

  it("a target that left: no retry into the old handle, no console, WakeFallbackAborted(skip)", async () => {
    const r = run("skip");
    await expect(r.done).rejects.toMatchObject({ result: "skip" });
    await expect(r.done).rejects.toBeInstanceOf(WakeFallbackAborted);
    expect(r.calls).toHaveLength(1);
    expect(r.typed).toEqual([]);
    expect(r.guard()).toBe(1);
  });

  it("a target that moved (pid or handle replaced): no retry, WakeFallbackAborted(moved) so the room re-queues", async () => {
    const r = run("moved");
    await expect(r.done).rejects.toMatchObject({ result: "moved" });
    expect(r.calls).toHaveLength(1);
    expect(r.typed).toEqual([]);
  });

  it("a target that is still the same session: the retry goes out with Orca's retry id", async () => {
    const r = run("proceed");
    await r.done;
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]).toContain("req-9");
    expect(r.guard()).toBe(1);
  });
});

describe("finding 3: handle-only registrations route callbacks by handle", () => {
  it("getAgentBinding picks the room by handle when two terminals share a name and have no pid", async () => {
    await withManager((manager) => {
      const a = manager.createConversation("a");
      const b = manager.createConversation("b");
      manager.bindAgent("K", a.id, 0, undefined, H1);
      manager.bindAgent("K", b.id, 0, undefined, H2);
      expect(manager.getAgentBinding("K", undefined, undefined, H1)).toBe(a.id);
      expect(manager.getAgentBinding("K", undefined, undefined, H2)).toBe(b.id);
      expect(manager.getAgentConversationId("K", undefined, undefined, H2)).toBe(b.id);
      expect(manager.getAgentBinding("K")).toBeUndefined(); // ambiguous without it, as before
      // pid handling is unchanged for everyone else
      manager.bindAgent("P", a.id, 300);
      expect(manager.getAgentBinding("P", 300, undefined, H2)).toBe(a.id);
    });
  });

  it("every agent route that looks up a binding passes the handle from the request", () => {
    const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf-8");
    const calls = src.match(/agentRoom\((?:[^()]|\([^()]*\))*\)/g) ?? [];
    const routeCalls = calls.filter((c) => !c.startsWith("agentRoom(name: string"));
    expect(routeCalls.length).toBeGreaterThanOrEqual(10);
    // Every route passes the Orca handle, and the WezTerm GUI after it (a pane is a pair).
    for (const c of routeCalls) expect(c).toMatch(/orcaOf\(req\), weztermGuiOf\(req\)\)$/);
    const lookups = src.match(/manager\.getAgentBinding\(name, pid, paneId(?:[^()]|\([^()]*\))*\)/g) ?? [];
    for (const l of lookups) expect(l).toMatch(/orcaTerminal|orcaOf\(req\)/);
  });
});

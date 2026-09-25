import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Codex gate round 2 on feat/wezterm-submit (4938bc0): every finding came
// from a pane whose GUI was unknown sitting beside GUI-keyed panes. The fix
// makes the GUI part of every pane. One group per finding, each failing on
// 4938bc0 and passing now.

const state = { texts: [] as string[], names: [] as string[] };
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return {
    ...actual,
    inject: async (_pid: number, text: string) => { state.texts.push(text); },
  };
});

import { resolvePaneForJoin, claimedPaneNumbers, type PaneResolverDeps } from "../src/tools.js";
import { ChatRoom, terminalKeys } from "../src/room.js";
import { ConversationManager } from "../src/manager.js";

function deps(over: Partial<PaneResolverDeps> = {}): PaneResolverDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    guiOf: async (pid: number) => (pid === 200 ? 200 : pid === 100 ? 100 : "unknown"),
    socketForGui: (gui: number) => `/s/gui-sock-${gui}`,
    listPaneIds: async (socket: string) => { calls.push(`list ${socket}`); return new Set([0, 1]); },
    autoDetect: async (socket: string) => { calls.push(`autoDetect ${socket}`); return 1; },
    ensureExe: async () => true,
    log: () => {},
    // The dependencies 4938bc0 also read (a reachable default GUI, "inside some
    // WezTerm", no cached server socket), so the fails-before check runs that
    // commit's real code path instead of failing on a missing function.
    ...({ checkWezTerm: async () => true, isInsideWezTerm: async () => true, serverSocket: () => undefined } as object),
    ...over,
  };
}

describe("finding 1: a pane without its GUI is never bound, so it cannot slip past the lock of a GUI-keyed pane", () => {
  it("a pane-only join (no pid) binds no pane: its instance cannot be determined", async () => {
    const r = await resolvePaneForJoin("B", 0, 0, deps());
    expect(r.paneId).toBeNull();
    expect(r.note).toBe("pane 0 ignored for B: its WezTerm instance cannot be determined");
  });

  it("the room refuses a pane number without its GUI: no pane, no pane key", () => {
    const room = new ChatRoom();
    try {
      const b = room.join("B", 0, 0);
      expect(b.weztermPaneId).toBeUndefined();
      expect(terminalKeys(b)).toEqual(["pid:0"]);
      const a = room.join("A", 111, 0, undefined, undefined, 100);
      expect(terminalKeys(a)).toEqual(["pid:111", "pane:100:0"]);
    } finally { room.destroy(); }
  });
});

describe("finding 2: a known GUI whose socket is unavailable fails resolution, even on a fresh server", () => {
  it("GUI 200's socket is missing: the pane is dropped, and nothing is listed in any other GUI", async () => {
    const d = deps({ socketForGui: (g) => (g === 100 ? "/s/gui-sock-100" : undefined) });
    const r = await resolvePaneForJoin("A", 200, 0, d);
    expect(r.paneId).toBeNull();
    expect(r.note).toBe("pane 0 ignored for A: its WezTerm instance (gui pid 200) has no reachable socket");
    expect(d.calls).toEqual([]);
  });
});

describe("finding 3: a rejoin from another GUI never keeps the old GUI's pane", () => {
  it("resolution: the new GUI's socket is unavailable, so the pane is cleared (null), not kept", async () => {
    const r = await resolvePaneForJoin("A", 200, undefined, deps({ socketForGui: () => undefined }));
    expect(r.paneId).toBeNull();
  });

  it("the room: 'nothing learned' from GUI 200 keeps a pane only when it is in GUI 200", () => {
    const room = new ChatRoom();
    try {
      const a = room.join("A", 111, 0, undefined, undefined, 100);
      room.join("A", 222, undefined, undefined, undefined, 200);
      expect(a.weztermPaneId).toBeUndefined();
      expect(a.weztermGui).toBeUndefined();
      room.join("A", 222, 5, undefined, undefined, 200);
      room.join("A", 222, undefined, undefined, undefined, 200);
      expect(a.weztermPaneId).toBe(5);
      expect(a.weztermGui).toBe(200);
    } finally { room.destroy(); }
  });

  it("the manager binding follows the same rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g2-"));
    const manager = new ConversationManager(dir);
    try {
      const c = manager.createConversation("c");
      manager.bindAgent("A", c.id, 111, 0, undefined, 100);
      manager.bindAgent("A", c.id, 222, undefined, undefined, 200);
      // The old GUI's pane did not survive the rejoin from GUI 200: no pane alias at all.
      expect(manager.effectiveJoinAliases("A", c.id, 222, undefined).some((k) => k.startsWith("pane:"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("finding 4: auto-detection counts only the claims made in the same GUI", () => {
  it("GUI 100's claimed pane 0 does not hide GUI 200's pane 0", () => {
    const agents = [{ weztermPaneId: 0, weztermGui: 100 }, { weztermPaneId: 3, weztermGui: 200 }, { weztermPaneId: 5 }];
    expect([...claimedPaneNumbers(agents, 200)]).toEqual([3]);
    expect([...claimedPaneNumbers(agents, 100)]).toEqual([0]);
  });
});

describe("finding 5: bindings and callbacks carry the pair (GUI, pane); a bare pane number identifies nothing", () => {
  let dir = "";
  let manager: ConversationManager;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "joind-g2-")); manager = new ConversationManager(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("the same name in two rooms, each in pane 0 of a different GUI, keeps two bindings and resolves by the pair", () => {
    const x = manager.createConversation("x");
    const y = manager.createConversation("y");
    manager.bindAgent("Codex", x.id, 111, 0, undefined, 100);
    manager.bindAgent("Codex", y.id, 222, 0, undefined, 200);
    expect(manager.getAgentBinding("Codex", undefined, 0, undefined, 100)).toBe(x.id);
    expect(manager.getAgentBinding("Codex", undefined, 0, undefined, 200)).toBe(y.id);
    // A bare pane number names neither: with two bindings the lookup is ambiguous.
    expect(manager.getAgentBinding("Codex", undefined, 0)).toBeUndefined();
    // Join freshness aliases are the pairs too.
    expect(ConversationManager.joinTerminalKeys(111, 0, undefined, 100)).toEqual(["pid:111", "pane:100:0"]);
  });

  it("the wake prompt names the pane with its GUI in the read URL and in the reply body", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const room = new ChatRoom();
    try {
      state.texts = [];
      room.join("Codex", 111, 0, undefined, undefined, 100);
      room.send("Rami", "@Codex ping");
      await vi.advanceTimersByTimeAsync(2500);
      for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
      expect(state.texts).toHaveLength(1);
      expect(state.texts[0]).toContain("&paneId=0&weztermGui=100");
      expect(state.texts[0]).toContain('"paneId":0,"weztermGui":100');
    } finally {
      await vi.advanceTimersByTimeAsync(1000);
      room.destroy();
      vi.useRealTimers();
    }
  });

  it("the REST read route resolves the binding with the GUI from the request (query or body)", () => {
    const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf-8");
    const read = src.slice(src.indexOf('app.get("/api/agent/read"'), src.indexOf('app.post("/api/agent/send"'));
    expect(read).toMatch(/agentRoom\(sender, res, pid, paneId, orcaOf\(req\), weztermGuiOf\(req\)\)/);
    const helper = src.slice(src.indexOf("function agentRoom("), src.indexOf("function agentRoom(") + 600);
    expect(helper).toMatch(/manager\.getAgentBinding\(name, pid, paneId, orcaTerminal, weztermGui\)/);
    // Both REST join replies hand the agent its GUI, so it can send the pair back.
    expect(src.match(/weztermGui: agent\.weztermGui/g) ?? []).toHaveLength(2);
  });
});

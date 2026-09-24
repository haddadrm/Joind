import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { resolvePaneForJoin, type PaneResolverDeps } from "../src/tools.js";
import { isInsideWezTermTree, parseCimDate, parseEtime, parseProcessTable, type ProcessEntry } from "../src/terminals.js";
import { inject, WakeFallbackAborted } from "../src/inject.js";
import { ChatRoom } from "../src/room.js";
import { ConversationManager } from "../src/manager.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

function deps(over: Partial<PaneResolverDeps> = {}): PaneResolverDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    checkWezTerm: async () => true,
    listPaneIds: async () => new Set([0, 3]),
    isInsideWezTerm: async (pid) => pid === 100,
    autoDetect: async () => 3,
    log: (l) => lines.push(l),
    lines,
    ...over,
  };
}

describe("resolvePaneForJoin", () => {
  it("accepts a live pane for a pid that runs inside WezTerm", async () => {
    const d = deps();
    expect(await resolvePaneForJoin("A", 100, 3, d)).toEqual({ paneId: 3 });
    expect(d.lines).toEqual([]);
  });

  it("rejects (null, so the stores clear it) a pane the joining process does not own: pane 0 from a WMI-started agent", async () => {
    const d = deps();
    const r = await resolvePaneForJoin("Claude", 32512, 0, d);
    expect(r.paneId).toBeNull();
    expect(r.note).toMatch(/pid 32512 does not run inside WezTerm/);
    expect(d.lines).toHaveLength(1);
  });

  it("rejects a pane that is not live and one offered when no WezTerm is reachable", async () => {
    const a = await resolvePaneForJoin("A", 100, 9, deps());
    expect(a.paneId).toBeNull(); expect(a.note).toMatch(/not a live WezTerm pane/);
    const b = await resolvePaneForJoin("A", 100, 3, deps({ checkWezTerm: async () => false }));
    expect(b.paneId).toBeNull(); expect(b.note).toMatch(/no WezTerm reachable/);
    // Nothing requested and nothing reachable: nothing learned, keep whatever was held.
    expect((await resolvePaneForJoin("A", 100, undefined, deps({ checkWezTerm: async () => false }))).paneId).toBeUndefined();
  });

  it("auto-detects only for a process inside WezTerm or pid-less; a pid provably elsewhere clears any old pane", async () => {
    expect((await resolvePaneForJoin("A", 100, undefined, deps())).paneId).toBe(3);
    expect((await resolvePaneForJoin("A", 0, undefined, deps())).paneId).toBe(3);
    expect((await resolvePaneForJoin("A", 555, undefined, deps())).paneId).toBeNull();
  });

  it("treats unverifiable ancestry as unknown: a requested live pane is kept with a note, nothing is auto-detected", async () => {
    const d = deps({ isInsideWezTerm: async () => "unknown" });
    expect((await resolvePaneForJoin("A", 100, 3, d)).paneId).toBe(3);
    expect(d.lines[0]).toMatch(/unverified/);
    expect((await resolvePaneForJoin("A", 100, undefined, d)).paneId).toBeUndefined();
  });
});

describe("join generations (manager-level: name+terminal across rooms, room+name across terminals)", () => {
  it("refuses a waited join after a newer one for the same terminal anywhere, or the same room from any terminal, or a departure", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-gen-"));
    const manager = new ConversationManager(dir);
    try {
      const x = manager.createConversation("x");
      const y = manager.createConversation("y");
      expect(ConversationManager.joinTerminalKeys(100, 7)).toEqual(["pid:100", "pane:7"]);
      expect(ConversationManager.joinTerminalKeys(0, 7)).toEqual(["pane:7"]);
      expect(ConversationManager.joinTerminalKeys(undefined, undefined)).toEqual(["pid:0"]);
      // Older join into X, newer join for the same terminal into Y: X is stale.
      const intoX = manager.beginJoin("Claude", ["pid:100"], x.id);
      const intoY = manager.beginJoin("Claude", ["pid:100"], y.id);
      expect(manager.joinIsCurrent(intoY)).toBe(true);
      expect(manager.joinIsCurrent(intoX)).toBe(false);
      // Round-9 case: a different terminal joining the SAME room supersedes the older one there.
      const oldTerm = manager.beginJoin("Claude", ["pid:100"], x.id);
      const newTerm = manager.beginJoin("Claude", ["pid:200"], x.id);
      expect(manager.joinIsCurrent(newTerm)).toBe(true);
      expect(manager.joinIsCurrent(oldTerm)).toBe(false);
      // Control: a different terminal joining a DIFFERENT room leaves a pending join alone.
      const pendingX = manager.beginJoin("Claude", ["pid:300"], x.id);
      const otherY = manager.beginJoin("Claude", ["pid:400"], y.id);
      expect(manager.joinIsCurrent(pendingX)).toBe(true);
      expect(manager.joinIsCurrent(otherY)).toBe(true);
      // Round-10 case: a join carrying pid AND pane is superseded by a newer join sharing only the pane.
      const withBoth = manager.beginJoin("Claude", ["pid:500", "pane:7"], x.id);
      const paneOnlyY = manager.beginJoin("Claude", ["pane:7"], y.id);
      expect(manager.joinIsCurrent(paneOnlyY)).toBe(true);
      expect(manager.joinIsCurrent(withBoth)).toBe(false);
      const withBoth2 = manager.beginJoin("Claude", ["pid:600", "pane:8"], x.id);
      const otherPidSamePane = manager.beginJoin("Claude", ["pid:700", "pane:8"], y.id);
      expect(manager.joinIsCurrent(otherPidSamePane)).toBe(true);
      expect(manager.joinIsCurrent(withBoth2)).toBe(false);
      // A departure for the name (even with no binding yet) ends every pending join for it.
      manager.supersedeJoins("Claude");
      expect(manager.joinIsCurrent(pendingX)).toBe(false);
      expect(manager.joinIsCurrent(otherY)).toBe(false);
      // A room-level leave reaches the manager through the room event; applying a join does not supersede itself.
      const tok = manager.beginJoin("Claude", ["pid:100", "pane:7"], x.id);
      const room = manager.getRoom(x.id)!;
      room.join("Claude", 100, 7);
      expect(manager.joinIsCurrent(tok)).toBe(true);
      room.leave("Claude");
      expect(manager.joinIsCurrent(tok)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a rejected pane does not survive a rejoin", () => {
  it("ChatRoom.join clears the pane on null and keeps it on undefined", () => {
    const room = new ChatRoom();
    try {
      room.join("Claude", 100, 7);
      expect(room.getAgent("Claude")!.weztermPaneId).toBe(7);
      room.join("Claude", 100, undefined);
      expect(room.getAgent("Claude")!.weztermPaneId).toBe(7);
      room.join("Claude", 200, null);
      expect(room.getAgent("Claude")!.weztermPaneId).toBeUndefined();
    } finally {
      room.destroy();
    }
  });

  it("ConversationManager.bindAgent clears the pane on null and keeps it on undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-wez-"));
    const manager = new ConversationManager(dir);
    try {
      const a = manager.createConversation("a");
      const b = manager.createConversation("b");
      manager.bindAgent("Claude", a.id, 100, 7);
      manager.bindAgent("Claude", b.id, 300);
      expect(manager.getAgentBinding("Claude", undefined, 7)).toBe(a.id);
      manager.bindAgent("Claude", a.id, 100, undefined);
      expect(manager.getAgentBinding("Claude", undefined, 7)).toBe(a.id);
      manager.bindAgent("Claude", a.id, 200, null);
      expect(manager.getAgentBinding("Claude", undefined, 7)).toBeUndefined();
      expect(manager.getAgentBinding("Claude", 200)).toBe(a.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isInsideWezTermTree", () => {
  const t0 = Date.UTC(2026, 8, 24, 4, 0, 0);
  const tree = new Map<number, ProcessEntry>([
    [17280, { ppid: 11324, name: "wezterm-gui.exe", started: t0 }],
    [11324, { ppid: 1, name: "explorer.exe", started: t0 - 60_000 }],
    [5000, { ppid: 17280, name: "pwsh.exe", started: t0 + 1000 }],
    [5001, { ppid: 5000, name: "claude.exe", started: t0 + 2000 }],
    [32512, { ppid: 71580, name: "claude.exe", started: t0 + 5000 }],
    [71580, { ppid: 7368, name: "claude.exe", started: t0 + 5000 }],
    [7368, { ppid: 1552, name: "WmiPrvSE.exe", started: t0 - 100_000 }],
    [1552, { ppid: 1368, name: "svchost.exe", started: t0 - 200_000 }],
    [1368, { ppid: 1368, name: "services.exe", started: t0 - 300_000 }],
    // macOS: ps prints the full executable path for comm
    [9000, { ppid: 1, name: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui", started: t0 }],
    [9001, { ppid: 9000, name: "/bin/zsh", started: t0 + 1000 }],
    [9002, { ppid: 9001, name: "claude", started: t0 + 2000 }],
    // pid reuse: the recorded parent 4000 is a WezTerm that started AFTER the child
    [4000, { ppid: 1, name: "wezterm-gui.exe", started: t0 + 50_000 }],
    [4001, { ppid: 4000, name: "claude.exe", started: t0 + 3000 }],
  ]);
  it("finds a WezTerm ancestor and rejects processes started elsewhere or unknown here", () => {
    expect(isInsideWezTermTree(5001, tree)).toBe(true);
    expect(isInsideWezTermTree(32512, tree)).toBe(false); // WMI-started, no terminal
    expect(isInsideWezTermTree(424242, tree)).toBe(false); // remote agent's pid
    expect(isInsideWezTermTree(0, tree)).toBe(false);
  });
  it("matches WezTerm by executable basename (macOS full paths) and refuses a recycled parent pid", () => {
    expect(isInsideWezTermTree(9002, tree)).toBe(true);
    expect(isInsideWezTermTree(4001, tree)).toBe(false);
  });
  it("is precision-aware: 1 ms later is recycled on WMI clocks, inside a second is unknown on etime clocks, missing times are unknown", () => {
    const wmi = new Map<number, ProcessEntry>([
      [1, { ppid: 0, name: "wezterm-gui.exe", started: t0 + 1, startedPrecisionMs: 1 }],
      [2, { ppid: 1, name: "claude.exe", started: t0, startedPrecisionMs: 1 }],
    ]);
    expect(isInsideWezTermTree(2, wmi)).toBe(false);
    const ps = new Map<number, ProcessEntry>([
      [1, { ppid: 0, name: "wezterm-gui", started: t0 + 500, startedPrecisionMs: 1000 }],
      [2, { ppid: 1, name: "claude", started: t0, startedPrecisionMs: 1000 }],
      [3, { ppid: 1, name: "claude", started: t0 + 2000, startedPrecisionMs: 1000 }],
    ]);
    expect(isInsideWezTermTree(2, ps)).toBe("unknown");
    expect(isInsideWezTermTree(3, ps)).toBe(true);
    const missing = new Map<number, ProcessEntry>([
      [1, { ppid: 0, name: "wezterm-gui.exe" }],
      [2, { ppid: 1, name: "claude.exe", started: t0 }],
      [3, { ppid: 999, name: "claude.exe", started: t0 }], // parent exited: unverifiable, not disproved
    ]);
    expect(isInsideWezTermTree(2, missing)).toBe("unknown");
    expect(isInsideWezTermTree(3, missing)).toBe("unknown");
    expect(isInsideWezTermTree(999, missing)).toBe(false); // the joining pid itself is absent
  });
  it("parses WMI creation dates, ps etime, and the PowerShell process table with separators in names", () => {
    expect(parseCimDate("20260924085113.123456+240")).toBe(Date.UTC(2026, 8, 24, 8, 51, 13, 123) - 240 * 60_000);
    expect(parseCimDate("garbage")).toBeUndefined();
    expect(parseCimDate(undefined)).toBeUndefined();
    expect(parseEtime("05:07")).toBe(307);
    expect(parseEtime("1:02:03")).toBe(3723);
    expect(parseEtime("2-01:00:00")).toBe(2 * 86400 + 3600);
    expect(parseEtime("nope")).toBeUndefined();
    const t1 = Date.UTC(2026, 8, 24, 4, 51, 13, 123);
    const listed = parseProcessTable([
      "",
      `5001|17280|${t1}|claude,agent|weird.exe`,
      `17280|11324|${t1 - 120_000}|wezterm-gui.exe`,
      "0|0||System Idle Process",
      "9|4||no-start.exe",
      "",
    ].join("\r\n"));
    expect(listed.get(5001)).toMatchObject({ ppid: 17280, name: "claude,agent|weird.exe", started: t1, startedPrecisionMs: 1 });
    expect(listed.get(9)!.started).toBeUndefined();
    expect(listed.has(0)).toBe(false);
    expect(isInsideWezTermTree(5001, listed)).toBe(true);
  });
});

describe("inject fallback", () => {
  it("falls back to console injection when the WezTerm pane fails and a pid is known", async () => {
    const calls: string[] = [];
    await inject(4242, "hello", 0, undefined, undefined, {
      wezterm: async () => { calls.push("wezterm"); throw new Error("failed to connect to Socket(gui-sock-1)"); },
      windows: async (pid) => { calls.push(`windows:${pid}`); },
      unix: async (pid) => { calls.push(`unix:${pid}`); },
      platform: "win32",
    });
    expect(calls).toEqual(["wezterm", "windows:4242"]);
  });

  it("reports the WezTerm error, not the fallback's, when both paths fail (keeps the retry decision honest)", async () => {
    await expect(inject(4242, "hello", 0, undefined, undefined, {
      wezterm: async () => { throw new Error("failed to connect to Socket(gui-sock-1)"); },
      windows: async () => {},
      unix: async () => { throw new Error("Unix injection failed: PID 4242 not found in any tmux pane"); },
      platform: "linux",
    })).rejects.toThrow(/failed to connect to Socket/);
  });

  it("asks the caller before falling back and aborts with skip or moved when the target changed", async () => {
    const calls: string[] = [];
    const backends = {
      wezterm: async () => { throw new Error("failed to connect to Socket(gui-sock-1)"); },
      windows: async (pid: number) => { calls.push(`windows:${pid}`); },
      unix: async () => {},
      platform: "win32" as const,
    };
    await expect(inject(100, "hi", 0, undefined, undefined, backends, { fallbackGuard: () => "skip" }))
      .rejects.toBeInstanceOf(WakeFallbackAborted);
    const moved = await inject(100, "hi", 0, undefined, undefined, backends, { fallbackGuard: () => "moved" }).catch((e) => e);
    expect(moved).toBeInstanceOf(WakeFallbackAborted);
    expect((moved as WakeFallbackAborted).result).toBe("moved");
    expect(calls).toEqual([]);
    await inject(100, "hi", 0, undefined, undefined, backends, { fallbackGuard: () => "proceed" });
    expect(calls).toEqual(["windows:100"]);
  });

  it("re-asks the guard right before typing, on the direct console path too", async () => {
    const calls: string[] = [];
    const verdicts: Array<"proceed" | "skip"> = ["proceed", "skip"];
    const backends = {
      wezterm: async () => { throw new Error("failed to connect to Socket(gui-sock-1)"); },
      windows: async (pid: number) => { calls.push(`windows:${pid}`); },
      unix: async (pid: number) => { calls.push(`unix:${pid}`); },
      platform: "linux" as const,
    };
    // Fallback path: the guard passes once (before fallback) and refuses at the last check.
    const aborted = await inject(100, "hi", 0, undefined, undefined, backends, { fallbackGuard: () => verdicts.shift() ?? "skip" }).catch((e) => e);
    expect(aborted).toBeInstanceOf(WakeFallbackAborted);
    expect(calls).toEqual([]);
    // Direct console path (no pane): the guard is consulted before the backend as well.
    const direct = await inject(100, "hi", undefined, undefined, undefined, backends, { fallbackGuard: () => "moved" }).catch((e) => e);
    expect(direct).toBeInstanceOf(WakeFallbackAborted);
    expect((direct as WakeFallbackAborted).result).toBe("moved");
    expect(calls).toEqual([]);
    await inject(100, "hi", undefined, undefined, undefined, backends, { fallbackGuard: () => "proceed" });
    expect(calls).toEqual(["unix:100"]);
  });

  it("hands the guard to the Unix backend so tmux discovery cannot outlive the target", async () => {
    const calls: string[] = [];
    let verdict: "proceed" | "skip" = "proceed";
    const backends = {
      wezterm: async () => { throw new Error("failed to connect to Socket(gui-sock-1)"); },
      windows: async () => {},
      unix: async (pid: number, _text: string, guard?: () => void) => {
        verdict = "skip";   // the target leaves during tmux discovery
        guard?.();          // the backend re-asks before send-keys
        calls.push(`unix:${pid}`);
      },
      platform: "linux" as const,
    };
    const out = await inject(100, "hi", 0, undefined, undefined, backends, { fallbackGuard: () => verdict }).catch((e) => e);
    expect(out).toBeInstanceOf(WakeFallbackAborted);
    expect(calls).toEqual([]);
  });

  it("surfaces the WezTerm failure when there is no pid to fall back to", async () => {
    await expect(inject(0, "hello", 0, undefined, undefined, {
      wezterm: async () => { throw new Error("wezterm send-text exit 1"); },
      windows: async () => {},
      unix: async () => {},
      platform: "win32",
    })).rejects.toThrow(/send-text exit 1/);
  });
});

describe("wezterm cli invocations", () => {
  it("never auto-start a mux server, except the deliberate spawn used for launches", () => {
    const dir = join(__dirname, "..", "src");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf-8");
      const re = /\["cli",\s*("[^"]+")/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (m[1] !== '"--no-auto-start"' && m[1] !== '"spawn"') offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

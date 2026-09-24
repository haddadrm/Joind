import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { resolvePaneForJoin, type PaneResolverDeps } from "../src/tools.js";
import { isInsideWezTermTree } from "../src/terminals.js";
import { inject } from "../src/inject.js";

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

  it("drops a pane the joining process does not own (field case: pane 0 from a WMI-started agent)", async () => {
    const d = deps();
    const r = await resolvePaneForJoin("Claude", 32512, 0, d);
    expect(r.paneId).toBeUndefined();
    expect(r.note).toMatch(/pid 32512 does not run inside WezTerm/);
    expect(d.lines).toHaveLength(1);
  });

  it("drops a pane that is not live and one offered when no WezTerm is reachable", async () => {
    expect((await resolvePaneForJoin("A", 100, 9, deps())).note).toMatch(/not a live WezTerm pane/);
    expect((await resolvePaneForJoin("A", 100, 3, deps({ checkWezTerm: async () => false }))).note).toMatch(/no WezTerm reachable/);
  });

  it("auto-detects only for a process inside WezTerm or an unknown one, never for a pid that is elsewhere", async () => {
    expect((await resolvePaneForJoin("A", 100, undefined, deps())).paneId).toBe(3);
    expect((await resolvePaneForJoin("A", 0, undefined, deps())).paneId).toBe(3);
    expect((await resolvePaneForJoin("A", 555, undefined, deps())).paneId).toBeUndefined();
  });
});

describe("isInsideWezTermTree", () => {
  const tree = new Map<number, { ppid: number; name: string }>([
    [17280, { ppid: 11324, name: "wezterm-gui.exe" }],
    [11324, { ppid: 1, name: "explorer.exe" }],
    [5000, { ppid: 17280, name: "pwsh.exe" }],
    [5001, { ppid: 5000, name: "claude.exe" }],
    [32512, { ppid: 71580, name: "claude.exe" }],
    [71580, { ppid: 7368, name: "claude.exe" }],
    [7368, { ppid: 1552, name: "WmiPrvSE.exe" }],
    [1552, { ppid: 1368, name: "svchost.exe" }],
    [1368, { ppid: 1368, name: "services.exe" }],
  ]);
  it("finds a WezTerm ancestor and rejects processes started elsewhere or unknown here", () => {
    expect(isInsideWezTermTree(5001, tree)).toBe(true);
    expect(isInsideWezTermTree(32512, tree)).toBe(false); // WMI-started, no terminal
    expect(isInsideWezTermTree(424242, tree)).toBe(false); // remote agent's pid
    expect(isInsideWezTermTree(0, tree)).toBe(false);
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

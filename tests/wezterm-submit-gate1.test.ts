import { describe, it, expect } from "vitest";
import { inject, type InjectBackends } from "../src/inject.js";
import { DEFAULT_PLAN } from "../src/target.js";
import { resolveWezTermExe, resetWezTermExe, getWeztermPath, weztermEnvForGui } from "../src/terminals.js";
import { resolvePaneForJoin, type PaneResolverDeps } from "../src/tools.js";
import { terminalKeys, terminalIdentity, lockKeysFor } from "../src/room.js";

// Codex gate round 1 on feat/wezterm-submit (dd7deef): one group per
// finding, each failing on dd7deef and passing now.

describe("finding 1: a known GUI that is gone fails the WezTerm route, never another GUI's socket", () => {
  const backends = (calls: string[], socket: (gui: number) => string | undefined): InjectBackends => ({
    wezterm: async (pane, _t, _e, env) => { calls.push(`wezterm pane ${pane} via ${env?.WEZTERM_UNIX_SOCKET ?? "default"}`); },
    windows: async (pid) => { calls.push(`console ${pid}`); },
    unix: async (pid) => { calls.push(`console ${pid}`); },
    platform: "win32",
    classify: async () => DEFAULT_PLAN,
    weztermSocket: socket,
  });

  it("GUI 60924 is gone: no WezTerm send at all, the guarded console fallback runs", async () => {
    const calls: string[] = [];
    await inject(100, "ping", 0, undefined, { WEZTERM_UNIX_SOCKET: "/s/gui-sock-69000" }, backends(calls, () => undefined), {
      weztermGui: 60924, fallbackGuard: () => "proceed",
    });
    expect(calls).toEqual(["console 100"]);
  });

  it("GUI 60924 is alive: the pane goes through ITS socket, whatever default the caller passed", async () => {
    const calls: string[] = [];
    await inject(100, "ping", 0, undefined, { WEZTERM_UNIX_SOCKET: "/s/gui-sock-69000" }, backends(calls, (g) => `/s/gui-sock-${g}`), {
      weztermGui: 60924, fallbackGuard: () => "proceed",
    });
    expect(calls).toEqual(["wezterm pane 0 via /s/gui-sock-60924"]);
  });

  it("the tab-title environment for a gone GUI is null (skip), never the server's socket", () => {
    // pid 1 is never a wezterm-gui we listed: no socket for it.
    expect(weztermEnvForGui(999999999)).toBeNull();
  });
});

function deps(over: Partial<PaneResolverDeps>): PaneResolverDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listPaneIds: async (socket: string) => { calls.push(`list ${socket}`); return new Set([0, 7]); },
    autoDetect: async (socket: string) => { calls.push(`autoDetect ${socket}`); return 7; },
    guiOf: async () => 200,
    socketForGui: (gui: number) => `/s/gui-sock-${gui}`,
    ensureExe: async () => { calls.push("ensureExe"); return true; },
    log: () => {},
    ...over,
  };
}

describe("finding 2: auto-detection runs in the agent's own GUI and never stamps another GUI's pane", () => {
  it("agent in GUI 200: discovery lists GUI 200's socket, and the detected pane carries GUI 200", async () => {
    const d = deps({});
    const r = await resolvePaneForJoin("A", 4242, undefined, d);
    expect(r).toEqual({ paneId: 7, gui: 200 });
    expect(d.calls).toContain("autoDetect /s/gui-sock-200");
    expect(d.calls).not.toContain("autoDetect default");
  });

  it("agent in GUI 200 whose socket is unavailable: no auto-detection at all, and no pane", async () => {
    const d = deps({ socketForGui: () => undefined });
    const r = await resolvePaneForJoin("A", 4242, undefined, d);
    expect(r.paneId).toBeNull();
    expect(d.calls.filter((c) => c.startsWith("autoDetect"))).toEqual([]);
  });

  it("an agent whose GUI is unknown gets no detection at all (a pane is a pair or nothing)", async () => {
    const d = deps({ guiOf: async () => "unknown" });
    const r = await resolvePaneForJoin("A", 4242, undefined, d);
    expect(r).toEqual({ paneId: undefined });
    expect(d.calls.filter((c) => c.startsWith("autoDetect"))).toEqual([]);
  });
});

describe("finding 3: a pane's key includes its GUI", () => {
  it("pane 0 of GUI 10 and pane 0 of GUI 20 are different terminals", () => {
    const a = { pid: 101, weztermPaneId: 0, weztermGui: 10 };
    const b = { pid: 202, weztermPaneId: 0, weztermGui: 20 };
    expect(terminalKeys(a)).toEqual(["pid:101", "pane:10:0"]);
    expect(terminalIdentity(a)).not.toBe(terminalIdentity({ ...a, weztermGui: 20 }));
    // Two GUIs no longer merge through a shared pane number.
    expect(lockKeysFor(a, [a, b]).sort()).toEqual(["pane:10:0", "pid:101"]);
  });

  it("a pane without its GUI has no key at all (it is never bound)", () => {
    expect(terminalKeys({ pid: 101, weztermPaneId: 0 })).toEqual(["pid:101"]);
  });
});

describe("finding 4: the executable is resolved before the agent's GUI is listed, without any default GUI", () => {
  it("an explicit pane in the agent's own GUI: ensureExe first, then the listing; no default-GUI check needed", async () => {
    const d = deps({});
    const r = await resolvePaneForJoin("A", 4242, 0, d);
    expect(r).toEqual({ paneId: 0, gui: 200 });
    expect(d.calls.indexOf("ensureExe")).toBeGreaterThanOrEqual(0);
    expect(d.calls.indexOf("ensureExe")).toBeLessThan(d.calls.indexOf("list /s/gui-sock-200"));
  });

  it("no executable at all: the pane is dropped with that reason, not as 'not live'", async () => {
    const d = deps({ ensureExe: async () => false });
    const r = await resolvePaneForJoin("A", 4242, 0, d);
    expect(r.paneId).toBeNull();
    expect(r.note).toBe("pane 0 ignored for A: no wezterm executable found on this server");
  });

  it("resolveWezTermExe walks the candidates with `--version` and keeps the first that runs (PATH absent, Program Files present)", async () => {
    resetWezTermExe();
    const tried: string[] = [];
    const ok = await resolveWezTermExe(async (exe) => { tried.push(exe); if (exe === "wezterm") throw new Error("ENOENT"); return "wezterm 2024"; },
      ["wezterm", "C:\\\\Program Files\\\\WezTerm\\\\wezterm.exe"]);
    expect(ok).toBe(true);
    expect(tried).toEqual(["wezterm", "C:\\\\Program Files\\\\WezTerm\\\\wezterm.exe"]);
    expect(getWeztermPath()).toBe("C:\\\\Program Files\\\\WezTerm\\\\wezterm.exe");
    resetWezTermExe();
  });
});

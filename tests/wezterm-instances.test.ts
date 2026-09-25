import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { injectWezTerm, type SendTextProcess, type SpawnSendText } from "../src/inject.js";
import { CODEX_PLAN, DEFAULT_PLAN } from "../src/target.js";
import { findWeztermSocket, socketForGui, socketGuiPid, weztermGuiOfTree, weztermProbeEnv, type ProcessEntry } from "../src/terminals.js";
import { resolvePaneForJoin, applyWeztermGui, type PaneResolverDeps } from "../src/tools.js";

// Findings from the end-to-end run of 25 Sep 2026 (tools/inject-matrix,
// results/e2e-20260925.md): each block fails on integration/injection-20260925
// (d66e805) and passes now.

function fakeSpawn(log: string[]): SpawnSendText {
  return () => {
    let payload = "";
    const listeners: { close?: (c: number | null) => void } = {};
    const proc: SendTextProcess = {
      stdin: {
        write: (chunk: string) => { payload += chunk; return true; },
        end: () => { log.push(`send:${JSON.stringify(payload)}`); setImmediate(() => listeners.close?.(0)); return undefined; },
      },
      stderr: { on: () => undefined },
      on: (event: "close" | "error", listener: ((c: number | null) => void) | ((e: Error) => void)) => {
        if (event === "close") listeners.close = listener as (c: number | null) => void;
        return undefined;
      },
    };
    return proc;
  };
}

describe("a: the Enter goes in its own send-text call, after a pause (long prompts were taken as a paste)", () => {
  const prompt = "[joind] @Agent mentioned by Admiral. ".repeat(9); // about 330 characters, like a real wake

  it("default plan: the text alone, at least 300 ms, then a lone carriage return", async () => {
    const log: string[] = [];
    const sleep = async (ms: number) => { log.push(`sleep:${ms}`); };
    await injectWezTerm(3, prompt, "wezterm", undefined, { spawn: fakeSpawn(log), sleep, plan: DEFAULT_PLAN });
    expect(log).toEqual([`send:${JSON.stringify(prompt)}`, "sleep:300", `send:${JSON.stringify("\r")}`]);
  });

  it("the post-text guard is asked before the FIRST Enter too, not only before Codex's second", async () => {
    const log: string[] = [];
    let left = false;
    const sleep = async () => { left = true; };
    const guard = () => { if (left) throw new Error("target left"); };
    await expect(injectWezTerm(3, prompt, "wezterm", undefined, { spawn: fakeSpawn(log), sleep, plan: DEFAULT_PLAN, guard })).rejects.toThrow("target left");
    expect(log).toEqual([`send:${JSON.stringify(prompt)}`]);
  });

  it("Codex: the pause is the longer of the plan's delay and 300 ms, then two lone carriage returns", async () => {
    const log: string[] = [];
    const sleep = async (ms: number) => { log.push(`sleep:${ms}`); };
    await injectWezTerm(3, prompt, "wezterm", undefined, { spawn: fakeSpawn(log), sleep, plan: { ...CODEX_PLAN, delayMs: 500 } });
    expect(log).toEqual([`send:${JSON.stringify(prompt)}`, "sleep:500", `send:${JSON.stringify("\r")}`, "sleep:500", `send:${JSON.stringify("\r")}`]);
  });
});

describe("b: the server's socket is a live GUI's, newest first, never a dead leftover", () => {
  const dir = "/home/u/.local/share/wezterm";
  const files = ["gui-sock-11111", "gui-sock-22222", "gui-sock-42272", "sock", "wezterm.exe-log-1.txt"];
  const mtimes: Record<string, number> = { "gui-sock-11111": 100, "gui-sock-22222": 200, "gui-sock-42272": 300 };
  const deps = (alive: number[]) => ({
    env: {},
    dir,
    list: () => files,
    mtimeMs: (f: string) => mtimes[f.split(/[\\/]/).pop() ?? ""] ?? 0,
    alive: (pid: number) => alive.includes(pid),
  });

  it("a dead GUI's socket that sorts last is ignored; the newest live one wins", () => {
    expect(findWeztermSocket(deps([11111, 22222]))).toBe(join(dir, "gui-sock-22222"));
  });

  it("an older live GUI is used when it is the only live one", () => {
    expect(findWeztermSocket(deps([11111]))).toBe(join(dir, "gui-sock-11111"));
  });

  it("no live GUI: no socket at all rather than a dead one", () => {
    expect(findWeztermSocket(deps([]))).toBeUndefined();
  });

  it("live sockets whose time cannot be read (Windows: stat fails with EACCES) are still candidates", () => {
    const unreadable = { ...deps([22222]), mtimeMs: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } };
    expect(findWeztermSocket(unreadable)).toBe(join(dir, "gui-sock-22222"));
  });

  it("WEZTERM_UNIX_SOCKET still wins", () => {
    expect(findWeztermSocket({ ...deps([22222]), env: { WEZTERM_UNIX_SOCKET: "/x/sock" } })).toBe("/x/sock");
  });

  it("a GUI's own socket: only while that GUI is alive and its file exists", () => {
    // Existence comes from the listing: a live socket cannot be stat'ed on Windows.
    expect(socketForGui(60924, { dir, list: () => ["gui-sock-60924"], alive: () => true })).toBe(join(dir, "gui-sock-60924"));
    expect(socketForGui(60924, { dir, list: () => ["gui-sock-60924"], alive: () => false })).toBeUndefined();
    expect(socketForGui(60924, { dir, list: () => ["gui-sock-69000"], alive: () => true })).toBeUndefined();
    expect(socketGuiPid(join(dir, "gui-sock-69000"))).toBe(69000);
    expect(socketGuiPid("/x/sock")).toBeNull();
  });
});

describe("c: a pane is checked in the agent's own WezTerm instance and woken through its socket", () => {
  const t0 = 1_000_000;
  // Two GUI instances, each with pane 0 running a shell.
  const tree = new Map<number, ProcessEntry>([
    [21728, { ppid: 0, name: "explorer.exe", started: t0 }],
    [69000, { ppid: 21728, name: "wezterm-gui.exe", started: t0 + 10 }],
    [65144, { ppid: 69000, name: "pwsh.exe", started: t0 + 20 }],
    [60924, { ppid: 21728, name: "wezterm-gui.exe", started: t0 + 30 }],
    [70000, { ppid: 60924, name: "pwsh.exe", started: t0 + 40 }],
    [70128, { ppid: 70000, name: "claude.exe", started: t0 + 50 }],
    [80000, { ppid: 21728, name: "wezterm-mux-server.exe", started: t0 + 60 }],
    [80001, { ppid: 80000, name: "pwsh.exe", started: t0 + 70 }],
  ]);

  it("the ancestry walk names the GUI instance each process runs in", () => {
    expect(weztermGuiOfTree(70128, tree)).toBe(60924);
    expect(weztermGuiOfTree(65144, tree)).toBe(69000);
    expect(weztermGuiOfTree(80001, tree)).toBe(false); // a mux-server pane has no GUI above it
    expect(weztermGuiOfTree(21728, tree)).toBe(false);
  });

  function deps(over: Partial<PaneResolverDeps> & { panes: Record<string, number[]> }): PaneResolverDeps & { asked: Array<string | undefined> } {
    const asked: Array<string | undefined> = [];
    return {
      asked,
      checkWezTerm: async () => true,
      listPaneIds: async (socket?: string) => { asked.push(socket); return new Set(over.panes[socket ?? "server"] ?? []); },
      isInsideWezTerm: async () => true,
      autoDetect: async () => undefined,
      guiOf: async (pid: number) => weztermGuiOfTree(pid, tree),
      socketForGui: (gui: number) => (over.panes[`/s/gui-sock-${gui}`] ? `/s/gui-sock-${gui}` : undefined),
      serverSocket: () => "/s/gui-sock-69000",
      log: () => {},
      ...over,
    };
  }

  it("the field case: an agent in GUI 60924 asking for pane 0 is checked and bound in GUI 60924, not in the server's GUI 69000", async () => {
    const d = deps({ panes: { "/s/gui-sock-60924": [0], "/s/gui-sock-69000": [0], server: [0] } });
    const r = await resolvePaneForJoin("Agent-B", 70128, 0, d);
    expect(r).toEqual({ paneId: 0, gui: 60924 });
    expect(d.asked).toEqual(["/s/gui-sock-60924"]);
  });

  it("a pane that is not live in the agent's own instance is dropped, even if the server's instance has it", async () => {
    const d = deps({ panes: { "/s/gui-sock-60924": [1], "/s/gui-sock-69000": [0], server: [0] } });
    const r = await resolvePaneForJoin("Agent-B", 70128, 0, d);
    expect(r.paneId).toBeNull();
    expect(r.note).toBe("pane 0 ignored for Agent-B: not a live pane of its WezTerm instance (gui pid 60924)");
  });

  it("the agent's instance has no reachable socket and the server's is another instance: dropped with the instance note", async () => {
    const d = deps({ panes: { "/s/gui-sock-69000": [0], server: [0] } });
    const r = await resolvePaneForJoin("Agent-B", 70128, 0, d);
    expect(r.paneId).toBeNull();
    expect(r.note).toMatch(/^pane 0 belongs to another WezTerm instance \(gui pid 69000\)/);
  });

  it("an agent in the server's own instance is accepted as before, and carries its GUI", async () => {
    const d = deps({ panes: { "/s/gui-sock-69000": [0], server: [0] } });
    const r = await resolvePaneForJoin("Agent-A", 65144, 0, d);
    expect(r).toEqual({ paneId: 0, gui: 69000 });
  });

  it("no pane requested from another instance: no auto-detection in the server's instance", async () => {
    let detected = 0;
    const d = deps({ panes: { "/s/gui-sock-69000": [0], server: [0] }, autoDetect: async () => { detected++; return 0; } });
    const r = await resolvePaneForJoin("Agent-B", 70128, undefined, d);
    expect(r.paneId).toBeUndefined();
    expect(detected).toBe(0);
  });

  it("the agent keeps its GUI with its pane: set with a bound pane, cleared with a cleared pane, kept when nothing was learned", () => {
    const agent: { weztermGui?: number } = {};
    applyWeztermGui(agent, { paneId: 0, gui: 60924 });
    expect(agent.weztermGui).toBe(60924);
    applyWeztermGui(agent, { paneId: undefined });
    expect(agent.weztermGui).toBe(60924);
    applyWeztermGui(agent, { paneId: null });
    expect(agent.weztermGui).toBeUndefined();
    applyWeztermGui(agent, { paneId: 3, gui: 69000 });
    applyWeztermGui(agent, { paneId: 4 });
    expect(agent.weztermGui).toBeUndefined();
  });

  it("the room wakes through the agent's own GUI socket, not the global one", () => {
    const room = readFileSync(join(__dirname, "..", "src", "room.ts"), "utf-8");
    expect(room).toMatch(/inject\(agent\.pid, prompt, agent\.weztermPaneId, getWeztermPath\(\), weztermEnvForGui\(agent\.weztermGui\)/);
    expect(room).not.toMatch(/getWeztermEnv\(\)/);
  });
});

describe("d: wezterm cli probes run with WezTerm's own log off (no wezterm.exe-log-*.txt per failed probe)", () => {
  it("the probe environment sets WEZTERM_LOG=off and the socket", () => {
    const env = weztermProbeEnv("/s/gui-sock-1");
    expect(env.WEZTERM_LOG).toBe("off");
    expect(env.WEZTERM_UNIX_SOCKET).toBe("/s/gui-sock-1");
  });

  it("every `wezterm cli ... list` call in src uses the probe environment", () => {
    const dir = join(__dirname, "..", "src");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const lines = readFileSync(join(dir, f), "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (!/"cli",\s*"--no-auto-start",\s*"list"/.test(line)) return;
        const context = lines.slice(Math.max(0, i - 14), i + 3).join("\n");
        if (!/weztermProbeEnv\(/.test(context)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

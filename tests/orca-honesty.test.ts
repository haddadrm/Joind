import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveOrcaForJoin, resolvePaneForJoin, joinNotesText, requestedOrcaHandle, type OrcaResolverDeps } from "../src/tools.js";
import { hasAncestor, isInsideOrcaTree, isInsideWezTermTree, isSessionRoot, type ProcessEntry } from "../src/terminals.js";
import { inject, WakeFallbackAborted, type InjectBackends } from "../src/inject.js";
import {
  injectOrca, orcaSendFailure, parseOrcaTerminalList, resolveOrcaCli, listOrcaTerminals, resetOrcaListCache,
  OrcaCliUnavailable, type OrcaResult, type OrcaEnvelope,
} from "../src/orca.js";
import { classifyWakeFailure } from "../src/wake.js";
import { ChatRoom, terminalKeys, terminalIdentity, lockKeysFor } from "../src/room.js";
import { ConversationManager } from "../src/manager.js";

const H1 = "term_0816c47b-7bc3-4cbe-9903-f686a0b73b16";
const H2 = "term_11111111-2222-3333-4444-555555555555";

function deps(over: Partial<OrcaResolverDeps> = {}): OrcaResolverDeps & { lines: string[]; insideCalls: number[] } {
  const lines: string[] = [];
  const insideCalls: number[] = [];
  const base: OrcaResolverDeps = {
    listTerminals: async () => new Map([
      [H1, { connected: true, writable: true }],
      [H2, { connected: true, writable: false }],
    ]),
    isInsideOrca: async (pid) => { insideCalls.push(pid); return pid === 100; },
    holdsHandle: () => false,
    log: (l) => lines.push(l),
  };
  return { ...base, ...over, lines, insideCalls };
}

describe("resolveOrcaForJoin", () => {
  it("accepts a live, writable handle for a pid that runs inside Orca", async () => {
    const d = deps();
    expect(await resolveOrcaForJoin("A", 100, H1, d)).toEqual({ orcaTerminal: H1 });
    expect(d.lines).toEqual([]);
  });

  it("trims the handle and accepts a pid-less join on liveness alone", async () => {
    const d = deps();
    expect(await resolveOrcaForJoin("A", 0, `  ${H1} `, d)).toEqual({ orcaTerminal: H1 });
    expect(d.insideCalls).toEqual([]);
  });

  it("drops (null, so the stores clear it) a handle Orca does not list, one not writable, and one offered when no Orca is reachable", async () => {
    const a = await resolveOrcaForJoin("A", 100, "term_deadbeef", deps());
    expect(a.orcaTerminal).toBeNull(); expect(a.note).toMatch(/not a live Orca terminal/);
    const b = await resolveOrcaForJoin("A", 100, H2, deps());
    expect(b.orcaTerminal).toBeNull(); expect(b.note).toMatch(/not writable/);
    const c = await resolveOrcaForJoin("A", 100, H1, deps({ listTerminals: async () => null }));
    expect(c.orcaTerminal).toBeNull(); expect(c.note).toMatch(/no Orca reachable/);
  });

  it("drops a live handle when the joining pid provably runs outside Orca", async () => {
    const d = deps();
    const r = await resolveOrcaForJoin("Claude", 32512, H1, d);
    expect(r.orcaTerminal).toBeNull();
    expect(r.note).toMatch(/pid 32512 does not run inside Orca/);
    expect(d.lines).toHaveLength(1);
  });

  it("keeps a live handle with a log line when ancestry is unknown", async () => {
    const d = deps({ isInsideOrca: async () => "unknown" });
    const r = await resolveOrcaForJoin("A", 100, H1, d);
    expect(r).toEqual({ orcaTerminal: H1 });
    expect(d.lines[0]).toMatch(/unverified/);
  });

  it("never hands a malformed or non-string value to the CLI; an empty string (unset variable) is no request", async () => {
    const flag = await resolveOrcaForJoin("A", 100, "--interrupt", deps());
    expect(flag.orcaTerminal).toBeNull(); expect(flag.note).toMatch(/not an Orca terminal handle/);
    const num = await resolveOrcaForJoin("A", 100, 42, deps());
    expect(num.orcaTerminal).toBeNull(); expect(num.note).toMatch(/not a string/);
    expect(await resolveOrcaForJoin("A", 100, "", deps())).toEqual({ orcaTerminal: undefined });
    expect(requestedOrcaHandle("--interrupt")).toBeUndefined();
    expect(requestedOrcaHandle(` ${H1}`)).toBe(H1);
  });

  it("without a handle: no auto-detection; a held handle is cleared unless ancestry is unknown; nothing held costs no enumeration", async () => {
    const quiet = deps();
    expect(await resolveOrcaForJoin("A", 100, undefined, quiet)).toEqual({ orcaTerminal: undefined });
    expect(quiet.insideCalls).toEqual([]);
    const held = deps({ holdsHandle: () => true });
    expect((await resolveOrcaForJoin("A", 555, undefined, held)).orcaTerminal).toBeNull(); // elsewhere
    expect((await resolveOrcaForJoin("A", 100, undefined, held)).orcaTerminal).toBeNull(); // inside Orca, but which terminal is unsaid
    const unknown = deps({ holdsHandle: () => true, isInsideOrca: async () => "unknown" });
    expect((await resolveOrcaForJoin("A", 100, undefined, unknown)).orcaTerminal).toBeUndefined();
  });

  it("joins both notes into one MCP line", () => {
    expect(joinNotesText([undefined, undefined])).toBe("");
    expect(joinNotesText(["pane 3 ignored", "Orca terminal x ignored"])).toMatch(/^\nNote: pane 3 ignored; Orca terminal x ignored\. Mentions reach you/);
  });
});

describe("process tree: Orca ancestry through the shared hasAncestor walk", () => {
  const T0 = 1_700_000_000_000;
  // The field chain: claude.exe < pwsh.exe < Orca.exe < Orca.exe < explorer.exe
  const tree = new Map<number, ProcessEntry>([
    [40, { ppid: 30, name: "claude.exe", started: T0 + 4000 }],
    [30, { ppid: 20, name: "pwsh.exe", started: T0 + 3000 }],
    [20, { ppid: 10, name: "Orca.exe", started: T0 + 2000 }],
    [10, { ppid: 5, name: "Orca.exe", started: T0 + 1000 }],
    [5, { ppid: 1, name: "explorer.exe", started: T0 }],
    [1, { ppid: 0, name: "System", started: T0 - 1000 }],
    [70, { ppid: 60, name: "claude.exe", started: T0 + 4000 }],
    [60, { ppid: 50, name: "pwsh.exe", started: T0 + 3000 }],
    [50, { ppid: 5, name: "wezterm-gui.exe", started: T0 + 2000 }],
  ]);

  it("finds Orca above the field chain and not above a WezTerm shell", () => {
    expect(isInsideOrcaTree(40, tree)).toBe(true);
    expect(isInsideOrcaTree(70, tree)).toBe(false);
    expect(isInsideWezTermTree(70, tree)).toBe(true);
    expect(isInsideWezTermTree(40, tree)).toBe(false);
    expect(isInsideOrcaTree(9999, tree)).toBe(false); // absent pid: remote
  });

  it("keeps the recycled-pid rule and the unknown tri-state", () => {
    const recycled = new Map(tree);
    recycled.set(20, { ppid: 10, name: "Orca.exe", started: T0 + 9000 }); // "parent" younger than pwsh: a recycled pid
    expect(isInsideOrcaTree(40, recycled)).toBe(false);
    const gap = new Map(tree);
    gap.delete(30); // exited intermediary
    gap.set(40, { ppid: 30, name: "claude.exe", started: T0 + 4000 });
    expect(isInsideOrcaTree(40, gap)).toBe("unknown");
    expect(hasAncestor(40, tree, /^pwsh\.exe$/i)).toBe(true);
  });

  it("matches full paths (macOS ps) and the lowercase Linux name", () => {
    const mac = new Map<number, ProcessEntry>([
      [3, { ppid: 2, name: "/bin/zsh", started: 3000 }],
      [2, { ppid: 1, name: "/Applications/Orca.app/Contents/MacOS/Orca", started: 2000 }],
    ]);
    expect(isInsideOrcaTree(3, mac)).toBe(true);
    const lin = new Map<number, ProcessEntry>([
      [3, { ppid: 2, name: "bash", started: 3000, startedPrecisionMs: 1000 }],
      [2, { ppid: 1, name: "orca", started: 1000, startedPrecisionMs: 1000 }],
    ]);
    expect(isInsideOrcaTree(3, lin)).toBe(true);
  });
});

describe("terminal identity, locks and join freshness carry orca:<handle>", () => {
  it("terminalKeys and lockKeysFor include the handle; a handle change is a new identity", () => {
    expect(terminalKeys({ pid: 100, orcaTerminal: H1 })).toEqual(["pid:100", `orca:${H1}`]);
    expect(terminalKeys({ pid: 0, orcaTerminal: H1 })).toEqual([`orca:${H1}`]);
    expect(terminalIdentity({ pid: 100, orcaTerminal: H1 })).not.toBe(terminalIdentity({ pid: 100, orcaTerminal: H2 }));
    // A pid-only registration elsewhere and a handle-only one lock together through a pairing registration.
    const locks = lockKeysFor({ pid: 100 }, [{ pid: 0, orcaTerminal: H1 }, { pid: 100, orcaTerminal: H1 }]);
    expect(locks.sort()).toEqual(["pid:100", `orca:${H1}`].sort());
    // Two rooms, one handle, different pids: same terminal lock.
    expect(lockKeysFor({ pid: 1, orcaTerminal: H1 }, [{ pid: 2, orcaTerminal: H1 }]).sort()).toEqual(["pid:1", "pid:2", `orca:${H1}`].sort());
  });

  it("manager aliases include the handle, and a newer join sharing only the handle supersedes an older one", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-orca-"));
    const manager = new ConversationManager(dir);
    try {
      const x = manager.createConversation("x");
      const y = manager.createConversation("y");
      expect(ConversationManager.joinTerminalKeys(100, undefined, H1)).toEqual(["pid:100", `orca:${H1}`]);
      expect(ConversationManager.joinTerminalKeys(0, undefined, H1)).toEqual([`orca:${H1}`]);
      const older = manager.beginJoin("Claude", x.id, 100, undefined, H1);
      const newer = manager.beginJoin("Claude", y.id, 200, undefined, H1);
      expect(manager.joinIsCurrent(newer, 200, undefined, H1)).toBe(true);
      expect(manager.joinIsCurrent(older, 100, undefined, H1)).toBe(false);
      // A binding holding a handle merges a later handle-only join and keeps its pid.
      manager.bindAgent("Kira", x.id, 300, undefined, H2);
      expect(manager.effectiveJoinAliases("Kira", y.id, 0, undefined, H2).sort()).toEqual(["pid:300", `orca:${H2}`].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rejoin clears the handle on null and keeps it on undefined", () => {
  it("ChatRoom.join", () => {
    const room = new ChatRoom();
    try {
      room.join("A", 100, undefined, undefined, H1);
      expect(room.getAgent("A")?.orcaTerminal).toBe(H1);
      room.join("A", 100, undefined, undefined, undefined);
      expect(room.getAgent("A")?.orcaTerminal).toBe(H1);
      room.join("A", 100, undefined, undefined, null);
      expect(room.getAgent("A")?.orcaTerminal).toBeUndefined();
      // A handle replaced by another handle is a new session, like a pane replacement.
      room.join("A", 100, undefined, undefined, H1);
      const before = room.read(undefined, 100).filter((m) => /rejoined/.test(m.text)).length;
      room.join("A", 100, undefined, undefined, H2);
      expect(room.read(undefined, 100).filter((m) => /rejoined/.test(m.text)).length).toBe(before + 1);
      expect(room.getAgent("A")?.orcaTerminal).toBe(H2);
    } finally {
      room.destroy();
    }
  });

  it("ConversationManager.bindAgent", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-orca-"));
    const manager = new ConversationManager(dir);
    try {
      const x = manager.createConversation("x");
      manager.bindAgent("A", x.id, 100, undefined, H1);
      expect(manager.holdsOrcaTerminal("A")).toBe(true);
      manager.bindAgent("A", x.id, 100, undefined, undefined);
      expect(manager.holdsOrcaTerminal("A")).toBe(true);
      manager.bindAgent("A", x.id, 100, undefined, null);
      expect(manager.holdsOrcaTerminal("A")).toBe(false);
      expect(manager.getAgentBinding("A", 100)).toBe(x.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("inject() prefers Orca and falls back through the guard", () => {
  function backends(over: Partial<InjectBackends> & { log: string[] }): InjectBackends {
    const { log } = over;
    return {
      orca: async (h) => { log.push(`orca:${h}`); },
      wezterm: async (p) => { log.push(`wezterm:${p}`); },
      windows: async (p) => { log.push(`console:${p}`); },
      unix: async (p) => { log.push(`console:${p}`); },
      platform: "linux",
      ...over,
    };
  }

  it("uses Orca before WezTerm and the console", async () => {
    const log: string[] = [];
    await inject(100, "hi", 7, undefined, undefined, backends({ log }), { orcaTerminal: H1 });
    expect(log).toEqual([`orca:${H1}`]);
  });

  it("falls back to the console on an Orca failure when the guard says proceed", async () => {
    const log: string[] = [];
    const guardCalls: number[] = [];
    await inject(100, "hi", undefined, undefined, undefined,
      backends({ log, orca: async () => { throw new Error(`orca terminal ${H1} unavailable (terminal_handle_stale)`); } }),
      { orcaTerminal: H1, fallbackGuard: () => { guardCalls.push(1); return "proceed"; } });
    expect(log).toEqual(["console:100"]);
    expect(guardCalls.length).toBeGreaterThanOrEqual(2); // after Orca, and again right before typing
  });

  it("aborts the fallback when the guard refuses, and never types", async () => {
    const log: string[] = [];
    await expect(inject(100, "hi", undefined, undefined, undefined,
      backends({ log, orca: async () => { throw new Error("orca send failed (runtime_unavailable): x"); } }),
      { orcaTerminal: H1, fallbackGuard: () => "moved" })).rejects.toBeInstanceOf(WakeFallbackAborted);
    expect(log).toEqual([]);
  });

  it("reports the Orca error when the console fallback fails too, and has no fallback without a pid", async () => {
    const orcaErr = new Error("orca send failed (runtime_unavailable): Orca could not verify");
    const log: string[] = [];
    await expect(inject(100, "hi", undefined, undefined, undefined,
      backends({ log, orca: async () => { throw orcaErr; }, unix: async () => { throw new Error("PID 100 not found in any tmux pane"); } }),
      { orcaTerminal: H1 })).rejects.toBe(orcaErr);
    await expect(inject(0, "hi", undefined, undefined, undefined,
      backends({ log, orca: async () => { throw orcaErr; } }), { orcaTerminal: H1 })).rejects.toBe(orcaErr);
    expect(log).toEqual([]);
  });
});

describe("Orca CLI results and failure classification", () => {
  // Envelopes observed live on 24 Sep 2026 (Orca 1.4.209).
  const accepted: OrcaEnvelope = { ok: true, result: { send: { handle: H1, accepted: true, bytesWritten: 63, prompt: { stages: ["input_accepted"] } } } };
  const stale: OrcaEnvelope = { ok: false, error: { code: "terminal_handle_stale", message: "terminal_handle_stale Terminal prompt request ID: af54. Re-issue ...", data: { orchestrationRequestId: "af54" } } };
  const noRuntime: OrcaEnvelope = { ok: false, error: { code: "runtime_unavailable", message: "Orca could not verify prompt-delivery support, so no input was sent." } };
  const ambiguous: OrcaEnvelope = { ok: false, error: { code: "transport_error", message: "connection reset", data: { orchestrationRequestId: "req-7" } } };
  const res = (json: OrcaEnvelope | null, code = 0): OrcaResult => ({ json, code, stdout: json ? JSON.stringify(json) : "garbage", stderr: "" });

  it("classifies Orca wording: a stale handle and a missing CLI are permanent, a transport failure is transient", () => {
    expect(orcaSendFailure(H1, res(accepted))).toBeNull();
    const s = orcaSendFailure(H1, res(stale, 1))!;
    expect(s.permanent).toBe(true);
    expect(classifyWakeFailure(new Error(s.message))).toBe("no-console");
    expect(classifyWakeFailure(new OrcaCliUnavailable("orca cli unavailable: orca.exe not found"))).toBe("no-console");
    const t = orcaSendFailure(H1, res(noRuntime))!;
    expect(t.permanent).toBe(false);
    expect(classifyWakeFailure(new Error(t.message))).toBe("transient");
    expect(classifyWakeFailure(new Error(orcaSendFailure(H1, res(null, 1))!.message))).toBe("transient");
  });

  it("injectOrca passes the prompt as one argv entry, never through a shell", async () => {
    const calls: string[][] = [];
    const text = `[joind] @A mentioned. Read: curl -s "http://x/api/agent/read?sender=A&since=3&pid=1" then | echo 'q'`;
    await injectOrca(H1, text, { run: async (args) => { calls.push(args); return res(accepted); } });
    expect(calls).toEqual([["terminal", "send", "--terminal", H1, "--text", text, "--enter", "--json"]]);
  });

  it("injectOrca re-issues an ambiguous failure once with its retry id, and not a stale handle or a no-runtime refusal", async () => {
    const calls: string[][] = [];
    let n = 0;
    await injectOrca(H1, "x", { run: async (args) => { calls.push(args); return res(n++ === 0 ? ambiguous : accepted); } });
    expect(calls).toHaveLength(2);
    expect(calls[1].slice(-4)).toEqual(["--retry-request", "req-7", "--wait-submit", "2"]);

    const staleCalls: string[][] = [];
    await expect(injectOrca(H1, "x", { run: async (a) => { staleCalls.push(a); return res(stale, 1); } })).rejects.toThrow(/unavailable \(terminal_handle_stale\)/);
    expect(staleCalls).toHaveLength(1);
    const rtCalls: string[][] = [];
    await expect(injectOrca(H1, "x", { run: async (a) => { rtCalls.push(a); return res(noRuntime); } })).rejects.toThrow(/orca send failed \(runtime_unavailable\)/);
    expect(rtCalls).toHaveLength(1);
    await expect(injectOrca("--help", "x", { run: async () => res(accepted) })).rejects.toThrow(/malformed_handle/);
  });

  it("parses the live terminal listing, and a failed listing is unreachable", async () => {
    const listing: OrcaEnvelope = { ok: true, result: { terminals: [
      { handle: H1, connected: true, writable: true, title: "t" },
      { handle: H2, connected: false, writable: true },
      { title: "no handle" },
    ] } };
    const m = parseOrcaTerminalList(listing)!;
    expect([...m.keys()]).toEqual([H1, H2]);
    expect(m.get(H2)).toEqual({ connected: false, writable: true });
    expect(parseOrcaTerminalList({ ok: false, error: { code: "runtime_unavailable" } })).toBeNull();
    expect(parseOrcaTerminalList(null)).toBeNull();

    resetOrcaListCache();
    let runs = 0;
    const run = async (): Promise<OrcaResult> => { runs++; return res(listing); };
    let clock = 0;
    await listOrcaTerminals(run, () => clock);
    await listOrcaTerminals(run, () => clock);
    expect(runs).toBe(1); // cached
    clock = 10_000;
    await listOrcaTerminals(run, () => clock);
    expect(runs).toBe(2);
    resetOrcaListCache();
    expect(await listOrcaTerminals(async () => { throw new Error("spawn timeout"); }, () => 0)).toBeNull();
    resetOrcaListCache();
  });

  it("resolveOrcaCli: override, a batch shim swapped for the native launcher or refused, per-user install, PATH", () => {
    const has = (set: string[]) => (p: string) => set.includes(p.replace(/\\/g, "/"));
    expect(resolveOrcaCli({ ORCA_CLI: "/opt/orca/bin/orca" }, "linux", has([]))).toBe("/opt/orca/bin/orca");
    expect(resolveOrcaCli({ ORCA_CLI: "C:/o/bin/orca.cmd" }, "win32", has(["C:/o/bin/orca.exe"])).replace(/\\/g, "/")).toBe("C:/o/bin/orca.exe");
    expect(() => resolveOrcaCli({ ORCA_CLI: "C:/o/bin/orca.cmd" }, "win32", has([]))).toThrow(OrcaCliUnavailable);
    expect(resolveOrcaCli({ LOCALAPPDATA: "C:/L" }, "win32", has(["C:/L/Programs/orca/resources/bin/orca.exe"])).replace(/\\/g, "/"))
      .toBe("C:/L/Programs/orca/resources/bin/orca.exe");
    expect(resolveOrcaCli({ LOCALAPPDATA: "C:/L" }, "win32", has([]))).toBe("orca.exe");
    expect(resolveOrcaCli({}, "darwin", has([]))).toBe("orca");
  });
});

describe("source guard: every Orca invocation goes through the one resolver", () => {
  it("only src/orca.ts starts a process for Orca, once, through resolveOrcaCli", () => {
    const srcDir = join(__dirname, "..", "src");
    for (const f of readdirSync(srcDir).filter((n) => n.endsWith(".ts") && n !== "orca.ts")) {
      // Code only: comments may talk about the CLI.
      const text = readFileSync(join(srcDir, f), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(text, `${f} names the Orca CLI`).not.toMatch(/orca\.(exe|cmd)|["']orca["']\s*,|"terminal",\s*"send"/i);
    }
    const orca = readFileSync(join(srcDir, "orca.ts"), "utf-8");
    const spawns = orca.match(/\b(spawn|execFile|execFileSync|exec|spawnSync)\(/g) ?? [];
    expect(spawns).toEqual(["spawn("]);
    const runOrca = orca.slice(orca.indexOf("export function runOrca"), orca.indexOf("export interface OrcaTerminalState"));
    expect(runOrca).toMatch(/exe = resolveOrcaCli\(\)/);
    expect(runOrca).toMatch(/spawn\(exe, args/);
    expect(runOrca).not.toMatch(/shell:/);
  });
});

describe("ancestry: a chain that ends at a session or system root is disproved, not unknown", () => {
  const T0 = 1_700_000_000_000;
  const e = (ppid: number, name: string, dt: number): ProcessEntry => ({ ppid, name, started: T0 + dt });
  // Field case: an agent started through WMI. wininit's parent (smss) has exited.
  const wmi = new Map<number, ProcessEntry>([
    [90, e(89, "claude.exe", 9000)],
    [89, e(88, "claude.exe", 8000)],
    [88, e(87, "WmiPrvSE.exe", 7000)],
    [87, e(86, "svchost.exe", 6000)],
    [86, e(85, "services.exe", 5000)],
    [85, e(80, "wininit.exe", 4000)],
  ]);
  // A shell in Windows Terminal. explorer's parent (userinit) has exited.
  const wt = new Map<number, ProcessEntry>([
    [40, e(30, "claude.exe", 9000)],
    [30, e(20, "pwsh.exe", 8000)],
    [20, e(10, "WindowsTerminal.exe", 7000)],
    [10, e(5, "explorer.exe", 1000)],
  ]);
  // An Orca shell, also rooted at explorer with its parent gone.
  const orcaChain = new Map<number, ProcessEntry>([
    [40, e(30, "claude.exe", 9000)],
    [30, e(20, "pwsh.exe", 8000)],
    [20, e(15, "Orca.exe", 7000)],
    [15, e(10, "Orca.exe", 6000)],
    [10, e(5, "explorer.exe", 1000)],
  ]);

  it("the WMI chain and the Windows Terminal chain are outside both terminals", () => {
    expect(isInsideOrcaTree(90, wmi)).toBe(false);
    expect(isInsideWezTermTree(90, wmi)).toBe(false);
    expect(isInsideOrcaTree(40, wt)).toBe(false);
    expect(isInsideWezTermTree(40, wt)).toBe(false);
  });

  it("an exited wrapper in the middle of an ordinary chain stays unknown", () => {
    const wrapped = new Map<number, ProcessEntry>([
      [40, e(30, "claude.exe", 9000)],
      [30, e(25, "pwsh.exe", 8000)], // its parent (a wrapper) has exited
    ]);
    expect(isInsideOrcaTree(40, wrapped)).toBe("unknown");
    expect(isInsideWezTermTree(40, wrapped)).toBe("unknown");
  });

  it("the Orca chain is still inside Orca", () => {
    expect(isInsideOrcaTree(40, orcaChain)).toBe(true);
    expect(isInsideWezTermTree(40, orcaChain)).toBe(false);
  });

  it("a macOS chain rooted at launchd is outside both terminals", () => {
    const mac = new Map<number, ProcessEntry>([
      [900, { ppid: 800, name: "claude", started: 9000, startedPrecisionMs: 1000 }],
      [800, { ppid: 700, name: "-zsh", started: 8000, startedPrecisionMs: 1000 }],
      [700, { ppid: 600, name: "/usr/bin/login", started: 7000, startedPrecisionMs: 1000 }],
      [600, { ppid: 1, name: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", started: 6000, startedPrecisionMs: 1000 }],
      [1, { ppid: 0, name: "/sbin/launchd", started: 0, startedPrecisionMs: 1000 }],
    ]);
    expect(isInsideOrcaTree(900, mac)).toBe(false);
    expect(isInsideWezTermTree(900, mac)).toBe(false);
  });

  it("a root whose parent carries no start time is still a root; the recycled-pid rule stays", () => {
    const noDate = new Map(wt);
    noDate.set(5, { ppid: 1, name: "userinit.exe" }); // present, but no creation date
    expect(isInsideOrcaTree(40, noDate)).toBe(false);
    const recycled = new Map(orcaChain);
    recycled.set(20, e(15, "node.exe", 9500)); // "parent" younger than its child pwsh
    expect(isInsideOrcaTree(40, recycled)).toBe(false);
    expect(isSessionRoot(4, { ppid: 0, name: "System" })).toBe(true);
    expect(isSessionRoot(30, e(25, "pwsh.exe", 0))).toBe(false);
    expect(isSessionRoot(12, e(1, "RuntimeBroker.EXE", 0))).toBe(true);
  });

  it("the resolvers now DROP a requested Orca handle or WezTerm pane from a pid on the WMI or Windows Terminal chain", async () => {
    for (const [tree, pid] of [[wmi, 90], [wt, 40]] as const) {
      const orca = await resolveOrcaForJoin("Claude", pid, H1, deps({ isInsideOrca: async (p) => isInsideOrcaTree(p, tree) }));
      expect(orca.orcaTerminal).toBeNull();
      expect(orca.note).toMatch(new RegExp(`pid ${pid} does not run inside Orca`));
      const lines: string[] = [];
      const pane = await resolvePaneForJoin("Claude", pid, 0, {
        checkWezTerm: async () => true,
        listPaneIds: async () => new Set([0]),
        isInsideWezTerm: async (p) => isInsideWezTermTree(p, tree),
        autoDetect: async () => 0,
        log: (l) => lines.push(l),
      });
      expect(pane.paneId).toBeNull();
      expect(pane.note).toMatch(new RegExp(`pid ${pid} does not run inside WezTerm`));
    }
    // And the Orca chain keeps its handle.
    expect((await resolveOrcaForJoin("Claude", 40, H1, deps({ isInsideOrca: async (p) => isInsideOrcaTree(p, orcaChain) }))).orcaTerminal).toBe(H1);
  });
});

/**
 * Hosted-wake verdicts end to end: two real servers in one process (A is the
 * home of a room, B hosts a member of it), linked both ways on loopback.
 * B's injector is the real inject() with fake backends (the target is
 * classified Codex by a stub, never by the host's real lookup), and B's
 * submit check reads a temp store on a fake clock: it finds nothing, so it
 * reaches "not submitted" with one rollout excluded by the 24 h horizon.
 * Each link's network can be cut, and a verdict's reply lost, from the test.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const typed: Array<{ pid: number }> = [];
const hooks = { onType: null as null | (() => void) };
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  const target = await vi.importActual<typeof import("../src/target.js")>("../src/target.js");
  return {
    ...actual,
    inject: (pid: number, text: string, pane?: number, exe?: string, env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) =>
      actual.inject(pid, text, pane, exe, env, {
        orca: async () => undefined,
        wezterm: async () => { throw new Error("no wezterm"); },
        windows: async () => { throw new Error("not windows"); },
        unix: async (p) => { typed.push({ pid: p }); hooks.onType?.(); },
        platform: "linux",
        // Never the host's real target lookup.
        classify: async () => target.CODEX_PLAN,
      }, options),
  };
});

// Fake pids and no pane: the per-join process enumeration has nothing to find.
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import { PeerRoutes } from "./peer-routes.js";
import type { JoindConfig } from "../src/config.js";
import type { FetchLike } from "../src/link.js";
import type { MirrorRoom } from "../src/mirror.js";
import { notSubmittedLine, type ChatMessage } from "../src/room.js";
import { HOSTED_VERDICT_TTL_MS } from "../src/peer-types.js";
import type { SubmitCheckOptions } from "../src/submit-check.js";

const TOKEN = "link-token-for-tests-0123456789";
const WEB = "b".repeat(64);
const PID = 999_971;
const PID_NEW = 999_973;
const DAY = 86_400_000;
const EXPECTED = notSubmittedLine("Curzon", PID, 30_000, 1, DAY, "bravo");

// Each server binds port 0; its link names the peer by a placeholder URL that
// resolves once the peer is up (tests/peer-routes.ts).
const routes = new PeerRoutes();

interface Net {
  fetchImpl: FetchLike;
  cut: (v: boolean) => void;
  /** Lose the reply of the next verdict the home took (the request lands). */
  loseNextVerdictReply: boolean;
  /** Drop the wake id from wake requests: the host behaves as an older build. */
  stripWakeId: boolean;
  verdicts: Array<{ body: Record<string, unknown>; answer?: Record<string, unknown> }>;
}

function net(): Net {
  let down = false;
  const n: Net = {
    cut: (v) => { down = v; },
    loseNextVerdictReply: false,
    stripWakeId: false,
    verdicts: [],
    fetchImpl: async (url, init) => {
      if (down) throw new Error("connect ECONNREFUSED (link cut by the test)");
      let reqInit = init;
      if (n.stripWakeId && url.includes("/api/peer/wake") && !url.includes("/wake-verdict") && init.body) {
        const b = JSON.parse(init.body) as Record<string, unknown>;
        delete b.wakeId;
        reqInit = { ...init, body: JSON.stringify(b) };
      }
      const res = await fetch(url, reqInit);
      const text = await res.text();
      if (url.includes("/api/peer/wake-verdict")) {
        const rec: Net["verdicts"][number] = { body: JSON.parse(init.body ?? "{}") as Record<string, unknown> };
        try { rec.answer = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
        n.verdicts.push(rec);
        if (n.loseNextVerdictReply) {
          n.loseNextVerdictReply = false;
          throw new Error("socket hang up (reply lost by the test)");
        }
      }
      return { status: res.status, text: async () => text };
    },
  };
  return n;
}

function config(dir: string, instance: string, peer: string): JoindConfig {
  return {
    port: 0, host: "127.0.0.1", dataDir: join(dir, "data"), instance, crewHome: join(dir, "crew"),
    humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
    webToken: WEB, webTokenUserSet: true,
    links: [{ name: peer, url: routes.url(peer), token: TOKEN }],
  };
}

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 12_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("hosted wake verdicts over the link: two servers in one process", { timeout: 30_000 }, () => {
  let dirA: string, dirB: string;
  let A: JoindHandle, B: JoindHandle;
  let netA: Net, netB: Net;
  let room: string;
  let remote: string;
  const logs: string[] = [];
  /** Held while set: the check's next poll waits for it. */
  const gate: { hold: Promise<void> | null } = { hold: null };

  const homeLines = (): ChatMessage[] => A.manager.getRoom(room)!.read(undefined, 1000).filter((m) => m.sender === "system" && m.text.includes("no submitted prompt seen"));
  const mirrorB = (): MirrorRoom => B.links.get("alpha")!.getMirror(room)!;
  const mirroredLines = (): ChatMessage[] => mirrorB().readForView(1000, undefined).filter((m) => m.text.includes("no submitted prompt seen"));
  /** Mention Curzon on A; resolves once B typed the wake. */
  async function mention(text: string): Promise<void> {
    const before = typed.length;
    const s = await post(A.baseUrl, "/api/send", { sender: "Rami", text, token: WEB, conversation: room });
    expect(s.status).toBe(200);
    await waitFor("B's injector", () => typed.length > before);
  }

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dirA = mkdtempSync(join(tmpdir(), "joind-verdict-a-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-verdict-b-"));
    // B's Codex store: one rollout idle for over 24 h, so the verdict carries a count of 1.
    const day = join(dirB, "codex", "sessions", "2026", "09", "01");
    mkdirSync(day, { recursive: true });
    const stale = join(day, "rollout-stale.jsonl");
    writeFileSync(stale, JSON.stringify({ timestamp: new Date(Date.now() - 26 * 3_600_000).toISOString(), type: "session_meta", payload: { id: "s" } }) + "\n");
    const old = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(stale, old, old);
    let clock = Date.now();
    const checkOptions: SubmitCheckOptions = {
      sessionsDirs: [join(dirB, "codex", "sessions")],
      now: () => clock,
      sleep: async (ms) => {
        if (gate.hold) await gate.hold;
        clock += ms;
        await new Promise((r) => setTimeout(r, 2));
      },
    };
    netA = net();
    netB = net();
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 60_000 };
    A = await startJoind(config(dirA, "alpha", "bravo"), { link: { ...tuning, fetchImpl: routes.wrap(netA.fetchImpl) } });
    routes.set("alpha", A.baseUrl);
    B = await startJoind(config(dirB, "bravo", "alpha"), { link: { ...tuning, fetchImpl: routes.wrap(netB.fetchImpl), submitCheckOptions: checkOptions } });
    routes.set("bravo", B.baseUrl);
    room = A.manager.createConversation("ops").id;
    remote = `alpha:${room}`;
    const j = await post(B.baseUrl, "/api/agent/join", { name: "Curzon", pid: PID, conversation: remote });
    expect(j.status).toBe(200);
    expect(A.manager.getRoom(room)!.getAgent("Curzon")?.host).toBe("bravo");
  }, 30_000);

  afterAll(async () => {
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  beforeEach(() => { hooks.onType = null; gate.hold = null; netA.stripWakeId = false; netB.loseNextVerdictReply = false; });

  it("the line lands on A with the host label, the unconfirmed wording and the count, and mirrors to B as exactly one line", async () => {
    await mention("@Curzon first ping");
    const line = await waitFor("the line on A", () => homeLines()[0]);
    expect(line.text).toBe(EXPECTED);
    expect(line.text).toContain("on their host bravo");
    expect(line.text).toContain("(unconfirmed: 1 rollout idle over 24 h not checked)");
    // B shows it once, as the home's message (positive id), never as a local line.
    const onB = await waitFor("the line mirrored to B", () => mirroredLines().length > 0 && mirroredLines());
    expect(onB).toHaveLength(1);
    expect(onB[0].id).toBe(line.id);
    expect(onB[0].local).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(homeLines()).toHaveLength(1);
    expect(mirroredLines()).toHaveLength(1);
    expect(netB.verdicts).toHaveLength(1);
    expect(netB.verdicts[0].answer).toEqual({ ok: true, accepted: true });
    // The hosted registration crossed the link, but no log line on either server holds it.
    const hosted = A.manager.getRoom(room)!.hostedRegistrationOf("Curzon")!;
    expect(netB.verdicts[0].body.hostedRegistration).toBe(hosted);
    expect(logs.join("\n")).not.toContain(hosted);
  });

  it("a replayed POST is dropped: accepted false, no second line", async () => {
    const replay = await post(A.baseUrl, "/api/peer/wake-verdict", netB.verdicts[0].body, auth);
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({ ok: true, accepted: false, reason: "unknown" });
    expect(homeLines()).toHaveLength(1);
  });

  it("a wrong token gets 401; a malformed body gets 400", async () => {
    const bad = await post(A.baseUrl, "/api/peer/wake-verdict", netB.verdicts[0].body, { Authorization: "Bearer not-the-token-at-all" });
    expect(bad.status).toBe(401);
    const malformed = await post(A.baseUrl, "/api/peer/wake-verdict", { ...netB.verdicts[0].body, wakeId: "not a wake id" }, auth);
    expect(malformed.status).toBe(400);
    expect(homeLines()).toHaveLength(1);
  });

  it("a network cut and restore delivers it exactly once", async () => {
    const before = homeLines().length;
    const sentBefore = netB.verdicts.length;
    hooks.onType = () => netB.cut(true);
    await mention("@Curzon ping across a cut");
    await waitFor("the verdict held on B", () => mirrorB().pendingVerdictCount() === 1);
    expect(homeLines()).toHaveLength(before);
    netB.cut(false);
    await waitFor("the line on A after the restore", () => homeLines().length === before + 1);
    await waitFor("B's queue empty", () => mirrorB().pendingVerdictCount() === 0);
    await new Promise((r) => setTimeout(r, 500));
    expect(homeLines()).toHaveLength(before + 1);
    expect(netB.verdicts.slice(sentBefore).filter((v) => v.answer?.accepted === true)).toHaveLength(1);
    await waitFor("one more mirrored line on B", () => mirroredLines().length === before + 1);
  });

  it("a lost reply and a retry deliver exactly one line: the retry is answered accepted false", async () => {
    const before = homeLines().length;
    const sentBefore = netB.verdicts.length;
    netB.loseNextVerdictReply = true;
    await mention("@Curzon ping with a lost reply");
    await waitFor("the line on A", () => homeLines().length === before + 1);
    await waitFor("the retry answered", () => netB.verdicts.length >= sentBefore + 2);
    await waitFor("B's queue empty", () => mirrorB().pendingVerdictCount() === 0);
    const mine = netB.verdicts.slice(sentBefore);
    expect(mine[0].answer).toEqual({ ok: true, accepted: true });
    expect(mine[1].body.wakeId).toBe(mine[0].body.wakeId);
    expect(mine[1].answer).toEqual({ ok: true, accepted: false, reason: "unknown" });
    await new Promise((r) => setTimeout(r, 300));
    expect(homeLines()).toHaveLength(before + 1);
  });

  it("an old-host simulation (no wake id reaches the host) reports nothing; A's entry expires with the logged reason", async () => {
    const before = homeLines().length;
    const home = A.manager.getRoom(room)!;
    netA.stripWakeId = true;
    const logged = logs.length;
    await mention("@Curzon ping to an older host");
    await waitFor("B's log: home did not ask", () => logs.slice(logged).some((l) => l === "  [verify] Curzon: hosted wake: not reported (home did not ask)"));
    expect(home.pendingHostedWakeCount()).toBe(1);
    // The TTL is 18 min 45 s; the sweep its timer runs is driven with A's clock moved past it.
    home.sweepHostedVerdicts(Date.now() + HOSTED_VERDICT_TTL_MS);
    expect(logs.slice(logged).some((l) => /^ {2}\[verdict\] hosted wake [0-9a-f-]{8}: no verdict \(host silent or older build\); Curzon on bravo$/.test(l))).toBe(true);
    expect(home.pendingHostedWakeCount()).toBe(0);
    expect(homeLines()).toHaveLength(before);
  });

  it("a rejoin mid-check produces no line", async () => {
    const before = homeLines().length;
    const logged = logs.length;
    let open!: () => void;
    gate.hold = new Promise<void>((r) => { open = r; });
    await mention("@Curzon ping, then a rejoin");
    // The check is parked at its first poll: Curzon rejoins on B from a new terminal.
    const j = await post(B.baseUrl, "/api/agent/join", { name: "Curzon", pid: PID_NEW, conversation: remote });
    expect(j.status).toBe(200);
    gate.hold = null;
    open();
    await waitFor("B's log: not reported", () => logs.slice(logged).some((l) => l.startsWith("  [verify] Curzon: hosted wake") && l.includes("not reported")));
    await new Promise((r) => setTimeout(r, 300));
    expect(homeLines()).toHaveLength(before);
  });
});

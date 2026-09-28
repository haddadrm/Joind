/**
 * Codex review of ff68dc3 (hosted verdict, CHANGES REQUESTED, two P2), its
 * four probes kept as regression tests with their exact expectations. All
 * four failed on ff68dc3 (REVIEW_TTL sent both, REVIEW_CAP 21, REVIEW_DESTROY
 * pending 1 and failures 1 on both routes).
 * - P2 (1): the host queue's TTL and cap hold across awaited sends.
 * - P2 (2): a late failure never revives a destroyed mirror or marks the
 *   shared link down.
 * Fake transport and fake clock only: no real queue, typing or store reads.
 */
import { it, expect, vi, afterEach } from "vitest";
import { MirrorRoom, HOSTED_VERDICT_QUEUE_CAP, type MirrorTransport } from "../src/mirror.js";
import { HOSTED_VERDICT_QUEUE_TTL_MS, LinkDownError, type PeerWakeVerdictBody, type PeerWakeVerdictResult } from "../src/peer-types.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
let counter = 0;
function body(): PeerWakeVerdictBody {
  return { room: "c-review", name: "Review", wakeId: `${String(++counter).padStart(8,"0")}-0000-4000-8000-000000000000`, hostedRegistration: "review-only-reg", verdict: "not-submitted", pid: 999979, waitedMs: 30000, excludedStale: 1, horizonMs: 86400000, checkedAt: Date.now() };
}
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  const state = { up: false, calls: [] as string[], failures: 0, answer: async (_b: PeerWakeVerdictBody): Promise<PeerWakeVerdictResult> => ({ ok: true, accepted: true }) };
  const transport: MirrorTransport = {
    isUp: () => state.up,
    send: async () => { throw new Error("not used"); }, leave: async () => {}, act: async () => {},
    register: async () => ({ ok: true, registration: "review-local", online: [] }),
    wakeVerdict: async b => { state.calls.push(b.wakeId); return state.answer(b); },
    failed: () => { state.failures++; state.up = false; }
  };
  const mirror = new MirrorRoom({ server: "alpha", homeId: "c-review", name: "review", queueFile: null, transport, selfName: "bravo" });
  return { state, mirror };
}
function gate() {
  let resolve!: (v: PeerWakeVerdictResult) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<PeerWakeVerdictResult>((a,b) => { resolve=a; reject=b; });
  return { promise, resolve, reject };
}

it("REVIEW: entries expiring while an earlier send waits are not dispatched", async () => {
  const { state, mirror } = setup();
  try {
    const first=body(), second=body();
    await mirror.reportVerdict(first); await mirror.reportVerdict(second);
    vi.setSystemTime(Date.now()+HOSTED_VERDICT_QUEUE_TTL_MS-1000);
    const pending=gate(); state.up=true; state.answer=async () => pending.promise;
    const flush=mirror.flushVerdicts();
    expect(state.calls).toEqual([first.wakeId]);
    vi.setSystemTime(Date.now()+2000);
    pending.resolve({ok:true,accepted:true});
    await flush;
    console.info("REVIEW_TTL",JSON.stringify({calls:state.calls,first:first.wakeId,expired:second.wakeId}));
    expect(state.calls).toEqual([first.wakeId]);
    expect(mirror.pendingVerdictCount()).toBe(0);
  } finally { mirror.destroy(); }
});

it("REVIEW: failed in-flight flush cannot reinsert a twenty-first pending verdict", async () => {
  const { state, mirror } = setup();
  try {
    const oldest=body();
    await mirror.reportVerdict(oldest);
    const pending=gate(); state.up=true; state.answer=async () => pending.promise;
    const flush=mirror.flushVerdicts();
    state.up=false;
    for(let i=0;i<HOSTED_VERDICT_QUEUE_CAP;i++) await mirror.reportVerdict(body());
    expect(mirror.pendingVerdictCount()).toBe(20);
    pending.reject(new LinkDownError("review link loss"));
    await flush;
    console.info("REVIEW_CAP",mirror.pendingVerdictCount());
    expect(mirror.pendingVerdictCount()).toBeLessThanOrEqual(HOSTED_VERDICT_QUEUE_CAP);
    state.up=true; state.answer=async () => ({ok:true,accepted:true});
    await mirror.flushVerdicts();
    expect(state.calls.slice(1)).not.toContain(oldest.wakeId);
  } finally { mirror.destroy(); }
});

it.each(["direct", "flush"])("REVIEW: a late %s failure cannot repopulate a destroyed mirror", async route => {
  const { state, mirror } = setup();
  try {
    const b=body(), pending=gate();
    if(route === "flush") await mirror.reportVerdict(b);
    state.up=true; state.answer=async () => pending.promise;
    const work=route === "flush" ? mirror.flushVerdicts() : mirror.reportVerdict(b);
    expect(state.calls).toHaveLength(1);
    mirror.destroy();
    pending.reject(new LinkDownError("review late error"));
    await work;
    console.info("REVIEW_DESTROY",JSON.stringify({route,pending:mirror.pendingVerdictCount(),failures:state.failures}));
    expect(mirror.pendingVerdictCount()).toBe(0);
    expect(state.failures).toBe(0);
  } finally { mirror.destroy(); }
});

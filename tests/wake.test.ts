import { describe, it, expect } from "vitest";
import { WakeCoordinator, classifyWakeFailure } from "../src/wake.js";

const noSleep = () => Promise.resolve();

describe("classifyWakeFailure", () => {
  it("recognises a missing console as permanent and everything else as transient", () => {
    expect(classifyWakeFailure(new Error("AttachConsole(59728) failed: error 87"))).toBe("no-console");
    expect(classifyWakeFailure(new Error("AttachConsole(33484) failed: error 5"))).toBe("transient");
    expect(classifyWakeFailure(new Error("kill ESRCH"))).toBe("no-console");
  });
});

describe("WakeCoordinator", () => {
  it("serializes attempts per target and lets different targets overlap", async () => {
    const wc = new WakeCoordinator({ sleep: noSleep });
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = wc.run("Claude", async () => { log.push("claude-1-start"); await gate; log.push("claude-1-end"); });
    const second = wc.run("Claude", async () => { log.push("claude-2"); });
    const other = wc.run("Jadzia", async () => { log.push("jadzia"); });
    await other;
    expect(log).toEqual(["claude-1-start", "jadzia"]);
    release();
    await first; await second;
    expect(log).toEqual(["claude-1-start", "jadzia", "claude-1-end", "claude-2"]);
  });

  it("retries once on a transient failure and succeeds", async () => {
    const wc = new WakeCoordinator({ sleep: noSleep });
    let calls = 0;
    const out = await wc.run("Claude", async () => { calls++; if (calls === 1) throw new Error("error 5"); });
    expect(out.ok).toBe(true);
    expect(out.attempts).toBe(2);
  });

  it("does not retry a no-console failure, warns once, then stays quiet until forget()", async () => {
    const wc = new WakeCoordinator({ sleep: noSleep });
    let calls = 0;
    const fail = async () => { calls++; throw new Error("AttachConsole(1) failed: error 87"); };
    const a = await wc.run("Curzon", fail);
    expect(a.ok).toBe(false); expect(a.kind).toBe("no-console"); expect(a.attempts).toBe(1); expect(a.warn).toBe(true);
    const b = await wc.run("Curzon", fail);
    expect(b.warn).toBe(false);
    wc.forget("Curzon");
    const c = await wc.run("Curzon", fail);
    expect(c.warn).toBe(true);
    expect(calls).toBe(3);
  });

  it("rate-limits transient warnings per agent", async () => {
    const wc = new WakeCoordinator({ sleep: noSleep, warnCooldownMs: 60_000 });
    const fail = async () => { throw new Error("error 5"); };
    const a = await wc.run("Claude", fail);
    const b = await wc.run("Claude", fail);
    expect(a.warn).toBe(true);
    expect(b.warn).toBe(false);
    expect(a.attempts).toBe(2);
  });
});

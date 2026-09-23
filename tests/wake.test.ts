import { describe, it, expect } from "vitest";
import { WakeCoordinator, classifyWakeFailure, injectBaseUrlFor } from "../src/wake.js";
import { ChatRoom, terminalKey } from "../src/room.js";

const noSleep = () => Promise.resolve();

describe("classifyWakeFailure", () => {
  it("recognises a missing console as permanent and everything else as transient", () => {
    expect(classifyWakeFailure(new Error("AttachConsole(59728) failed: error 87"))).toBe("no-console");
    expect(classifyWakeFailure(new Error("AttachConsole(33484) failed: error 5"))).toBe("transient");
    expect(classifyWakeFailure(new Error("kill ESRCH"))).toBe("no-console");
    expect(classifyWakeFailure(new Error("Unix injection failed: PID 4242 not found in any tmux pane. Ensure the agent runs inside tmux."))).toBe("no-console");
    expect(classifyWakeFailure(new Error("tmux send-keys timed out"))).toBe("transient");
  });
});

describe("injectBaseUrlFor", () => {
  it("maps wildcard binds to loopback and brackets IPv6 literals", () => {
    expect(injectBaseUrlFor("0.0.0.0", 4200)).toBe("http://127.0.0.1:4200");
    expect(injectBaseUrlFor("::", 4200)).toBe("http://127.0.0.1:4200");
    expect(injectBaseUrlFor("::1", 4200)).toBe("http://[::1]:4200");
    expect(injectBaseUrlFor("fd7a:115c:a1e0::1", 4200)).toBe("http://[fd7a:115c:a1e0::1]:4200");
    expect(injectBaseUrlFor("100.113.239.70", 4200)).toBe("http://100.113.239.70:4200");
    expect(injectBaseUrlFor("localhost", 4201)).toBe("http://localhost:4201");
  });
});

describe("WakeCoordinator", () => {
  it("serializes attempts per terminal and lets different terminals overlap", async () => {
    const wc = new WakeCoordinator({ sleep: noSleep });
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = wc.run("pid:1", "r1:Claude", async () => { log.push("claude-1-start"); await gate; log.push("claude-1-end"); return "done"; });
    // A second room mentioning the same terminal queues behind the first.
    const second = wc.run("pid:1", "r2:Claude", async () => { log.push("claude-2"); return "done"; });
    const other = wc.run("pid:2", "r1:Jadzia", async () => { log.push("jadzia"); return "done"; });
    await other;
    expect(log).toEqual(["claude-1-start", "jadzia"]);
    release();
    await first; await second;
    expect(log).toEqual(["claude-1-start", "jadzia", "claude-1-end", "claude-2"]);
  });

  it("passes skip and moved results through as successful outcomes", async () => {
    const wc = new WakeCoordinator({ sleep: noSleep });
    expect(await wc.run("pid:1", "r1:A", async () => "skip")).toMatchObject({ ok: true, result: "skip", attempts: 1 });
    expect(await wc.run("pid:1", "r1:A", async () => "moved")).toMatchObject({ ok: true, result: "moved", attempts: 1 });
  });

  it("retries once on a transient failure and succeeds", async () => {
    const wc = new WakeCoordinator({ sleep: noSleep });
    let calls = 0;
    const out = await wc.run("pid:1", "r1:Claude", async () => { calls++; if (calls === 1) throw new Error("error 5"); return "done"; });
    expect(out.ok).toBe(true);
    expect(out.attempts).toBe(2);
  });

  it("reports the true attempt count when a transient failure is followed by a permanent one", async () => {
    const wc = new WakeCoordinator({ sleep: noSleep });
    let calls = 0;
    const out = await wc.run("pid:1", "r1:Claude", async () => {
      calls++;
      throw new Error(calls === 1 ? "error 5" : "AttachConsole(1) failed: error 87");
    });
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("no-console");
    expect(out.attempts).toBe(2);
  });

  it("does not retry a no-console failure, warns once, then stays quiet until forget()", async () => {
    const wc = new WakeCoordinator({ sleep: noSleep });
    let calls = 0;
    const fail = async (): Promise<"done"> => { calls++; throw new Error("AttachConsole(59728) failed: error 87"); };
    const a = await wc.run("pid:59728", "r1:Curzon", fail);
    expect(a).toMatchObject({ ok: false, kind: "no-console", attempts: 1, warn: true });
    const b = await wc.run("pid:59728", "r1:Curzon", fail);
    expect(b.warn).toBe(false);
    expect(calls).toBe(2);
    wc.forget("r1:Curzon");
    const c = await wc.run("pid:59728", "r1:Curzon", fail);
    expect(c.warn).toBe(true);
  });

  it("keeps warning state per room: a second room with the same name gets its own warning", async () => {
    const wc = new WakeCoordinator({ sleep: noSleep });
    const fail = async (): Promise<"done"> => { throw new Error("error 87"); };
    expect((await wc.run("pid:7", "r1:Claude", fail)).warn).toBe(true);
    expect((await wc.run("pid:7", "r1:Claude", fail)).warn).toBe(false);
    expect((await wc.run("pid:7", "r2:Claude", fail)).warn).toBe(true);
  });

  it("treats a failure that outlives its session as stale: no warning, no suppression of the next session", async () => {
    const wc = new WakeCoordinator({ sleep: noSleep });
    let reject!: (err: Error) => void;
    const held = new Promise<"done">((_, r) => { reject = r; });
    const inFlight = wc.run("pid:401", "r1:Claude", () => held);
    // The agent leaves and rejoins from a new pid while the old injection hangs.
    wc.forget("r1:Claude");
    reject(new Error("AttachConsole(401) failed: error 87"));
    const old = await inFlight;
    expect(old).toMatchObject({ ok: false, warn: false, stale: true });
    const fresh = await wc.run("pid:402", "r1:Claude", async () => { throw new Error("error 87"); });
    expect(fresh.warn).toBe(true);
  });

  it("rate-limits transient warnings per warn key", async () => {
    const wc = new WakeCoordinator({ sleep: noSleep, warnCooldownMs: 60_000 });
    const fail = async (): Promise<"done"> => { throw new Error("error 5"); };
    const a = await wc.run("pid:1", "r1:Claude", fail);
    const b = await wc.run("pid:1", "r1:Claude", fail);
    expect(a).toMatchObject({ ok: false, kind: "transient", attempts: 2, warn: true });
    expect(b.warn).toBe(false);
  });
});

describe("ChatRoom presence timestamps", () => {
  it("emits a presence update on a heartbeat so the UI can keep ages live", () => {
    const room = new ChatRoom();
    try {
      room.join("Jadzia", 1234);
      room.send("Jadzia", "hello");
      const events: Array<{ type: string; data: unknown }> = [];
      room.on("room", (e: { type: string; data: unknown }) => events.push(e));
      room.touch("Jadzia");
      const presence = events.find((e) => e.type === "presence");
      expect(presence).toBeDefined();
      const data = presence!.data as { name: string; lastSeen: number; lastPostAt?: number; at: number };
      expect(data.name).toBe("Jadzia");
      expect(data.lastPostAt).toBeGreaterThan(0);
      expect(data.lastSeen).toBe(data.at);
    } finally {
      room.destroy();
    }
  });

  it("records lastPostAt when an agent posts", () => {
    const room = new ChatRoom();
    try {
      room.join("Codex", 99);
      expect(room.getAgent("Codex")?.lastPostAt).toBeUndefined();
      room.send("Codex", "first post");
      expect(room.getAgent("Codex")?.lastPostAt).toBeGreaterThan(0);
    } finally {
      room.destroy();
    }
  });

  it("resets proof of life when the same name rejoins from a new pid", () => {
    const room = new ChatRoom();
    try {
      room.join("Claude", 401);
      room.send("Claude", "posted once");
      const before = room.getAgent("Claude")!;
      expect(before.lastPostAt).toBeGreaterThan(0);
      const joinedBefore = before.joinedAt;
      room.join("Claude", 402);
      const after = room.getAgent("Claude")!;
      expect(after.pid).toBe(402);
      expect(after.lastPostAt).toBeUndefined();
      expect(after.joinedAt).toBeGreaterThanOrEqual(joinedBefore);
      // Same pid again: an ordinary rejoin keeps what it had.
      room.send("Claude", "posted again");
      const posted = room.getAgent("Claude")!.lastPostAt;
      room.join("Claude", 402);
      expect(room.getAgent("Claude")!.lastPostAt).toBe(posted);
    } finally {
      room.destroy();
    }
  });

  it("canonicalizes a process registered with a pane in one room and pid-only in another", () => {
    const a = new ChatRoom();
    const b = new ChatRoom();
    try {
      a.join("Codex", 501, 7);
      b.join("Codex", 501);
      expect(terminalKey(a.getAgent("Codex")!)).toBe("pane:7");
      expect(terminalKey(b.getAgent("Codex")!)).toBe("pane:7");
      expect(terminalKey({ pid: 777 })).toBe("pid:777");
    } finally {
      a.destroy(); b.destroy();
    }
  });

  it("destroy() drops every agent so nothing queued can wake or warn afterwards", () => {
    const room = new ChatRoom();
    room.join("Jadzia", 9);
    room.send("Rami", "@Jadzia are you there");
    room.destroy();
    expect(room.who()).toEqual([]);
    expect(room.getAgent("Jadzia")).toBeUndefined();
  });
});

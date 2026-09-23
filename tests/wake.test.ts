import { describe, it, expect } from "vitest";
import { WakeCoordinator, classifyWakeFailure, injectBaseUrlFor } from "../src/wake.js";
import { ChatRoom } from "../src/room.js";

const noSleep = () => Promise.resolve();
const done = async () => "done" as const;

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
});

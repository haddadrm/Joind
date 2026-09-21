import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatRoom, setDefaultPresenceGrace } from "../src/room.js";
import { classifyMessage } from "../src/notifications.js";
import type { ChatMessage } from "../src/room.js";

const HUMANS = ["Admiral", "Rami"];

describe("asks", () => {
  it("send with askFor creates an open ask; resolveAsk closes it once", () => {
    const room = new ChatRoom();
    const msg = room.send("Codex", "Your call on F4, Admiral", { askFor: "Admiral" });
    expect(msg.ask).toEqual({ for: "Admiral", state: "open" });
    expect(room.openAsks("admiral").map((m) => m.id)).toEqual([msg.id]);

    const resolved = room.resolveAsk(msg.id, "Admiral");
    expect(resolved?.ask?.state).toBe("resolved");
    expect(resolved?.ask?.resolvedBy).toBe("Admiral");
    expect(room.openAsks()).toEqual([]);
    expect(room.resolveAsk(msg.id, "Admiral")).toBeNull();
  });

  it("resolution fires the persistence callback and applyAskRecords replays it", () => {
    const records: { messageId: number; resolvedBy: string; at: number }[] = [];
    const room = new ChatRoom({ onAskResolve: (messageId, by, at) => records.push({ messageId, resolvedBy: by, at }) });
    const msg = room.send("Jadzia", "pick a winner @Admiral", { askFor: "Admiral" });
    room.resolveAsk(msg.id, "Admiral");
    expect(records).toHaveLength(1);

    // A fresh room with the same message replays the sidecar to resolved.
    const fresh = new ChatRoom();
    const again = fresh.send("Jadzia", "pick a winner @Admiral", { askFor: "Admiral" });
    fresh.applyAskRecords([{ messageId: again.id, resolvedBy: "Admiral", at: Date.now() }]);
    expect(fresh.openAsks()).toEqual([]);
  });

  it("openAsks filters by target name case-insensitively", () => {
    const room = new ChatRoom();
    room.send("Codex", "for the admiral", { askFor: "Admiral" });
    room.send("Codex", "for curzon", { askFor: "Curzon" });
    expect(room.openAsks("ADMIRAL")).toHaveLength(1);
    expect(room.openAsks()).toHaveLength(2);
  });
});

describe("presence grace", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setDefaultPresenceGrace(30 * 60_000);
  });

  it("an unverifiable pid dims after 2 minutes but survives until the grace window", () => {
    setDefaultPresenceGrace(10 * 60_000);
    const room = new ChatRoom();
    room.join("Curzon", 999_999_999); // no such pid: unverifiable
    const events: string[] = [];
    room.on("room", (e: { type: string }) => events.push(e.type));

    vi.advanceTimersByTime(3 * 60_000); // past the 2min dim mark
    expect(room.who().some((a) => a.name === "Curzon")).toBe(true);
    expect(events).toContain("stale");
    expect(events).not.toContain("leave");

    vi.advanceTimersByTime(8 * 60_000); // past the 10min grace
    expect(room.who().some((a) => a.name === "Curzon")).toBe(false);
    expect(events).toContain("leave");
    const lastSystem = room.read(undefined, 5).find((m) => m.text.includes("lost presence"));
    expect(lastSystem?.text).toBe("Curzon lost presence (timed out)");
    room.destroy();
  });

  it("a touch during the grace window resets the clock", () => {
    setDefaultPresenceGrace(10 * 60_000);
    const room = new ChatRoom();
    room.join("Curzon", 999_999_999);
    vi.advanceTimersByTime(9 * 60_000);
    room.touch("Curzon");
    vi.advanceTimersByTime(9 * 60_000);
    expect(room.who().some((a) => a.name === "Curzon")).toBe(true);
    room.destroy();
  });

  it("a same-name rejoin with a new pid announces itself", () => {
    const room = new ChatRoom();
    room.join("Curzon", 1111);
    room.join("Curzon", 2222);
    const texts = room.read(undefined, 10).map((m) => m.text);
    expect(texts).toContain("Curzon rejoined (new session)");
    room.destroy();
  });
});

describe("classifier additions", () => {
  function msg(sender: string, text: string, extra?: Partial<ChatMessage>): ChatMessage {
    return { id: 1, sender, text, timestamp: Date.now(), ...extra } as ChatMessage;
  }

  it("distinguishes dropped from departed and flags rejoins", () => {
    expect(classifyMessage(msg("system", "Curzon lost presence (timed out)"), HUMANS)?.text).toBe("Curzon dropped (presence timeout)");
    expect(classifyMessage(msg("system", "Curzon left the chat"), HUMANS)?.text).toBe("Curzon left");
    expect(classifyMessage(msg("system", "Curzon rejoined (new session)"), HUMANS)?.kind).toBe("crew-joined");
  });

  it("an open ask for a human rings action-required even without a mention", () => {
    const withAsk = msg("Codex", "Custody report attached. Your call on F4.", { ask: { for: "Admiral", state: "open" } });
    expect(classifyMessage(withAsk, HUMANS)?.kind).toBe("action-required");
    const resolvedAsk = msg("Codex", "same", { ask: { for: "Admiral", state: "resolved" } });
    expect(classifyMessage(resolvedAsk, HUMANS)).toBeNull();
    const forAgent = msg("Codex", "same", { ask: { for: "Curzon", state: "open" } });
    expect(classifyMessage(forAgent, HUMANS)).toBeNull();
  });
});

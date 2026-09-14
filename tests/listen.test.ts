import { describe, it, expect } from "vitest";
import { ChatRoom } from "../src/room.js";
import { waitForMessage, clampListenTimeout, mentionsAgent, LISTEN_DEFAULT_MS, LISTEN_MAX_MS } from "../src/listen.js";

describe("clampListenTimeout", () => {
  it("defaults when omitted and clamps to the allowed window", () => {
    expect(clampListenTimeout(undefined)).toBe(LISTEN_DEFAULT_MS);
    expect(clampListenTimeout(10)).toBe(1_000);
    expect(clampListenTimeout(9_999_999)).toBe(LISTEN_MAX_MS);
    expect(clampListenTimeout(30_000)).toBe(30_000);
  });
});

describe("waitForMessage", () => {
  it("resolves immediately when a foreign message already waits past the cursor", async () => {
    const room = new ChatRoom();
    const msg = room.send("Codex", "hello resident");
    const result = await waitForMessage(room, "Claude", 0, 5_000);
    expect(result.timedOut).toBe(false);
    expect(result.messages.some((m) => m.id === msg.id)).toBe(true);
    expect(result.lastId).toBe(msg.id);
  });

  it("wakes on a new foreign message but not on the listener's own", async () => {
    const room = new ChatRoom();
    const promise = waitForMessage(room, "Claude", 0, 5_000);
    room.send("Claude", "my own message must not wake me");
    const foreign = await new Promise<number>((resolve) =>
      setTimeout(() => resolve(room.send("Jadzia", "knock knock").id), 50)
    );
    const result = await promise;
    expect(result.timedOut).toBe(false);
    expect(result.messages.some((m) => m.sender === "Jadzia" && m.id === foreign)).toBe(true);
  });

  it("times out quietly with an empty result", async () => {
    const room = new ChatRoom();
    const result = await waitForMessage(room, "Claude", 0, 1_000);
    expect(result.timedOut).toBe(true);
    expect(result.messages).toEqual([]);
  });
});

describe("mentionsAgent", () => {
  it("matches @Name case-insensitively and @all, not substrings", () => {
    expect(mentionsAgent("ping @codex please", "Codex")).toBe(true);
    expect(mentionsAgent("heads up @all", "Codex")).toBe(true);
    expect(mentionsAgent("email codex@example.com", "Codex")).toBe(false);
    expect(mentionsAgent("@CodexBot is different", "Codex")).toBe(false);
  });
});

describe("waitForMessage mentionsOnly", () => {
  it("stays asleep through unaddressed traffic, wakes on @Name, delivers only addressed messages", async () => {
    const room = new ChatRoom();
    const promise = waitForMessage(room, "Codex", 0, 5_000, { mentionsOnly: true });
    room.send("Claude", "long unaddressed ramble that must not burn Codex context");
    room.send("Jadzia", "more chatter between the others");
    const target = await new Promise<number>((resolve) =>
      setTimeout(() => resolve(room.send("Claude", "@Codex your turn").id), 50)
    );
    const result = await promise;
    expect(result.timedOut).toBe(false);
    expect(result.messages.map((m) => m.id)).toEqual([target]);
    expect(result.lastId).toBe(target);
  });

  it("in mentionsOnly a timeout advances the cursor past unaddressed traffic", async () => {
    const room = new ChatRoom();
    const promise = waitForMessage(room, "Codex", 0, 1_200, { mentionsOnly: true });
    const chatter = room.send("Claude", "not for codex");
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.messages).toEqual([]);
    expect(result.lastId).toBe(chatter.id);
  });
});

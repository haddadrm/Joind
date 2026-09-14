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

  it("handles names ending in punctuation or Unicode letters", () => {
    expect(mentionsAgent("over to @C++ now", "C++")).toBe(true);
    expect(mentionsAgent("hola @José", "José")).toBe(true);
    expect(mentionsAgent("hola @Josée", "José")).toBe(false);
  });
});

describe("waitForMessage hardening", () => {
  it("aborts promptly on signal without advancing past undelivered messages", async () => {
    const room = new ChatRoom();
    const abort = new AbortController();
    const promise = waitForMessage(room, "Claude", 0, 30_000, { signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.messages).toEqual([]);
  });

  it("does not wake on a DM addressed to someone else", async () => {
    const room = new ChatRoom();
    const promise = waitForMessage(room, "Claude", 0, 1_200);
    room.send("Codex", "secret for Jadzia only", { to: ["Jadzia"] });
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.messages).toEqual([]);
  });

  it("a second listen for the same agent aborts the first (no double delivery)", async () => {
    const room = new ChatRoom();
    const first = waitForMessage(room, "Claude", 0, 30_000);
    await new Promise((r) => setTimeout(r, 20));
    const second = waitForMessage(room, "Claude", 0, 5_000);
    const firstResult = await first;
    expect(firstResult.aborted).toBe(true);
    room.send("Codex", "only the live listener gets this");
    const secondResult = await second;
    expect(secondResult.messages.some((m) => m.sender === "Codex")).toBe(true);
  });

  it("pages a large backlog ascending instead of skipping past it", async () => {
    const room = new ChatRoom();
    for (let i = 0; i < 150; i++) room.send("Claude", `own backlog ${i}`);
    const target = room.send("Codex", "buried but not lost");
    for (let i = 0; i < 10; i++) room.send("Claude", `more noise ${i}`);
    // First call scans only the first page of the backlog: cursor moves, no skip.
    const scan1 = await waitForMessage(room, "Claude", 0, 1_000);
    expect(scan1.messages).toEqual([]);
    expect(scan1.lastId).toBeLessThan(target.id);
    // Following the returned cursor eventually delivers the buried message.
    const scan2 = await waitForMessage(room, "Claude", scan1.lastId, 1_000);
    expect(scan2.messages.some((m) => m.id === target.id)).toBe(true);
  });

  it("clamps a bogus future cursor to the room high-water mark", async () => {
    const room = new ChatRoom();
    const real = room.send("Codex", "actual last message");
    const result = await waitForMessage(room, "Claude", 999_999, 1_000);
    expect(result.timedOut).toBe(true);
    expect(result.lastId).toBe(real.id);
  });

  it("an immediate-path call still replaces an older parked listen", async () => {
    const room = new ChatRoom();
    // A mentionsOnly listen sleeps through unaddressed traffic...
    const parked = waitForMessage(room, "Claude", 0, 30_000, { mentionsOnly: true });
    await new Promise((r) => setTimeout(r, 20));
    room.send("Codex", "unaddressed, parked listener stays asleep");
    // ...so a plain listen now takes the immediate path, and must still
    // replace the parked one on its way out.
    const immediate = await waitForMessage(room, "Claude", 0, 5_000);
    expect(immediate.messages.length).toBe(1);
    const parkedResult = await parked;
    expect(parkedResult.aborted).toBe(true);
  });

  it("destroying the room cancels its parked listens", async () => {
    const room = new ChatRoom();
    const parked = waitForMessage(room, "Claude", 0, 30_000);
    await new Promise((r) => setTimeout(r, 20));
    room.destroy();
    const result = await parked;
    expect(result.aborted).toBe(true);
  });

  it("own posts never appear in delivery even on the immediate path", async () => {
    const room = new ChatRoom();
    room.send("Claude", "mine");
    const foreign = room.send("Codex", "yours");
    const result = await waitForMessage(room, "Claude", 0, 1_000);
    expect(result.messages.map((m) => m.id)).toEqual([foreign.id]);
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

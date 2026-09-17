import { describe, it, expect } from "vitest";
import { ChatRoom, visibleToViewer, type ChatMessage } from "../src/room.js";

function msg(partial: Partial<ChatMessage> & { id: number }): ChatMessage {
  return { sender: "alice", text: "hi", timestamp: 1700000000000, ...partial };
}

describe("visibleToViewer", () => {
  it("shows public messages to anyone", () => {
    const m = msg({ id: 1 });
    expect(visibleToViewer(m, "bob")).toBe(true);
    expect(visibleToViewer(m, "alice")).toBe(true);
  });

  it("shows a public message even without a viewer", () => {
    expect(visibleToViewer(msg({ id: 1 }), undefined)).toBe(true);
  });

  it("shows a DM to its recipient", () => {
    const m = msg({ id: 1, sender: "alice", to: ["bob"] });
    expect(visibleToViewer(m, "bob")).toBe(true);
  });

  it("shows a DM to its sender", () => {
    const m = msg({ id: 1, sender: "alice", to: ["bob"] });
    expect(visibleToViewer(m, "alice")).toBe(true);
  });

  it("hides a DM from a third party", () => {
    const m = msg({ id: 1, sender: "alice", to: ["bob"] });
    expect(visibleToViewer(m, "carol")).toBe(false);
  });

  it("hides a DM when no viewer is known (fail closed)", () => {
    const m = msg({ id: 1, sender: "alice", to: ["bob"] });
    expect(visibleToViewer(m, undefined)).toBe(false);
  });

  it("hides a targeted decision card (choices) from a third party", () => {
    // The message-choice fanout filters by the original message's visibility;
    // a targeted poll must behave like any other DM.
    const m = msg({ id: 1, sender: "alice", to: ["bob"], choices: ["A", "B"] });
    expect(visibleToViewer(m, "bob")).toBe(true);
    expect(visibleToViewer(m, "alice")).toBe(true);
    expect(visibleToViewer(m, "carol")).toBe(false);
    expect(visibleToViewer(m, undefined)).toBe(false);
  });
});

describe("room.read viewer filtering", () => {
  it("returns only public messages and the viewer's own DMs", () => {
    const room = new ChatRoom();
    room.send("alice", "public one");
    room.send("alice", "for bob only", { to: ["bob"] });
    room.send("carol", "for alice only", { to: ["alice"] });

    const bobView = room.read(undefined, 100, undefined, "bob");
    expect(bobView.map((m) => m.text)).toEqual(["public one", "for bob only"]);

    const noViewer = room.read(undefined, 100);
    expect(noViewer.map((m) => m.text)).toEqual(["public one"]);
  });
});

describe("room.search viewer filtering", () => {
  it("excludes DMs the viewer may not see", () => {
    const room = new ChatRoom();
    room.send("alice", "public secret-ish chatter");
    room.send("alice", "bob confidential", { to: ["bob"] });

    expect(room.search("secret", 20, "carol").length).toBe(1);
    expect(room.search("confidential", 20, "carol").length).toBe(0);
    expect(room.search("confidential", 20, "bob").length).toBe(1);
    // Fail closed: no viewer means no targeted results
    expect(room.search("confidential", 20).length).toBe(0);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationManager } from "../src/manager.js";
import { collectDmThread, collectDmPartners, resolveDmTargetConversation } from "../src/dms.js";

describe("DM mailboxes", () => {
  let manager: ConversationManager;
  let convA: string;
  let convB: string;

  const tick = () => new Promise((r) => setTimeout(r, 3));

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-dms-"));
    manager = new ConversationManager(dir);
    convA = manager.createConversation("engine").id;
    convB = manager.createConversation("bridge").id;
    const roomA = manager.getRoom(convA)!;
    const roomB = manager.getRoom(convB)!;
    // Real timestamps order the cross-room thread; same-ms sends are
    // genuinely ambiguous, so keep the fixture unambiguous.
    roomA.send("Jadzia", "public in A");
    await tick();
    roomA.send("Jadzia", "dm one in A", { to: ["Admiral"] });
    await tick();
    roomB.send("Admiral", "dm two in B", { to: ["Jadzia"] });
    await tick();
    roomB.send("Codex", "secret to Curzon", { to: ["Curzon"] });
  });

  it("collectDmThread aggregates the pair across conversations, oldest first", () => {
    const thread = collectDmThread(manager, "Admiral", "Jadzia");
    expect(thread.map((m) => m.text)).toEqual(["dm one in A", "dm two in B"]);
    expect(thread[0].conversationName).toBe("engine");
    expect(thread[1].conversationName).toBe("bridge");
  });

  it("never leaks third-party DMs into a thread or the partner list", () => {
    const thread = collectDmThread(manager, "Admiral", "Codex");
    expect(thread).toEqual([]);
    const partners = collectDmPartners(manager, "Admiral").map((p) => p.partner);
    expect(partners).toContain("Jadzia");
    expect(partners).not.toContain("Codex");
    expect(partners).not.toContain("Curzon");
  });

  it("partner summaries carry the newest exchange first", () => {
    const partners = collectDmPartners(manager, "Jadzia");
    expect(partners[0].partner).toBe("Admiral");
    expect(partners[0].lastText).toBe("dm two in B");
  });

  it("routes a new DM to the partner's bound conversation first", () => {
    manager.getRoom(convA)!.join("Jadzia", 4242);
    manager.bindAgent?.("Jadzia", convA);
    const target = resolveDmTargetConversation(manager, "Admiral", "Jadzia");
    // Bound room wins when a binding exists; otherwise the last-DM room.
    const bound = manager.getAgentConversationId("Jadzia");
    expect(target).toBe(bound ?? convB);
  });

  it("an outgoing group DM lands in every recipient's mailbox", () => {
    manager.getRoom(convA)!.send("Admiral", "all hands, privately", { to: ["Jadzia", "Codex", "Curzon"] });
    const partners = collectDmPartners(manager, "Admiral").map((p) => p.partner);
    expect(partners).toContain("Codex");
    expect(partners).toContain("Curzon");
    expect(collectDmThread(manager, "Admiral", "Codex").map((m) => m.text)).toEqual(["all hands, privately"]);
  });

  it("choosing an option on an asked message resolves the ask in the same click", () => {
    const room = manager.getRoom(convA)!;
    const msg = room.send("Jadzia", "GO or HOLD on W090?", { askFor: "Admiral", choices: ["GO", "HOLD"] });
    expect(msg.ask?.state).toBe("open");
    room.chooseMessage(msg.id, "GO", "Admiral");
    expect(msg.choiceResponse?.value).toBe("GO");
    expect(msg.ask?.state).toBe("resolved");
    expect(msg.ask?.resolvedBy).toBe("Admiral");
  });

  it("falls back to the last DM's conversation, then the active one", () => {
    // Jadzia has no binding in this fixture, so the pair's most recent DM
    // conversation (B) wins; a stranger falls through to the active room.
    expect(manager.getAgentConversationId("Jadzia")).toBeUndefined();
    expect(resolveDmTargetConversation(manager, "Admiral", "Jadzia")).toBe(convB);
    manager.setActive(convA);
    expect(resolveDmTargetConversation(manager, "Admiral", "Nobody")).toBe(convA);
  });
});

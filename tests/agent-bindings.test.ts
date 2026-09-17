import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationManager } from "../src/manager.js";

describe("agent binding resolution", () => {
  it("resolves only existing bindings and never creates one", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-bindings-"));
    try {
      const m = new ConversationManager(dir);
      const meta = m.createConversation("test");

      // Unbound name: pure lookup returns undefined (no lazy creation).
      expect(m.getAgentConversationId("Claude")).toBeUndefined();

      // bindAgent (join flows only) creates the binding.
      m.bindAgent("Claude", meta.id, 1234);
      expect(m.getAgentConversationId("Claude", 1234)).toBe(meta.id);
      expect(m.getAgentConversationId("Claude")).toBe(meta.id); // single-binding fallback

      // Other names resolve to nothing.
      expect(m.getAgentConversationId("Codex")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disambiguates multiple bindings by pid and paneId", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-bindings-"));
    try {
      const m = new ConversationManager(dir);
      const a = m.createConversation("a");
      const b = m.createConversation("b");
      m.bindAgent("Claude", a.id, 111);
      m.bindAgent("Claude", b.id, 222);

      expect(m.getAgentConversationId("Claude", 111)).toBe(a.id);
      expect(m.getAgentConversationId("Claude", 222)).toBe(b.id);
      // Ambiguous without a disambiguator: resolves to nothing.
      expect(m.getAgentConversationId("Claude")).toBeUndefined();

      m.unbindAgent("Claude", a.id);
      expect(m.getAgentConversationId("Claude")).toBe(b.id); // now unambiguous
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

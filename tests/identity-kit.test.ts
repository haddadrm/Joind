import { describe, it, expect } from "vitest";
import { buildIdentityKit } from "../src/identity-kit.js";

const opts = {
  name: "Scotty",
  joinAs: "Scotty",
  role: "Engineer",
  emoji: "🔧",
  serverUrl: "http://100.113.239.70:4200",
  conversation: "Tatmeem",
};

describe("buildIdentityKit", () => {
  it("produces the four identity files and a memory dir", () => {
    const kit = buildIdentityKit(opts);
    expect(Object.keys(kit.files).sort()).toEqual(
      ["AGENTS.md", "CLAUDE.md", "MEMORY.md", "SOUL.md"]
    );
    expect(kit.dirs).toContain("memory");
  });

  it("embeds name, server URL, conversation, and join ritual in AGENTS.md", () => {
    const agents = buildIdentityKit(opts).files["AGENTS.md"];
    expect(agents).toContain("Scotty");
    expect(agents).toContain("http://100.113.239.70:4200");
    expect(agents).toContain("Tatmeem");
    expect(agents).toContain("Memory Ritual");
    expect(agents).toContain("chat_join");
  });

  it("CLAUDE.md defers to AGENTS.md", () => {
    const claude = buildIdentityKit(opts).files["CLAUDE.md"];
    expect(claude).toContain("AGENTS.md");
  });

  it("omits conversation cleanly when not set", () => {
    const kit = buildIdentityKit({ ...opts, conversation: undefined });
    expect(kit.files["AGENTS.md"]).not.toContain("undefined");
  });

  it("contains no em or en dashes anywhere", () => {
    const kit = buildIdentityKit(opts);
    for (const content of Object.values(kit.files)) {
      expect(content).not.toMatch(/[—–]/);
    }
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import CrewStore, { initCrewStore } from "../src/crew.js";
import { scaffoldCrewMember } from "../src/scaffold.js";

describe("scaffoldCrewMember", () => {
  let dataDir: string;
  let parent: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "joind-data-"));
    parent = mkdtempSync(join(tmpdir(), "joind-crewhome-"));
    initCrewStore(dataDir);
  });

  it("creates folder, identity files, memory dir, and registers the entry", () => {
    const result = scaffoldCrewMember({
      name: "Uhura",
      parentDir: parent,
      role: "Comms",
      serverUrl: "http://127.0.0.1:4200",
    });
    expect(existsSync(join(parent, "Uhura", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(parent, "Uhura", "SOUL.md"))).toBe(true);
    expect(existsSync(join(parent, "Uhura", "memory"))).toBe(true);
    expect(result.created).toContain("AGENTS.md");
    expect(result.skipped).toEqual([]);
    expect(CrewStore.getAll().some((c) => c.name === "Uhura")).toBe(true);
    expect(result.entry.joinAs).toBe("Uhura");
  });

  it("never overwrites existing files", () => {
    const folder = join(parent, "Uhura");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SOUL.md"), "MY EXISTING SOUL");
    const result = scaffoldCrewMember({
      name: "Uhura",
      parentDir: parent,
      serverUrl: "http://127.0.0.1:4200",
    });
    expect(readFileSync(join(folder, "SOUL.md"), "utf8")).toBe("MY EXISTING SOUL");
    expect(result.skipped).toContain("SOUL.md");
    expect(result.created).toContain("AGENTS.md");
  });

  it("throws DUPLICATE for an already registered name", () => {
    CrewStore.add({ name: "Uhura", path: parent });
    expect(() =>
      scaffoldCrewMember({ name: "Uhura", parentDir: parent, serverUrl: "http://x" })
    ).toThrowError(/already/i);
  });
});

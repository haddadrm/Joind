import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import CrewStore, { initCrewStore } from "../src/crew.js";

describe("CrewStore.update", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "joind-crew-"));
    initCrewStore(dir); // repoints store at empty data dir
    CrewStore.add({ name: "Scotty", path: dir });
  });

  it("updates role, emoji, defaultFlags", () => {
    const updated = CrewStore.update("Scotty", {
      role: "Engineer",
      emoji: "🔧",
      defaultFlags: { model: "opus", yolo: true },
    });
    expect(updated?.role).toBe("Engineer");
    expect(updated?.emoji).toBe("🔧");
    expect(updated?.defaultFlags).toEqual({ model: "opus", yolo: true });
    expect(CrewStore.getAll()[0]?.role).toBe("Engineer");
  });

  it("returns null for unknown name", () => {
    expect(CrewStore.update("Nobody", { role: "x" })).toBeNull();
  });

  it("does not allow renaming via patch", () => {
    const updated = CrewStore.update("Scotty", { role: "Chief" });
    expect(updated?.name).toBe("Scotty");
  });
});

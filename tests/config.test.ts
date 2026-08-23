import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { homedir } from "os";
import { join } from "path";

describe("loadConfig crewHome", () => {
  it("defaults to <home>/joind-crew", () => {
    delete process.env.JOIND_CREW_HOME;
    const cfg = loadConfig([]);
    expect(cfg.crewHome).toBe(join(homedir(), "joind-crew"));
  });

  it("honors --crew-home flag", () => {
    const cfg = loadConfig(["--crew-home", "C:/Users/hadda/clawd/Joind"]);
    expect(cfg.crewHome).toBe("C:/Users/hadda/clawd/Joind");
  });

  it("honors JOIND_CREW_HOME env", () => {
    process.env.JOIND_CREW_HOME = "D:/crew";
    const cfg = loadConfig([]);
    expect(cfg.crewHome).toBe("D:/crew");
    delete process.env.JOIND_CREW_HOME;
  });
});

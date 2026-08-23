import { describe, it, expect } from "vitest";
import { validateCrewFolder } from "../src/crew.js";
import { tmpdir } from "os";

describe("validateCrewFolder", () => {
  it("rejects empty name", () => {
    const r = validateCrewFolder({ name: "", path: tmpdir() });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("rejects missing path", () => {
    const r = validateCrewFolder({ name: "Scotty", path: "Z:/definitely/not/here-12345" });
    expect(r.valid).toBe(false);
  });

  it("accepts a real folder", () => {
    const r = validateCrewFolder({ name: "Scotty", path: tmpdir() });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Redesign lane 1: one type scale. Every font size in the web client is a
// token, and the six steps are defined once in :root.
const pub = join(__dirname, "..", "public");
const css = readFileSync(join(pub, "style.css"), "utf8");
const js = readFileSync(join(pub, "app.js"), "utf8");

function tokenRe(name: string, px: number): RegExp {
  return new RegExp("--" + name + ":[ ]*" + px + "px;");
}

const STEPS: ReadonlyArray<readonly [string, number, number]> = [
  ["meta", 11, 16],
  ["label", 12, 16],
  ["ui", 13, 20],
  ["body", 14, 21],
  ["title", 16, 24],
  ["display", 20, 28],
];

describe("type scale tokens", () => {
  it("defines the six steps with their line heights", () => {
    for (const [name, fs, lh] of STEPS) {
      expect(css).toMatch(tokenRe("fs-" + name, fs));
      expect(css).toMatch(tokenRe("lh-" + name, lh));
    }
  });

  it("defines the spacing scale and fixed heights", () => {
    const want: ReadonlyArray<readonly [string, number]> = [
      ["s1", 4], ["s2", 8], ["s3", 12], ["s4", 16], ["s5", 24], ["s6", 32],
      ["row", 28], ["ctl", 32], ["bar", 52],
    ];
    for (const [name, px] of want) expect(css).toMatch(tokenRe(name, px));
  });

  it("style.css has no hard-coded font size", () => {
    const hard = css.match(/font-size:\s*[\d.]+(px|rem|em|pt)/g) ?? [];
    expect(hard).toEqual([]);
    const used = new Set((css.match(/font-size:\s*var\(--fs-([a-z]+)\)/g) ?? []).map((m) => m.replace(/.*--fs-|\)/g, "")));
    for (const u of used) expect(STEPS.map((s) => s[0])).toContain(u);
  });

  it("app.js sets no pixel font size inline", () => {
    expect(js.match(/fontSize\s*=\s*'[\d.]+px'/g) ?? []).toEqual([]);
    expect(js.match(/font-size:\s*[\d.]+px/g) ?? []).toEqual([]);
  });

  it("form controls take the ui step, not the browser default", () => {
    expect(css).toMatch(/button, input, select, textarea \{ font-family: inherit; font-size: var\(--fs-ui\); \}/);
  });

  it("message ids are meta mono, not 9 px", () => {
    const block = css.slice(css.indexOf(".msg-id {"), css.indexOf("}", css.indexOf(".msg-id {")));
    expect(block).toContain("font-family: var(--font-mono)");
    expect(block).toContain("font-size: var(--fs-meta)");
  });
});

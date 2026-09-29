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

// Every way app.js could set a size inline: a style property in any
// quotes, cssText or a template string, setProperty, and the font
// shorthand inside a string.
const JS_SIZE_FORMS: ReadonlyArray<RegExp> = [
  /fontSize\s*=\s*['"`][^'"`]*\d(px|rem|em|pt)/,
  /font-size\s*:\s*[\d.]+(px|rem|em|pt)/,
  /setProperty\(\s*['"`]font-size['"`]\s*,\s*['"`][\d.]+/,
  /\bfont\s*[:=]\s*['"`][^;'"`]*\b[\d.]+(px|rem|pt)\b/,
];
const CSS_SHORTHAND_SIZE = /\bfont\s*:\s*[^;{}]*\b[\d.]+(px|rem|em|pt)\b/;

function allMatches(src: string, re: RegExp): string[] {
  return src.match(new RegExp(re.source, "g")) ?? [];
}

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

  it("style.css sets no size through the font shorthand", () => {
    expect(allMatches(css, CSS_SHORTHAND_SIZE)).toEqual([]);
  });

  it("app.js sets no fixed font size inline, in any form", () => {
    for (const re of JS_SIZE_FORMS) expect(allMatches(js, re)).toEqual([]);
  });

  it("the patterns catch every form they claim to", () => {
    const bad = [
      "el.style.fontSize = '12px';",
      "el.style.fontSize = \"12px\";",
      "el.style.fontSize = `13px`;",
      "el.style.cssText = 'padding:0;font-size: 11px;';",
      "el.style.setProperty('font-size', '12px');",
      "el.style.font = '600 12px Inter';",
    ];
    for (const s of bad) expect(JS_SIZE_FORMS.some((re) => re.test(s))).toBe(true);
    const ok = [
      "el.style.fontSize = 'var(--fs-ui)';",
      "el.style.cssText = 'font-size:var(--fs-meta);';",
    ];
    for (const s of ok) expect(JS_SIZE_FORMS.some((re) => re.test(s))).toBe(false);
    expect(CSS_SHORTHAND_SIZE.test(".x { font: 600 12px/16px Inter; }")).toBe(true);
    expect(CSS_SHORTHAND_SIZE.test(".x { font: inherit; }")).toBe(false);
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

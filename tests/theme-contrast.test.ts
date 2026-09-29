/**
 * Redesign lane 3: the light theme's text tokens stay readable. Every text
 * colour clears WCAG 4.5:1 on every light ground and on its own 10 percent
 * tint (badges and chips), and white clears it on every status colour it
 * is drawn on. The values are read from public/style.css, so a later edit
 * to the palette is checked too.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const css = readFileSync(join(__dirname, "..", "public", "style.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(selector + " {");
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

function token(src: string, name: string): string {
  const m = new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6});").exec(src);
  if (!m) throw new Error("no hex value for --" + name);
  return m[1];
}

type Rgb = [number, number, number];
function rgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}
function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function luminance(c: Rgb): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}
function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function tint(c: Rgb, alpha: number, over: Rgb): Rgb {
  return c.map((v, i) => Math.round(v * alpha + over[i] * (1 - alpha))) as Rgb;
}

const light = block(':root[data-theme="light"]');
const grounds = ["bg", "bg-sidebar", "bg-rail", "bg-elevated", "bg-active"];
const texts = ["text", "text-dim", "text-muted", "accent", "accent-bright", "success", "warn", "danger"];

describe("light theme contrast", () => {
  it("every text colour clears 4.5:1 on every light ground", () => {
    const low: string[] = [];
    for (const t of texts) {
      for (const g of grounds) {
        const r = contrast(rgb(token(light, t)), rgb(token(light, g)));
        if (r < 4.5) low.push(`${t} on ${g}: ${r.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
  });

  it("every text colour clears 4.5:1 on its own soft tint", () => {
    const white: Rgb = [255, 255, 255];
    for (const t of texts) {
      const c = rgb(token(light, t));
      expect(contrast(c, tint(c, 0.1, white))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("white clears 4.5:1 on every status colour", () => {
    for (const t of ["accent", "success", "warn", "danger"]) {
      expect(contrast([255, 255, 255], rgb(token(light, t)))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("code blocks keep their text readable in the light theme", () => {
    const code = rgb(token(light, "code-bg"));
    for (const t of ["text", "text-dim", "text-muted"]) {
      expect(contrast(rgb(token(light, t)), code)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("only scrims, backdrops and the lightbox use a fixed black tint", () => {
    // A fixed black tint under text reads in the dark theme only; content
    // surfaces take a token that the light theme redefines.
    const offenders: string[] = [];
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = rule.exec(css)) !== null) {
      const selector = m[1].trim().split("\n").pop() ?? "";
      if (/(^|\s|;)background(-color)?:\s*rgba\(0, 0, 0/.test(m[2]) && !/overlay|backdrop|lightbox/.test(selector)) offenders.push(selector);
    }
    expect(offenders).toEqual([]);
  });

  it("the warning badge on the rail takes white in the light theme", () => {
    expect(css).toMatch(/:root\[data-theme="light"\] \.rail \.rail-badge\.warn \{ color: #fff; \}/);
  });

  it("the helper catches a colour that is too light", () => {
    expect(contrast(rgb("#c26a06"), rgb("#ffffff"))).toBeLessThan(4.5);
  });
});

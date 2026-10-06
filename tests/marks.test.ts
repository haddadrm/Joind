/**
 * Marks (logo variant B, member variant M1): the pure helpers in
 * public/marks.js (window.joindMarks) and their parity with
 * src/server-badge.ts, which owns the same default badge rule.
 * The DOM builders run in JSDOM.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { JSDOM } from "jsdom";
// The Lucide hexagon, pinned inline (identical in lucide-react 0.562.0) so the
// mark and the favicon never follow the icon CDN's @latest.
const LUCIDE_HEXAGON = "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z";
import { BADGE_PALETTE, badgeHash, defaultBadge, validBadgeCode, validBadgeColor, peerBadge } from "../src/server-badge.js";

interface Badge { code: string; color: string }
interface Seat { id: string; name: string; conversationId: string; createdAt: number; lastUsedAt: number | null }
interface LinkLike { name: string; badge?: unknown }
interface AgentLike { name: string; host?: string }
interface Marks {
  PALETTE: string[];
  badgeHash(name: string): number;
  defaultBadge(name: string): Badge;
  validBadge(b: unknown): Badge | null;
  badgeFor(server: string, ctx: { selfName?: string; selfBadge?: unknown; links?: LinkLike[] }): Badge;
  memberHost(agent: AgentLike | null, roomServer: string | null, selfName: string): string | null;
  joinRouteLabel(route: unknown): string;
  seatsForRoom(seats: unknown, convId: string | null): Seat[];
  seatSummary(summary: { count: number; label: string }, n: number): { count: number; label: string };
  seatReadRecently(seat: Seat | null, nowMs: number, windowMs: number): boolean;
  whiteContrast(hex: string): number;
  faviconSvg(badge: unknown, theme?: "light" | "dark"): string;
  faviconHref(badge: unknown, theme?: "light" | "dark"): string;
  hexIcon(doc: Document, size: number): SVGElement;
  eyeIcon(doc: Document, size: number): SVGElement;
  badgeEl(doc: Document, badge: unknown, inline?: boolean): HTMLElement;
  eyeBadgeEl(doc: Document, size?: number): HTMLElement;
}

const pub = join(__dirname, "..", "public");

function load(): Marks {
  const src = readFileSync(join(pub, "marks.js"), "utf8");
  const mod: { exports: Marks | Record<string, never> } = { exports: {} };
  new Function("module", src)(mod);
  return mod.exports as Marks;
}

const m = load();

const NAMES = ["ramiy530", "Ramiy530", "buyukdepoht", "Joind", "laptop-2", "9lives", "ølstue", "Ärzte", "αλφα", "東京", "--x", "", "   ", "a", "ab", "ß-server"];

describe("palette", () => {
  it("is the server's palette, and white text clears 4.5:1 on every colour", () => {
    expect(m.PALETTE).toEqual([...BADGE_PALETTE]);
    for (const c of m.PALETTE) {
      expect(m.whiteContrast(c), c).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("whiteContrast is the WCAG ratio (white on black 21, on white 1, junk 0)", () => {
    expect(m.whiteContrast("#000000")).toBeCloseTo(21, 5);
    expect(m.whiteContrast("#ffffff")).toBeCloseTo(1, 5);
    expect(m.whiteContrast("blue")).toBe(0);
    expect(m.whiteContrast("#fff")).toBe(0);
  });
});

describe("default badge (parity with src/server-badge.ts)", () => {
  it("hash and default agree with the server for every sample name", () => {
    for (const n of NAMES) {
      expect(m.badgeHash(n), n).toBe(badgeHash(n));
      expect(m.defaultBadge(n), n).toEqual(defaultBadge(n));
    }
  });

  it("agrees on a thousand generated names", () => {
    for (let i = 0; i < 1000; i++) {
      const n = "srv-" + i.toString(36) + (i % 7 === 0 ? "-Ü" : "");
      expect(m.defaultBadge(n)).toEqual(defaultBadge(n));
    }
  });

  it("is the first letter or digit, upper-cased, and deterministic", () => {
    expect(m.defaultBadge("ramiy530").code).toBe("R");
    expect(m.defaultBadge("--x").code).toBe("X");
    expect(m.defaultBadge("9lives").code).toBe("9");
    expect(m.defaultBadge("").code).toBe("J");
    expect(m.defaultBadge("ramiy530")).toEqual(m.defaultBadge("ramiy530"));
    // Case does not move the colour: the hash is over the lower-cased name.
    expect(m.defaultBadge("Ramiy530").color).toBe(m.defaultBadge("ramiy530").color);
  });

  it("spreads names over the palette", () => {
    const used = new Set(Array.from({ length: 64 }, (_, i) => m.defaultBadge("host" + i).color));
    expect(used.size).toBeGreaterThanOrEqual(6);
  });
});

describe("validation (parity with the server)", () => {
  const CASES: unknown[] = [
    { code: "R", color: "#0e7490" },
    { code: "r5", color: "#0E7490" },
    { code: " Y ", color: "#a21caf" },
    { code: "東", color: "#123456" },
    { code: "", color: "#0e7490" },
    { code: "ABC", color: "#0e7490" },
    { code: "R!", color: "#0e7490" },
    { code: "<b", color: "#0e7490" },
    { code: "R", color: "#0e749" },
    { code: "R", color: "red" },
    { code: "R", color: "#0e7490;background:url(x)" },
    { code: 5, color: "#0e7490" },
    { code: "R" },
    null,
    "R",
  ];
  it("validBadge accepts what the server accepts, and normalises the same way", () => {
    for (const c of CASES) {
      const server = peerBadge(c);
      expect(m.validBadge(c), JSON.stringify(c)).toEqual(server ?? null);
    }
  });

  it("the server's field checks match", () => {
    expect(validBadgeCode("R5")).toBe("R5");
    expect(validBadgeCode("R55")).toBeNull();
    expect(validBadgeColor("#ABCDEF")).toBe("#abcdef");
    expect(validBadgeColor("#abc")).toBeNull();
  });
});

describe("badgeFor", () => {
  const links: LinkLike[] = [
    { name: "buyukdepoht", badge: { code: "BD", color: "#1d4ed8" } },
    { name: "oldpeer" },
    { name: "badpeer", badge: { code: "<script>", color: "red" } },
  ];
  it("this server: its own badge, else its default", () => {
    expect(m.badgeFor("ramiy530", { selfName: "ramiy530", selfBadge: { code: "Y5", color: "#be123c" }, links })).toEqual({ code: "Y5", color: "#be123c" });
    expect(m.badgeFor("ramiy530", { selfName: "ramiy530", selfBadge: null, links })).toEqual(defaultBadge("ramiy530"));
  });
  it("a linked server: the badge it sent", () => {
    expect(m.badgeFor("buyukdepoht", { selfName: "ramiy530", links })).toEqual({ code: "BD", color: "#1d4ed8" });
  });
  it("an older peer (no badge), a bad badge, or an unknown host: the default", () => {
    expect(m.badgeFor("oldpeer", { selfName: "ramiy530", links })).toEqual(defaultBadge("oldpeer"));
    expect(m.badgeFor("badpeer", { selfName: "ramiy530", links })).toEqual(defaultBadge("badpeer"));
    expect(m.badgeFor("elsewhere", { selfName: "ramiy530", links })).toEqual(defaultBadge("elsewhere"));
  });
});

describe("member marks", () => {
  it("memberHost: the member's host, else the remote room's home, never this server", () => {
    expect(m.memberHost({ name: "Kira", host: "buyukdepoht" }, null, "ramiy530")).toBe("buyukdepoht");
    expect(m.memberHost({ name: "Kira" }, "buyukdepoht", "ramiy530")).toBe("buyukdepoht");
    expect(m.memberHost({ name: "Kira", host: "ramiy530" }, "buyukdepoht", "ramiy530")).toBeNull();
    expect(m.memberHost({ name: "Kira" }, null, "ramiy530")).toBeNull();
    expect(m.memberHost(null, "buyukdepoht", "ramiy530")).toBeNull();
  });
  it("joinRouteLabel names the route", () => {
    expect(m.joinRouteLabel("mcp")).toBe("MCP");
    expect(m.joinRouteLabel("rest")).toBe("REST");
    expect(m.joinRouteLabel(undefined)).toBe("not stated");
  });
});

describe("read-only seats", () => {
  const seats: Seat[] = [
    { id: "s2", name: "reader", conversationId: "c-1", createdAt: 1, lastUsedAt: null },
    { id: "s1", name: "Auditor", conversationId: "c-1", createdAt: 1, lastUsedAt: 1_000 },
    { id: "s3", name: "other", conversationId: "c-2", createdAt: 1, lastUsedAt: null },
  ];
  it("seatsForRoom filters to the room and sorts by name", () => {
    expect(m.seatsForRoom(seats, "c-1").map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(m.seatsForRoom(seats, "c-9")).toEqual([]);
    expect(m.seatsForRoom(null, "c-1")).toEqual([]);
    expect(m.seatsForRoom(seats, null)).toEqual([]);
  });
  it("seatReadRecently is true within the window only", () => {
    const w = 10 * 60_000;
    expect(m.seatReadRecently(seats[1], 1_000 + w, w)).toBe(true);
    expect(m.seatReadRecently(seats[1], 1_001 + w, w)).toBe(false);
    expect(m.seatReadRecently(seats[0], 5, w)).toBe(false);
  });
  it("seatSummary adds the seats to the members count and label", () => {
    expect(m.seatSummary({ count: 3, label: "Members: 3 connected" }, 0)).toEqual({ count: 3, label: "Members: 3 connected" });
    expect(m.seatSummary({ count: 3, label: "Members: 3 connected" }, 2)).toEqual({ count: 5, label: "Members: 3 connected, 2 read only" });
    expect(m.seatSummary({ count: 0, label: "No members yet" }, 1)).toEqual({ count: 1, label: "Members: 1 read only" });
  });
});

describe("favicon", () => {
  it("is the outlined hexagon in the accent of each theme, with no badge by default", () => {
    const svg = m.faviconSvg(null);
    expect(svg).toContain(`d='${LUCIDE_HEXAGON}'`);
    expect(svg).toContain("#7330e3");
    expect(svg).toContain("prefers-color-scheme:dark");
    expect(svg).toContain("#a78bfa");
    expect(svg).not.toContain("<text");
    expect(svg).not.toContain("⬢");
  });
  it("adds the badge on request, escaping nothing unsafe (a bad badge is dropped)", () => {
    const svg = m.faviconSvg({ code: "R5", color: "#be123c" });
    expect(svg).toContain("fill='#be123c'");
    expect(svg).toContain(">R5</text>");
    expect(m.faviconSvg({ code: "<x", color: "#be123c" })).not.toContain("<text");
  });
  it("the accents are the stylesheet's (light --accent, dark --accent-bright)", () => {
    const css = readFileSync(join(pub, "style.css"), "utf8");
    expect(css).toMatch(/--accent:\s*#7330e3;/);
    expect(css).toMatch(/--accent-bright:\s*#a78bfa;/);
  });
  it("index.html ships the same icon, and every asset carries v=34", () => {
    const html = readFileSync(join(pub, "index.html"), "utf8");
    expect(html).toContain('id="favicon" type="image/svg+xml" href="' + m.faviconHref(null) + '"');
    expect(html).not.toContain("&#x2B22;");
    const versions = html.match(/\?v=\d+/g) ?? [];
    expect(versions.length).toBeGreaterThanOrEqual(5);
    for (const v of versions) expect(v).toBe("?v=34");
    // marks.js loads before app.js, which calls into it.
    expect(html.indexOf("marks.js?v=34")).toBeGreaterThan(0);
    expect(html.indexOf("marks.js?v=34")).toBeLessThan(html.indexOf("app.js?v=34"));
  });
  it("takes one theme's accent when the page names its theme", () => {
    const light = m.faviconSvg(null, "light");
    expect(light).toContain("#7330e3");
    expect(light).not.toContain("#a78bfa");
    expect(light).not.toContain("prefers-color-scheme");
    const dark = m.faviconSvg({ code: "R", color: "#1d4ed8" }, "dark");
    expect(dark).toContain("#a78bfa");
    expect(dark).not.toContain("#7330e3");
    expect(dark).not.toContain("prefers-color-scheme");
    expect(dark).toContain(">R</text>");
  });
  it("is a valid SVG document", () => {
    const dom = new JSDOM("");
    const doc = new dom.window.DOMParser().parseFromString(m.faviconSvg({ code: "B", color: "#1d4ed8" }), "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
    expect(doc.documentElement.tagName).toBe("svg");
  });
});

describe("DOM builders", () => {
  const doc = new JSDOM("<!doctype html><body></body>").window.document;
  it("badgeEl paints a valid badge and hides an invalid one", () => {
    const b = m.badgeEl(doc, { code: "BD", color: "#1d4ed8" });
    expect(b.className).toBe("sbadge");
    expect(b.textContent).toBe("BD");
    expect(b.style.background).toMatch(/#1d4ed8|rgb\(29, 78, 216\)/);
    expect(b.getAttribute("aria-hidden")).toBe("true");
    const bad = m.badgeEl(doc, { code: "BD", color: "url(x)" }, true);
    expect(bad.hidden).toBe(true);
    expect(bad.className).toBe("sbadge inline");
    expect(bad.textContent).toBe("");
  });
  it("eyeBadgeEl and hexIcon draw inline SVG (no icon CDN needed)", () => {
    const e = m.eyeBadgeEl(doc);
    expect(e.className).toBe("kbadge");
    expect(e.querySelector("svg circle")).not.toBeNull();
    const h = m.hexIcon(doc, 20);
    expect(h.getAttribute("width")).toBe("20");
    expect(h.querySelector("path")?.getAttribute("d")).toBe(LUCIDE_HEXAGON);
  });
});

// --- the shipped page functions in JSDOM ---------------------------------

const APP = readFileSync(join(pub, "app.js"), "utf8").replace(/\r\n?/g, "\n");

/** A top-level function from app.js, as shipped. */
function lift(name: string): string {
  const start = APP.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  const end = APP.indexOf("\n}\n", start + 1);
  if (end < 0) throw new Error(`end of ${name} not found in app.js`);
  return APP.slice(start + 1, end + 2);
}

/** A one-line top-level `var` from app.js, as shipped. */
function liftVar(name: string): string {
  const match = new RegExp(`^var ${name} = [^\n]*$`, "m").exec(APP);
  if (!match) throw new Error(`var ${name} not found in app.js`);
  return match[0];
}

interface PageWindow {
  document: Document;
  eval(src: string): unknown;
}

function page(): PageWindow {
  const dom = new JSDOM('<!doctype html><head><link rel="icon" id="favicon" href="x"></head><body></body>', { runScripts: "outside-only", url: "http://joind.test/" });
  const w = dom.window as unknown as PageWindow;
  w.eval(readFileSync(join(pub, "marks.js"), "utf8"));
  w.eval([
    liftVar("THEME_KEY"), liftVar("selfServerName"), liftVar("selfServerBadge"), liftVar("faviconWithBadge"), liftVar("badgeEditable"),
    ...["currentTheme", "setTheme", "applyFavicon", "ownServerBadge", "settingsRow", "settingsSwitch", "renderServerBadgeSettings"].map(lift),
  ].join("\n"));
  return w;
}

function faviconOf(w: PageWindow): string {
  return decodeURIComponent((w.document.getElementById("favicon")?.getAttribute("href") ?? "").replace(/^data:image\/svg\+xml,/, ""));
}

describe("the page's tab icon follows the app theme", () => {
  it("regenerates the data URI on every theme switch", () => {
    const w = page();
    w.eval("applyFavicon()");
    expect(faviconOf(w)).toBe(m.faviconSvg(null, "dark"));
    w.eval("setTheme('light')");
    expect(w.document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(faviconOf(w)).toBe(m.faviconSvg(null, "light"));
    w.eval("setTheme('dark')");
    expect(faviconOf(w)).toBe(m.faviconSvg(null, "dark"));
  });
  it("keeps the badge across a switch when the badge option is on", () => {
    const w = page();
    w.eval("selfServerName = 'ramiy530'; faviconWithBadge = true; setTheme('light')");
    expect(faviconOf(w)).toBe(m.faviconSvg(m.defaultBadge("ramiy530"), "light"));
  });
});

describe("the Settings badge editor and the token kind", () => {
  function render(editable: boolean): HTMLElement {
    const w = page();
    w.eval(`selfServerName = 'ramiy530'; badgeEditable = ${editable};`);
    const part = w.document.createElement("div");
    w.document.body.appendChild(part);
    (w.eval("renderServerBadgeSettings") as (p: HTMLElement) => void)(part);
    return part;
  }
  it("a configured token gets every control, and no lock line", () => {
    const part = render(true);
    const controls = Array.from(part.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"));
    expect(controls.length).toBeGreaterThan(8);
    expect(controls.every((c) => !c.disabled)).toBe(true);
    expect(part.querySelector("#settings-badge-locked")).toBeNull();
  });
  it("a served (auto) token gets every control disabled and a one-line reason", () => {
    const part = render(false);
    const controls = Array.from(part.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"));
    expect(controls.length).toBeGreaterThan(8);
    expect(controls.every((c) => c.disabled)).toBe(true);
    const why = part.querySelector("#settings-badge-locked");
    expect(why?.textContent).toMatch(/JOIND_WEB_TOKEN/);
    expect(part.firstChild).toBe(why);
  });
});

/**
 * The page's pure helpers (public/ui-helpers.js): the bare message number in
 * the search box, the sidebar drag-to-collapse outcome, and the agent pill
 * strip (presence order, short ages, how many pills fit before the +N chip).
 * The file is a plain browser script; it is evaluated here with a stand-in
 * `module`, as the sanitizer test loads its script.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

type Presence = "online" | "stale" | "silent";
interface UiHelpers {
  parseBareMessageNumber(q: string | null | undefined): number | null;
  sidebarDragOutcome(raw: number, min: number, max: number, collapseAt: number): { width: number; collapse: boolean };
  pillPresence(stale: boolean, quietMs: number | null): Presence;
  orderByPresence<T>(items: T[], presenceOf: (item: T) => Presence): T[];
  shortAge(ms: number): string;
  pillsThatFit(widths: number[], available: number, gap: number, chipWidth: number): number;
}

function load(): UiHelpers {
  const src = readFileSync(join(__dirname, "..", "public", "ui-helpers.js"), "utf8");
  const mod: { exports: UiHelpers | Record<string, never> } = { exports: {} };
  new Function("module", src)(mod);
  return mod.exports as UiHelpers;
}

const ui = load();

describe("parseBareMessageNumber", () => {
  it("takes a lone number with or without #, trimmed", () => {
    expect(ui.parseBareMessageNumber("1234")).toBe(1234);
    expect(ui.parseBareMessageNumber("#1234")).toBe(1234);
    expect(ui.parseBareMessageNumber("  #7  ")).toBe(7);
    expect(ui.parseBareMessageNumber("007")).toBe(7);
  });

  it("leaves ranges, words, mixed queries and junk to the ordinary search", () => {
    for (const q of ["#10-40", "#3-#9", "12 deploy", "deploy 12", "#", "##12", "12#", "1e3", "-4", "4.5", "", "   ", "from:12", "@12", "#12abc"]) {
      expect(ui.parseBareMessageNumber(q)).toBeNull();
    }
    expect(ui.parseBareMessageNumber(null)).toBeNull();
    expect(ui.parseBareMessageNumber(undefined)).toBeNull();
  });

  it("rejects zero and anything past the 12 digits the #N links accept", () => {
    expect(ui.parseBareMessageNumber("0")).toBeNull();
    expect(ui.parseBareMessageNumber("#000")).toBeNull();
    expect(ui.parseBareMessageNumber("999999999999")).toBe(999999999999);
    expect(ui.parseBareMessageNumber("1234567890123")).toBeNull();
  });
});

describe("sidebarDragOutcome", () => {
  const drag = (raw: number) => ui.sidebarDragOutcome(raw, 180, 480, 140);

  it("clamps the width and collapses only below the threshold", () => {
    expect(drag(300)).toEqual({ width: 300, collapse: false });
    expect(drag(900)).toEqual({ width: 480, collapse: false });
    expect(drag(160)).toEqual({ width: 180, collapse: false });
    expect(drag(140)).toEqual({ width: 180, collapse: false });
    expect(drag(139.6)).toEqual({ width: 180, collapse: true });
    expect(drag(-20)).toEqual({ width: 180, collapse: true });
  });
});

describe("pill presence and order", () => {
  it("stale outranks silent; quiet up to 30 minutes is online", () => {
    expect(ui.pillPresence(false, null)).toBe("online");
    expect(ui.pillPresence(false, 30 * 60000)).toBe("online");
    expect(ui.pillPresence(false, 30 * 60000 + 1)).toBe("silent");
    expect(ui.pillPresence(true, 5 * 3600000)).toBe("stale");
    expect(ui.pillPresence(true, null)).toBe("stale");
  });

  it("orders online, stale, silent and keeps the incoming order in each group", () => {
    const people: Array<{ n: string; p: Presence }> = [
      { n: "Scotty", p: "silent" }, { n: "Jadzia", p: "online" }, { n: "Odo", p: "stale" },
      { n: "Kira", p: "silent" }, { n: "Claude", p: "online" }, { n: "Worf", p: "stale" },
    ];
    const out = ui.orderByPresence(people, (x) => x.p).map((x) => x.n);
    expect(out).toEqual(["Jadzia", "Claude", "Odo", "Worf", "Scotty", "Kira"]);
    expect(people[0].n).toBe("Scotty"); // input untouched
  });
});

describe("shortAge", () => {
  it("is one unit: minutes, then hours below two days, then days", () => {
    expect(ui.shortAge(45 * 60000)).toBe("45m");
    expect(ui.shortAge(9 * 3600000 + 45 * 60000)).toBe("9h");
    expect(ui.shortAge(47 * 3600000 + 59 * 60000)).toBe("47h");
    expect(ui.shortAge(3 * 86400000 + 5 * 3600000)).toBe("3d");
    expect(ui.shortAge(-5000)).toBe("0m");
  });
});

describe("pillsThatFit", () => {
  it("shows everything when all pills and gaps fit exactly", () => {
    expect(ui.pillsThatFit([50, 50, 50], 158, 4, 30)).toBe(3);
    expect(ui.pillsThatFit([], 10, 4, 30)).toBe(0);
  });

  it("reserves the chip and its gap once the pills overflow", () => {
    // 3 pills need 158; with 157 the chip (30) takes the room of the last two.
    expect(ui.pillsThatFit([50, 50, 50], 157, 4, 30)).toBe(2);
    // 30 + (50 + 4) * 2 = 138 fits, a third would need 192.
    expect(ui.pillsThatFit([50, 50, 50, 50], 150, 4, 30)).toBe(2);
    expect(ui.pillsThatFit([50, 50, 50, 50], 137, 4, 30)).toBe(1);
  });

  it("keeps order: a narrow later pill never jumps a wide earlier one", () => {
    expect(ui.pillsThatFit([120, 20, 20, 20], 100, 4, 24)).toBe(0);
  });
});

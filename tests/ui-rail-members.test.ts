/**
 * Redesign lane 2: the pure helpers behind the rail and the members panel
 * (public/ui-helpers.js, window.joindUi). Loaded the way ui-helpers.test.ts
 * loads the file, with a stand-in `module`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

type Presence = "online" | "stale" | "silent";
interface Msg { id?: number; sender?: string; timestamp?: number }
interface Offline { name: string; lastAt: number | null }
type Group<T> = [string, string, Array<T | Offline>];
interface RailHelpers {
  railView(value: unknown): string;
  sectionInView(views: string | null | undefined, view: string): boolean;
  offlineAuthors(messages: Msg[], present: string[], me: string, limit?: number): Offline[];
  memberGroups<T>(items: T[], presenceOf: (item: T) => Presence, offline: Offline[]): Group<T>[];
  membersSummary(connected: number, offline: number): { count: number; label: string };
}

function load(): RailHelpers {
  const src = readFileSync(join(__dirname, "..", "public", "ui-helpers.js"), "utf8");
  const mod: { exports: RailHelpers | Record<string, never> } = { exports: {} };
  new Function("module", src)(mod);
  return mod.exports as RailHelpers;
}

const ui = load();

describe("railView", () => {
  it("keeps the sidebar views and falls back to rooms", () => {
    expect(ui.railView("rooms")).toBe("rooms");
    expect(ui.railView("dms")).toBe("dms");
    expect(ui.railView("crew")).toBe("crew");
    expect(ui.railView("decisions")).toBe("decisions");
    expect(ui.railView("tasks")).toBe("tasks");
    for (const v of ["board", "search", "Decisions", "", null, undefined, 3, "ROOMS", "rooms "]) {
      expect(ui.railView(v)).toBe("rooms");
    }
  });
});

describe("sectionInView", () => {
  it("reads the space-separated list", () => {
    expect(ui.sectionInView("rooms dms", "rooms")).toBe(true);
    expect(ui.sectionInView("rooms dms", "dms")).toBe(true);
    expect(ui.sectionInView("rooms dms", "crew")).toBe(false);
    expect(ui.sectionInView("  crew  ", "crew")).toBe(true);
  });
  it("does not match on a prefix", () => {
    expect(ui.sectionInView("rooms", "room")).toBe(false);
    expect(ui.sectionInView("dmsx", "dms")).toBe(false);
  });
  it("shows a section with no list in every view", () => {
    expect(ui.sectionInView(null, "crew")).toBe(true);
    expect(ui.sectionInView("", "dms")).toBe(true);
  });
});

describe("offlineAuthors", () => {
  const msgs: Msg[] = [
    { id: 1, sender: "Kira", timestamp: 100 },
    { id: 2, sender: "system", timestamp: 110 },
    { id: 3, sender: "Worf", timestamp: 120 },
    { id: 4, sender: "Rami", timestamp: 130 },
    { id: 5, sender: "Kira", timestamp: 140 },
    { id: -6, sender: "Odo", timestamp: 150 },
    { id: 7, sender: "Dax", timestamp: 160 },
  ];

  it("lists authors not present and not me, newest post first, once each", () => {
    expect(ui.offlineAuthors(msgs, ["Dax"], "Rami")).toEqual([
      { name: "Kira", lastAt: 140 },
      { name: "Worf", lastAt: 120 },
    ]);
  });
  it("skips system lines and this server's local lines", () => {
    const names = ui.offlineAuthors(msgs, [], "Rami").map((o) => o.name);
    expect(names).not.toContain("system");
    expect(names).not.toContain("Odo");
    expect(names).toEqual(["Dax", "Kira", "Worf"]);
  });
  it("honours the limit and tolerates junk", () => {
    expect(ui.offlineAuthors(msgs, [], "Rami", 1)).toEqual([{ name: "Dax", lastAt: 160 }]);
    expect(ui.offlineAuthors([{}, { sender: "" }, { sender: "Nog" }], [], "Rami")).toEqual([{ name: "Nog", lastAt: null }]);
    expect(ui.offlineAuthors([], [], "Rami")).toEqual([]);
  });
  it("does not treat a name as present by prefix", () => {
    expect(ui.offlineAuthors([{ id: 1, sender: "Kira", timestamp: 1 }], ["Kir"], "Rami").map((o) => o.name)).toEqual(["Kira"]);
  });
});

describe("memberGroups", () => {
  const items: Array<{ n: string; p: Presence }> = [
    { n: "a", p: "silent" }, { n: "b", p: "online" }, { n: "c", p: "stale" }, { n: "d", p: "online" },
  ];
  it("groups by presence in the order active, idle, silent, offline", () => {
    const g = ui.memberGroups(items, (x) => x.p, [{ name: "z", lastAt: 1 }]);
    expect(g.map((x) => x[0])).toEqual(["active", "idle", "silent", "offline"]);
    expect(g.map((x) => x[1])).toEqual(["Active now", "Idle", "Silent", "Offline"]);
    expect(g[0][2]).toEqual([{ n: "b", p: "online" }, { n: "d", p: "online" }]);
    expect(g[3][2]).toEqual([{ name: "z", lastAt: 1 }]);
  });
  it("leaves empty groups out", () => {
    const g = ui.memberGroups([{ n: "b", p: "online" as Presence }], (x) => x.p, []);
    expect(g.map((x) => x[0])).toEqual(["active"]);
    expect(ui.memberGroups([], (x: { p: Presence }) => x.p, [])).toEqual([]);
  });
});

describe("membersSummary", () => {
  it("counts everyone the panel lists", () => {
    expect(ui.membersSummary(3, 2)).toEqual({ count: 5, label: "Members: 3 connected, 2 offline" });
    expect(ui.membersSummary(4, 0)).toEqual({ count: 4, label: "Members: 4 connected" });
    expect(ui.membersSummary(0, 5)).toEqual({ count: 5, label: "Members: 0 connected, 5 offline" });
  });
  it("never reads as 0 members when nobody is known", () => {
    expect(ui.membersSummary(0, 0)).toEqual({ count: 0, label: "No members yet" });
  });
});

describe("mentionsName (lane 3b)", () => {
  const m = (ui as unknown as { mentionsName(text: unknown, name: string): boolean }).mentionsName;
  it("finds @name as a whole word, any case", () => {
    expect(m("@Rami one call needed", "Rami")).toBe(true);
    expect(m("hold on, @rami.", "Rami")).toBe(true);
    expect(m("(@RAMI) see #12", "Rami")).toBe(true);
  });
  it("ignores longer names, emails and plain words", () => {
    expect(m("@Ramiro is here", "Rami")).toBe(false);
    expect(m("mail rami@host.example", "Rami")).toBe(false);
    expect(m("Rami said so", "Rami")).toBe(false);
    expect(m("@Rami-bot ran", "Rami")).toBe(false);
  });
  it("escapes names with special characters and tolerates junk", () => {
    expect(m("@a.b hi", "a.b")).toBe(true);
    expect(m("@axb hi", "a.b")).toBe(false);
    expect(m(null, "Rami")).toBe(false);
    expect(m("@Rami", "")).toBe(false);
  });
});

interface BoardTask { id: number; conversationId: string; status: string; priority?: string; assignee?: string; updatedAt?: number }
interface BoardHelpers {
  boardColumns(): Array<[string, string]>;
  filterBoardTasks(tasks: BoardTask[], f: { view?: string; room?: string; who?: string[]; me?: string }): BoardTask[];
  groupByStatus(tasks: BoardTask[]): Record<string, BoardTask[]>;
}
describe("board helpers (lane 5)", () => {
  const b = ui as unknown as BoardHelpers;
  const tasks: BoardTask[] = [
    { id: 1, conversationId: "a", status: "open", assignee: "Rami", updatedAt: 10 },
    { id: 2, conversationId: "a", status: "in_progress", priority: "urgent", assignee: "Kira", updatedAt: 5 },
    { id: 3, conversationId: "b", status: "review", updatedAt: 7 },
    { id: 4, conversationId: "b", status: "done", priority: "urgent", assignee: "Rami", updatedAt: 9 },
    { id: 5, conversationId: "b", status: "blocked", updatedAt: 1 },
    { id: 6, conversationId: "a", status: "open", priority: "urgent", updatedAt: 2 },
  ];
  it("names the four columns in order", () => {
    expect(b.boardColumns()).toEqual([["open", "Open"], ["in_progress", "In progress"], ["review", "In review"], ["done", "Done"]]);
  });
  it("filters by view, room and assignee", () => {
    const ids = (f: Parameters<BoardHelpers["filterBoardTasks"]>[1]) => b.filterBoardTasks(tasks, f).map((t) => t.id);
    expect(ids({ view: "all" })).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids({ view: "mine", me: "Rami" })).toEqual([1, 4]);
    expect(ids({ view: "urgent" })).toEqual([2, 6]);
    expect(ids({ view: "all", room: "b" })).toEqual([3, 4, 5]);
    expect(ids({ view: "all", who: ["Kira", ""] })).toEqual([2, 3, 5, 6]);
    expect(ids({ view: "urgent", room: "a", who: ["Kira"] })).toEqual([2]);
  });
  it("groups by state, unknown to Open, urgent first then the newest", () => {
    const g = b.groupByStatus(tasks);
    expect(g.open.map((t) => t.id)).toEqual([6, 1, 5]);
    expect(g.in_progress.map((t) => t.id)).toEqual([2]);
    expect(g.review.map((t) => t.id)).toEqual([3]);
    expect(g.done.map((t) => t.id)).toEqual([4]);
    expect(b.groupByStatus([])).toEqual({ open: [], in_progress: [], review: [], done: [] });
  });
});

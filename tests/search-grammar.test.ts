/**
 * Room search grammar, paging, and the window around a message, on a local
 * room and on a remote room's mirror. DM visibility fails closed everywhere.
 */
import { describe, it, expect } from "vitest";
import { ChatRoom, type ChatMessage } from "../src/room.js";
import { MirrorRoom, type MirrorTransport } from "../src/mirror.js";
import { parseSearchQuery, hasTerms, matchesSearch, searchLimit, searchBefore, windowLimit, SEARCH_LIMIT_MAX, WINDOW_LIMIT_MAX } from "../src/search.js";

function msg(partial: Partial<ChatMessage> & { id: number }): ChatMessage {
  return { sender: "Kira", text: "", timestamp: 1_700_000_000_000 + partial.id, ...partial };
}

function stubTransport(): MirrorTransport {
  return {
    isUp: () => true,
    send: async () => { throw new Error("not used"); },
    leave: async () => {}, act: async () => {},
    register: async () => ({ ok: true, registration: "r", online: [] }),
    wakeVerdict: async () => ({ ok: true, accepted: true }),
    failed: () => {},
  };
}

describe("parseSearchQuery", () => {
  it("splits from:, @name, mentions:, an id range and free words", () => {
    const q = parseSearchQuery('from:Worf @Odo mentions:@Kira #40-12 Deploy "code red" #7');
    expect(q.from).toEqual(["worf"]);
    expect(q.mentions).toEqual(["odo", "kira"]);
    expect(q.range).toEqual({ min: 12, max: 40 });
    expect(q.words).toEqual(["deploy", "code red", "#7"]);
    expect(hasTerms(q)).toBe(true);
  });

  it("takes #a-#b as a range and keeps malformed operators as words", () => {
    expect(parseSearchQuery("#3-#9").range).toEqual({ min: 3, max: 9 });
    const q = parseSearchQuery("from: @ mentions: from:<b> @x!y");
    expect(q.from).toEqual([]);
    expect(q.mentions).toEqual([]);
    expect(q.words).toEqual(["from:", "@", "mentions:", "from:<b>", "@x!y"]);
  });

  it("has no terms for blank input and caps the query length", () => {
    expect(hasTerms(parseSearchQuery("   "))).toBe(false);
    expect(hasTerms(parseSearchQuery('""'))).toBe(false);
    const long = parseSearchQuery("a".repeat(600));
    expect(long.words[0].length).toBe(500);
  });

  it("clamps limits and ignores a bad cursor", () => {
    expect(searchLimit(undefined)).toBe(20);
    expect(searchLimit("0")).toBe(20);
    expect(searchLimit("5000")).toBe(SEARCH_LIMIT_MAX);
    expect(searchLimit("7.9")).toBe(7);
    expect(searchBefore("abc")).toBeUndefined();
    expect(searchBefore("-4")).toBeUndefined();
    expect(searchBefore("")).toBeUndefined();
    expect(searchBefore("41")).toBe(41);
    expect(windowLimit("9999")).toBe(WINDOW_LIMIT_MAX);
    expect(windowLimit("x")).toBe(50);
  });
});

describe("matchesSearch", () => {
  it("ANDs every term, case-insensitive", () => {
    const m = msg({ id: 12, sender: "Worf", text: "@Odo Deploy at 0900, see #7" });
    expect(matchesSearch(m, parseSearchQuery("deploy from:worf @odo"))).toBe(true);
    expect(matchesSearch(m, parseSearchQuery("deploy from:kira"))).toBe(false);
    expect(matchesSearch(m, parseSearchQuery("deploy rollback"))).toBe(false);
    expect(matchesSearch(m, parseSearchQuery("#10-12"))).toBe(true);
    expect(matchesSearch(m, parseSearchQuery("#13-20"))).toBe(false);
    expect(matchesSearch(m, parseSearchQuery("#7"))).toBe(true);
  });

  it("counts a mention only as a whole @name, never @all for a name", () => {
    expect(matchesSearch(msg({ id: 1, text: "@all standup" }), parseSearchQuery("@Odo"))).toBe(false);
    expect(matchesSearch(msg({ id: 1, text: "@all standup" }), parseSearchQuery("@all"))).toBe(true);
    expect(matchesSearch(msg({ id: 1, text: "@Odox check" }), parseSearchQuery("@Odo"))).toBe(false);
    expect(matchesSearch(msg({ id: 1, text: "hi odo" }), parseSearchQuery("@Odo"))).toBe(false);
    // Two different posters under AND match nothing.
    expect(matchesSearch(msg({ id: 1, sender: "Kira", text: "x" }), parseSearchQuery("from:Kira from:Worf"))).toBe(false);
  });
});

function seededRoom(): ChatRoom {
  const room = new ChatRoom();
  for (let n = 1; n <= 60; n++) room.send("Kira", `alpha ${n}`);
  room.send("Kira", "secret plan alpha", { to: ["Odo"] }); // 61
  room.send("Kira", "for Rami alpha", { to: ["Rami"] }); // 62
  room.send("Worf", "@Odo please check #12"); // 63
  room.send("Worf", "@all standup"); // 64
  return room;
}

describe("ChatRoom.searchPage", () => {
  it("pages newest first with a before cursor: no skip, no repeat", () => {
    const room = seededRoom();
    const seen: number[] = [];
    let before: number | undefined;
    const pages: number[] = [];
    for (let i = 0; i < 10; i++) {
      const p = room.searchPage(parseSearchQuery("alpha"), { limit: 20, before, viewer: "Rami" });
      pages.push(p.results.length);
      seen.push(...p.results.map((r) => r.message.id));
      if (p.nextBefore === null) break;
      before = p.nextBefore;
    }
    // 60 public plus the viewer's own DM (62); never the DM to Odo (61).
    expect(pages).toEqual([20, 20, 20, 1]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(62);
    expect(seen).not.toContain(61);
    const sorted = [...seen].sort((a, b) => b - a);
    expect(seen).toEqual(sorted);
  });

  it("an exact final page has no next cursor", () => {
    const room = new ChatRoom();
    for (let n = 1; n <= 20; n++) room.send("Kira", `beta ${n}`);
    const p = room.searchPage(parseSearchQuery("beta"), { limit: 20, viewer: "Rami" });
    expect(p.results.length).toBe(20);
    expect(p.nextBefore).toBeNull();
  });

  it("filters by poster, mention, range and words", () => {
    const room = seededRoom();
    // `null` stands for no viewer (a default parameter would swallow undefined).
    const ids = (q: string, viewer: string | null = "Rami") => room.searchPage(parseSearchQuery(q), { limit: 50, viewer: viewer ?? undefined }).results.map((r) => r.message.id);
    expect(ids("from:worf")).toEqual([64, 63]);
    expect(ids("@odo")).toEqual([63]);
    expect(ids("mentions:all")).toEqual([64]);
    expect(ids("#10-12 alpha")).toEqual([12, 11, 10]);
    expect(ids("#12")).toEqual([63]);
    expect(ids("secret")).toEqual([]);
    expect(ids("secret", "Odo")).toEqual([61]);
    // Fail closed: no viewer, no targeted messages.
    expect(ids("for rami", null)).toEqual([]);
    expect(ids("for rami")).toEqual([62]);
  });

  it("a query with no terms returns nothing", () => {
    expect(seededRoom().searchPage(parseSearchQuery(""), { limit: 20, viewer: "Rami" })).toEqual({ results: [], nextBefore: null });
  });
});

describe("ChatRoom.readAround", () => {
  it("centres a window on the target and reports older and newer", () => {
    const room = seededRoom();
    const w = room.readAround(30, 11, "Rami")!;
    expect(w.messages.map((m) => m.id)).toEqual([25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
    expect(w.hasOlder).toBe(true);
    expect(w.hasNewer).toBe(true);
  });

  it("fills from the other side at the edges", () => {
    const room = seededRoom();
    const first = room.readAround(1, 5, "Rami")!;
    expect(first.messages.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    expect(first.hasOlder).toBe(false);
    const last = room.readAround(64, 5, "Rami")!;
    // 61 is hidden from Rami, so the window skips it.
    expect(last.messages.map((m) => m.id)).toEqual([59, 60, 62, 63, 64]);
    expect(last.hasNewer).toBe(false);
  });

  it("is null for a hidden or missing target (fail closed)", () => {
    const room = seededRoom();
    expect(room.readAround(61, 10, "Rami")).toBeNull();
    expect(room.readAround(62, 10, undefined)).toBeNull();
    expect(room.readAround(999, 10, "Rami")).toBeNull();
    expect(room.readAround(61, 10, "Odo")?.messages.some((m) => m.id === 61)).toBe(true);
  });
});

describe("MirrorRoom: search, window and coverage over the cache", () => {
  function mirror(): MirrorRoom {
    return new MirrorRoom({ server: "alpha", homeId: "c1", name: "ops", queueFile: null, transport: stubTransport(), selfName: "bravo" });
  }

  it("applies the local viewer to cached messages another local viewer may see", () => {
    const m = mirror();
    const messages: ChatMessage[] = [];
    for (let id = 101; id <= 130; id++) messages.push(msg({ id, text: `gamma ${id}` }));
    // A DM for a local member (Curzon), cached because Curzon is a viewer here.
    messages.push(msg({ id: 131, text: "gamma private", to: ["Curzon"] }));
    messages.push(msg({ id: 132, text: "gamma public tail" }));
    m.fill({ server: "alpha", room: "c1", name: "ops", messages, members: [], cursor: 1, complete: false });

    const hits = m.searchPage(parseSearchQuery("gamma"), { limit: 100, viewer: "Rami" }).results.map((r) => r.message.id);
    expect(hits).not.toContain(131);
    expect(hits.length).toBe(31);
    expect(m.searchPage(parseSearchQuery("private"), { limit: 10, viewer: "Curzon" }).results.length).toBe(1);
    expect(m.readAround(131, 10, "Rami")).toBeNull();
    expect(m.readAround(132, 3, "Rami")!.messages.map((x) => x.id)).toEqual([129, 130, 132]);
    expect(m.historyCoverage("Rami")).toEqual({ complete: false, oldestId: 101 });
  });

  it("never lets a hidden DM set the oldest cached id", () => {
    const m = mirror();
    m.fill({ server: "alpha", room: "c1", name: "ops", messages: [msg({ id: 90, text: "dm", to: ["Curzon"] }), msg({ id: 95, text: "pub" })], members: [], cursor: 1, complete: false });
    expect(m.historyCoverage("Rami").oldestId).toBe(95);
    expect(m.historyCoverage("Curzon").oldestId).toBe(90);
    expect(m.historyCoverage(undefined).oldestId).toBe(95);
  });

  it("reports complete after a complete snapshot, and local lines never match", () => {
    const m = mirror();
    m.fill({ server: "alpha", room: "c1", name: "ops", messages: [msg({ id: 1, text: "link" })], members: [], cursor: 1, complete: true });
    m.addLocalLine("link down: search me");
    expect(m.historyCoverage("Rami").complete).toBe(true);
    expect(m.searchPage(parseSearchQuery("link"), { limit: 10, viewer: "Rami" }).results.map((r) => r.message.id)).toEqual([1]);
  });
});

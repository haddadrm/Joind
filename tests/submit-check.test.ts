import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";

// Field case, 28 Sep 2026: a Codex CLI 0.157.1 TUI took the wake text and
// none of its Enters; the server logged success. The
// submit check looks for the typed prompt in the Codex session store after a
// keystroke wake of a Codex target, and says so only when it is missing.
// Every store here is a temp directory; the real ~/.codex is never read
// (tests/setup-codex-home.ts points CODEX_HOME at a path that does not exist).

type Mode = "codex" | "default";
const state = {
  mode: "codex" as Mode,
  console: [] as number[],
  orca: [] as string[],
  /** What the fake Codex does when keys arrive: write the prompt to its rollout, or not. */
  onType: null as null | ((text: string) => void),
};

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  const target = await vi.importActual<typeof import("../src/target.js")>("../src/target.js");
  return {
    ...actual,
    inject: (pid: number, text: string, pane?: number, exe?: string, env?: Record<string, string>, _b?: unknown, options?: import("../src/inject.js").InjectOptions) =>
      actual.inject(pid, text, pane, exe, env, {
        orca: async (handle) => { state.orca.push(handle); },
        wezterm: async () => { throw new Error("no wezterm"); },
        windows: async () => { throw new Error("not windows"); },
        unix: async (p, t) => { state.console.push(p); state.onType?.(t); },
        platform: "linux",
        // Never the host's real target lookup (commit 50cf861).
        classify: async () => (state.mode === "codex" ? target.CODEX_PLAN : target.DEFAULT_PLAN),
      }, options),
  };
});

import { ChatRoom, notSubmittedLine } from "../src/room.js";
import { beginSubmitCheck, codexSessionsDirs, lineSubmitsPrompt } from "../src/submit-check.js";

const PROMPT = `[joind] @Scotty mentioned by Rami. Read: curl -s "http://127.0.0.1:4200/api/agent/read?sender=Scotty&since=2173&pid=27092" then Reply: curl -s -X POST http://127.0.0.1:4200/api/agent/send -H "Content-Type: application/json" -d '{"sender":"Scotty","text":"YOUR_REPLY","pid":27092}'`;

const userMessage = (text: string, at: Date = new Date()) =>
  JSON.stringify({ timestamp: at.toISOString(), type: "event_msg", payload: { type: "user_message", message: text, local_images: [] } }) + "\n";
const responseItem = (text: string, at: Date = new Date()) =>
  JSON.stringify({ timestamp: at.toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }) + "\n";
const compacted = (text: string, at: Date = new Date()) =>
  JSON.stringify({ timestamp: at.toISOString(), type: "compacted", payload: { message: "", replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }] } }) + "\n";
const toolOutput = (text: string, at: Date = new Date()) =>
  JSON.stringify({ timestamp: at.toISOString(), type: "response_item", payload: { type: "function_call_output", output: text } }) + "\n";
const HOUR_AGO = () => new Date(Date.now() - 3_600_000);

let root: string;
let sessions: string;
/** A rollout in a day directory of its own (a session keeps the file of the day it started). */
function rollout(day: string, name: string, content = ""): string {
  const dir = join(sessions, ...day.split("/"));
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `rollout-${name}.jsonl`);
  writeFileSync(f, JSON.stringify({ timestamp: HOUR_AGO().toISOString(), type: "session_meta", payload: { id: name, cwd: "D:\\x" } }) + "\n" + content);
  return f;
}
const fast = { pollMs: 10, windowMs: 150, graceMs: 50, capMs: 5000 };
const turnEvent = (type: "task_started" | "task_complete" | "turn_aborted", at: Date) =>
  JSON.stringify({ timestamp: at.toISOString(), type: "event_msg", payload: { type, turn_id: "t1" } }) + "\n";
const tokenCount = (at: Date) => JSON.stringify({ timestamp: at.toISOString(), type: "event_msg", payload: { type: "token_count" } }) + "\n";
/** A fake clock for the check: each poll's sleep moves it on, and `onSleep`
 *  plays what a Codex session writes by then (ms since the start). */
function script(onSleep: (elapsed: number, at: Date) => void) {
  const start = Date.now();
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; onSleep(t - start, new Date(t)); await new Promise<void>((r) => setImmediate(r)); },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "joind-submit-check-"));
  sessions = join(root, "sessions");
  mkdirSync(sessions);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("the submit check reads only what a Codex session wrote after the wake began", () => {
  it("finds the exact prompt appended to an older day's rollout (event_msg shape)", async () => {
    const f = rollout("2026/09/25", "a", userMessage("earlier work", HOUR_AGO()));
    rollout("2026/09/28", "b");
    const check = beginSubmitCheck(PROMPT, { sessionsDirs: [sessions], ...fast });
    await new Promise((r) => setTimeout(r, 20)); // the keys go in
    appendFileSync(f, toolOutput("x".repeat(5000)) + userMessage(PROMPT));
    const r = await check.verify();
    expect(r).toMatchObject({ result: "submitted", file: f });
  });

  it("finds it in a rollout born after the wake began (response_item shape, typed behind older text)", async () => {
    const check = beginSubmitCheck(PROMPT, { sessionsDirs: [sessions], ...fast });
    await new Promise((r) => setTimeout(r, 20));
    const f = rollout("2026/09/28", "fresh", responseItem(`leftover text ${PROMPT}`));
    expect(await check.verify()).toMatchObject({ result: "submitted", file: f });
  });

  it("an identical older prompt never matches: not before the start, not replayed, not quoted", async () => {
    // The same text submitted an hour ago (same sender, cursor unchanged),
    // already in the file before the check began...
    const f = rollout("2026/09/27", "a", userMessage(PROMPT, HOUR_AGO()));
    const check = beginSubmitCheck(PROMPT, { sessionsDirs: [sessions], ...fast });
    await new Promise((r) => setTimeout(r, 20));
    // ...and, appended after the start: an old line re-logged with its old
    // timestamp, a compaction replaying the prompt, a tool output quoting it,
    // and a real user message whose prompt differs only in its cursor.
    appendFileSync(f, userMessage(PROMPT, HOUR_AGO()) + compacted(PROMPT) + toolOutput(PROMPT) + userMessage(PROMPT.replace("since=2173", "since=2172")));
    const r = await check.verify();
    expect(r.result).toBe("not-submitted");
  });

  it("the first line alone is not the prompt: a truncated text does not match", () => {
    const start = Date.now() - 1000;
    expect(lineSubmitsPrompt(userMessage(PROMPT), PROMPT, start)).toBe(true);
    expect(lineSubmitsPrompt(userMessage(PROMPT.slice(0, 120)), PROMPT, start)).toBe(false);
    expect(lineSubmitsPrompt(responseItem(PROMPT), PROMPT, start)).toBe(true);
    expect(lineSubmitsPrompt(userMessage(PROMPT, new Date(start - 1)), PROMPT, start)).toBe(false);
    expect(lineSubmitsPrompt("{not json \"user_message\"", PROMPT, start)).toBe(false);
  });

  it("reads back only to the last line before the start and the last turn marker, never the whole file", async () => {
    // A line that WOULD match (stamped in the future) sits at the head of a
    // file, then 200 KB of older lines, then an ended turn. The backward read
    // stops at the ended turn, so a whole-file read is the only way to see it.
    const trap = userMessage(PROMPT, new Date(Date.now() + 60_000));
    const filler = userMessage("older work", HOUR_AGO());
    rollout("2026/09/20", "big", trap + filler.repeat(Math.ceil(200_000 / filler.length)) + turnEvent("task_complete", HOUR_AGO()));
    const check = beginSubmitCheck(PROMPT, { sessionsDirs: [sessions], ...fast });
    await new Promise((r) => setTimeout(r, 20));
    expect((await check.verify()).result).toBe("not-submitted");
  });

  it("a store that is absent is unverifiable, not a failure", async () => {
    const check = beginSubmitCheck(PROMPT, { sessionsDirs: [join(root, "nope")], ...fast });
    const r = await check.verify();
    expect(r).toMatchObject({ result: "unverifiable" });
    expect(r.result === "unverifiable" && r.reason).toMatch(/no Codex session store/);
  });

  it("both $CODEX_HOME and ~/.codex are read; JOIND_CODEX_SESSIONS replaces both; the suite's names nowhere", () => {
    expect(codexSessionsDirs({ CODEX_HOME: root })).toEqual([join(root, "sessions"), join(homedir(), ".codex", "sessions")]);
    expect(codexSessionsDirs({})).toEqual([join(homedir(), ".codex", "sessions")]);
    expect(codexSessionsDirs({ CODEX_HOME: root, JOIND_CODEX_SESSIONS: `a${delimiter}b${delimiter}a` })).toEqual(["a", "b"]);
    expect(codexSessionsDirs()).toEqual([expect.stringMatching(/joind-test-no-codex-home-/)]);
  });

  it("reads a store reached under two names once", async () => {
    const f = rollout("2026/09/28", "a");
    const alias = join(root, "alias");
    symlinkSync(sessions, alias, "junction");
    const check = beginSubmitCheck(PROMPT, { sessionsDirs: [sessions, alias, join(root, "absent")], ...fast });
    expect(check.sessionsDirs).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 20));
    appendFileSync(f, userMessage(PROMPT));
    expect(await check.verify()).toMatchObject({ result: "submitted", file: f });
  });
});

describe("a busy Codex session delays the verdict, never makes one", () => {
  it("wakes queued during a turn and MERGED into one message are each found", async () => {
    const other = PROMPT.replace("mentioned by Rami", "mentioned by Curzon").replace("since=2173", "since=2170");
    for (const [i, text] of [[0, `${other}\n${PROMPT}`], [1, `${PROMPT}${other}`], [2, `${other} ${PROMPT} ${other}`]] as const) {
      const f = rollout("2026/09/28", `merged-${i}`);
      const check = beginSubmitCheck(PROMPT, { sessionsDirs: [sessions], ...fast });
      await new Promise((r) => setTimeout(r, 20));
      appendFileSync(f, i === 1 ? responseItem(text) : userMessage(text));
      expect(await check.verify()).toMatchObject({ result: "submitted", file: f });
      rmSync(f);
    }
  });

  it("mid-turn at the wake: no alarm at 30 s; found when the turn ends at 100 s, merged with another wake", async () => {
    const f = rollout("2026/09/26", "busy", turnEvent("task_started", new Date(Date.now() - 20_000)));
    const clock = script((elapsed, at) => {
      if (elapsed < 100_000) appendFileSync(f, tokenCount(at)); // the turn keeps writing
      else if (elapsed === 100_000) appendFileSync(f, turnEvent("task_complete", at) + turnEvent("task_started", at) + userMessage(`an older wake ${PROMPT}`, at));
    });
    const check = beginSubmitCheck(PROMPT, { sessionsDirs: [sessions], ...clock });
    await new Promise((r) => setTimeout(r, 20));
    const r = await check.verify();
    expect(r).toMatchObject({ result: "submitted", file: f });
    expect(r.result === "submitted" && r.afterMs).toBe(100_000);
  });

  it("an open turn that writes nothing for a while still holds the verdict (the turn began within the cap)", async () => {
    rollout("2026/09/26", "thinking", turnEvent("task_started", new Date(Date.now() - 5_000)));
    const clock = script(() => undefined);
    const check = beginSubmitCheck(PROMPT, { sessionsDirs: [sessions], ...clock, capMs: 120_000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(await check.verify()).toMatchObject({ result: "unverifiable", reason: expect.stringMatching(/not seen in 120 s .*rollout-thinking\.jsonl has a turn open/) });
  });

  it("busy, then idle, prompt never seen: NOT submitted only after the turn ended plus the grace", async () => {
    const f = rollout("2026/09/26", "busy");
    const clock = script((elapsed, at) => {
      if (elapsed === 2_000) appendFileSync(f, turnEvent("task_started", at));
      else if (elapsed < 50_000) appendFileSync(f, tokenCount(at));
      else if (elapsed === 50_000) appendFileSync(f, turnEvent("task_complete", at));
    });
    const check = beginSubmitCheck(PROMPT, { sessionsDirs: [sessions], ...clock });
    await new Promise((r) => setTimeout(r, 20));
    const r = await check.verify();
    // Last busy at the 50 s poll (it grew, carrying the end marker), then at
    // least 15 s of grace: the first quiet poll past it is at 66 s.
    expect(r).toEqual({ result: "not-submitted", waitedMs: 66_000 });
  });

  it("a turn left open an hour ago, file written recently: never taken as idle", async () => {
    rollout("2026/09/26", "dead", turnEvent("task_started", HOUR_AGO()));
    const clock = script(() => undefined);
    const check = beginSubmitCheck(PROMPT, { sessionsDirs: [sessions], ...clock });
    await new Promise((r) => setTimeout(r, 20));
    expect(await check.verify()).toMatchObject({ result: "unverifiable", reason: expect.stringMatching(/rollout-dead\.jsonl has a turn open/) });
  });

  it("the one inference from silence: a rollout untouched for over 24 h holds no live session", async () => {
    const f = rollout("2026/09/20", "ancient", turnEvent("task_started", new Date(Date.now() - 30 * 3_600_000)));
    const old = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(f, old, old);
    const clock = script(() => undefined);
    const check = beginSubmitCheck(PROMPT, { sessionsDirs: [sessions], ...clock });
    await new Promise((r) => setTimeout(r, 20));
    expect(await check.verify()).toEqual({ result: "not-submitted", waitedMs: 30_000 });
  });

  it("still busy at the cap: gives up unverified, never NOT submitted", async () => {
    const f = rollout("2026/09/26", "forever");
    const clock = script((_e, at) => appendFileSync(f, tokenCount(at)));
    const check = beginSubmitCheck(PROMPT, { sessionsDirs: [sessions], ...clock });
    await new Promise((r) => setTimeout(r, 20));
    const r = await check.verify();
    expect(r).toMatchObject({ result: "unverifiable", reason: expect.stringMatching(/not seen in 600 s and no idle state was observed/) });
  });
});

// Codex review of 987a688 (CHANGES REQUESTED), its synthetic reproducer
// ported as it was run: each case returned "not-submitted" at 30 s there.
describe("Codex review of 987a688: never NOT submitted without seeing everything", () => {
  const prompt = "[joind] @Scotty mentioned; since=2239&pid=27092";
  const event = (type: string, at: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg", payload: { type, ...extra } }) + "\n";
  const output = (at: number, text: string) =>
    JSON.stringify({ timestamp: new Date(at).toISOString(), type: "response_item", payload: { type: "function_call_output", output: text } }) + "\n";
  function fixture(name: string) {
    const store = join(root, name, "sessions");
    const folder = join(store, "2026", "09", "28");
    mkdirSync(folder, { recursive: true });
    const start = Date.now();
    let now = start;
    const clock = { now: () => now, sleep: async (ms: number) => { now += ms; await new Promise<void>((r) => setImmediate(r)); } };
    return { store, file: join(folder, "rollout-target.jsonl"), start, clock, elapsed: () => now - start, setOnSleep: (fn: (elapsed: number) => void) => { clock.sleep = async (ms: number) => { now += ms; fn(now - start); await new Promise<void>((r) => setImmediate(r)); }; } };
  }

  it("P1 snapshot race: a prompt plus 150 KB written the moment the check begins is found", async () => {
    const fx = fixture("race");
    writeFileSync(fx.file, event("task_complete", fx.start - 1000));
    const check = beginSubmitCheck(prompt, { sessionsDirs: [fx.store], ...fx.clock });
    appendFileSync(fx.file, event("user_message", fx.start + 1, { message: prompt }) + output(fx.start + 2, "x".repeat(150_000)));
    expect(await check.verify()).toMatchObject({ result: "submitted", file: fx.file });
  });

  it("P1 turn state: an open-turn marker buried before a 100 KB tail is found; unverifiable, not NOT submitted", async () => {
    const fx = fixture("buried");
    writeFileSync(fx.file, event("task_started", fx.start - 5000) + output(fx.start - 1000, "x".repeat(100_000)));
    const check = beginSubmitCheck(prompt, { sessionsDirs: [fx.store], ...fx.clock });
    await new Promise((r) => setTimeout(r, 40));
    expect(await check.verify()).toMatchObject({ result: "unverifiable", reason: expect.stringMatching(/has a turn open/) });
  });

  it("P1 turn state: a silent turn open for longer than the cap is unverifiable, not NOT submitted", async () => {
    const fx = fixture("old-open");
    writeFileSync(fx.file, event("task_started", fx.start - 700_000));
    const check = beginSubmitCheck(prompt, { sessionsDirs: [fx.store], ...fx.clock });
    await new Promise((r) => setTimeout(r, 40));
    expect(await check.verify()).toMatchObject({ result: "unverifiable", reason: expect.stringMatching(/has a turn open/) });
  });

  it("P1 turn state: a turn marker beyond the backscan cap is unknown, so unverifiable", async () => {
    // Stated through the reason: unknown turn state is reported as such.
    const fx = fixture("no-marker-in-reach");
    writeFileSync(fx.file, event("task_complete", fx.start - 9000) + output(fx.start - 1000, "y".repeat(40_000_000)));
    const check = beginSubmitCheck(prompt, { sessionsDirs: [fx.store], ...fx.clock });
    await new Promise((r) => setTimeout(r, 40));
    expect(await check.verify()).toMatchObject({ result: "unverifiable" });
  }, 60_000);

  it("P2: a store that disappears before the first look is unverifiable", async () => {
    const fx = fixture("missing-store");
    writeFileSync(fx.file, event("task_complete", fx.start - 1000));
    const check = beginSubmitCheck(prompt, { sessionsDirs: [fx.store], ...fx.clock });
    await new Promise((r) => setTimeout(r, 40));
    renameSync(fx.store, join(root, "missing-store", "sessions-unavailable"));
    expect(await check.verify()).toMatchObject({ result: "unverifiable" });
  });

  it("P2: a store that disappears during the check is unverifiable, not NOT submitted", async () => {
    const fx = fixture("store-goes");
    writeFileSync(fx.file, event("task_complete", fx.start - 1000));
    fx.setOnSleep((elapsed) => { if (elapsed === 4_000) renameSync(fx.store, join(root, "store-goes", "gone")); });
    const check = beginSubmitCheck(prompt, { sessionsDirs: [fx.store], ...fx.clock });
    const r = await check.verify();
    expect(r).toMatchObject({ result: "unverifiable", reason: expect.stringMatching(/became unreadable/) });
  });

  it("P2: a rollout that goes out of view during the check is unverifiable, not NOT submitted", async () => {
    const fx = fixture("file-goes");
    writeFileSync(fx.file, event("task_complete", fx.start - 1000));
    fx.setOnSleep((elapsed) => { if (elapsed === 4_000) renameSync(fx.file, join(root, "file-goes", "moved.jsonl")); });
    const check = beginSubmitCheck(prompt, { sessionsDirs: [fx.store], ...fx.clock });
    expect(await check.verify()).toMatchObject({ result: "unverifiable", reason: expect.stringMatching(/rollout-target\.jsonl went out of view/) });
  });

  it("control: the same idle store, fully readable, is NOT submitted at 30 s", async () => {
    const fx = fixture("control");
    writeFileSync(fx.file, event("task_complete", fx.start - 1000));
    const check = beginSubmitCheck(prompt, { sessionsDirs: [fx.store], ...fx.clock });
    expect(await check.verify()).toEqual({ result: "not-submitted", waitedMs: 30_000 });
  });
});

describe("the room says a typed Codex wake was not submitted, and only then", () => {
  const tick = () => new Promise<void>((r) => setImmediate(r));
  async function settle(rounds = 40): Promise<void> { for (let i = 0; i < rounds; i++) await tick(); }
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.mode = "codex"; state.console = []; state.orca = []; state.onType = null;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** A room whose submit check runs on a fake clock: each poll moves it on by its sleep. */
  function roomWithStore(dir: string): ChatRoom {
    const room = new ChatRoom();
    let t = Date.now();
    room.submitCheckOptions = { sessionsDirs: [dir], now: () => t, sleep: async (ms) => { t += ms; await tick(); } };
    return room;
  }
  async function mention(room: ChatRoom, text = "@Scotty ping"): Promise<void> {
    room.send("Rami", text);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle(200);
  }
  const lines = (room: ChatRoom) => room.read(undefined, 100).map((m) => m.text).filter((t) => /NOT submitted/.test(t));
  /** The check does real file I/O: give the event loop turns until it has spoken. */
  async function verified(name: string): Promise<void> {
    const said = `[verify] ${name}:`;
    for (let i = 0; i < 100_000 && !logs.some((l) => l.includes(said)); i++) await tick();
  }

  it("submitted: the prompt reached the store, the log says so, the room hears nothing", async () => {
    const f = rollout("2026/09/26", "scotty");
    state.onType = (text) => appendFileSync(f, userMessage(text));
    const room = roomWithStore(sessions);
    room.join("Scotty", 27092);
    try {
      await mention(room);
      await verified("Scotty");
      expect(state.console).toEqual([27092]);
      expect(lines(room)).toEqual([]);
      expect(logs.some((l) => /^ {2}\[verify\] Scotty: submitted \(seen in rollout-scotty\.jsonl after \d+ s\)$/.test(l))).toBe(true);
    } finally {
      room.destroy();
    }
  });

  it("not submitted: one line naming the agent and its pid, even with the same prompt in the store from before", async () => {
    const room = roomWithStore(sessions);
    room.join("Scotty", 27092);
    try {
      // The previous wake's identical prompt, submitted an hour ago.
      rollout("2026/09/26", "scotty", userMessage(room["buildWakePrompt"]("Rami", room.getAgent("Scotty")!, undefined, 1), HOUR_AGO()));
      await mention(room);
      await verified("Scotty");
      expect(state.console).toEqual([27092]);
      expect(lines(room)).toEqual([
        "Typed into Scotty (pid 27092) but NOT submitted within 30 s: no matching prompt in the Codex session store. The text is probably sitting in their input box; it needs Enter by hand.",
      ]);
      expect(lines(room)[0]).toBe(notSubmittedLine("Scotty", 27092));
    } finally {
      room.destroy();
    }
  });

  it("mid-turn target: no line at 30 s; the wake is found merged into the message submitted when the turn ends", async () => {
    const f = rollout("2026/09/26", "scotty", turnEvent("task_started", new Date(Date.now() - 10_000)));
    let typed = "";
    state.onType = (text) => { typed = text; };
    const room = new ChatRoom();
    const start = Date.now();
    let t = start;
    room.submitCheckOptions = {
      sessionsDirs: [sessions], now: () => t,
      sleep: async (ms) => {
        t += ms;
        const at = new Date(t);
        if (t - start < 90_000) appendFileSync(f, tokenCount(at));
        else if (typed) { appendFileSync(f, turnEvent("task_complete", at) + turnEvent("task_started", at) + userMessage(`an earlier queued wake\n${typed}`, at)); typed = ""; }
        await tick();
      },
    };
    room.join("Scotty", 27092);
    try {
      await mention(room);
      await verified("Scotty");
      expect(lines(room)).toEqual([]);
      expect(logs.some((l) => /\[verify\] Scotty: submitted \(seen in rollout-scotty\.jsonl after 90 s\)$/.test(l))).toBe(true);
    } finally {
      room.destroy();
    }
  });

  it("store absent: logged as not verifiable, nothing said", async () => {
    const room = roomWithStore(join(root, "missing"));
    room.join("Scotty", 27092);
    try {
      await mention(room);
      await verified("Scotty");
      expect(state.console).toEqual([27092]);
      expect(lines(room)).toEqual([]);
      expect(logs.some((l) => /\[verify\] Scotty: not verifiable \(no Codex session store at .*\); nothing said/.test(l))).toBe(true);
    } finally {
      room.destroy();
    }
  });

  it("a target that is not Codex is not checked", async () => {
    state.mode = "default";
    const room = roomWithStore(sessions);
    room.join("Scotty", 27092);
    try {
      await mention(room);
      expect(state.console).toEqual([27092]);
      expect(lines(room)).toEqual([]);
      expect(logs.some((l) => /\[verify\]/.test(l))).toBe(false);
    } finally {
      room.destroy();
    }
  });

  it("the Orca route is not checked: Orca answers for its own send", async () => {
    const room = roomWithStore(sessions);
    room.join("Scotty", 27092, undefined, undefined, "term_0816c47b-7bc3-4cbe-9903-f686a0b73b16");
    try {
      await mention(room);
      expect(state.orca).toHaveLength(1);
      expect(state.console).toEqual([]);
      expect(lines(room)).toEqual([]);
      expect(logs.some((l) => /\[verify\]/.test(l))).toBe(false);
    } finally {
      room.destroy();
    }
  });

  it("a hosted wake is checked on the host, where the keys were typed, and only logged there", async () => {
    vi.useRealTimers();
    const room = roomWithStore(sessions);
    room.join("Curzon", 999_991, undefined, undefined, undefined, undefined, "reg-local");
    try {
      const r = await room.wakeForPeer("Rami", "Curzon", "reg-local", `"ops" on y530`);
      expect(r).toMatchObject({ ok: true });
      await verified("Curzon");
      expect(logs.some((l) => /\[verify\] Curzon: NOT submitted \(pid 999991, .*\); hosted wake, not reported to the home room$/.test(l))).toBe(true);
      expect(lines(room)).toEqual([]);
    } finally {
      room.destroy();
    }
  });
});

/**
 * Submit check: did a wake typed into a Codex session get submitted?
 *
 * A keystroke route (the Windows console, WezTerm, tmux) knows only that the
 * keys were written. On 28 Sep 2026 a Codex CLI 0.157.1 TUI took every
 * wake's text and none of its Enters: the server logged "Injected 311 chars
 * + Enter (double=True)" as success while the prompt sat in the input box
 * for hours. This module only observes: it never presses a key, retypes,
 * delays or retries anything.
 *
 * Codex writes every submitted user prompt to a rollout file,
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl (CODEX_HOME defaults to
 * ~/.codex), as a line of either shape:
 *   {"timestamp":..,"type":"event_msg","payload":{"type":"user_message","message":"<text>",..}}
 *   {"timestamp":..,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<text>"}]}}
 * A session keeps writing to the file of the day it STARTED, so every day
 * directory is a candidate, not only today's. Several sessions share the
 * store and a rollout names no pid (session_meta carries an id, cwd and
 * version only), so the check does not map pid to file: it looks in every
 * rollout for a line written after the injection started.
 *
 * The match is strict, so an older prompt can never pass for this one:
 * - The line must be one of the two user-message shapes above (a "compacted"
 *   line replays old user messages in its history, and tool output can quote
 *   a prompt; neither shape counts).
 * - Its text must contain the EXACT prompt that was typed, whole, anywhere
 *   inside it: Codex queues input typed during a turn and submits it when
 *   the turn ends, several queued wakes MERGED into one user message (seen
 *   28 Sep 2026: two and three wake texts in one message, 90 to 120 s after
 *   the first was typed).
 * - Its timestamp must be at or after the moment the check began, which is
 *   just before the first key was typed (same machine, same clock). Two wakes
 *   with identical text (same sender, cursor unchanged) are told apart by
 *   this, never by the text.
 *
 * Where reading starts is decided by time, not by a size taken beforehand
 * (a size taken while the keys go in can already lie past the prompt): on
 * first contact each file is read BACKWARDS from its end until a line
 * stamped before the check began, and on until its last turn marker, so
 * every line written since the start and the session's turn state are both
 * seen. After that, only appended bytes are read. Rollout lines are
 * appended in time order, which is what makes the backward boundary sound.
 *
 * The verdict. "Submitted" needs the line above. "NOT submitted" needs
 * positive evidence that nothing is still pending: every live rollout seen
 * idle (its last turn marker a task_complete or turn_aborted, or the whole
 * file read with no turn in it), nothing written for 15 s, at least 30 s
 * since the keys, and every store and file read without a gap the whole
 * time. A turn left open (task_started last), a marker too far back to
 * find, or a read that failed never yields "NOT submitted": the check keeps
 * looking up to a 10 min cap, then says "unverifiable" (logged only). With
 * no pid-to-file mapping this is judged over every live rollout, so a busy
 * neighbour delays the verdict or makes it unverifiable, never negative.
 *
 * The one inference from silence: a rollout not written for 24 h
 * (SUBMIT_CHECK_LIVE_HORIZON_MS) is taken as holding no live session and is
 * not read, unless it grows during the check. Without it the check could
 * never say anything: on the Y530 on 28 Sep 2026 five rollouts in each
 * store ended on a turn left open more than 24 h earlier (sessions ended
 * mid-turn).
 *
 * Which store: the server's CODEX_HOME need not be the target's (the Y530's
 * server environment named an Orca runtime home, while a Codex started
 * outside Orca writes to ~/.codex), so both $CODEX_HOME/sessions and
 * ~/.codex/sessions are read, once each. JOIND_CODEX_SESSIONS (a list in the
 * platform's path-list form) replaces both when set: for a Codex that runs
 * with yet another home, and for the test suite, which must never read the
 * real store.
 *
 * TODO: each wake runs its own check, listing and stating every rollout
 * every 2 s for up to 10 min. Several wakes at once multiply that; a shared
 * poller per store (and cancelling a check whose agent left) would bound it.
 */

import { open, readdir, realpath, stat, type FileHandle } from "fs/promises";
import { homedir } from "os";
import { basename, delimiter, join } from "path";

/** How often the store is looked at after the keys were written. */
export const SUBMIT_CHECK_POLL_MS = 2000;
/** The least time after the keys before "NOT submitted" may be said. */
export const SUBMIT_CHECK_WINDOW_MS = 30000;
/** After the last sign of a busy session, how long to keep looking: Codex
 *  submits input queued during a turn when the turn ends. */
export const SUBMIT_CHECK_GRACE_MS = 15000;
/** The most a check waits; past it, anything short of a match is unverifiable. */
export const SUBMIT_CHECK_CAP_MS = 10 * 60 * 1000;
/** A rollout not written for this long before the check holds no live session. */
export const SUBMIT_CHECK_LIVE_HORIZON_MS = 24 * 60 * 60 * 1000;
/** The most bytes read backwards from one file on first contact. */
export const SUBMIT_CHECK_BACKSCAN_MAX_BYTES = 32 * 1024 * 1024;
/** Backward reads go in chunks of this size. */
const BACKSCAN_CHUNK = 64 * 1024;
/** The most bytes read forwards from one file per poll; the rest waits for the next. */
const MAX_READ_PER_POLL = 8 * 1024 * 1024;
/** A single line longer than this (a huge tool output) is skipped, not held. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type SubmitCheckResult =
  | { result: "submitted"; file: string; afterMs: number }
  | { result: "not-submitted"; waitedMs: number }
  | { result: "unverifiable"; reason: string };

export interface SubmitCheckOptions {
  /** The sessions directories; codexSessionsDirs() when unset. */
  sessionsDirs?: string[];
  pollMs?: number;
  windowMs?: number;
  graceMs?: number;
  capMs?: number;
  liveHorizonMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A check begun just before typing: `verify()` once the keys are written. */
export interface PendingSubmitCheck {
  readonly startedAt: number;
  readonly sessionsDirs: readonly string[];
  verify(): Promise<SubmitCheckResult>;
}

/** Where Codex may keep its rollouts on this machine (see the file header). */
export function codexSessionsDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.JOIND_CODEX_SESSIONS?.trim();
  if (explicit) return [...new Set(explicit.split(delimiter).map((d) => d.trim()).filter(Boolean))];
  const dirs: string[] = [];
  const home = env.CODEX_HOME?.trim();
  if (home) dirs.push(join(home, "sessions"));
  dirs.push(join(homedir(), ".codex", "sessions"));
  return [...new Set(dirs)];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errText(err: unknown): string {
  const code = isRecord(err) && typeof err.code === "string" ? err.code : "";
  return code || (err instanceof Error ? err.message.split("\n")[0].slice(0, 80) : "error");
}

/**
 * Every rollout file under `dir` (YYYY/MM/DD/rollout-*.jsonl), and every
 * directory below it that could not be listed (its contents went unseen).
 * Throws when `dir` itself cannot be read.
 */
export async function listRollouts(dir: string): Promise<{ files: string[]; unlisted: string[] }> {
  const files: string[] = [];
  const unlisted: string[] = [];
  const subdirs = async (p: string, re: RegExp): Promise<string[]> => {
    try {
      return (await readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory() && re.test(e.name)).map((e) => join(p, e.name));
    } catch (err) {
      unlisted.push(`${p} (${errText(err)})`);
      return [];
    }
  };
  const years = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name)).map((e) => join(dir, e.name));
  for (const y of years) {
    for (const m of await subdirs(y, /^\d{2}$/)) {
      for (const d of await subdirs(m, /^\d{2}$/)) {
        try {
          for (const e of await readdir(d, { withFileTypes: true })) {
            if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) files.push(join(d, e.name));
          }
        } catch (err) {
          unlisted.push(`${d} (${errText(err)})`);
        }
      }
    }
  }
  return { files, unlisted };
}

/** A line's timestamp in ms, read from its head without parsing the whole
 *  line; NaN when it has none. Every rollout line starts with it. */
export function lineTime(line: string): number {
  const m = /^\{"timestamp":"([^"]{10,40})"/.exec(line.slice(0, 64));
  return m ? Date.parse(m[1]) : NaN;
}

/**
 * Is `line` a user message, written at or after `startedAt`, whose text
 * contains the whole `prompt`? See the file header for why each rule holds.
 */
export function lineSubmitsPrompt(line: string, prompt: string, startedAt: number): boolean {
  // Cheap filter first: most lines are tool calls and outputs, some huge.
  if (!line.includes('"user_message"') && !line.includes('"role":"user"')) return false;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return false;
  }
  if (!isRecord(obj) || !isRecord(obj.payload) || typeof obj.timestamp !== "string") return false;
  const at = Date.parse(obj.timestamp);
  if (!Number.isFinite(at) || at < startedAt) return false;
  const p = obj.payload;
  if (obj.type === "event_msg" && p.type === "user_message") {
    return typeof p.message === "string" && p.message.includes(prompt);
  }
  if (obj.type === "response_item" && p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
    return p.content.some((c) => isRecord(c) && typeof c.text === "string" && c.text.includes(prompt));
  }
  return false;
}

/** A turn marker line: "start" (task_started), "end" (task_complete or
 *  turn_aborted); null for any other line. */
export function turnMarker(line: string): "start" | "end" | null {
  if (!line.includes('"task_started"') && !line.includes('"task_complete"') && !line.includes('"turn_aborted"')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(obj) || obj.type !== "event_msg" || !isRecord(obj.payload)) return null;
  const t = obj.payload.type;
  if (t === "task_started") return "start";
  if (t === "task_complete" || t === "turn_aborted") return "end";
  return null;
}

/** What a rollout says about its session's turn: "open" (task_started
 *  last), "ended" (task_complete or turn_aborted last), "none" (the whole
 *  file read, no turn in it), "unknown" (no marker within reach). */
type TurnState = "open" | "ended" | "none" | "unknown";

/** Where forward reading of one file stands, and what it says. */
interface FileCursor {
  offset: number;
  /** The unfinished last line of the previous read. */
  carry: Buffer;
  /** Discard up to and including the next newline (a line outgrew MAX_LINE_BYTES). */
  skipToNewline: boolean;
  turn: TurnState;
  /** The size last seen: growth since is activity. */
  lastSize: number;
}

/** Split `data` on newlines into every part, the last one after the final newline. */
function parts(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let from = 0;
  let nl: number;
  while ((nl = data.indexOf(0x0a, from)) >= 0) {
    out.push(data.subarray(from, nl));
    from = nl + 1;
  }
  out.push(data.subarray(from));
  return out;
}

async function readExactly(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const got = (await fh.read(buf, 0, len, pos)).bytesRead;
  if (got !== len) throw new Error(`short read (${got} of ${len} bytes at ${pos})`);
  return buf;
}

/**
 * Begin a check for `prompt` now, just before the first key is typed. No
 * I/O happens here: the clock starts, nothing else. `verify()` then looks
 * every pollMs until the prompt is found, "NOT submitted" is proven (see the
 * file header), or the cap is reached.
 */
export function beginSubmitCheck(prompt: string, opts: SubmitCheckOptions = {}): PendingSubmitCheck {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? SUBMIT_CHECK_POLL_MS;
  const windowMs = opts.windowMs ?? SUBMIT_CHECK_WINDOW_MS;
  const graceMs = opts.graceMs ?? SUBMIT_CHECK_GRACE_MS;
  const capMs = opts.capMs ?? SUBMIT_CHECK_CAP_MS;
  const horizonMs = opts.liveHorizonMs ?? SUBMIT_CHECK_LIVE_HORIZON_MS;
  const dirs = opts.sessionsDirs ?? codexSessionsDirs();
  const startedAt = now();
  const needle = prompt.trim();
  const cursors = new Map<string, FileCursor>();
  /** The first thing that went unseen; once set, no negative verdict. */
  let gap: string | null = null;
  const noteGap = (why: string): void => { gap ??= why; };

  /**
   * First contact with `file` (`size` bytes now): read it backwards until a
   * line stamped before the start AND its last turn marker have both been
   * seen, or its head, or the backscan cap. True when a line written since
   * the start holds the prompt; otherwise the cursor to read on from.
   */
  async function backscan(fh: FileHandle, file: string, size: number): Promise<true | FileCursor> {
    // The end of the last complete line; an unfinished one is read forwards later.
    let end = 0;
    let skipFirst = false;
    for (let p = size; p > 0;) {
      if (size - p >= MAX_LINE_BYTES) { end = size; skipFirst = true; break; } // one huge unfinished line
      const len = Math.min(BACKSCAN_CHUNK, p);
      p -= len;
      const i = (await readExactly(fh, p, len)).lastIndexOf(0x0a);
      if (i >= 0) { end = p + i + 1; break; }
    }
    if (skipFirst) noteGap(`${basename(file)}: an unfinished line longer than ${MAX_LINE_BYTES} bytes`);
    // Backwards over [0, end), whole lines only, newest first. `carry` is the
    // head fragment of the region already read: the end of a line that
    // starts in an earlier chunk.
    let pos = end;
    let carry = Buffer.alloc(0);
    let dropLast = false;
    let boundary = false;
    let turn: "open" | "ended" | null = null;
    scan: while (pos > 0) {
      if (end - pos >= SUBMIT_CHECK_BACKSCAN_MAX_BYTES) break;
      const len = Math.min(BACKSCAN_CHUNK, pos);
      pos -= len;
      const ps = parts(Buffer.concat([await readExactly(fh, pos, len), carry]));
      // The last part is a whole line (or empty at `end`), the first part is
      // whole only at the file's head.
      const lowest = pos === 0 ? 0 : 1;
      for (let i = ps.length - 1; i >= lowest; i--) {
        if (i === ps.length - 1 && dropLast) { dropLast = false; continue; }
        const line = ps[i].toString("utf8");
        const at = lineTime(line);
        if (!Number.isFinite(at)) continue;
        if (at >= startedAt) {
          if (lineSubmitsPrompt(line, needle, startedAt)) return true;
        } else boundary = true;
        if (turn === null) {
          const m = turnMarker(line);
          if (m) turn = m === "start" ? "open" : "ended";
        }
        if (boundary && turn !== null) break scan;
      }
      carry = pos === 0 ? Buffer.alloc(0) : Buffer.from(ps[0]);
      if (carry.length > MAX_LINE_BYTES) { carry = Buffer.alloc(0); dropLast = true; }
    }
    const whole = pos === 0;
    // Lines since the start that the backscan could not reach went unseen.
    if (!boundary && !whole) noteGap(`${basename(file)}: more than ${SUBMIT_CHECK_BACKSCAN_MAX_BYTES} bytes to read back`);
    return {
      offset: end, carry: Buffer.alloc(0), skipToNewline: skipFirst,
      turn: turn ?? (whole ? "none" : "unknown"), lastSize: size,
    };
  }

  /** Read what `file` gained since the last look, up to `size`: true when it
   *  holds the prompt. Turn markers on the way update the cursor. */
  async function readForward(fh: FileHandle, size: number, cur: FileCursor): Promise<boolean> {
    if (size <= cur.offset) return false;
    const len = Math.min(size - cur.offset, MAX_READ_PER_POLL);
    const buf = await readExactly(fh, cur.offset, len);
    cur.offset += len;
    const ps = parts(cur.carry.length > 0 ? Buffer.concat([cur.carry, buf]) : buf);
    const rest = ps.pop() ?? Buffer.alloc(0);
    for (const raw of ps) {
      if (cur.skipToNewline) { cur.skipToNewline = false; continue; }
      const line = raw.toString("utf8");
      if (lineSubmitsPrompt(line, needle, startedAt)) return true;
      const m = turnMarker(line);
      if (m) cur.turn = m === "start" ? "open" : "ended";
    }
    if (cur.skipToNewline || rest.length > MAX_LINE_BYTES) {
      cur.carry = Buffer.alloc(0);
      cur.skipToNewline = true;
    } else {
      cur.carry = Buffer.from(rest);
    }
    return false;
  }

  return {
    startedAt,
    sessionsDirs: dirs,
    async verify(): Promise<SubmitCheckResult> {
      // The stores readable now, each real directory once.
      const seen = new Set<string>();
      const stores: string[] = [];
      const problems: string[] = [];
      for (const dir of dirs) {
        try {
          const real = await realpath(dir);
          if (seen.has(real)) continue;
          seen.add(real);
          await readdir(dir);
          stores.push(dir);
        } catch (err) {
          const code = errText(err);
          problems.push(code === "ENOENT" ? `no Codex session store at ${dir}` : `the Codex session store at ${dir} is unreadable (${code})`);
        }
      }
      if (stores.length === 0) return { result: "unverifiable", reason: problems.join("; ") || "no Codex session store configured" };
      const typedAt = now();
      let lastBusyAt: number | undefined;
      for (;;) {
        let busy = false;
        const files: string[] = [];
        for (const dir of stores) {
          try {
            const listed = await listRollouts(dir);
            files.push(...listed.files);
            for (const u of listed.unlisted) noteGap(`could not list ${u}`);
          } catch (err) {
            noteGap(`the Codex session store at ${dir} became unreadable (${errText(err)})`);
          }
        }
        const listed = new Set(files);
        for (const f of cursors.keys()) {
          if (!listed.has(f)) noteGap(`${basename(f)} went out of view`);
        }
        for (const file of files) {
          let cur = cursors.get(file);
          let fh: FileHandle | undefined;
          try {
            const st = await stat(file);
            // Not written within the live horizon and never read: no live session.
            if (!cur && st.mtimeMs < startedAt - horizonMs) continue;
            fh = await open(file, "r");
            if (!cur) {
              const first = await backscan(fh, file, st.size);
              if (first === true) return { result: "submitted", file, afterMs: now() - typedAt };
              cur = first;
              cursors.set(file, cur);
            } else if (st.size > cur.lastSize) {
              busy = true; // written since the last look
            }
            cur.lastSize = st.size;
            if (await readForward(fh, st.size, cur)) return { result: "submitted", file, afterMs: now() - typedAt };
          } catch (err) {
            noteGap(`${basename(file)} could not be read (${errText(err)})`);
          } finally {
            await fh?.close().catch(() => undefined);
          }
          if (cur && (cur.turn === "open" || cur.turn === "unknown")) busy = true;
        }
        const t = now();
        const waited = t - typedAt;
        if (busy) lastBusyAt = t;
        const quietFor = lastBusyAt === undefined ? Number.POSITIVE_INFINITY : t - lastBusyAt;
        if (!busy && waited >= windowMs && quietFor >= graceMs) {
          // Every live session seen idle and quiet: negative, unless something went unseen.
          if (gap) return { result: "unverifiable", reason: `not seen, but not everything could be read: ${gap}` };
          return { result: "not-submitted", waitedMs: waited };
        }
        if (waited >= capMs) {
          const pending = [...cursors.entries()]
            .filter(([, c]) => c.turn === "open" || c.turn === "unknown")
            .map(([f, c]) => `${basename(f)} ${c.turn === "open" ? "has a turn open" : "shows no turn marker within reach"}`);
          const why = pending.slice(0, 3).join("; ") || "sessions kept writing";
          return { result: "unverifiable", reason: `not seen in ${Math.round(waited / 1000)} s and no idle state was observed (${why})${gap ? `; also ${gap}` : ""}` };
        }
        await sleep(waited < windowMs ? Math.min(pollMs, windowMs - waited) : pollMs);
      }
    },
  };
}

/** The file name alone, for log lines. */
export function rolloutName(file: string): string {
  return basename(file);
}

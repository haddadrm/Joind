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
 * time. Anything not read cannot support "NOT submitted": a line longer
 * than SUBMIT_CHECK_MAX_LINE_BYTES (32 MB; lines up to it are held and
 * inspected whole, so a huge merged message is still searched) is a gap on
 * either read path, and bytes not yet read or an unfinished last line hold
 * the verdict back until they are whole. A turn left open (task_started
 * last), a marker too far back to find, or a read that failed never yields
 * "NOT submitted": the check keeps
 * looking up to a 10 min cap, then says "unverifiable" (logged only). With
 * no pid-to-file mapping this is judged over every live rollout, so a busy
 * neighbour delays the verdict or makes it unverifiable, never negative.
 *
 * The one inference from silence: a rollout not written for 24 h
 * (SUBMIT_CHECK_LIVE_HORIZON_MS) is taken as holding no live session and is
 * not read, unless it grows during the check. Without it the check could
 * never say anything: on the Y530 on 28 Sep 2026 five rollouts in each
 * store ended on a turn left open more than 24 h earlier (sessions ended
 * mid-turn). It is a policy, not proof, and it has a known counterexample
 * (Codex review of 2d245bf): a session whose turn has been open for over
 * 24 h without writing (waiting for an approval, or a silent tool) reads as
 * idle, so a wake queued behind it can be reported not seen; with
 * liveHorizonMs Infinity the same case is unverifiable. So the negative
 * result carries how many rollouts the horizon left unread, and the room
 * words it as unconfirmed, never as a bare "NOT submitted".
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
/** The longest line held and inspected whole. A longer one (a huge tool
 *  output, or a huge merged message) is not inspected, and that is a gap:
 *  what was not read cannot support "NOT submitted". */
export const SUBMIT_CHECK_MAX_LINE_BYTES = 32 * 1024 * 1024;

export type SubmitCheckResult =
  | { result: "submitted"; file: string; afterMs: number }
  /** Not seen, every live rollout seen idle and fully read. Unconfirmed all
   *  the same: `excludedStale` rollouts were not read because they had not
   *  been written within `horizonMs` (see the file header). */
  | { result: "not-submitted"; waitedMs: number; excludedStale: number; horizonMs: number }
  | { result: "unverifiable"; reason: string };

export interface SubmitCheckOptions {
  /** The sessions directories; codexSessionsDirs() when unset. */
  sessionsDirs?: string[];
  pollMs?: number;
  windowMs?: number;
  graceMs?: number;
  capMs?: number;
  liveHorizonMs?: number;
  /** SUBMIT_CHECK_MAX_LINE_BYTES and SUBMIT_CHECK_BACKSCAN_MAX_BYTES when
   *  unset; lowered by tests, to keep their fixtures small. */
  maxLineBytes?: number;
  backscanMaxBytes?: number;
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
  /** The unfinished last line so far, in pieces (joined once, when it ends). */
  carry: Buffer[];
  carryLen: number;
  /** Discard up to and including the next newline: a line outgrew the
   *  limit and was not inspected (already noted as a gap). */
  skipToNewline: boolean;
  turn: TurnState;
  /** The size last seen: growth since is activity. */
  lastSize: number;
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
 * every pollMs until the prompt is found, "NOT submitted" is established
 * (see the file header), or the cap is reached.
 */
export function beginSubmitCheck(prompt: string, opts: SubmitCheckOptions = {}): PendingSubmitCheck {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? SUBMIT_CHECK_POLL_MS;
  const windowMs = opts.windowMs ?? SUBMIT_CHECK_WINDOW_MS;
  const graceMs = opts.graceMs ?? SUBMIT_CHECK_GRACE_MS;
  const capMs = opts.capMs ?? SUBMIT_CHECK_CAP_MS;
  const horizonMs = opts.liveHorizonMs ?? SUBMIT_CHECK_LIVE_HORIZON_MS;
  const maxLine = opts.maxLineBytes ?? SUBMIT_CHECK_MAX_LINE_BYTES;
  const backscanMax = opts.backscanMaxBytes ?? SUBMIT_CHECK_BACKSCAN_MAX_BYTES;
  const dirs = opts.sessionsDirs ?? codexSessionsDirs();
  const startedAt = now();
  const needle = prompt.trim();
  const cursors = new Map<string, FileCursor>();
  /** The first thing that went unseen; once set, no negative verdict. */
  let gap: string | null = null;
  const noteGap = (why: string): void => { gap ??= why; };
  const tooLong = (file: string): string => `${basename(file)}: a line longer than ${maxLine} bytes was not inspected`;

  /**
   * First contact with `file` (`size` bytes now): read it backwards until a
   * line stamped before the start AND its last turn marker have both been
   * seen, or its head, or the backscan cap. True when a line written since
   * the start holds the prompt; otherwise the cursor to read on from.
   */
  async function backscan(fh: FileHandle, file: string, size: number): Promise<true | FileCursor> {
    // The end of the last complete line. What follows it is an unfinished
    // line, left to the forward reader, which holds any negative verdict
    // back until it ends.
    let end = 0;
    for (let p = size; p > 0;) {
      if (size - p >= maxLine) {
        // An unfinished line already too long to hold: never inspected, and
        // nothing before it was reached.
        noteGap(tooLong(file));
        return { offset: size, carry: [], carryLen: 0, skipToNewline: true, turn: "unknown", lastSize: size };
      }
      const len = Math.min(BACKSCAN_CHUNK, p);
      p -= len;
      const i = (await readExactly(fh, p, len)).lastIndexOf(0x0a);
      if (i >= 0) { end = p + i + 1; break; }
    }
    let boundary = false;
    let turn: "open" | "ended" | null = null;
    /** One whole line, newest first: "match", "stop" (boundary and marker
     *  both seen) or "go". */
    const look = (line: string): "match" | "stop" | "go" => {
      const at = lineTime(line);
      if (!Number.isFinite(at)) return "go";
      if (at >= startedAt) {
        if (lineSubmitsPrompt(line, needle, startedAt)) return "match";
      } else boundary = true;
      if (turn === null) {
        const m = turnMarker(line);
        if (m) turn = m === "start" ? "open" : "ended";
      }
      return boundary && turn !== null ? "stop" : "go";
    };
    // A line too long to hold is skipped whole. It is a gap unless a line
    // after it was already stamped before the start (then it is older still:
    // rollout lines are appended in time order).
    const skipped = (): void => { if (!boundary) noteGap(tooLong(file)); };
    // Backwards over [0, end), whole lines only, newest first. `pieces` is
    // the end of a line whose start lies in an earlier chunk.
    let pos = end;
    let pieces: Buffer[] = [];
    let piecesLen = 0;
    let dropping = false;
    scan: while (pos > 0) {
      if (end - pos >= backscanMax) break;
      const len = Math.min(BACKSCAN_CHUNK, pos);
      pos -= len;
      const chunk = await readExactly(fh, pos, len);
      let hi = len;
      for (;;) {
        const nl = hi > 0 ? chunk.lastIndexOf(0x0a, hi - 1) : -1;
        if (nl < 0) break;
        // A whole line: chunk[nl + 1, hi) then the pieces after it.
        if (dropping) {
          dropping = false;
          skipped();
        } else {
          const seg = chunk.subarray(nl + 1, hi);
          const r = look((pieces.length > 0 ? Buffer.concat([seg, ...pieces]) : seg).toString("utf8"));
          if (r === "match") return true;
          if (r === "stop") break scan;
        }
        pieces = [];
        piecesLen = 0;
        hi = nl;
      }
      // chunk[0, hi) belongs to a line that starts earlier (or is the file's first).
      if (!dropping && hi > 0) {
        pieces.unshift(chunk.subarray(0, hi));
        piecesLen += hi;
        if (piecesLen > maxLine) { pieces = []; piecesLen = 0; dropping = true; }
      }
      if (pos === 0) {
        if (dropping) skipped();
        else if (piecesLen > 0) {
          if (look(Buffer.concat(pieces).toString("utf8")) === "match") return true;
        }
      }
    }
    const whole = pos === 0;
    // Lines since the start that the backscan could not reach went unseen.
    if (!boundary && !whole) noteGap(`${basename(file)}: more than ${backscanMax} bytes to read back`);
    return { offset: end, carry: [], carryLen: 0, skipToNewline: false, turn: turn ?? (whole ? "none" : "unknown"), lastSize: size };
  }

  /** Read what `file` gained since the last look, up to `size` (at most
   *  MAX_READ_PER_POLL of it): true when it holds the prompt. Turn markers
   *  on the way update the cursor. */
  async function readForward(fh: FileHandle, file: string, size: number, cur: FileCursor): Promise<boolean> {
    if (size <= cur.offset) return false;
    const len = Math.min(size - cur.offset, MAX_READ_PER_POLL);
    const buf = await readExactly(fh, cur.offset, len);
    cur.offset += len;
    let from = 0;
    let nl: number;
    while ((nl = buf.indexOf(0x0a, from)) >= 0) {
      const seg = buf.subarray(from, nl);
      from = nl + 1;
      if (cur.skipToNewline) { cur.skipToNewline = false; continue; } // its gap is already noted
      const whole = cur.carry.length > 0 ? Buffer.concat([...cur.carry, seg]) : seg;
      cur.carry = [];
      cur.carryLen = 0;
      const line = whole.toString("utf8");
      if (lineSubmitsPrompt(line, needle, startedAt)) return true;
      const m = turnMarker(line);
      if (m) cur.turn = m === "start" ? "open" : "ended";
    }
    const rest = buf.subarray(from);
    if (!cur.skipToNewline && rest.length > 0) {
      cur.carry.push(rest);
      cur.carryLen += rest.length;
      if (cur.carryLen > maxLine) {
        cur.carry = [];
        cur.carryLen = 0;
        cur.skipToNewline = true;
        noteGap(tooLong(file));
      }
    }
    return false;
  }

  /** Bytes read but not yet part of a whole line, or not read yet: the file
   *  is not fully observed, so no negative verdict may rest on it. */
  const pendingIn = (cur: FileCursor): boolean => cur.offset < cur.lastSize || cur.carryLen > 0 || cur.skipToNewline;

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
        /** Rollouts left unread this poll by the live horizon. */
        let excludedStale = 0;
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
            // Not written within the live horizon and never read: taken as
            // no live session (the one inference from silence), and counted.
            if (!cur && st.mtimeMs < startedAt - horizonMs) { excludedStale++; continue; }
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
            if (await readForward(fh, file, st.size, cur)) return { result: "submitted", file, afterMs: now() - typedAt };
          } catch (err) {
            noteGap(`${basename(file)} could not be read (${errText(err)})`);
          } finally {
            await fh?.close().catch(() => undefined);
          }
          if (cur && (cur.turn === "open" || cur.turn === "unknown" || pendingIn(cur))) busy = true;
        }
        const t = now();
        const waited = t - typedAt;
        if (busy) lastBusyAt = t;
        const quietFor = lastBusyAt === undefined ? Number.POSITIVE_INFINITY : t - lastBusyAt;
        if (!busy && waited >= windowMs && quietFor >= graceMs) {
          // Every live session seen idle, quiet and fully read: negative,
          // unless something went unseen.
          if (gap) return { result: "unverifiable", reason: `not seen, but not everything could be read: ${gap}` };
          return { result: "not-submitted", waitedMs: waited, excludedStale, horizonMs };
        }
        if (waited >= capMs) {
          const pending = [...cursors.entries()]
            .filter(([, c]) => c.turn === "open" || c.turn === "unknown" || pendingIn(c))
            .map(([f, c]) => `${basename(f)} ${c.turn === "open" ? "has a turn open" : c.turn === "unknown" ? "shows no turn marker within reach" : "ends in an unfinished line"}`);
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

/**
 * Submit check: did a wake typed into a Codex session get submitted?
 *
 * A keystroke route (the Windows console, WezTerm, tmux) knows only that the
 * keys were written. On 28 Sep 2026 a Codex CLI 0.157.1 TUI in a plain pwsh
 * console took every wake's text and none of its Enters: the server logged
 * "Injected 311 chars + Enter (double=True)" as success while the prompt sat
 * in the input box for hours. This module only observes: it never presses a
 * key, retypes, delays or retries anything.
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
 * rollout for a line appended after the injection started.
 *
 * The match is strict, so an older prompt can never pass for this one:
 * - The line must be one of the two user-message shapes above (a "compacted"
 *   line replays old user messages in its history, and tool output can quote
 *   a prompt; neither shape counts).
 * - Its text must contain the EXACT prompt that was typed, whole. The prompt
 *   carries the agent's name, the sender, and the `since=` cursor, and it is
 *   one line; a text that merely resembles it does not count.
 * - Its timestamp must be at or after the moment the check began, which is
 *   just before the first key was typed (same machine, same clock). Two wakes
 *   with identical text (same sender, cursor unchanged) are told apart by
 *   this, never by the text.
 * - Only bytes appended since a snapshot taken at that moment are read (with
 *   a small backtrack, see below); files can be hundreds of MB.
 *
 * A busy target is not a failure. Codex 0.157.1 queues input typed during a
 * turn and submits it when the turn ends, several queued wakes MERGED into
 * one user message (seen 28 Sep 2026: messages holding two and three wake
 * texts, submitted 90 to 120 s after the first was typed). Hence the
 * substring match above, and the wait: 30 s when every session is idle, but
 * while any session looks busy the check keeps looking until 15 s after the
 * last busy sign, up to a 10 min cap. With no pid-to-file mapping, "busy" is
 * judged over EVERY rollout, conservatively (a busy neighbour delays the
 * verdict; it never produces one). A rollout is busy while its last turn
 * marker is task_started (no task_complete or turn_aborted after it) and the
 * session is alive (the file grew during the check, or the turn started
 * within the cap), or, before any marker is seen, while it keeps growing.
 * At the cap, still busy, the check gives up unverified and says nothing.
 *
 * Which store: the server's CODEX_HOME need not be the target's (the Y530's
 * environment named an Orca runtime home, while a Codex CLI started in a
 * plain console writes to ~/.codex), so both $CODEX_HOME/sessions and
 * ~/.codex/sessions are read, once each. JOIND_CODEX_SESSIONS (a list in the
 * platform's path-list form) replaces both when set: for a Codex that runs
 * with yet another home, and for the test suite, which must never read the
 * real store.
 */

import { open, readdir, realpath, stat } from "fs/promises";
import { homedir } from "os";
import { basename, delimiter, join } from "path";

/** How often the store is looked at after the keys were written. */
export const SUBMIT_CHECK_POLL_MS = 2000;
/** How long after the keys were written a missing prompt counts as not
 *  submitted, when no Codex session is busy. */
export const SUBMIT_CHECK_WINDOW_MS = 30000;
/** After the last sign of a busy session, how long to keep looking: Codex
 *  submits input queued during a turn when the turn ends. */
export const SUBMIT_CHECK_GRACE_MS = 15000;
/** The most a check waits on busy sessions; past it, it gives up unsaid. */
export const SUBMIT_CHECK_CAP_MS = 10 * 60 * 1000;
/** Bytes re-read before each file's snapshot size: a line appended while the
 *  snapshot was being taken is still seen. Lines from before the check began
 *  are rejected by their timestamp, so the backtrack cannot admit them. */
export const SUBMIT_CHECK_BACKTRACK_BYTES = 64 * 1024;
/** The most bytes read from one file per poll; the rest waits for the next. */
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

/** Every rollout file under `dir` (YYYY/MM/DD/rollout-*.jsonl). Throws when
 *  `dir` itself cannot be read; an unreadable subdirectory is skipped. */
export async function listRollouts(dir: string): Promise<string[]> {
  const out: string[] = [];
  const subdirs = async (p: string, re: RegExp): Promise<string[]> => {
    try {
      return (await readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory() && re.test(e.name)).map((e) => join(p, e.name));
    } catch {
      return [];
    }
  };
  // The top level must be readable: a missing or unreadable store is unverifiable.
  const years = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name)).map((e) => join(dir, e.name));
  for (const y of years) {
    for (const m of await subdirs(y, /^\d{2}$/)) {
      for (const d of await subdirs(m, /^\d{2}$/)) {
        try {
          for (const e of await readdir(d, { withFileTypes: true })) {
            if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(join(d, e.name));
          }
        } catch {
          // A day directory that vanished or cannot be read holds nothing for us.
        }
      }
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface FileStat { size: number; mtimeMs: number }

/** Each file's size and modification time now, keyed by path, all stats at
 *  once; a file gone meanwhile is left out. */
async function statsOf(files: string[]): Promise<Map<string, FileStat>> {
  const out = new Map<string, FileStat>();
  await Promise.all(files.map(async (f) => {
    try {
      const s = await stat(f);
      out.set(f, { size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // Gone between readdir and stat.
    }
  }));
  return out;
}

/** Why a store cannot be read, in words. */
function storeProblem(dir: string, err: unknown): string {
  const code = isRecord(err) && typeof err.code === "string" ? err.code : "";
  if (code === "ENOENT") return `no Codex session store at ${dir}`;
  const why = code || (err instanceof Error ? err.message.split("\n")[0].slice(0, 80) : "error");
  return `the Codex session store at ${dir} is unreadable (${why})`;
}

/** The readable stores among `dirs` (one per real directory) and the size
 *  and time of every rollout in them now; or, when none is readable, why. */
async function snapshotStores(dirs: readonly string[]): Promise<{ dirs: string[]; base: Map<string, FileStat> } | string> {
  const seen = new Set<string>();
  const readable: string[] = [];
  const files: string[] = [];
  const problems: string[] = [];
  for (const dir of dirs) {
    try {
      const real = await realpath(dir);
      if (seen.has(real)) continue; // the same store under two names
      seen.add(real);
      files.push(...await listRollouts(dir));
      readable.push(dir);
    } catch (err) {
      problems.push(storeProblem(dir, err));
    }
  }
  if (readable.length === 0) return problems.join("; ") || "no Codex session store configured";
  return { dirs: readable, base: await statsOf(files) };
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
 *  turn_aborted), with its timestamp; null for any other line. */
export function turnMarker(line: string): { kind: "start" | "end"; at: number } | null {
  if (!line.includes('"task_started"') && !line.includes('"task_complete"') && !line.includes('"turn_aborted"')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(obj) || obj.type !== "event_msg" || !isRecord(obj.payload)) return null;
  const t = obj.payload.type;
  const at = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
  if (t === "task_started") return { kind: "start", at };
  if (t === "task_complete" || t === "turn_aborted") return { kind: "end", at };
  return null;
}

/** Where reading of one file stands, and what it says about its session. */
interface FileCursor {
  offset: number;
  /** The unfinished last line of the previous read. */
  carry: Buffer;
  /** Discard up to and including the next newline (a backtracked start
   *  landed mid-line, or a line outgrew MAX_LINE_BYTES). */
  skipToNewline: boolean;
  /** The last turn marker read: none yet, a turn open, or ended. */
  turn: "unknown" | "open" | "ended";
  /** When the open turn started (NaN when its timestamp was unreadable). */
  turnStartedAt: number;
  /** The size last seen; the file grew during the check when it moved. */
  lastSize: number;
  grewDuringCheck: boolean;
}

/**
 * Begin a check for `prompt` now, just before the first key is typed: the
 * clock starts and a snapshot of the stores' files is taken in the
 * background (never awaited by the wake). `verify()` then reads the bytes
 * appended since, every pollMs, until the prompt is found, or every session
 * has been idle long enough (see the file header), or the cap is reached.
 */
export function beginSubmitCheck(prompt: string, opts: SubmitCheckOptions = {}): PendingSubmitCheck {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? SUBMIT_CHECK_POLL_MS;
  const windowMs = opts.windowMs ?? SUBMIT_CHECK_WINDOW_MS;
  const graceMs = opts.graceMs ?? SUBMIT_CHECK_GRACE_MS;
  const capMs = opts.capMs ?? SUBMIT_CHECK_CAP_MS;
  const dirs = opts.sessionsDirs ?? codexSessionsDirs();
  const startedAt = now();
  const needle = prompt.trim();
  // Settles to the baseline or to the reason no store can be read; never rejects.
  const snapshot = snapshotStores(dirs).catch((err: unknown) => `the Codex session store could not be listed (${err instanceof Error ? err.message.split("\n")[0].slice(0, 80) : "error"})`);
  const cursors = new Map<string, FileCursor>();

  /** Read what `file` gained since the last look, up to `size`: true when it
   *  holds the prompt. Turn markers on the way update the cursor. */
  async function readNew(file: string, size: number, cur: FileCursor): Promise<boolean> {
    if (size <= cur.offset) return false; // nothing new (rollouts only grow)
    const len = Math.min(size - cur.offset, MAX_READ_PER_POLL);
    const buf = Buffer.alloc(len);
    let got = 0;
    try {
      const fh = await open(file, "r");
      try {
        got = (await fh.read(buf, 0, len, cur.offset)).bytesRead;
      } finally {
        await fh.close();
      }
    } catch {
      return false;
    }
    cur.offset += got;
    let data = cur.carry.length > 0 ? Buffer.concat([cur.carry, buf.subarray(0, got)]) : buf.subarray(0, got);
    let nl: number;
    while ((nl = data.indexOf(0x0a)) >= 0) {
      const line = data.subarray(0, nl).toString("utf8");
      data = data.subarray(nl + 1);
      if (cur.skipToNewline) { cur.skipToNewline = false; continue; }
      if (lineSubmitsPrompt(line, needle, startedAt)) return true;
      const marker = turnMarker(line);
      if (marker) {
        cur.turn = marker.kind === "start" ? "open" : "ended";
        cur.turnStartedAt = marker.kind === "start" ? marker.at : NaN;
      }
    }
    if (cur.skipToNewline || data.length > MAX_LINE_BYTES) {
      cur.carry = Buffer.alloc(0);
      cur.skipToNewline = true;
    } else {
      cur.carry = Buffer.from(data);
    }
    return false;
  }

  return {
    startedAt,
    sessionsDirs: dirs,
    async verify(): Promise<SubmitCheckResult> {
      const snap = await snapshot;
      if (typeof snap === "string") return { result: "unverifiable", reason: snap };
      const typedAt = now();
      let lastBusyAt: number | undefined;
      for (;;) {
        const files: string[] = [];
        for (const dir of snap.dirs) {
          try {
            files.push(...await listRollouts(dir));
          } catch {
            // A store that went away mid-check holds nothing more to find.
          }
        }
        // One stat per file, all at once; only files that grew, or were
        // written within the cap before the check, are read.
        let busy = false;
        for (const [file, st] of await statsOf(files)) {
          let cur = cursors.get(file);
          if (!cur) {
            const was = snap.base.get(file);
            // Untouched since the snapshot and quiet for longer than the cap:
            // no live session and nothing new. Never read.
            if (was && st.size === was.size && was.mtimeMs < startedAt - capMs) continue;
            // A file born after the snapshot is all new. An existing one is
            // read from a little before its snapshot size, starting one byte
            // earlier and dropping through the first newline, so a start that
            // lands mid line never yields a fragment. The backtrack also
            // shows whether a turn was open when the check began.
            const from = was === undefined ? 0 : Math.max(0, was.size - SUBMIT_CHECK_BACKTRACK_BYTES);
            cur = {
              offset: from === 0 ? 0 : from - 1, carry: Buffer.alloc(0), skipToNewline: from > 0,
              turn: "unknown", turnStartedAt: NaN, lastSize: was?.size ?? 0, grewDuringCheck: false,
            };
            cursors.set(file, cur);
          }
          const grew = st.size > cur.lastSize;
          if (grew) cur.grewDuringCheck = true;
          cur.lastSize = st.size;
          if (await readNew(file, st.size, cur)) return { result: "submitted", file, afterMs: now() - typedAt };
          // An open turn counts only for a live session: one that wrote
          // during the check, or whose turn began within the cap (a session
          // that died mid-turn leaves task_started as its last marker).
          const live = cur.grewDuringCheck || (Number.isFinite(cur.turnStartedAt) && cur.turnStartedAt >= startedAt - capMs);
          if ((cur.turn === "open" && live) || (cur.turn === "unknown" && grew)) busy = true;
        }
        const t = now();
        const waited = t - typedAt;
        if (busy) lastBusyAt = t;
        const quietFor = lastBusyAt === undefined ? Number.POSITIVE_INFINITY : t - lastBusyAt;
        if (!busy && waited >= windowMs && quietFor >= graceMs) return { result: "not-submitted", waitedMs: waited };
        if (waited >= capMs) {
          return { result: "unverifiable", reason: `Codex sessions stayed busy for ${Math.round(waited / 1000)} s and the prompt was not seen` };
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

/**
 * The write-ahead record of this server's human in one remote room: who is
 * registered with the home (`current`), whom the viewer last chose
 * (`wanted`), a registration that was sent but not confirmed
 * (`unconfirmed`), and former registrations still to release
 * (`releasesOwed`).
 *
 * Every step that changes the home is recorded BEFORE it is made and again
 * after it is confirmed, atomically (a temp file, then a rename). A record
 * that cannot be written stops the transition with an error: nothing is
 * sent on a stale record (gate round 4, finding 1). The record is the only
 * source of truth for the viewer; queued messages never infer it (finding 2).
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { dirname } from "path";
import { ensureDir } from "./persist.js";

export interface HumanRegistrationRecord {
  name: string;
  registration: string;
}

export interface HumanStateData {
  current: HumanRegistrationRecord | null;
  /** The viewer's latest explicit choice, pending until registered. A choice
   *  of the current registration cancels a pending change (finding 3). */
  wanted: string | null;
  /** A registration sent to the home whose reply was not seen: the home may
   *  hold it. Settled by registering it again (idempotent there) and either
   *  keeping it (it is wanted) or releasing it. */
  unconfirmed: string | null;
  releasesOwed: HumanRegistrationRecord[];
  /** Bumped on every write. */
  seq: number;
}

export class HumanStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanStateError";
  }
}

function isRecord(v: unknown): v is HumanRegistrationRecord {
  const r = v as { name?: unknown; registration?: unknown } | null;
  return !!r && typeof r.name === "string" && typeof r.registration === "string";
}

export class HumanState {
  private data: HumanStateData = { current: null, wanted: null, unconfirmed: null, releasesOwed: [], seq: 0 };

  constructor(private readonly file: string | null) {
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<HumanStateData> & { human?: unknown; wanted?: unknown; releases?: unknown[] };
      // The round-3 layout ({ human, wanted, releases }) is read too.
      const current = raw.current ?? raw.human;
      this.data = {
        current: isRecord(current) ? { name: current.name, registration: current.registration } : null,
        wanted: typeof raw.wanted === "string" ? raw.wanted : null,
        unconfirmed: typeof raw.unconfirmed === "string" ? raw.unconfirmed : null,
        releasesOwed: (raw.releasesOwed ?? raw.releases ?? []).filter(isRecord).map((r) => ({ name: r.name, registration: r.registration })),
        seq: typeof raw.seq === "number" ? raw.seq : 0,
      };
    } catch { /* a torn record: start clean (writes are atomic, so only a hand edit tears it) */ }
  }

  snapshot(): HumanStateData {
    return {
      current: this.data.current ? { ...this.data.current } : null,
      wanted: this.data.wanted,
      unconfirmed: this.data.unconfirmed,
      releasesOwed: this.data.releasesOwed.map((r) => ({ ...r })),
      seq: this.data.seq,
    };
  }

  get current(): HumanRegistrationRecord | null { return this.data.current ? { ...this.data.current } : null; }
  get wanted(): string | null { return this.data.wanted; }
  get unconfirmed(): string | null { return this.data.unconfirmed; }
  get releasesOwed(): HumanRegistrationRecord[] { return this.data.releasesOwed.map((r) => ({ ...r })); }

  /** The viewer the home should hold: the latest choice, else the current one. */
  target(): string | null {
    return this.data.wanted ?? this.data.current?.name ?? null;
  }

  /** Whether anything is owed to the home. */
  owes(): boolean {
    return this.data.releasesOwed.length > 0 || this.data.unconfirmed != null ||
      (this.data.wanted != null && this.data.wanted !== this.data.current?.name);
  }

  /**
   * Apply a change and write it. The in-memory record changes only when the
   * write succeeded; a failed write throws HumanStateError and leaves both
   * the file and the record as they were.
   */
  update(change: (d: HumanStateData) => void): void {
    const next = this.snapshot();
    change(next);
    next.seq = this.data.seq + 1;
    if (this.file) {
      try {
        ensureDir(dirname(this.file));
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(next), "utf-8");
        renameSync(tmp, this.file);
      } catch (err) {
        throw new HumanStateError(`the viewer record could not be saved (${(err as Error).message}); nothing was sent`);
      }
    }
    this.data = next;
  }
}

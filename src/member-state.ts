/**
 * The write-ahead record of this server's members of one remote room, one
 * entry per name, in one file per room (`<room>.members.json`). Every id in
 * it is THIS server's registration id for the member (the one the home keeps
 * as the hosted registration), so anything the home may hold can be released
 * by that id alone (`/api/peer/leave` with `hostedRegistration`); an old id
 * is never registered again to learn anything (gate round 10).
 *
 *   live         the id of the member here now, whose registration the home
 *                should hold;
 *   unconfirmed  an id sent to the home whose outcome is not known yet (a
 *                join in flight, a reply lost);
 *   releasesOwed ids the home may still hold that belong to no member here.
 *
 * Every transition is written (a temp file, then a rename) before the remote
 * call it announces and again when that call is answered; a write that fails
 * throws MemberStateError and changes nothing. The same rule as the viewer's
 * record (human-state.ts).
 *
 * Migration: the round-9 file `<room>.releases.json` ({ releases, intents },
 * or the round-7 array of releases) is read once when no members file
 * exists. Its intents become owed ids; its releases carry the HOME's ids and
 * are kept as `legacyHomeReleases`, released by the home id until settled.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { dirname } from "path";
import { ensureDir } from "./persist.js";

export interface MemberRecord {
  name: string;
  live: string | null;
  unconfirmed: string | null;
  releasesOwed: string[];
  seq: number;
}

export interface LegacyHomeRelease {
  name: string;
  /** The home's registration id (round 9 and earlier recorded those). */
  registration: string;
}

interface MembersFileData {
  members: MemberRecord[];
  legacyHomeReleases: LegacyHomeRelease[];
}

export class MemberStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberStateError";
  }
}

function emptyRecord(name: string): MemberRecord {
  return { name, live: null, unconfirmed: null, releasesOwed: [], seq: 0 };
}

function isEmptyRecord(r: MemberRecord): boolean {
  return r.live == null && r.unconfirmed == null && r.releasesOwed.length === 0;
}

export class MemberState {
  private data: MembersFileData = { members: [], legacyHomeReleases: [] };

  constructor(private readonly file: string | null, legacyFile: string | null = null) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<MembersFileData>;
        this.data = {
          members: (raw.members ?? []).filter((m): m is MemberRecord => !!m && typeof m.name === "string").map((m) => ({
            name: m.name,
            live: typeof m.live === "string" ? m.live : null,
            unconfirmed: typeof m.unconfirmed === "string" ? m.unconfirmed : null,
            releasesOwed: Array.isArray(m.releasesOwed) ? m.releasesOwed.filter((x): x is string => typeof x === "string") : [],
            seq: typeof m.seq === "number" ? m.seq : 0,
          })),
          legacyHomeReleases: (raw.legacyHomeReleases ?? []).filter((r): r is LegacyHomeRelease => !!r && typeof r.name === "string" && typeof r.registration === "string"),
        };
      } catch { /* a torn record (only a hand edit tears it): start clean */ }
      return;
    }
    if (legacyFile && existsSync(legacyFile)) this.migrate(legacyFile);
  }

  /** Read the round-7/9 releases file into this layout (kept in memory; the
   *  next write persists it in the new file). */
  private migrate(legacyFile: string): void {
    try {
      const raw = JSON.parse(readFileSync(legacyFile, "utf-8")) as unknown;
      const rec = (Array.isArray(raw) ? { releases: raw } : raw) as { releases?: unknown; intents?: unknown };
      for (const r of Array.isArray(rec.releases) ? rec.releases as Array<{ name?: unknown; registration?: unknown }> : []) {
        if (typeof r.name === "string" && typeof r.registration === "string") this.data.legacyHomeReleases.push({ name: r.name, registration: r.registration });
      }
      for (const i of Array.isArray(rec.intents) ? rec.intents as Array<{ name?: unknown; hosted?: unknown }> : []) {
        if (typeof i.name !== "string" || typeof i.hosted !== "string") continue;
        let m = this.data.members.find((x) => x.name === i.name);
        if (!m) { m = emptyRecord(i.name); this.data.members.push(m); }
        if (!m.releasesOwed.includes(i.hosted)) m.releasesOwed.push(i.hosted);
      }
    } catch { /* unreadable: nothing known */ }
  }

  get(name: string): MemberRecord {
    const m = this.data.members.find((x) => x.name === name);
    return m ? { ...m, releasesOwed: [...m.releasesOwed] } : emptyRecord(name);
  }

  names(): string[] {
    return this.data.members.map((m) => m.name);
  }

  legacyReleases(): LegacyHomeRelease[] {
    return this.data.legacyHomeReleases.map((r) => ({ ...r }));
  }

  isEmpty(): boolean {
    return this.data.members.length === 0 && this.data.legacyHomeReleases.length === 0;
  }

  /** Ids this server owes the home a release for (all names), for diagnostics. */
  owed(): Array<{ name: string; registration: string }> {
    return [
      ...this.data.members.flatMap((m) => m.releasesOwed.map((id) => ({ name: m.name, registration: id }))),
      ...this.data.legacyHomeReleases.map((r) => ({ ...r })),
    ];
  }

  /**
   * Change one member's record and write the file. The in-memory record
   * changes only when the write succeeded; a failed write throws
   * MemberStateError. A record left empty is dropped.
   */
  update(name: string, change: (r: MemberRecord) => void): MemberRecord {
    const current = this.get(name);
    const next = { ...current, releasesOwed: [...current.releasesOwed] };
    change(next);
    next.releasesOwed = [...new Set(next.releasesOwed.filter((id) => id !== next.live))];
    next.seq = current.seq + 1;
    const members = this.data.members.filter((m) => m.name !== name);
    if (!isEmptyRecord(next)) members.push(next);
    this.write({ members, legacyHomeReleases: this.data.legacyHomeReleases });
    return { ...next, releasesOwed: [...next.releasesOwed] };
  }

  removeLegacy(entry: LegacyHomeRelease): void {
    this.write({
      members: this.data.members,
      legacyHomeReleases: this.data.legacyHomeReleases.filter((r) => !(r.name === entry.name && r.registration === entry.registration)),
    });
  }

  private write(next: MembersFileData): void {
    if (this.file) {
      try {
        ensureDir(dirname(this.file));
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(next), "utf-8");
        renameSync(tmp, this.file);
      } catch (err) {
        throw new MemberStateError(`the member record could not be saved (${(err as Error).message}); nothing was changed`);
      }
    }
    this.data = next;
  }
}

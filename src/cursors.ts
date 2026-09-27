/**
 * CursorStore: each agent's last-read message id, per room.
 *
 * Message ids are per room, so a cursor means something only in the room it
 * was read in. The first version kept one number per agent NAME, and a name
 * that read in a big room carried that number into every other room (field
 * case, Y530, 27 Sep 2026: Scotty's cursor 10029, advanced in a room of
 * 10,044 messages, went into every wake prompt of a room whose latest id was
 * about 1900, so each successful wake read nothing). Cursors are now keyed by
 * (room id, agent name); a room id is a local conversation id or a mirrored
 * remote room's `<server>:<room>` id.
 *
 * File (data/agent-cursors.json), readable by hand:
 *   { "version": 2, "rooms": { "<room id>": { "<agent>": <last read id> } } }
 * The old flat `{ "<agent>": <id> }` entries are legacy: ignored, never
 * migrated (a number read in one room means nothing in another), and kept
 * in the file untouched, beside "version" and "rooms".
 *
 * Nothing here rewrites a stored cursor on inference (the room's ruling,
 * cpm-engine #1907): a cursor past its room's end is logged once and read
 * as the room's end, and the entry is left as it is.
 *
 * Debounced saves; cursors only move forward.
 */

import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";

interface CursorFileV2 {
  version: 2;
  rooms: Record<string, Record<string, number>>;
}

function isCursorValue(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

export class CursorStore {
  private rooms = new Map<string, Map<string, number>>();
  /** Top-level keys of the file other than "version" and "rooms" (legacy
   *  name-only cursors): written back exactly as they were read. */
  private preserved: Array<[string, unknown]> = [];
  /** "<room>\u0000<agent>" pairs already logged as past their room's end. */
  private loggedForeign = new Set<string>();
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private log: (line: string) => void;

  constructor(dataDir: string, opts: { log?: (line: string) => void } = {}) {
    this.filePath = join(dataDir, "agent-cursors.json");
    this.log = opts.log ?? ((l) => console.log(l));
    this.load();
  }

  /** Last-read message id of `agentName` in `roomId` (0 if never read there). */
  get(roomId: string, agentName: string): number {
    return this.rooms.get(roomId)?.get(agentName) ?? 0;
  }

  /**
   * The stored cursor, checked against the room's high-water mark. A cursor
   * past the room's end cannot have been read there: it is logged once per
   * room and agent and read as the room's end, and the stored entry is left
   * alone (no rewrite on inference). A wake prompt stays correct anyway: its
   * since is clamped below the mention.
   */
  cursorFor(roomId: string, agentName: string, roomLastId: number): number {
    return this.storedCursor(roomId, agentName, roomLastId) ?? 0;
  }

  /**
   * As cursorFor, but undefined when this agent has never read this room.
   * An absent cursor is "no lower bound known", not 0: a wake prompt or a
   * first listen built from 0 would hand the agent the whole room's history
   * (field case: every member's first wake after the room-scoped upgrade,
   * since legacy entries are ignored and a rejoin creates none).
   */
  storedCursor(roomId: string, agentName: string, roomLastId: number): number | undefined {
    const stored = this.rooms.get(roomId)?.get(agentName);
    if (stored === undefined) return undefined;
    const cursor = stored;
    if (cursor > roomLastId) {
      const key = `${roomId}\u0000${agentName}`;
      if (!this.loggedForeign.has(key)) {
        this.loggedForeign.add(key);
        this.log(`  [cursors] ${agentName} in ${roomId}: stored cursor ${cursor} is past the room's last id ${roomLastId}; left as stored, read as ${roomLastId}`);
      }
      return roomLastId;
    }
    return cursor;
  }

  /**
   * Advance forward. No-op if messageId <= current cursor. `roomLastId`,
   * when given, caps the value: a cursor never moves past what the room has.
   */
  advance(roomId: string, agentName: string, messageId: number, roomLastId?: number): void {
    const capped = roomLastId != null ? Math.min(messageId, roomLastId) : messageId;
    if (!(capped > 0)) return;
    const current = this.get(roomId, agentName);
    if (capped <= current) return;
    let room = this.rooms.get(roomId);
    if (!room) { room = new Map(); this.rooms.set(roomId, room); }
    room.set(agentName, capped);
    this.scheduleSave();
  }

  /** Count unread messages after `cursor` and collect their senders
   *  (excluding the agent itself). */
  getUnreadCount(
    cursor: number,
    agentName: string,
    allMessages: Array<{ id: number; sender: string }>,
  ): { count: number; senders: string[] } {
    const senderSet = new Set<string>();
    let count = 0;
    for (const m of allMessages) {
      if (m.id > cursor && m.sender !== agentName) {
        count++;
        senderSet.add(m.sender);
      }
    }
    return { count, senders: Array.from(senderSet) };
  }

  /** Test hook: write now instead of after the debounce. */
  flush(): void {
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.write();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      this.log("  [cursors] agent-cursors.json is not readable JSON; starting with no cursors");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const file = parsed as { version?: unknown; rooms?: unknown };
    // Every other top-level key is kept, untouched, for the next save.
    this.preserved = Object.entries(parsed as Record<string, unknown>).filter(([k]) => k !== "version" && k !== "rooms");
    if (this.preserved.length > 0) {
      this.log(`  [cursors] agent-cursors.json holds ${this.preserved.length} legacy name-only cursor(s); ignored and kept in the file untouched (cursors are per room now)`);
    }
    if (file.version !== 2 || !file.rooms || typeof file.rooms !== "object" || Array.isArray(file.rooms)) return;
    for (const [roomId, names] of Object.entries(file.rooms as Record<string, unknown>)) {
      if (!names || typeof names !== "object" || Array.isArray(names)) continue;
      const room = new Map<string, number>();
      for (const [name, value] of Object.entries(names as Record<string, unknown>)) {
        if (isCursorValue(value) && value > 0) room.set(name, value);
      }
      if (room.size > 0) this.rooms.set(roomId, room);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.write();
    }, 5_000);
  }

  private write(): void {
    // Object.fromEntries defines own properties, so a room or agent called
    // "__proto__" is saved like any other key.
    const out: CursorFileV2 & Record<string, unknown> = {
      ...Object.fromEntries(this.preserved),
      version: 2,
      rooms: Object.fromEntries(
        [...this.rooms.entries()]
          .filter(([, names]) => names.size > 0)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([roomId, names]) => [roomId, Object.fromEntries([...names.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))]),
      ),
    };
    // A failed save (a full or missing disk) must not take the server down
    // from inside a timer; the cursors stay in memory and the next advance
    // tries again.
    try {
      writeFileSync(this.filePath, JSON.stringify(out, null, 2) + "\n", "utf-8");
    } catch (err) {
      this.log(`  [cursors] could not save agent-cursors.json (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
    }
  }
}

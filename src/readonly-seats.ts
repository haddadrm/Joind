/**
 * Read-only room seats (docs/superpowers/specs/2026-10-05-readonly-seat-design.md).
 *
 * A seat is one name that may READ one local room and never send. Its
 * credential is a random token shown once at minting; only its SHA-256 is
 * kept, in `readonly-seats.json` inside the data dir. A request carrying the
 * seat header (X-Joind-Seat-Token) is answered here, by an explicit
 * allowlist of read routes, and never reaches any other route of the
 * server: default deny. Nothing here binds a terminal, discovers one, or
 * wakes anyone; the seat's name is held in its room so no member can take
 * it, and the room never wakes it (ChatRoom.seatReserved). A seat reads
 * public messages only: a DM is routed by name, and a name is not a
 * principal, so no DM is ever shown to a seat.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { EventEmitter } from "events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { IncomingHttpHeaders } from "http";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ChatMessage } from "./room.js";
import { parseSearchQuery, hasTerms, searchLimit, searchBefore, searchMessages } from "./search.js";

/** The header a seat presents its token in; no other credential uses it. */
export const SEAT_HEADER = "x-joind-seat-token";
/** Every seat token starts with this, so a token is recognisable in logs and
 *  in any credential slot it was put in by mistake. */
export const SEAT_TOKEN_PREFIX = "jrs_";
/** The only path prefix a seat may use. */
export const SEAT_PATH_PREFIX = "/api/seat";
/** A seat name is a mention target: the characters an @mention matches. */
export const SEAT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
/** Names that are never a seat (a mention of `all` wakes every member). */
const RESERVED_WORDS = new Set(["all", "system"]);

export function seatsPath(dataDir: string): string {
  return join(dataDir, "readonly-seats.json");
}

export function newSeatToken(): string {
  return SEAT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** A seat as stored: the token's digest, never the token. */
export interface SeatRecord {
  id: string;
  name: string;
  conversationId: string;
  /** SHA-256 of the token, hex. */
  tokenHash: string;
  createdAt: number;
  revokedAt: number | null;
}

/** A seat as listed: no digest, no token. */
export interface SeatView {
  id: string;
  name: string;
  conversationId: string;
  createdAt: number;
  revokedAt: number | null;
  /** A short, non-reversible label of the token. */
  fingerprint: string;
  /** When the seat last read (this run only; never persisted). */
  lastUsedAt: number | null;
}

/** A seat as the member list shows it to web token holders: an active seat
 *  only, with no token, digest or fingerprint. */
export interface SeatMemberView {
  id: string;
  name: string;
  conversationId: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** A seat that read within this window shows a green dot ("read recently"). */
export const SEAT_RECENT_READ_MS = 10 * 60_000;
/** A seat's reads are told to the page at most this often (a polling seat
 *  would otherwise send one socket event per poll). The page's "read Nm
 *  ago" is accurate to this. */
export const SEAT_USE_NOTICE_MS = 60_000;

interface SeatFile {
  version: 1;
  seats: SeatRecord[];
}

/** Why a mint or a revoke was refused, with the HTTP status that says it. */
export class SeatError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SeatError";
  }
}

function isSeatRecord(v: unknown): v is SeatRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.name === "string" && typeof r.conversationId === "string"
    && typeof r.tokenHash === "string" && /^[0-9a-f]{64}$/.test(r.tokenHash)
    && typeof r.createdAt === "number" && (r.revokedAt === null || typeof r.revokedAt === "number");
}

/**
 * Emits "changed" (no argument) when the member-list view of the seats
 * changes: a mint, a revoke, or a read (at most once per SEAT_USE_NOTICE_MS
 * per seat). The server pushes `activeSeats()` to web sockets on it.
 */
export class ReadonlySeatStore extends EventEmitter {
  private readonly file: string;
  private readonly now: () => number;
  private seats: SeatRecord[] = [];
  private readonly lastUsed = new Map<string, number>();
  /** When a read of each seat was last told ("changed"). */
  private readonly lastUseNoticed = new Map<string, number>();
  /** The file exists but could not be read: no seat is valid, and nothing is
   *  written over it (mint and revoke refuse) until a person looks. */
  readonly broken: boolean = false;

  constructor(dataDir: string, opts: { now?: () => number; log?: (line: string) => void } = {}) {
    super();
    this.file = seatsPath(dataDir);
    this.now = opts.now ?? Date.now;
    const log = opts.log ?? ((line: string) => console.log(line));
    if (!existsSync(this.file)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const seats = (parsed as { seats?: unknown } | null)?.seats;
      if (!Array.isArray(seats) || !seats.every(isSeatRecord)) throw new Error("unexpected shape");
      this.seats = seats;
    } catch (err) {
      this.broken = true;
      log(`  [readonly-seats] cannot read ${this.file} (${(err as Error).message}); no read-only seat is valid until it is fixed or removed`);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const body: SeatFile = { version: 1, seats: this.seats };
    writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private view(r: SeatRecord): SeatView {
    return {
      id: r.id,
      name: r.name,
      conversationId: r.conversationId,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
      fingerprint: createHash("sha256").update(r.tokenHash).digest("hex").slice(0, 12),
      lastUsedAt: this.lastUsed.get(r.id) ?? null,
    };
  }

  /** The active seat holding `name` in `conversationId` (case-insensitive). */
  activeFor(conversationId: string, name: string): SeatRecord | undefined {
    const lower = name.toLowerCase();
    return this.seats.find((s) => s.revokedAt === null && s.conversationId === conversationId && s.name.toLowerCase() === lower);
  }

  /** True when an active seat holds `name` in this room. */
  reserves(conversationId: string, name: string): boolean {
    return this.activeFor(conversationId, name) !== undefined;
  }

  /** True when an active seat holds `name` in any room (case-insensitive).
   *  A human viewer may not take such a name: DMs route by name. */
  holdsAnywhere(name: string): boolean {
    const lower = name.toLowerCase();
    return this.seats.some((s) => s.revokedAt === null && s.name.toLowerCase() === lower);
  }

  /**
   * Mint a seat. The caller has checked the room is local and the name is
   * free there; this checks the name's form and the one-seat-per-name rule.
   * The token is returned once and never stored.
   */
  mint(name: string, conversationId: string): { seat: SeatView; token: string } {
    if (this.broken) throw new SeatError(503, "the read-only seat file cannot be read; fix or remove it and restart");
    if (!SEAT_NAME.test(name) || RESERVED_WORDS.has(name.toLowerCase())) {
      throw new SeatError(400, "name must be 1 to 64 letters, digits, _ or - (starting with a letter, digit or _), and not all or system");
    }
    if (this.reserves(conversationId, name)) throw new SeatError(409, `${name} already has a read-only seat in this room; revoke it first`);
    const token = newSeatToken();
    const record: SeatRecord = {
      id: `seat-${randomBytes(6).toString("hex")}`,
      name,
      conversationId,
      tokenHash: sha256(token).toString("hex"),
      createdAt: this.now(),
      revokedAt: null,
    };
    this.seats.push(record);
    try {
      this.save();
    } catch (err) {
      this.seats.pop();
      throw new SeatError(500, `could not write the read-only seat file (${(err as Error).message})`);
    }
    this.emit("changed");
    return { seat: this.view(record), token };
  }

  /** Revoke one seat by id; idempotent. Null when no such seat. */
  revoke(id: string): SeatView | null {
    if (this.broken) throw new SeatError(503, "the read-only seat file cannot be read; fix or remove it and restart");
    const r = this.seats.find((s) => s.id === id);
    if (!r) return null;
    if (r.revokedAt === null) {
      r.revokedAt = this.now();
      try {
        this.save();
      } catch (err) {
        r.revokedAt = null;
        throw new SeatError(500, `could not write the read-only seat file (${(err as Error).message})`);
      }
      this.emit("changed");
    }
    return this.view(r);
  }

  list(): SeatView[] {
    return this.seats.map((r) => this.view(r));
  }

  /** The active seats as the member list shows them (every room; the page
   *  keeps the room on screen). Never a token, digest or fingerprint. */
  activeSeats(): SeatMemberView[] {
    return this.seats.filter((r) => r.revokedAt === null).map((r) => ({
      id: r.id,
      name: r.name,
      conversationId: r.conversationId,
      createdAt: r.createdAt,
      lastUsedAt: this.lastUsed.get(r.id) ?? null,
    }));
  }

  /** The record whose token this is (active or revoked), compared in
   *  constant time over every record. */
  private match(token: string | undefined): SeatRecord | undefined {
    if (typeof token !== "string" || !token.startsWith(SEAT_TOKEN_PREFIX)) return undefined;
    const digest = sha256(token);
    let found: SeatRecord | undefined;
    for (const r of this.seats) {
      if (timingSafeEqual(digest, Buffer.from(r.tokenHash, "hex"))) found = r;
    }
    return found;
  }

  /** The active seat a token proves, or undefined (unknown or revoked). */
  verify(token: string | undefined): SeatRecord | undefined {
    const r = this.match(token);
    return r && r.revokedAt === null ? r : undefined;
  }

  /** True when `value` is a seat's token, active or revoked. */
  isSeatToken(value: string | undefined): boolean {
    return this.match(value) !== undefined;
  }

  noteUse(id: string): void {
    const now = this.now();
    this.lastUsed.set(id, now);
    const told = this.lastUseNoticed.get(id);
    if (told === undefined || now - told >= SEAT_USE_NOTICE_MS) {
      this.lastUseNoticed.set(id, now);
      this.emit("changed");
    }
  }
}

/**
 * What a seat may read of a message: a public message of its room, and
 * nothing else. A DM names its recipients by name, and the same name may
 * belong to a human viewer, a browser tab still holding an old name, or a
 * member of another room, so a seat never reads any DM, even one addressed
 * to its own name. Mirror-local lines (id <= 0) are never shown.
 */
export function seatCanSee(m: ChatMessage): boolean {
  return m.id > 0 && m.to === undefined;
}

/** The room a seat reads: a local room only (never a mirror of a remote one). */
export interface SeatRoomSource {
  /** The messages of a local room in ascending id order, or undefined when
   *  the room does not exist here or is not local. Must have no side effect. */
  messagesOf(conversationId: string): readonly ChatMessage[] | undefined;
  roomName(conversationId: string): string | undefined;
}

/** Normalize a path the way Express matches it: case-insensitive, repeated
 *  slashes collapsed, no trailing slash. */
export function normalizeSeatPath(path: string): string {
  return path.toLowerCase().replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
}

type SeatHandler = (seat: SeatRecord, req: Request, res: Response, match: RegExpExecArray) => void;

/** One value of a query parameter, or undefined (repeated or nested values are refused). */
function q(req: Request, name: string): string | undefined | null {
  const v = (req.query as Record<string, unknown>)[name];
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : null;
}

const READ_LIMIT_DEFAULT = 50;
const READ_LIMIT_MAX = 500;

/**
 * The seat's routes: GET only, each a pure read of the seat's own room.
 * This table IS the allowlist; anything not in it is refused.
 */
function seatRoutes(rooms: SeatRoomSource): Array<{ method: "GET"; path: RegExp; handle: SeatHandler }> {
  const roomOr404 = (seat: SeatRecord, res: Response): readonly ChatMessage[] | undefined => {
    const msgs = rooms.messagesOf(seat.conversationId);
    if (!msgs) res.status(404).json({ error: "This seat's room no longer exists on this server" });
    return msgs;
  };
  const conversation = (seat: SeatRecord) => ({ id: seat.conversationId, name: rooms.roomName(seat.conversationId) ?? seat.conversationId });
  return [
    {
      method: "GET",
      path: /^\/api\/seat\/me$/,
      handle: (seat, _req, res) => {
        res.json({ seat: { id: seat.id, name: seat.name, createdAt: seat.createdAt }, conversation: conversation(seat), readOnly: true });
      },
    },
    {
      method: "GET",
      path: /^\/api\/seat\/read$/,
      handle: (seat, req, res) => {
        const sinceRaw = q(req, "since"), limitRaw = q(req, "limit"), from = q(req, "from");
        if (sinceRaw === null || limitRaw === null || from === null) { res.status(400).json({ error: "since, limit and from take one value each" }); return; }
        const since = sinceRaw === undefined ? undefined : Number(sinceRaw);
        if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) { res.status(400).json({ error: "since must be a message id (0 or more)" }); return; }
        const limitN = limitRaw === undefined ? READ_LIMIT_DEFAULT : Number(limitRaw);
        if (!Number.isSafeInteger(limitN) || limitN < 1) { res.status(400).json({ error: "limit must be a positive integer" }); return; }
        const limit = Math.min(limitN, READ_LIMIT_MAX);
        const all = roomOr404(seat, res);
        if (!all) return;
        const visible = all.filter((m) => (since === undefined || m.id > since) && (!from || m.sender === from) && seatCanSee(m));
        const messages = visible.slice(-limit);
        // The seat keeps its own place: no cursor is stored for it, or moved
        // for anyone, by a read. lastId is what the next `since` should be.
        const lastId = messages.length > 0 ? messages[messages.length - 1].id : (since ?? 0);
        res.json({ conversation: conversation(seat), messages, lastId, more: visible.length > messages.length });
      },
    },
    {
      method: "GET",
      path: /^\/api\/seat\/search$/,
      handle: (seat, req, res) => {
        const raw = q(req, "q");
        if (raw === null) { res.status(400).json({ error: "q takes one value" }); return; }
        const all = roomOr404(seat, res);
        if (!all) return;
        const query = parseSearchQuery(raw ?? "");
        const page = hasTerms(query)
          ? searchMessages(all, query, { limit: searchLimit(req.query.limit), before: searchBefore(req.query.before), visible: (m) => seatCanSee(m) })
          : { results: [], nextBefore: null };
        res.json({ conversation: conversation(seat), ...page });
      },
    },
    {
      method: "GET",
      path: /^\/api\/seat\/message\/(\d{1,15})$/,
      handle: (seat, _req, res, match) => {
        const id = Number(match[1]);
        const all = roomOr404(seat, res);
        if (!all) return;
        const m = all.find((x) => x.id === id);
        if (!m || !seatCanSee(m)) { res.status(404).json({ error: "Message not found" }); return; }
        res.json(m);
      },
    },
  ];
}

/** The paths of the allowlist, for the design note and tests. */
export const SEAT_ALLOWLIST: readonly string[] = ["GET /api/seat/me", "GET /api/seat/read", "GET /api/seat/search", "GET /api/seat/message/:id"];

function refuse(res: Response, status: 401 | 403, error: string): void {
  res.setHeader("Cache-Control", "no-store");
  if (status === 401) res.setHeader("WWW-Authenticate", 'JoindSeat realm="joind-readonly-seat"');
  res.status(status).json({ error, readOnlySeat: true });
}

/** Every place another credential may ride: a seat token found in one of
 *  them is refused, never read as that credential. */
function otherCredentialValues(req: Request): string[] {
  const queryValues: string[] = [];
  const query = req.query as Record<string, unknown>;
  for (const k of Object.keys(query)) {
    const v = query[k];
    if (typeof v === "string") queryValues.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") queryValues.push(x);
  }
  return credentialSlotValues(req.headers, queryValues);
}

/** The values in every credential slot other than the seat header: the
 *  Authorization value (scheme dropped), the agent-key and web-token
 *  headers, and the given query values. */
function credentialSlotValues(headers: IncomingHttpHeaders, queryValues: string[]): string[] {
  const out: string[] = [];
  const authz = headers.authorization;
  if (typeof authz === "string") {
    const m = /^\s*\S+\s+(\S+)\s*$/.exec(authz);
    out.push(m ? m[1] : authz.trim());
  }
  for (const h of ["x-joind-agent-key", "x-joind-token"]) {
    const v = headers[h];
    if (typeof v === "string") out.push(v.trim());
    else if (Array.isArray(v)) for (const x of v) out.push(x.trim());
  }
  out.push(...queryValues);
  return out;
}

/**
 * The socket upgrade rule, matching the HTTP gate: an upgrade carrying the
 * seat header (any value), or a seat token in any other credential slot, is
 * refused before the socket opens, so a seat never holds a socket. Returns
 * the refusal message, or null to let the upgrade go on to the web-token
 * check.
 */
export function seatUpgradeRefusal(store: ReadonlySeatStore, headers: IncomingHttpHeaders, url: string | undefined): string | null {
  if (headers[SEAT_HEADER] !== undefined) return "A read-only seat token cannot open a socket";
  let queryValues: string[] = [];
  try {
    queryValues = [...new URL(url ?? "", "http://localhost").searchParams.values()];
  } catch {
    queryValues = [];
  }
  if (credentialSlotValues(headers, queryValues).some((v) => v.startsWith(SEAT_TOKEN_PREFIX) && store.isSeatToken(v))) {
    return "A read-only seat token cannot open a socket";
  }
  return null;
}

/**
 * The seat gate. Mounted before every other middleware and route.
 *
 * - A request with the seat header is answered here and nowhere else: a
 *   valid token on an allowlisted route is served; a valid token anywhere
 *   else is 403; an unknown or revoked token is 401. It never calls next().
 * - A request without the header on /api/seat... is 401 (the seat routes
 *   take no other credential).
 * - A seat token placed in another credential slot (Authorization, the
 *   agent-key or web-token header, any query parameter) is 403.
 * - Everything else passes through untouched.
 */
export function seatGate(store: ReadonlySeatStore, rooms: SeatRoomSource): RequestHandler {
  const routes = seatRoutes(rooms);
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = normalizeSeatPath(req.path);
    const onSeatPath = p === SEAT_PATH_PREFIX || p.startsWith(SEAT_PATH_PREFIX + "/");
    const header = req.get(SEAT_HEADER);
    if (header === undefined) {
      if (onSeatPath) { refuse(res, 401, "A read-only seat token is required here: send it as X-Joind-Seat-Token"); return; }
      if (otherCredentialValues(req).some((v) => v.startsWith(SEAT_TOKEN_PREFIX) && store.isSeatToken(v))) {
        refuse(res, 403, "A read-only seat token is accepted only in X-Joind-Seat-Token, on the seat's read routes");
        return;
      }
      next();
      return;
    }
    const seat = store.verify(header.trim());
    if (!seat) { refuse(res, 401, "Unknown or revoked read-only seat token"); return; }
    const method = req.method.toUpperCase();
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.path.exec(p);
      if (!m) continue;
      store.noteUse(seat.id);
      res.setHeader("Cache-Control", "no-store");
      r.handle(seat, req, res, m);
      return;
    }
    refuse(res, 403, "A read-only seat may only read its own room (GET /api/seat/me, /api/seat/read, /api/seat/search, /api/seat/message/:id)");
  };
}

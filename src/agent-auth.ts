/**
 * Agent credentials (docs/superpowers/specs/2026-09-29-agent-credentials-design.md).
 *
 * One crew key per server (the agent key) authenticates the join and every
 * agent call. The registration id a key-authenticated join returns is a
 * credential for that name's own callbacks, so wake prompts never carry the
 * key. Three modes: off (no checks), warn (count and log, never refuse; the
 * default), require (refuse without a credential).
 *
 * The key is never logged, never put in a prompt, and never sent to a web
 * client except through the explicit reveal route.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

/** Constant-time comparison over SHA-256 digests (lengths always match), as
 *  config.ts tokensEqual; kept here so this module has no import cycle. */
function tokensEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export type AgentAuthMode = "off" | "warn" | "require";

export const AGENT_AUTH_MODES: readonly AgentAuthMode[] = ["off", "warn", "require"];

/** Parse a mode; undefined or empty gives the default (warn). Throws on anything else. */
export function parseAgentAuthMode(raw: string | undefined): AgentAuthMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return "warn";
  if ((AGENT_AUTH_MODES as readonly string[]).includes(v)) return v as AgentAuthMode;
  throw new Error(`Invalid agent auth mode ${JSON.stringify(raw)}: expected off, warn or require`);
}

/** Minimum length of a key set by flag or env. */
export const MIN_AGENT_KEY_LENGTH = 16;

/** The key file lives beside the data dir, never in it (as the web token). */
export function agentKeyPath(dataDir: string): string {
  return join(resolve(dataDir), "..", "joind-agent-key");
}

export function newAgentKey(): string {
  return randomBytes(32).toString("hex");
}

/** Read the persisted key, or mint and persist one. */
export function loadOrCreateAgentKey(dataDir: string): string {
  const path = agentKeyPath(dataDir);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0) return existing;
  } catch {
    // No key file yet: create one below.
  }
  const key = newAgentKey();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key + "\n", { mode: 0o600 });
  return key;
}

/** A short, non-reversible label for a key (safe to show and log). */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** Minimal request shape the extractors read (Express's Request fits). */
export interface CredentialSource {
  get(name: string): string | undefined;
  query: unknown;
}

function queryString(q: unknown, name: string): string | undefined {
  if (!q || typeof q !== "object") return undefined;
  const v = (q as Record<string, unknown>)[name];
  return typeof v === "string" && v ? v : undefined;
}

/**
 * The agent key a request presents: `Authorization: Bearer`, else
 * `X-Joind-Agent-Key`, else the `agentKey` query parameter. Undefined when
 * none is present.
 */
export function presentedAgentKey(req: CredentialSource): string | undefined {
  const authz = req.get("authorization");
  if (typeof authz === "string") {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authz);
    if (m) return m[1];
  }
  const header = req.get("x-joind-agent-key");
  if (typeof header === "string" && header.trim()) return header.trim();
  return queryString(req.query, "agentKey");
}

/** The web token a request presents in its header or query (never the body:
 *  the gate runs before any body is parsed). */
export function presentedWebToken(req: CredentialSource): string | undefined {
  const header = req.get("x-joind-token");
  if (typeof header === "string" && header) return header;
  return queryString(req.query, "token");
}

/**
 * What a request carries, as far as the header and query tell:
 * "key" (the agent key), "web" (the web token), "bad" (an agent key that is
 * wrong), or "none".
 */
export type Credential = "key" | "web" | "bad" | "none";

/** How the gate treats a path. */
export type RouteClass =
  | "outside"      // not an agent-auth concern (static files, the page, /data/files)
  | "exempt"       // authenticates itself (link token, web registration)
  | "callback"     // resolves the caller's binding; a credentialed registration admits it
  | "gated";       // needs the key or the web token

const CALLBACK_ROUTES: ReadonlyArray<[string, RegExp]> = [
  ["GET", /^\/api\/agent\/(read|listen|unread|decisions)$/],
  ["POST", /^\/api\/agent\/(send|heartbeat|typing|status|leave|pending\/delete)$/],
  ["POST", /^\/api\/message\/[^/]+\/resolve$/],
];

/** Classify a request path (no query) for the gate. */
export function classifyRoute(method: string, path: string): RouteClass {
  // Express matches paths case-insensitively and ignores a trailing slash;
  // classify the same way so no spelling slips past the gate.
  const p = path.toLowerCase().replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  if (p !== "/mcp" && !p.startsWith("/mcp/") && p !== "/api" && !p.startsWith("/api/")) return "outside";
  if (p === "/api/peer" || p.startsWith("/api/peer/")) return "exempt";
  if (p === "/api/web/register") return "exempt";
  const m = method.toUpperCase();
  if (CALLBACK_ROUTES.some(([meth, re]) => meth === m && re.test(p))) return "callback";
  return "gated";
}

/** A stable label for a path in counters and logs: id-like segments become :id. */
export function routeLabel(method: string, path: string): string {
  const segs = path.split("/").map((s) => (/^\d+$/.test(s) || /^[0-9a-f-]{16,}$/i.test(s) || s.length > 40 ? ":id" : s));
  return `${method.toUpperCase()} ${segs.join("/").slice(0, 120)}`;
}

export interface AgentAuthCounter {
  route: string;
  /** Calls with no credential. */
  missing: number;
  /** Calls with a wrong agent key. */
  bad: number;
  /** Calls naming a registration that is not a credential (unknown or revoked). */
  badRegistration: number;
  lastAt: number;
  lastFrom?: string;
  lastName?: string;
}

export interface AgentAuthStatus {
  mode: AgentAuthMode;
  keySource: "file" | "flag";
  fingerprint: string;
  rotatedAt: number | null;
  since: number;
  /** In warn: calls that require would have refused. In require: calls refused. */
  unauthenticated: number;
  routes: AgentAuthCounter[];
  /** The web token is served in index.html (require refuses to start then). */
  webTokenServed: boolean;
}

export type AgentAuthFailure = "missing" | "bad" | "badRegistration";

export interface AgentAuthOptions {
  mode: AgentAuthMode;
  key: string;
  keyUserSet: boolean;
  /** Where a rotated key is written (file-backed keys only). */
  keyPath?: string;
  webTokenServed: boolean;
  now?: () => number;
  log?: (line: string) => void;
  /** Minimum gap between two log lines for the same route (default 5 min). */
  logEveryMs?: number;
}

const MAX_ROUTES = 200;

export class AgentAuth {
  readonly mode: AgentAuthMode;
  private key: string;
  private readonly keyUserSet: boolean;
  private readonly keyPath?: string;
  private readonly webTokenServed: boolean;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly logEveryMs: number;
  private readonly since: number;
  private rotatedAt: number | null = null;
  /** Registrations that existed at a rotation: never a credential again. */
  private readonly revoked = new Set<string>();
  private readonly counters = new Map<string, AgentAuthCounter>();
  private readonly lastLogAt = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();
  private total = 0;

  constructor(opts: AgentAuthOptions) {
    this.mode = opts.mode;
    this.key = opts.key;
    this.keyUserSet = opts.keyUserSet;
    this.keyPath = opts.keyPath;
    this.webTokenServed = opts.webTokenServed;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.log(line));
    this.logEveryMs = opts.logEveryMs ?? 5 * 60_000;
    this.since = this.now();
  }

  /** The current key, for this process's own calls to itself. Never log it. */
  currentKey(): string {
    return this.key;
  }

  fingerprint(): string {
    return keyFingerprint(this.key);
  }

  get enforcing(): boolean {
    return this.mode === "require";
  }

  /** Constant-time check of a presented key. */
  keyMatches(provided: string | undefined): boolean {
    return tokensEqual(provided, this.key);
  }

  /** What a request carries in its header and query. */
  credentialOf(req: CredentialSource, webTokenOk: (t: string | undefined) => boolean): Credential {
    const key = presentedAgentKey(req);
    if (key !== undefined) return this.keyMatches(key) ? "key" : "bad";
    return webTokenOk(presentedWebToken(req)) ? "web" : "none";
  }

  /**
   * True when `provided` is one of `registrations` (this name's local
   * registrations) and was not revoked by a rotation. Every candidate is
   * compared in constant time.
   */
  registrationAdmits(provided: string | undefined, registrations: string[]): boolean {
    if (!provided) return false;
    let ok = false;
    for (const r of registrations) {
      if (tokensEqual(provided, r) && !this.revoked.has(r)) ok = true;
    }
    return ok;
  }

  /**
   * Record a call that has no valid credential. In warn it is served; in
   * require it is refused by the caller. Logged at most once per route per
   * interval, never with any credential value.
   */
  note(route: string, failure: AgentAuthFailure, from: string | undefined, name?: string): void {
    if (this.mode === "off") return;
    this.total++;
    let c = this.counters.get(route);
    if (!c) {
      if (this.counters.size >= MAX_ROUTES) {
        // Keep the table bounded: fold newcomers into one row.
        route = "(other routes)";
        c = this.counters.get(route);
      }
      if (!c) {
        c = { route, missing: 0, bad: 0, badRegistration: 0, lastAt: 0 };
        this.counters.set(route, c);
      }
    }
    c[failure]++;
    c.lastAt = this.now();
    c.lastFrom = from;
    c.lastName = name && name.length <= 64 ? name : undefined;
    const last = this.lastLogAt.get(route) ?? 0;
    if (c.lastAt - last < this.logEveryMs && last !== 0) {
      this.suppressed.set(route, (this.suppressed.get(route) ?? 0) + 1);
      return;
    }
    const more = this.suppressed.get(route) ?? 0;
    this.suppressed.delete(route);
    this.lastLogAt.set(route, c.lastAt);
    const what = failure === "missing" ? "no agent credential" : failure === "bad" ? "a wrong agent key" : "a registration that is not a credential";
    const who = `${name ? `, name ${JSON.stringify(c.lastName ?? "(long)")}` : ""}${from ? `, from ${from}` : ""}`;
    const tail = this.mode === "warn" ? "; served (warn), require would refuse it" : "; refused (require)";
    this.log(`  [agent-auth] ${route}: ${what}${who}${tail}${more > 0 ? ` (${more} more since the last line)` : ""}`);
  }

  /** Rotate the key: mint, persist, and revoke every registration given. */
  rotate(currentRegistrations: string[]): { fingerprint: string } {
    if (this.keyUserSet || !this.keyPath) throw new AgentKeyRotateError();
    const next = newAgentKey();
    writeFileSync(this.keyPath, next + "\n", { mode: 0o600 });
    this.key = next;
    for (const r of currentRegistrations) this.revoked.add(r);
    this.rotatedAt = this.now();
    this.log(`  [agent-auth] key rotated (fingerprint ${this.fingerprint()}); ${currentRegistrations.length} registration(s) revoked`);
    return { fingerprint: this.fingerprint() };
  }

  status(): AgentAuthStatus {
    return {
      mode: this.mode,
      keySource: this.keyUserSet ? "flag" : "file",
      fingerprint: this.fingerprint(),
      rotatedAt: this.rotatedAt,
      since: this.since,
      unauthenticated: this.total,
      routes: [...this.counters.values()].sort((a, b) => b.lastAt - a.lastAt).map((c) => ({ ...c })),
      webTokenServed: this.webTokenServed,
    };
  }
}

export class AgentKeyRotateError extends Error {
  constructor() {
    super("The agent key is set by --agent-key or JOIND_SERVER_AGENT_KEY (or held in memory because its file could not be written); change it there and restart");
    this.name = "AgentKeyRotateError";
  }
}

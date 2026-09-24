/**
 * WakeCoordinator: makes terminal injection honest.
 *
 * Field data (cpm-engine room, 23 Sep 2026): a local Claude Code session
 * missed about one mention in five (AttachConsole access-denied while two
 * injections overlapped), a remote one missed every mention (no console for
 * a foreign pid), and none of it was visible in the room. Three rules:
 *   1. one injection at a time per terminal (no overlap), whichever room
 *      asks for it;
 *   2. one retry after a short pause on a transient failure;
 *   3. a failure is reported back to the room that asked, rate-limited per
 *      room and agent, and permanent causes (no reachable console) are
 *      reported once until that agent starts a new session there.
 *
 * Two kinds of key, on purpose. Serialization follows the terminal: a wake
 * holds every identity it knows for the target (`pid:1234` and, when known,
 * `pane:7`), so two rooms mentioning the same session never overlap even when
 * one of them registered the session pid-only. Warning state follows the
 * room and name (`<room>:<name>`): a second room with the same agent name has
 * its own right to one warning.
 */

/** "partial": the text reached the terminal but the Enter that submits it
 *  could not be sent (PartialDeliveryError). Never retried: a retry would
 *  type the whole prompt again behind the one already in the input box. */
export type WakeFailureKind = "no-console" | "transient" | "partial";

/** What an attempt did. "skip": the target was gone by the time its turn
 *  came; "moved": the target now lives in a different terminal (the caller
 *  should queue again under the new key). */
export type WakeAttemptResult = "done" | "skip" | "moved";

export interface WakeOutcome {
  ok: boolean;
  result?: WakeAttemptResult;
  kind?: WakeFailureKind;
  attempts: number;
  /** True when the caller should tell the room about this failure now. */
  warn: boolean;
  /** The warn key was reset (new session) while this attempt was running:
   *  the failure belongs to a session that no longer exists. Never warned. */
  stale?: boolean;
  reason?: string;
}

const NO_CONSOLE_PATTERNS = [
  /error 87\b/i,                 // AttachConsole: invalid pid (foreign machine, or no console)
  /error 6\b/i,                  // AttachConsole: invalid handle
  /no such process/i,
  /ESRCH/i,
  /PID 0\b/,
  /not found in any tmux pane/i, // Unix: the pid is not under any tmux pane
  /no console/i,
  // Orca (src/orca.ts wording): the handle names no live, writable terminal
  // ("terminal_handle_stale" observed for unknown and closed handles), or
  // there is no Orca CLI on this host. "orca send failed" stays transient.
  /orca terminal \S+ unavailable \(/i,
  /\bterminal_handle_stale\b/i,
  /orca cli unavailable/i,
];

export function classifyWakeFailure(err: unknown): WakeFailureKind {
  // By name, so this module needs no import from inject.ts.
  if (err instanceof Error && err.name === "PartialDeliveryError") return "partial";
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  return NO_CONSOLE_PATTERNS.some((re) => re.test(text)) ? "no-console" : "transient";
}

/**
 * The base URL an injected prompt should tell the agent to call back on.
 * Wildcard binds map to loopback; IPv6 literals are bracketed.
 */
export function injectBaseUrlFor(host: string, port: number): string {
  let h = host.trim();
  if (h === "" || h === "0.0.0.0" || h === "::" || h === "[::]") h = "127.0.0.1";
  if (h.includes(":") && !h.startsWith("[")) h = `[${h}]`;
  return `http://${h}:${port}`;
}

export class WakeCoordinator {
  private chains = new Map<string, Promise<void>>();
  private lastWarnAt = new Map<string, number>();
  private permanentWarned = new Set<string>();
  /** Bumped by forget(): an attempt started under an older generation
   *  reports stale and never touches the warn record. */
  private generation = new Map<string, number>();
  /** Attempts executing per warn key; a released key is reclaimed once
   *  they drain. */
  private executing = new Map<string, number>();
  private released = new Set<string>();

  constructor(
    private opts: { retryDelayMs?: number; warnCooldownMs?: number; sleep?: (ms: number) => Promise<void> } = {}
  ) {}

  private sleep(ms: number): Promise<void> {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** A new session for this warn key (fresh join, rejoin with a new pid,
   *  departure): give its wake path a fresh chance to be warned about. */
  forget(warnKey: string): void {
    this.released.delete(warnKey);
    this.permanentWarned.delete(warnKey);
    this.lastWarnAt.delete(warnKey);
    this.generation.set(warnKey, (this.generation.get(warnKey) ?? 0) + 1);
  }

  /** The warn key's agent left or its room was destroyed: behave as forget()
   *  for anything still executing, then reclaim the records once it drains. */
  release(warnKey: string): void {
    this.forget(warnKey);
    this.released.add(warnKey);
    this.reclaim(warnKey);
  }

  private reclaim(warnKey: string): void {
    if (!this.released.has(warnKey) || (this.executing.get(warnKey) ?? 0) > 0) return;
    this.released.delete(warnKey);
    this.generation.delete(warnKey);
    this.permanentWarned.delete(warnKey);
    this.lastWarnAt.delete(warnKey);
  }

  /**
   * Run `attempt` serialized after any in-flight attempt sharing any of the
   * `serialKeys` (every identity known for the target terminal), with one
   * retry on a transient failure. Warning decisions are made per `warnKey`
   * (room and agent) against the generation current when each attempt
   * starts, so a target resolved at execution time is judged by its own
   * session.
   */
  run(serialKeys: string[], warnKey: string, attempt: () => Promise<WakeAttemptResult>): Promise<WakeOutcome> {
    const keys = [...new Set(serialKeys)];
    const previous = Promise.all(keys.map((k) => (this.chains.get(k) ?? Promise.resolve()).catch(() => undefined)));
    const task = previous.then(() => this.execute(warnKey, attempt));
    // Keep every chain alive whatever happened, and drop each when it is the tail.
    const tail = task.then(() => undefined, () => undefined);
    for (const k of keys) this.chains.set(k, tail);
    tail.then(() => { for (const k of keys) if (this.chains.get(k) === tail) this.chains.delete(k); });
    return task;
  }

  private async execute(warnKey: string, attempt: () => Promise<WakeAttemptResult>): Promise<WakeOutcome> {
    this.executing.set(warnKey, (this.executing.get(warnKey) ?? 0) + 1);
    try {
      const retryDelay = this.opts.retryDelayMs ?? 400;
      let lastErr: unknown;
      let attempts = 0;
      let gen = 0;
      for (let i = 1; i <= 2; i++) {
        attempts = i;
        // Each attempt is judged by the session current when IT starts: a
        // retry that lands after a rejoin belongs to the new session.
        gen = this.generation.get(warnKey) ?? 0;
        try {
          const result = await attempt();
          return { ok: true, result, attempts: i, warn: false };
        } catch (err) {
          lastErr = err;
          // Retrying cannot help a missing console, and would duplicate a
          // prompt whose text was already delivered.
          if (classifyWakeFailure(err) !== "transient") break;
          if (i === 1) await this.sleep(retryDelay);
        }
      }
      const kind = classifyWakeFailure(lastErr);
      const reason = lastErr instanceof Error ? lastErr.message.split("\n")[0] : String(lastErr);
      if ((this.generation.get(warnKey) ?? 0) !== gen) {
        // The session this attempt was aimed at is gone; its failure must not
        // be announced, nor suppress the new session's first warning.
        return { ok: false, kind, attempts, warn: false, stale: true, reason };
      }
      return { ok: false, kind, attempts, warn: this.shouldWarn(warnKey, kind), reason };
    } finally {
      const left = (this.executing.get(warnKey) ?? 1) - 1;
      if (left > 0) this.executing.set(warnKey, left); else this.executing.delete(warnKey);
      this.reclaim(warnKey);
    }
  }

  private shouldWarn(warnKey: string, kind: WakeFailureKind): boolean {
    // Each partial delivery is its own prompt left unsent in an input box:
    // always worth a line, never folded into a cooldown.
    if (kind === "partial") return true;
    if (kind === "no-console") {
      if (this.permanentWarned.has(warnKey)) return false;
      this.permanentWarned.add(warnKey);
      return true;
    }
    const cooldown = this.opts.warnCooldownMs ?? 10 * 60_000;
    const last = this.lastWarnAt.get(warnKey) ?? 0;
    const now = Date.now();
    if (now - last < cooldown) return false;
    this.lastWarnAt.set(warnKey, now);
    return true;
  }
}

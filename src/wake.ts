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
 * Two keys, on purpose. Serialization follows the terminal (`pid:1234`,
 * `pane:7`): two rooms mentioning the same session must not overlap. Warning
 * state follows the room and name (`<room>:<name>`): a second room with the
 * same agent name has its own right to one warning.
 */

export type WakeFailureKind = "no-console" | "transient";

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
];

export function classifyWakeFailure(err: unknown): WakeFailureKind {
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

  constructor(
    private opts: { retryDelayMs?: number; warnCooldownMs?: number; sleep?: (ms: number) => Promise<void> } = {}
  ) {}

  private sleep(ms: number): Promise<void> {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** A new session for this warn key (fresh join, rejoin with a new pid,
   *  departure): give its wake path a fresh chance to be warned about. */
  forget(warnKey: string): void {
    this.permanentWarned.delete(warnKey);
    this.lastWarnAt.delete(warnKey);
    this.generation.set(warnKey, (this.generation.get(warnKey) ?? 0) + 1);
  }

  /**
   * Run `attempt` serialized after any in-flight attempt for the same
   * `serialKey` (terminal identity), with one retry on a transient failure.
   * Warning decisions are made per `warnKey` (room and agent).
   */
  run(serialKey: string, warnKey: string, attempt: () => Promise<WakeAttemptResult>): Promise<WakeOutcome> {
    const previous = this.chains.get(serialKey) ?? Promise.resolve();
    const gen = this.generation.get(warnKey) ?? 0;
    const task = previous.catch(() => undefined).then(() => this.execute(warnKey, gen, attempt));
    // Keep the chain alive whatever happened, and drop it when it is the tail.
    const tail = task.then(() => undefined, () => undefined);
    this.chains.set(serialKey, tail);
    tail.then(() => { if (this.chains.get(serialKey) === tail) this.chains.delete(serialKey); });
    return task;
  }

  private async execute(warnKey: string, gen: number, attempt: () => Promise<WakeAttemptResult>): Promise<WakeOutcome> {
    const retryDelay = this.opts.retryDelayMs ?? 400;
    let lastErr: unknown;
    let attempts = 0;
    for (let i = 1; i <= 2; i++) {
      attempts = i;
      try {
        const result = await attempt();
        return { ok: true, result, attempts: i, warn: false };
      } catch (err) {
        lastErr = err;
        if (classifyWakeFailure(err) === "no-console") break; // retrying cannot help
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
  }

  private shouldWarn(warnKey: string, kind: WakeFailureKind): boolean {
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

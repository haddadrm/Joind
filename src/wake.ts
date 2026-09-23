/**
 * WakeCoordinator: makes terminal injection honest.
 *
 * Field data (cpm-engine room, 23 Sep 2026): a local Claude Code session
 * missed about one mention in five (AttachConsole access-denied while two
 * injections overlapped), a remote one missed every mention (no console for
 * a foreign pid), and none of it was visible in the room. Three rules:
 *   1. one injection at a time per target (no overlap);
 *   2. one retry after a short pause on a transient failure;
 *   3. a failure is reported back to the room, rate-limited per agent, and
 *      permanent causes (no reachable console) are reported once until
 *      the agent rejoins.
 */

export type WakeFailureKind = "no-console" | "transient";

export interface WakeOutcome {
  ok: boolean;
  kind?: WakeFailureKind;
  attempts: number;
  /** True when the caller should tell the room about this failure now. */
  warn: boolean;
  reason?: string;
}

const NO_CONSOLE_PATTERNS = [/error 87\b/i, /error 6\b/i, /no such process/i, /ESRCH/i, /PID 0\b/];

export function classifyWakeFailure(err: unknown): WakeFailureKind {
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  return NO_CONSOLE_PATTERNS.some((re) => re.test(text)) ? "no-console" : "transient";
}

export class WakeCoordinator {
  private chains = new Map<string, Promise<void>>();
  private lastWarnAt = new Map<string, number>();
  private permanentWarned = new Set<string>();

  constructor(
    private opts: { retryDelayMs?: number; warnCooldownMs?: number; sleep?: (ms: number) => Promise<void> } = {}
  ) {}

  private sleep(ms: number): Promise<void> {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** An agent rejoined (new pid): give its wake path a fresh chance. */
  forget(name: string): void {
    this.permanentWarned.delete(name);
    this.lastWarnAt.delete(name);
  }

  /**
   * Run `attempt` for `name`, serialized after any in-flight attempt for the
   * same name, with one retry on a transient failure.
   */
  run(name: string, attempt: () => Promise<void>): Promise<WakeOutcome> {
    const previous = this.chains.get(name) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.execute(name, attempt));
    // Keep the chain alive whatever happened, and drop it when it is the tail.
    const tail = task.then(() => undefined, () => undefined);
    this.chains.set(name, tail);
    tail.then(() => { if (this.chains.get(name) === tail) this.chains.delete(name); });
    return task;
  }

  private async execute(name: string, attempt: () => Promise<void>): Promise<WakeOutcome> {
    const retryDelay = this.opts.retryDelayMs ?? 400;
    let lastErr: unknown;
    for (let i = 1; i <= 2; i++) {
      try {
        await attempt();
        return { ok: true, attempts: i, warn: false };
      } catch (err) {
        lastErr = err;
        if (classifyWakeFailure(err) === "no-console") break; // retrying cannot help
        if (i === 1) await this.sleep(retryDelay);
      }
    }
    const kind = classifyWakeFailure(lastErr);
    const reason = lastErr instanceof Error ? lastErr.message.split("\n")[0] : String(lastErr);
    return { ok: false, kind, attempts: kind === "no-console" ? 1 : 2, warn: this.shouldWarn(name, kind), reason };
  }

  private shouldWarn(name: string, kind: WakeFailureKind): boolean {
    if (kind === "no-console") {
      if (this.permanentWarned.has(name)) return false;
      this.permanentWarned.add(name);
      return true;
    }
    const cooldown = this.opts.warnCooldownMs ?? 10 * 60_000;
    const last = this.lastWarnAt.get(name) ?? 0;
    const now = Date.now();
    if (now - last < cooldown) return false;
    this.lastWarnAt.set(name, now);
    return true;
  }
}

/**
 * Joind runtime configuration.
 *
 * Resolves port, data directory, and instance label from CLI flags and
 * environment variables, with sane defaults for the single-instance case.
 *
 * Precedence: CLI flag > env var > default.
 */

import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { ensureDir } from "./persist.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = join(__dirname, "..", "data");
const DEFAULT_PORT = 4200;
const DEFAULT_INSTANCE = "Joind";
// Bind to loopback by default so a stock install is never exposed to the
// network. Set --host / JOIND_HOST to a Tailscale IP (e.g. 100.x.y.z) to make
// the room reachable by remote agents over the tailnet, or 0.0.0.0 for all
// interfaces. Never expose to a public interface without auth in front.
const DEFAULT_HOST = "127.0.0.1";

export interface JoindConfig {
  port: number;
  host: string;
  dataDir: string;
  instance: string;
  crewHome: string;
  humanNames: string[];
  /** Presence removal grace for unverifiable pids, in ms. */
  presenceGraceMs: number;
  /** Log file path, or "none" to disable file logging. */
  logFile: string;
  webToken: string;
  /** True when the token came from --web-token / JOIND_WEB_TOKEN (not generated+served). */
  webTokenUserSet: boolean;
}

function getFlag(argv: string[], name: string): string | undefined {
  const eq = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}` && i + 1 < argv.length) return argv[i + 1];
    if (a.startsWith(eq)) return a.slice(eq.length);
  }
  return undefined;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): JoindConfig {
  const portRaw = getFlag(argv, "port") ?? process.env.JOIND_PORT;
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${portRaw}`);
  }

  const dataDirRaw = getFlag(argv, "data-dir") ?? process.env.JOIND_DATA_DIR;
  const dataDir = resolve(dataDirRaw ?? DEFAULT_DATA_DIR);

  const instance = getFlag(argv, "name") ?? process.env.JOIND_INSTANCE ?? DEFAULT_INSTANCE;

  const host = getFlag(argv, "host") ?? process.env.JOIND_HOST ?? DEFAULT_HOST;

  const crewHome =
    getFlag(argv, "crew-home") ?? process.env.JOIND_CREW_HOME ?? join(homedir(), "joind-crew");

  // Names the human answers to in rooms; @mentions of these ring the bell.
  const humanNamesRaw =
    getFlag(argv, "human-names") ?? process.env.JOIND_HUMAN_NAMES ?? "Admiral,Rami";
  const humanNames = humanNamesRaw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);

  // Web token: gates DM visibility for browser clients (WS + viewer REST).
  // Flag/env wins; otherwise reuse the persisted token so all browser tabs
  // share it across restarts; otherwise mint and persist one. The file lives
  // NEXT TO the data dir, never inside it (/data used to expose the dir).
  const webTokenOverride = getFlag(argv, "web-token") ?? process.env.JOIND_WEB_TOKEN;
  const webTokenUserSet = !!webTokenOverride;
  const webToken = webTokenOverride ?? loadOrCreateWebToken(dataDir);

  // Presence grace (seconds on the flag, ms internally); minimum 120s.
  const graceRaw = getFlag(argv, "presence-grace") ?? process.env.JOIND_PRESENCE_GRACE;
  const graceSec = graceRaw != null ? Number(graceRaw) : 1800;
  const presenceGraceMs = Math.max(120, Number.isFinite(graceSec) ? graceSec : 1800) * 1000;

  // File log: default lives under the data dir; "none" disables.
  const logFile =
    getFlag(argv, "log-file") ?? process.env.JOIND_LOG_FILE ?? join(dataDir, "logs", "joind.log");

  return { port, host, dataDir, instance, crewHome, humanNames, presenceGraceMs, logFile, webToken, webTokenUserSet };
}

/** Secrets live beside the data dir, not in it (the /data mount is scoped, but depth is safer). */
export function webTokenPath(dataDir: string): string {
  return join(resolve(dataDir), "..", "joind-web-token");
}

/** The registered human viewer name is stored next to the token. */
export function webNamePath(dataDir: string): string {
  return join(resolve(dataDir), "..", "joind-web-name");
}

function loadOrCreateWebToken(dataDir: string): string {
  const tokenPath = webTokenPath(dataDir);
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length > 0) return existing;
  } catch {
    // No token file yet: create one below.
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  return token;
}

/** Read the persisted web name, or null if none is registered yet. */
export function loadWebName(dataDir: string): string | null {
  try {
    const name = readFileSync(webNamePath(dataDir), "utf8").trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Validate a name the browser wants to register as the human viewer.
 * Returns the trimmed name, or null when invalid.
 */
export function validWebName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > 64) return null;
  // No control characters: the name rides in URLs and JSON payloads.
  if (/[\x00-\x1f\x7f]/.test(name)) return null;
  return name;
}

export type RegisterDecision = "accept-first" | "accept-same" | "reject-conflict";

/**
 * HTTP registration policy: the first name wins; re-registering the same
 * name is idempotent; anything else is a conflict (renames go over the
 * authenticated WebSocket channel instead).
 */
export function canRegister(current: string | null, submitted: string): RegisterDecision {
  if (current === null) return "accept-first";
  if (current === submitted) return "accept-same";
  return "reject-conflict";
}

/**
 * Constant-time token comparison (SHA-256 digests so lengths always match).
 * A missing provided token never matches.
 */
export function tokensEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Inject the web token into index.html just before </head> (pure, testable). */
export function injectWebToken(html: string, token: string): string {
  const safe = token.replace(/[^a-f0-9]/gi, "");
  const snippet = `<script>window.__JOIND_TOKEN="${safe}";</script>`;
  const idx = html.indexOf("</head>");
  if (idx < 0) return html + snippet;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

/**
 * Acquire an exclusive lock on the data directory so two Joind servers
 * can't write to the same files. Returns a release function.
 *
 * The lock is a JSON file containing pid/start/instance. If a stale lock
 * exists (its PID is dead) we replace it. If a live lock exists, throw.
 */
export function acquireLock(cfg: JoindConfig): () => void {
  ensureDir(cfg.dataDir);
  const lockPath = join(cfg.dataDir, ".joind.lock");

  if (existsSync(lockPath)) {
    let live = false;
    try {
      const raw = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
      if (typeof raw.pid === "number") {
        try {
          process.kill(raw.pid, 0);
          live = true;
        } catch {
          live = false;
        }
      }
    } catch {
      // Corrupt lock — treat as stale.
    }
    if (live) {
      throw new Error(
        `Another Joind instance is already using ${cfg.dataDir} (lock at ${lockPath}). ` +
        `Pass --data-dir or stop the other instance.`
      );
    }
  }

  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, start: new Date().toISOString(), instance: cfg.instance, port: cfg.port }, null, 2)
  );

  return () => {
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  };
}

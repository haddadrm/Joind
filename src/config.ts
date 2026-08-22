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

  return { port, host, dataDir, instance };
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

/**
 * File logging: tee console output to a log file and record crash causes.
 * Motivated by a field report: the server on another machine exited with
 * result 1 and left no trace anywhere, so the cause was unrecoverable and
 * agents could not tell a dead server from a quiet room.
 */

import { appendFileSync, existsSync, statSync, renameSync } from "fs";
import { dirname } from "path";
import { ensureDir } from "./persist.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function stamp(): string {
  return new Date().toISOString();
}

function safeAppend(path: string, line: string): void {
  try {
    appendFileSync(path, line);
  } catch { /* logging must never take the server down */ }
}

/**
 * Start teeing console.log/warn/error to `path` (with timestamps) and
 * register process-level handlers so a crash leaves a cause behind.
 * Pass "none" to disable. Rotates a >5MB file to `<path>.old` at boot.
 */
export function initFileLog(path: string): void {
  if (!path || path === "none") return;
  try {
    ensureDir(dirname(path));
    if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) {
      renameSync(path, path + ".old");
    }
  } catch { return; }

  const tee = (level: string, original: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      original(...args);
      const text = args
        .map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
        .join(" ");
      safeAppend(path, `${stamp()} [${level}] ${text}\n`);
    };

  console.log = tee("info", console.log.bind(console));
  console.warn = tee("warn", console.warn.bind(console));
  console.error = tee("error", console.error.bind(console));

  process.on("uncaughtException", (err) => {
    safeAppend(path, `${stamp()} [fatal] uncaughtException: ${err?.stack ?? String(err)}\n`);
    process.exitCode = 1;
    // Re-throwing is pointless inside the handler; exit deliberately so the
    // task scheduler sees a failure it can restart.
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    safeAppend(path, `${stamp()} [error] unhandledRejection: ${detail}\n`);
  });
  process.on("exit", (code) => {
    safeAppend(path, `${stamp()} [info] process exit with code ${code}\n`);
  });

  safeAppend(path, `${stamp()} [info] --- log opened (pid ${process.pid}) ---\n`);
}

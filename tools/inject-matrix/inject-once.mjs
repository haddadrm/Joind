// One injection through the project's real injector (dist/inject.js).
// Usage: MATRIX_TEXT=<text> node inject-once.mjs <pid> [weztermPaneId] [weztermSocket]
// Prints one JSON line: { resolved, error, ms, log }.
// "resolved" only means inject() did not throw. Whether the text arrived is
// decided by the caller from the receiver's log, because the Windows backend
// can report success when WriteConsoleInputW wrote nothing.
import { inject } from "../../dist/inject.js";

const pid = Number(process.argv[2]);
const pane = process.argv[3] ? Number(process.argv[3]) : undefined;
const socket = process.argv[4];
const text = process.env.MATRIX_TEXT ?? "";

const log = [];
console.log = (...args) => { log.push(args.map(String).join(" ")); };

const t0 = performance.now();
const emit = (result) => {
  process.stdout.write(JSON.stringify({ ...result, ms: Math.round(performance.now() - t0), log }) + "\n");
};

try {
  const env = socket ? { WEZTERM_UNIX_SOCKET: socket } : undefined;
  await inject(pid, text, pane, undefined, env);
  emit({ resolved: true, error: null });
} catch (err) {
  emit({ resolved: false, error: err instanceof Error ? err.message : String(err) });
}

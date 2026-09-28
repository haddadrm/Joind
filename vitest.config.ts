import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file runs with CODEX_HOME pointed at a directory that does
    // not exist, so no wake in the suite can read the host's real Codex
    // session store (see tests/setup-codex-home.ts).
    setupFiles: ["tests/setup-codex-home.ts"],
  },
});

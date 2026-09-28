import { tmpdir } from "os";
import { join } from "path";

// A wake typed into a Codex target starts a submit check that reads the
// Codex session stores. The suite must never read the host's real store
// ($CODEX_HOME or ~/.codex): JOIND_CODEX_SESSIONS replaces both, and here
// it names a path that does not exist, which the check reports as
// unverifiable and says nothing. Tests that want a store pass their own
// temp directory as `sessionsDirs`.
const nowhere = join(tmpdir(), `joind-test-no-codex-home-${process.pid}`);
process.env.JOIND_CODEX_SESSIONS = join(nowhere, "sessions");
process.env.CODEX_HOME = nowhere;

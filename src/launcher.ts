/**
 * LaunchService — spawns new TUI agent processes via WezTerm and injects
 * a Joind join command once the process has started.
 *
 * Flow:
 *  1. Caller POSTs /api/launch with crewPath, harness, flags, etc.
 *  2. LaunchService builds the argv array and calls spawnWeztermPane.
 *  3. On success, a timer fires after `injectDelay` ms to inject `/joind ...`.
 *  4. On WezTerm failure, the caller receives the full command for clipboard copy.
 */

import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { injectWezTerm, spawnWeztermPane } from "./inject.js";
import type { HarnessDefinition } from "./harnesses.js";
import { applyProjectMcp } from "./mcp-merge.js";

export type LaunchStatus =
  | "pending"
  | "spawning"
  | "spawned"
  | "waiting"
  | "injecting"
  | "done"
  | "failed"
  | "waiting-join"
  | "joined"
  | "join-timeout";

/** Checks whether `joinAs` is present and active in a conversation, at the moment of the call. */
export type PresenceProbe = (joinAs: string, conversation?: string) => boolean;

export interface LaunchRequest {
  crewName: string;
  crewPath: string;
  harness: string;           // harness id
  flags: Record<string, string | string[] | boolean>;
  conversation?: string;     // conversation id to join
  joinAs: string;
  injectDelay: number;       // ms — used only when initialPrompt is empty
  terminal: "wezterm" | "wt" | "manual";
  /** Initial prompt passed as a positional argument to the TUI on launch.
   *  When set, no post-launch injection happens. */
  initialPrompt?: string;
  /** Session identifier to resume. When set, buildCommand adds the harness-specific
   *  resume form and buildDefaultPrompt skips the "Read AGENTS.md" instruction. */
  resumeSessionId?: string;
}

export interface LaunchResult {
  launchId: string;
  status: LaunchStatus;
  paneId?: number;           // WezTerm pane ID if available
  command: string;           // full command string for copy fallback
  error?: string;
  joinedAt?: number;         // epoch ms, set when the presence probe confirms the join
}

interface LaunchState {
  req: LaunchRequest;
  harness: HarnessDefinition;
  result: LaunchResult;
  weztermExe?: string;
  weztermEnv?: Record<string, string>;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Build the argv array for a harness invocation from a flags record.
 *
 * - boolean flags: include the CLI flag key only when value is true
 * - multi-text flags: repeat the CLI flag for each element in the array
 * - text/enum flags: emit `--flag value` (skip when empty/undefined)
 */
export function buildCommand(
  harness: HarnessDefinition,
  flags: LaunchRequest["flags"],
  initialPrompt?: string,
  resumeSessionId?: string
): string[] {
  const argv: string[] = [harness.resolvedPath ?? harness.command];

  // Codex: resume is a SUBCOMMAND (`codex resume <opts> <id> <prompt>`).
  // Insert "resume" immediately after the binary, before any flags.
  if (resumeSessionId && harness.id === "codex") {
    argv.push("resume");
  }

  // Autonomy/model flags apply both to fresh launches and resumes —
  // resuming a yolo session in non-yolo mode would silently downgrade.
  for (const flagDef of harness.flags) {
    const value = flags[flagDef.id];
    if (value === undefined || value === null) continue;

    if (flagDef.type === "boolean") {
      if (value === true) argv.push(flagDef.cli);
      continue;
    }

    if (flagDef.type === "multi-text") {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.trim().length > 0) {
            argv.push(flagDef.cli, item.trim());
          }
        }
      } else if (typeof value === "string" && value.trim().length > 0) {
        argv.push(flagDef.cli, value.trim());
      }
      continue;
    }

    // text / enum
    if (typeof value === "string" && value.trim().length > 0) {
      if (flagDef.valueArgs) {
        const expansion = flagDef.valueArgs[value];
        if (expansion && expansion.length > 0) argv.push(...expansion);
        continue;
      }
      if (flagDef.type === "enum" && value === flagDef.default) continue;
      argv.push(flagDef.cli, value.trim());
    }
  }

  // Harness-specific resume argument insertion (after flags, before prompt).
  if (resumeSessionId) {
    switch (harness.id) {
      case "claude":
        argv.push("--resume", resumeSessionId);
        break;
      case "gemini":
        argv.push("--resume", resumeSessionId);
        break;
      case "codex":
        // Codex takes the session ID as a positional argument after flags
        argv.push(resumeSessionId);
        break;
      // openclaw: intentionally not handled — stubbed for v1
    }
  }

  // Append initial prompt as the trailing positional argument.
  // Codex, Gemini, and Claude all accept a free-text prompt at the end of argv.
  if (initialPrompt && initialPrompt.trim().length > 0) {
    argv.push(initialPrompt.trim());
  }

  // On Windows, .cmd/.bat files cannot be executed directly by CreateProcessW
  // (which WezTerm and `wt` both use). Wrap them in cmd.exe /c.
  if (process.platform === "win32") {
    const exe = argv[0] ?? "";
    const lower = exe.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      return ["cmd.exe", "/c", ...argv];
    }
  }

  return argv;
}

/** Build the default initial prompt for a launch.
 *  - Fresh launch: "Read AGENTS.md then join <conv> as <name>"
 *  - Resume: "Join <conv> as <name>" (agent already knows who it is from prior session;
 *    the join still needs an explicit instruction because the agent won't auto-join) */
export function buildDefaultPrompt(req: LaunchRequest): string {
  const isResume = !!req.resumeSessionId;
  if (isResume) {
    if (req.conversation) {
      return `Join ${req.conversation} as ${req.joinAs}`;
    }
    return ""; // resume with no conversation → no prompt
  }
  if (req.conversation) {
    return `Read AGENTS.md then join ${req.conversation} as ${req.joinAs}`;
  }
  return `Read AGENTS.md`;
}

/**
 * Format a human-readable command string for clipboard copy.
 * e.g. `cd "C:/Users/hadda/clawd" && claude --permission-mode auto "Read AGENTS.md..."`
 */
export function formatCommand(
  req: LaunchRequest,
  harness: HarnessDefinition,
  initialPrompt?: string
): string {
  const argv = buildCommand(harness, req.flags, initialPrompt, req.resumeSessionId);
  // Quote path if it contains spaces
  const cdPart = req.crewPath.includes(" ")
    ? `cd "${req.crewPath}"`
    : `cd ${req.crewPath}`;
  // Quote the prompt arg (last token) if it contains spaces, for clipboard readability
  const quotedArgv = argv.map((tok, i) => {
    if (i === argv.length - 1 && tok.includes(" ")) return `"${tok}"`;
    if (tok.includes(" ")) return `"${tok}"`;
    return tok;
  });
  return `${cdPart} && ${quotedArgv.join(" ")}`;
}

/** Build the /joind injection string for a launch request. */
function buildJoinCommand(req: LaunchRequest): string {
  if (req.conversation) {
    return `/joind ${req.conversation} as ${req.joinAs}`;
  }
  return `/joind as ${req.joinAs}`;
}

class LaunchServiceImpl {
  private launches = new Map<string, LaunchState>();
  private presenceProbe?: PresenceProbe;

  /** Register the callback used by startJoinWatch to check whether an agent has joined. */
  setPresenceProbe(probe: PresenceProbe): void {
    this.presenceProbe = probe;
  }

  /**
   * Poll the presence probe until the agent shows up in the room or the
   * timeout elapses. Safe to call once per launch; replaces any pending timer.
   */
  startJoinWatch(
    launchId: string,
    opts?: { intervalMs?: number; timeoutMs?: number }
  ): void {
    const state = this.launches.get(launchId);
    if (!state || !this.presenceProbe) return;
    const probe = this.presenceProbe;
    const intervalMs = opts?.intervalMs ?? 3000;
    const timeoutMs = opts?.timeoutMs ?? 120000;
    const startedAt = Date.now();

    if (state.timer) clearTimeout(state.timer);
    state.result.status = "waiting-join";

    const tick = (): void => {
      if (probe(state.req.joinAs, state.req.conversation)) {
        state.result.status = "joined";
        state.result.joinedAt = Date.now();
        state.timer = undefined;
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        state.result.status = "join-timeout";
        state.timer = undefined;
        return;
      }
      state.timer = setTimeout(tick, intervalMs);
    };
    state.timer = setTimeout(tick, intervalMs);
  }

  /**
   * Spawn a TUI agent process for the given launch request.
   *
   * Branches on req.terminal:
   *  - "wezterm": uses spawnWeztermPane with auto-inject (existing behavior)
   *  - "wt": spawns via Windows Terminal new-tab (detached, no inject)
   *  - "manual": returns command string immediately without spawning
   */
  async launch(
    req: LaunchRequest,
    harness: HarnessDefinition,
    weztermExe?: string,
    weztermEnv?: Record<string, string>,
    wtExe?: string
  ): Promise<LaunchResult> {
    const launchId = randomUUID();
    // Resolve the initial prompt: caller-provided > computed default > none
    const prompt =
      req.initialPrompt && req.initialPrompt.trim().length > 0
        ? req.initialPrompt.trim()
        : buildDefaultPrompt(req);
    const commandStr = formatCommand(req, harness, prompt);

    const result: LaunchResult = {
      launchId,
      status: "spawning",
      command: commandStr,
    };

    const state: LaunchState = {
      req: { ...req, initialPrompt: prompt },
      harness,
      result,
      weztermExe,
      weztermEnv,
    };

    this.launches.set(launchId, state);

    // Merge project .mcp.json into the agent's config when applicable.
    // Never blocks launch — failures only log.
    try {
      const status = applyProjectMcp(harness.id, req.crewPath);
      console.log(`  [launch ${launchId}] mcp-merge: ${status}`);
    } catch (err) {
      console.warn(`  [launch ${launchId}] mcp-merge unexpected: ${(err as Error).message}`);
    }

    // --- manual: no spawn, just return command ---
    if (req.terminal === "manual") {
      result.status = "spawned";
      return { ...result };
    }

    // --- Windows Terminal: spawn detached, no inject ---
    if (req.terminal === "wt") {
      const argv = buildCommand(harness, req.flags, prompt, req.resumeSessionId);
      const wtBin = wtExe ?? "wt";
      const quotedPath = req.crewPath.includes(" ")
        ? `"${req.crewPath}"`
        : req.crewPath;
      // wt new-tab --startingDirectory "<path>" --title "<name>" -- <cmd...>
      const wtArgs = [
        "new-tab",
        "--startingDirectory", quotedPath,
        "--title", req.crewName,
        "--",
        ...argv,
      ];
      try {
        const child = spawn(wtBin, wtArgs, {
          detached: true,
          stdio: "ignore",
          shell: false,
        });
        child.unref();
        result.status = "spawned";
        if (req.joinAs && this.presenceProbe) {
          this.startJoinWatch(launchId);
        }
      } catch (spawnErr) {
        result.status = "spawned";
        result.error = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        console.warn(`[launcher] Windows Terminal spawn failed (${result.error}). Returning manual command.`);
      }
      return { ...result };
    }

    // --- WezTerm (default): spawn pane with prompt baked into argv ---
    const argv = buildCommand(harness, req.flags, prompt, req.resumeSessionId);

    try {
      const paneId = await spawnWeztermPane({
        cwd: req.crewPath,
        command: argv,
        tabTitle: req.crewName,
        weztermExe,
        weztermEnv,
      });

      result.paneId = paneId;
      // Prompt is in argv → TUI starts already running it. No auto-inject needed.
      result.status = "done";
      if (req.joinAs && this.presenceProbe) {
        this.startJoinWatch(launchId);
      }
    } catch (spawnErr) {
      // WezTerm not available or failed — return command for manual use
      result.status = "spawned";
      result.paneId = undefined;
      result.error =
        spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      console.warn(
        `[launcher] WezTerm spawn failed (${result.error}). Returning manual command.`
      );
    }

    return { ...result };
  }

  /**
   * Manually trigger injection for an existing launch.
   * Used by POST /api/launch/:launchId/inject.
   */
  async inject(launchId: string): Promise<void> {
    const state = this.launches.get(launchId);
    if (!state) {
      throw new Error(`Launch ${launchId} not found`);
    }

    const { result, req } = state;
    if (result.paneId == null) {
      throw new Error(`Launch ${launchId} has no pane ID — WezTerm spawn failed`);
    }

    // Cancel pending auto-inject timer if called manually
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    result.status = "injecting";

    const joinCmd = buildJoinCommand(req);

    await injectWezTerm(
      result.paneId,
      joinCmd,
      state.weztermExe,
      state.weztermEnv
    );

    result.status = "done";

    // Manual inject shares LaunchState.timer with the join watch, so the
    // clearTimeout above (if it caught a pending watch) would otherwise
    // strand the launch on "done" forever. Restart the watch so the launch
    // can still reach joined/join-timeout, mirroring what launch() does.
    if (req.joinAs && this.presenceProbe) {
      this.startJoinWatch(launchId);
    }
  }

  /** Get the current status of a launch by ID. Returns null if not found. */
  getLaunchStatus(launchId: string): LaunchResult | null {
    const state = this.launches.get(launchId);
    return state ? { ...state.result } : null;
  }
}

const LaunchService = new LaunchServiceImpl();
export default LaunchService;

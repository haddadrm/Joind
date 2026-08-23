# Headless agent launching via ACP: engineering brief for Joind

Research date: 2026-08-23, to scope a future headless launch mode. Epistemic status per section: VERIFIED means checked against live web sources on the research date; RECALLED means an agent's training knowledge (May 2026 cutoff) that was NOT verified against primary sources and needs a live check before anyone builds on it.

## 1. BUZZ, identified (VERIFIED)

BUZZ is **Buzz by Block** (Jack Dorsey's company), at buzz.xyz: a group chat workspace where AI agents are first-class channel members alongside humans, described as "Slack for humans and coding agents". The parts relevant to Joind:

- **It uses ACP.** Buzz connects to locally installed agent harnesses (goose, Claude Code, Codex) through the Agent Client Protocol. The desktop app detects installed harnesses and installs missing adapters with a click; each agent can override the default harness/model pair. So the "hidden window" is in fact no window: agents run as headless ACP subprocesses while Buzz renders the chat.
- **Identity rides on Nostr.** Every participant, human or agent, holds its own cryptographic keypair; channels, threads, DMs and workflows ride the Nostr protocol. That is Buzz's answer to the crew-identity problem Joind solves with crew folders + identity kits.
- **Known pain:** on Windows 11 the adapter installation has failed for both Claude Code and Codex even when both CLIs work in PowerShell, and a recent release (Desktop v0.5.8) fixed managed agents not reading/replying. The polish gap is real and recent.
- Joind's differentiator stands: Buzz manages the agent lifecycle inside its app; Joind's philosophy keeps each agent in its own harness with its own memory system, with the room as a meeting place. ACP for Joind is a launch transport option, not an architecture change.

Sources: [Block's announcement](https://block.xyz/inside/introducing-buzz-where-humans-and-agents-work-together), [hands-on review](https://www.devtoolsdaily.com/blog/a-week-with-buzz-coding-agents/), [setup guide](https://www.dplooy.com/blog/buzz-by-block-setup-claude-code-agents-channels), [use cases](https://www.hostinger.com/tutorials/buzz-use-cases/), [v0.5.8 fix note](https://digg.com/tech/ljcko1wt).

## 2. Adapters (VERIFIED, decay-prone: re-check at implementation time)

- **Claude:** `@zed-industries/claude-code-acp` (npm, v0.16.x) exists and is succeeded by **`@zed-industries/claude-agent-acp`** (v0.23.x), powered by the Claude Agent SDK. There is also `agentclientprotocol/claude-agent-acp` under the ACP org itself, implementing the permission extension. Zed ships prebuilt single-file binaries per platform on its releases page, which sidesteps the Windows npx/.cmd problem entirely: prefer the binary.
- **Codex:** no first-party ACP adapter found; community bridges exist (e.g. `zedcode-acps` supports both Claude Code and Codex with streaming and tool-call mapping; `claude-code-cli-acp` is a Rust PTY bridge for the real CLI).
- **Neovim (CodeCompanion) and Emacs consume ACP** via the same adapters, which is good evidence the adapter surface is stable enough to build on.

Sources: [npm claude-code-acp](https://www.npmjs.com/package/@zed-industries/claude-code-acp), [npm claude-agent-acp](https://www.npmjs.com/package/@zed-industries/claude-agent-acp), [ACP org adapter](https://github.com/agentclientprotocol/claude-agent-acp), [Zed blog](https://zed.dev/blog/claude-code-via-acp), [Zed agent page](https://zed.dev/acp/agent/claude-agent), [zedcode-acps](https://github.com/SuperagenticAI/zedcode-acps).

## 3. ACP protocol shape (RECALLED, verify against https://agentclientprotocol.com and the JSON schema)

JSON-RPC 2.0 over the subprocess's stdin/stdout, newline-delimited, LSP-shaped. Terminology inverts the usual sense: the client is the host app (Joind), the agent is the CLI, and the client spawns the agent. Protocol version is an integer negotiated in `initialize`. Stdout is protocol-only; agent logging goes to stderr.

Method surface (names medium-confidence):
- `initialize`, then `authenticate` if required.
- `session/new` with `cwd` and an `mcpServers` array returns a `sessionId`; `session/load` only if the agent advertises `loadSession`.
- `session/prompt` (MCP-style content blocks) returns a `stopReason` (`end_turn`, `max_tokens`, `refusal`, `cancelled`). **Turn-based: one prompt in flight per session.**
- Agent-to-client `session/update` notifications: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`.
- `session/cancel` as a client notification.
- Client-implemented, capability-gated services: `fs/read_text_file`, `fs/write_text_file`, and a `terminal/*` group.
- **Permissions are first class:** the agent calls `session/request_permission` with options (`allow_once`, `allow_always`, `reject_once`, `reject_always`); the request blocks the agent's turn until the client answers.

SDKs: Rust crate `agent-client-protocol`; TypeScript `@zed-industries/agent-client-protocol` on npm.

## 4. A2A in one paragraph (RECALLED, medium-high confidence)

Agent2Agent originated at Google and moved to the Linux Foundation in 2025 (a2a-protocol.org): JSON-RPC over HTTPS with Agent Cards at `/.well-known/agent-card.json`, a task lifecycle, artifacts, SSE streaming and webhook push. It targets discovery and delegation between independently deployed, network-addressable agent services across vendor boundaries. Wrong layer for Joind: attaching a local subprocess to a local UI is exactly ACP's problem; A2A becomes relevant only if Joind rooms federate across machines or call hosted third-party agents.

## 5. Recommendation for Joind (design reasoning grounded in Joind's actual code and skill surface)

Add a per-harness `LaunchStrategy` of `acp | terminal` rather than replacing the terminal path. Claude (and later Gemini) go ACP first; Codex and Copilot stay on terminal until their adapter story is verified.

- **Spawn:** `child_process.spawn` with piped stdio and `windowsHide: true`. Prefer Zed's prebuilt adapter binary on Windows; if using the npm package, resolve the JS entry and spawn `node <entry>` (never npx directly: .cmd shim quoting and orphaned shims). Pin adapter versions in a Joind-managed install dir. Inherit the environment so existing Claude Code credentials resolve; force UTF-8 stdio.
- **Message injection becomes `session/prompt`,** replacing keystroke injection: lossless and acknowledged. Critical constraint: one prompt in flight per session, no mid-turn injection except cancel. Joind needs a per-agent inbox queue that buffers messages arriving mid-turn and flushes them as one combined prompt on `stopReason`, with queue depth visible in the UI.
- **Streaming out:** map `agent_message_chunk` to a streaming room message, `agent_thought_chunk` to a collapsed thinking block, `tool_call`/`tool_call_update` to a mutating tool card, `plan` to the task list.
- **Permissions:** map `session/request_permission` onto Joind's existing decision-card/task system (urgent task whose response options are the ACP option IDs; resolve the RPC when the human answers). Default to no timeout plus a visible blocked-status pill rather than auto-reject.
- **Capabilities to decline in v1:** advertise `fs` and `terminal` false; the agent uses its own tools and Joind implements no terminal service on day one.
- **MCP relationship:** pass Joind's MCP server via `session/new` `mcpServers` so agents keep chat tools without touching user config. For ACP-launched agents, drop the self-join requirement: Joind owns the transcript mapping directly, removing "agent forgot to post" failures and idle polling burn.
- **Lifecycle/health:** process alive + successful initialize + last-activity timestamp; no protocol heartbeat expected. On crash: restart, `session/load` if advertised, else new session seeded with a Joind-generated context summary. Kill child trees with a job object or `taskkill /T /F`; expect EPIPE on shutdown.
- **Risks:** adapter lag vs harness-native features (hooks, subagents, slash commands); no TUI means no manual rescue, so keep a "reveal in terminal" fallback (respawn same workdir in WezTerm) and write per-agent stdio JSONL to disk for post-mortems; auth breaks silently under a different user/service context; pin and assert protocol/adapter versions; and the turn model is a real UX regression vs a TUI that visibly queues input, so build the queue indicator before shipping.

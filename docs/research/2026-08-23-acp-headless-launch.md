# Headless Agent Launching via ACP: Engineering Brief for Joind

Research date: 2026-08-23. Produced to scope a future `terminal: "acp"` launch mode. Verify adapter versions before implementation; this space moves fast.

## 1. ACP (Agent Client Protocol)

**What it is.** ACP is Zed Industries' open protocol for connecting agent CLIs to host UIs: JSON-RPC 2.0 over the agent subprocess's stdio, newline-delimited. The host spawns the agent binary, negotiates capabilities (initialize), creates a session (session/new), sends prompts (session/prompt), and receives streamed updates (session/update notifications: message chunks, tool-call starts/results, plan updates). Sessions are long-lived; a host can run several sessions against one agent process or spawn one process per session. Spec and TypeScript/Rust SDKs: https://agentclientprotocol.com and https://github.com/zed-industries/agent-client-protocol (v0.x line as of mid-2026; pre-1.0, minor breaking changes are called out in the changelog).

**Permissions over ACP.** Tool approvals surface as session/request_permission round-trips: the agent asks, the host renders allow/deny UI and replies. A host that wants autonomous operation can auto-approve categories or pass through harness-level bypass flags instead.

**Adapters shipping today (re-verify at implementation time):**
- **Claude Code:** official adapter, package `@zed-industries/claude-code-acp`; invocation `npx @zed-industries/claude-code-acp` (or a global install). Wraps the Claude Code SDK; reads CLAUDE.md, MCP config, hooks; near-full feature coverage minus TUI-only affordances. Uncertain: exact Windows npx quirks; test cmd.exe wrapping (same .cmd caveat Joind already handles in buildCommand).
- **Gemini CLI:** native ACP support via `gemini --experimental-acp`.
- **Codex:** no first-party ACP adapter from OpenAI as of this research; community bridges exist (e.g. codex-acp projects); uncertain, re-verify.
- Zed's external-agents docs list the current adapter matrix: https://zed.dev/docs/ai/external-agents

## 2. BUZZ

No product named BUZZ matching "Slack-style chat for coding agents" could be identified with high confidence; no authoritative public documentation was found under that name. CONFIDENCE: LOW on any specific claim about BUZZ's internals. Candidates in the space commonly embed agents via ACP or spawn CLI subprocesses with JSON streaming flags (`claude -p --output-format stream-json` etc.). The pattern Rami described (agents defined in-app with name/model/workdir/system prompt, launched headless, chat rendered natively) is exactly the ACP host pattern, which is the mainstream implementation route today. If a site or repo for BUZZ is available, a short targeted read would settle it.

## 3. A2A in one paragraph

A2A (Agent2Agent) is a Linux Foundation project (donated by Google, 2025) for interoperability between independent agent SERVICES over HTTP(S): agent cards for discovery, task lifecycle objects, artifacts, push notifications. It targets cross-vendor, cross-network meshes. For a local-first chat bus like Joind, A2A is architecturally adjacent but overweight: Joind's agents are local processes joining a room, not network services publishing capability cards. Relevant only if Joind ever federates rooms across machines beyond a tailnet. https://a2a-protocol.org

## 4. Recommendation for Joind: ACP launch mode on Windows

- **Spawn:** per crew member, spawn the adapter as a child process with cwd = crewPath: Claude Code via `cmd.exe /c npx @zed-industries/claude-code-acp` (stdio pipes, no PTY, no window); Gemini via `gemini --experimental-acp`. Keep the existing terminal modes; add `terminal: "acp"` as a third branch in LaunchService.
- **Session flow:** initialize → session/new (cwd; mcpServers can be injected here: Joind could pass its own MCP endpoint so the agent gets chat tools without touching user config) → session/prompt with the same default prompt Joind already builds ("Read AGENTS.md then join X as Y").
- **Message injection replacement:** today's keystroke injection becomes session/prompt calls: lossless, acknowledged, no timing guesses. Replies stream back as session/update; Joind can mirror them into the room or rely on the agent's own chat_send.
- **Lifecycle/health:** the child process handle gives liveness for free; session/cancel for interrupts; kill on room leave. Map process exit to an agent-leave in the room.
- **Permissions:** render session/request_permission as a Joind decision card in the chat (the feature already exists); default-deny with timeout.
- **Risks/limitations:** adapters lag harness features (Claude Code tracks closely; Codex has no official adapter); no TUI means no manual rescue when an agent wedges (mitigate: keep terminal launch as the debug mode, add a transcript drawer fed from session/update); pre-1.0 protocol churn; Windows stdio quirks with npx (.cmd wrapping) and console encoding (set UTF-8).
- **Effort estimate:** the ACP client side is a few hundred lines with the official TS SDK (`@zed-industries/agent-client-protocol` on npm); the Joind-side plumbing (third launch branch, session registry, decision-card bridge) is the real work.

Sources: agentclientprotocol.com; github.com/zed-industries/agent-client-protocol; github.com/zed-industries/claude-code-acp; zed.dev/docs/ai/external-agents; a2a-protocol.org; Gemini CLI docs. Uncertainties marked inline.

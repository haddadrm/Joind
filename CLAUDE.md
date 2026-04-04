# Joind

Universal agent chat via MCP. Any CLI agent joins with `/join`.

## Architecture

- `src/index.ts` — Express server + MCP transport (multi-session, streamable HTTP)
- `src/manager.ts` — ConversationManager: isolated conversations, agent bindings (pid/paneId disambiguated)
- `src/room.ts` — ChatRoom: messages, agents, @mention injection (batched), search, tagging, pinning
- `src/tasks.ts` — TaskStore: conversation-scoped task/input management (JSONL)
- `src/reactions.ts` — ReactionStore: per-message emoji reactions with toggle semantics (JSONL)
- `src/edits.ts` — EditStore: message edit overlays (original JSONL never modified)
- `src/cursors.ts` — CursorStore: per-agent unread tracking (flat JSON, debounced saves)
- `src/tools.ts` — 13 MCP tools + /join prompt
- `src/sessions.ts` — Workflow session engine (structured multi-phase orchestration)
- `src/inject.ts` — Terminal injection (Windows + Unix + WezTerm)
- `src/terminals.ts` — Terminal discovery (Claude, Codex, Gemini, OpenClaw, Copilot)
- `src/persist.ts` — JSONL persistence helpers

## Data Files

- `data/conversations/{id}.jsonl` — Messages (append-only)
- `data/conversations/{id}.tasks.jsonl` — Tasks
- `data/conversations/{id}.reactions.jsonl` — Reactions
- `data/conversations/{id}.edits.jsonl` — Edit overlays
- `data/conversations.json` — Conversation index + active ID
- `data/agent-roles.json` — Per-agent role persistence
- `data/roles.json` — Custom role definitions
- `data/agent-cursors.json` — Unread cursors
- `data/scratchpads.json` — Agent scratchpad notes
- `data/state-blocks.json` — Per-conversation state blocks
- `data/turn-guard.json` — Turn limit settings
- `data/tab-names.json` — WT_SESSION → agent name mapping
- `data/files/` — Uploaded files (any type, 25MB limit)

## MCP Tools (13)

**Core chat:**
- `chat_join(name, pid, conversation?, weztermPaneId?)` — Join a conversation
- `chat_send(sender, text, replyTo?)` — Send a message (@name to mention)
- `chat_read(sender?, since?, limit?, from?)` — Read messages (filter by sender with `from`)
- `chat_who(sender?)` — List online agents
- `chat_leave(name)` — Disconnect
- `chat_typing(name, typing)` — Signal typing status
- `chat_dm(sender, to[], text)` — Send targeted message (DM)

**Reactions, editing & search:**
- `chat_react(sender, messageId, emoji)` — Toggle emoji reaction
- `chat_edit(sender, messageId, newText)` — Edit own message (overlay, preserves original)
- `chat_search(sender, query, limit?)` — Search messages (case-insensitive, newest first)

**Message intelligence:**
- `chat_tag(sender, messageId, tag)` — Classify: decision, status, question, evidence, handoff
- `chat_pin(sender, messageId, pinned?)` — Pin/unpin important messages
- `chat_session_marker(sender, markerType, label?)` — Insert session start/end boundary

**Status & awareness:**
- `chat_status(name, status)` — Set visible status (auto-clears 10min)
- `chat_unread(name)` — Check unread count + senders

**Collaboration:**
- `chat_task(sender, title, description?, assignee?, priority?)` — Create a task
- `chat_tasks(sender?, status?, id?, response?)` — List/resolve tasks
- `chat_handoff(sender, currentState, nextSteps, openQuestions?, blockers?)` — Structured handoff note (auto-pinned)
- `chat_notes(sender, notes?)` — Per-agent scratchpad (read/write)
- `chat_state(sender?, key?, value?)` — Per-conversation state blocks
- `chat_upload(sender, filename, content, message?)` — Upload file + optional message

## Conversation Isolation

Each conversation is fully isolated: separate messages, agents, and JSONL files.
- Agents bound to conversations via `chat_join` with pid/paneId disambiguation
- Same agent name can exist in multiple conversations (different PIDs route correctly)
- WebSocket events filtered by `conversationId` on both server and client
- Deleting a conversation cleans up room state, agent bindings, tasks, reactions, and edits

## REST API

Agent endpoints accept optional `pid` and `paneId` params for disambiguation.
Rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`) on agent responses.

Key endpoints: `/api/agent/join`, `/api/agent/read`, `/api/agent/send`, `/api/agent/leave`,
`/api/agent/status`, `/api/agent/scratchpad`, `/api/agent/unread`,
`/api/message/:id/react`, `/api/message/:id/edit`, `/api/message/:id/tag`, `/api/message/:id/pin`,
`/api/search`, `/api/state`, `/api/roles`, `/api/session-marker`,
`/api/export`, `/api/export/decisions`, `/api/export/summary`.

## Web UI Features

- Real-time WebSocket chat with markdown rendering
- Agent pills with role badges, status text, typing indicators, stale detection
- Tabbed settings dialog (Sounds + Roles with custom role CRUD)
- Emoji reactions (quick palette + full 64-emoji grid)
- Message search overlay with click-to-scroll
- Task panel (right sidebar)
- Auto-scan terminals every 15s with fingerprint diffing
- Session workflow engine with templates

## Terminal Integration

**WezTerm (recommended):** Clean pane-based discovery and injection via CLI.
**Windows Terminal (fallback):** Python ctypes AttachConsole + PowerShell UIAutomation.
**Unix:** tmux send-keys.

Detected agent types: Claude, Codex, Gemini, OpenClaw, Copilot.

## Build & Run

```bash
pnpm build    # TypeScript → dist/
pnpm start    # Server on port 4200
```

## Connect from Claude Code

Add to `.mcp.json`:
```json
{ "mcpServers": { "joind": { "type": "http", "url": "http://127.0.0.1:4200/mcp" } } }
```

Then: `/join YourName`

# Changelog

## 2026-04-04 — "Make the Crew Happy" Release

### Phase 1: Bug Fixes & Admiral's Orders

#### Fixed
- **Conversation bleed bug** (CRITICAL): Agent name bindings were a flat `Map<name, convId>` — same-name agents across conversations overwrote each other, routing messages to the wrong conversation. Restructured to `Map<name, Array<{convId, pid, paneId}>>` with disambiguation by paneId (most specific), pid, then single-entry fallback. Updated all agent REST endpoints, MCP tools, and injection prompts to pass pid/paneId for correct routing.

#### Added
- **Copilot TUI detection**: Terminal scanner now discovers GitHub Copilot TUI processes (`copilot` command pattern). Added `"copilot"` type to `TerminalInfo` and GitHub blue (`#1f6feb`) to sender colors.
- **Role persistence on rejoin**: Agent roles now persist in `data/agent-roles.json`. When an agent leaves and rejoins, their role is automatically restored. Roles are passed through all join paths (REST, MCP, web UI).
- **Custom role CRUD**: New endpoints `GET /api/roles`, `POST /api/roles`, `DELETE /api/roles/:label`. Custom roles stored in `data/roles.json`. Preset roles (16 built-in) moved from hardcoded frontend to server-side source of truth. `"roles-updated"` WebSocket event broadcasts changes to all clients.
- **Roles sidebar section**: New collapsible "Roles" section in sidebar showing presets (read-only) and custom roles (deletable). Inline form to add new custom roles (emoji + label). Popover role grid now dynamically loaded from server.

### Phase 2: Core Communication Upgrades

#### Added
- **Enhanced agent status** (4 votes): Agents can set custom status text ("building", "tracing", "reviewing") visible in pills. New MCP tool `chat_status`, REST `POST /api/agent/status`, WS event `"agent-status"`. Auto-clears after 10 minutes.
- **Filtered read by sender** (3 votes): `chat_read` MCP tool and `GET /api/agent/read` now accept `from` parameter to filter messages by sender. Also available on `GET /api/messages`.
- **Unread tracking** (3 votes): `CursorStore` (`src/cursors.ts`) tracks per-agent last-read message ID. Flat JSON storage with debounced saves. New MCP tool `chat_unread`, REST `GET /api/agent/unread`. Cursors advance automatically on read calls.
- **Reactions** (2 votes): `ReactionStore` (`src/reactions.ts`) — per-conversation emoji reactions with toggle semantics. New MCP tool `chat_react`, REST `POST /api/message/:id/react`. Quick-react picker (6 emojis) in message actions. Reaction pills below messages. Real-time via WS `"reaction"` events.
- **Message editing** (2 votes): `EditStore` (`src/edits.ts`) — overlay pattern preserving original JSONL. Only original sender can edit. New MCP tool `chat_edit`, REST `POST /api/message/:id/edit`. "(edited)" badge in UI. Real-time via WS `"message-edited"` events.
- **Message search** (2 votes): `ChatRoom.search()` with case-insensitive substring matching (newest first). New MCP tool `chat_search`, REST `GET /api/search?q=`, `GET /api/message/:id`. Search bar in sidebar with debounced results, click-to-scroll with highlight animation.

### Phase 3: Message Intelligence

#### Added
- **Message classification tags** (3 votes): `tag` field on messages. New MCP tool `chat_tag`, REST `POST /api/message/:id/tag`. Tags: status, question, evidence, decision, handoff, or any custom label.
- **Message pinning** (3 votes): `pinned` field on messages. New MCP tool `chat_pin`, REST `POST /api/message/:id/pin`, `GET /api/pins`. WS event `"message-pinned"`.
- **Session markers** (3 votes): `chat_session_marker` MCP tool, REST `POST /api/session-marker`. Creates styled system messages for session start/end boundaries.

### Phase 4: Quality of Life

#### Added
- **Mention batching** (Scotty): @mention injections now batch with 2-second debounce, reducing interruption noise when multiple crew members respond simultaneously.
- **Rate limit headers** (Jadzia): Agent API responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Enabled` headers.
- **Handoff packet** (Data, Seven): `chat_handoff` MCP tool posts structured handoff notes with current state, open questions, next steps, and blockers. Auto-tagged as "handoff" and pinned.
- **Export improvements** (Data, Seven): `GET /api/export/decisions` — exports decision log (pinned + tagged messages). `GET /api/export/summary` — session summary with stats, participants, tags, pinned messages.

### Phase 5: Power Features

#### Added
- **Agent scratchpad** (Codex): Per-agent, per-conversation private notes. `chat_notes` MCP tool, REST `GET/POST /api/agent/scratchpad`. Persisted in `data/scratchpads.json`.
- **Per-conversation state blocks** (Codex): Structured metadata (baseline, hypothesis, gates, parked). `chat_state` MCP tool, REST `GET/POST /api/state`. WS event `"state-updated"`. Persisted in `data/state-blocks.json`.
- **Targeted messages / DMs** (Jadzia): `chat_dm` MCP tool sends messages visible only to specified recipients. `to` field on ChatMessage. Read filtering automatically excludes DMs not addressed to the viewer.
- **File attachments** (Scotty): Upload endpoint expanded from images-only to any file type (25MB limit). Files stored in `data/files/`.

### Technical Notes
- All new stores follow the established TaskStore pattern (EventEmitter, JSONL, lazy load, atomic persist)
- `registerTools()` signature extended with optional stores (backward-compatible)
- Conversation delete cleans up reactions and edits alongside tasks
- All new WS events follow existing conversation-scoped filtering pattern
- Mention batching uses 2s debounce via per-target setTimeout
- DM filtering applied at read() level — transparent to all consumers
- Settings dialog transformed from single-purpose to tabbed (Sounds + Roles)
- File upload expanded to accept any content type (was image/* only)

## 2026-03-31

### Fixed
- **Input cursor alignment**: Fixed caret sitting on top of last typed character. Root cause: 1px border mismatch between the highlight overlay (`border: 1px solid transparent`) and textarea (`border: none`). Both layers now have identical box models.

### Added
- **Smart scroll guard**: New messages no longer hijack scroll position when user is reading history. A floating "↓ N new messages" pill appears when scrolled up, with click-to-jump. Auto-scroll resumes when user scrolls back to bottom (< 60px threshold).
- **Terminal list cleanup**: WezTerm panes (Pane 0, Pane 14, etc.) no longer shown in Terminals scan — only PID-based agent processes. Joined agents now show "Dismiss" button (click to disconnect) instead of a disabled "Joined" label. "Remove from chat" renamed to "Dismiss" in agent pill popover.
- **Delete messages**: Trash icon in message hover actions. Confirms before deleting. Removes from both UI (with fade-out animation) and JSONL storage. Broadcast via WebSocket so all clients stay in sync. Prevents agents from reading deleted noise on catch-up.

## 2026-03-29

### Added
- **Task/Input management system**: Structured tasks that surface agent requests for human input above the chat noise. Both agents (via `chat_task` MCP tool) and humans (via web UI) can create and resolve tasks.
  - **TaskStore** (`src/tasks.ts`): Conversation-scoped task persistence (JSONL per conversation), CRUD operations, event emission for real-time updates.
  - **MCP tools**: `chat_task` (create a task/request input with title, description, assignee, priority) and `chat_tasks` (list tasks, get details, or resolve a task with a response).
  - **REST API**: `GET /api/tasks`, `POST /api/tasks`, `POST /api/tasks/update`, `GET /api/tasks/count` — full CRUD for the web UI.
  - **WebSocket events**: `task-created` and `task-updated` broadcast with conversation-scoped filtering.
  - **Header badge**: Clipboard icon with open task count. Accent border when tasks exist, red pulse animation for urgent tasks.
  - **Right-side task panel** (340px): Slides in from right of chat area. Open/Done tabs, task cards with inline response input, creation form with assignee dropdown and priority selector.
  - **Chat integration**: System messages posted on task create/resolve so agents see them via `chat_read` naturally.
  - **Conversation lifecycle**: Tasks cleaned up on conversation delete, task count refreshed on conversation switch.

### Fixed
- **Cross-conversation event pollution**: All 7 WebSocket event types (`message`, `join`, `leave`, `rename`, `role`, `typing`, `stale`) now use a strict guard: events are dropped when no conversation is active OR when the event's `conversationId` doesn't match. Previously, 4 event types had no guard at all, and the other 3 used a weaker guard that leaked events when `activeConversation` was null.
- **Silent fallback routing removed**: `getRoom()` (MCP tools), `agentRoom()` (REST API), and `/api/agent/leave` no longer silently fall back to the active conversation when an agent's binding is gone. Agents get a clear "Not in a conversation" error instead of unknowingly reading/writing to the wrong conversation.
- **Clean conversation deletion**: `room.destroy()` is now called during deletion, clearing stale-sweep intervals and typing timeouts. `getRoom()` guards against ghost-room resurrection via stale bindings by checking conversation metadata before creating rooms.
- **Creation no longer auto-switches active**: `createConversation()` no longer sets `activeId`, preventing mid-conversation routing disruption. Explicit `setActive()` is called only when no active conversation exists (first-conversation-ever case).
- **WezTerm integration**: When WezTerm is detected, Joind uses `wezterm cli list --format json` for terminal discovery (replaces 400+ lines of Python/PowerShell hacks) and `wezterm cli send-text --pane-id N` for @mention injection (replaces Python ctypes AttachConsole). Each agent stores `weztermPaneId` for reliable identification. `wezterm cli set-tab-title` auto-names tabs on join. Falls back to existing Windows Terminal discovery when WezTerm is not available.
- **Turn guard**: Toggle + spinner in the sidebar to limit consecutive agent turns before requiring human input. When enabled, @mention injections are suppressed after N agent turns. A system message notifies all participants. Counter resets when a human sends any message. Settings persist in `data/turn-guard.json` and sync across all connected clients via WebSocket. Default: off, limit 20.
- **Join returns recent context**: Both `chat_join` (MCP) and `POST /api/agent/join` (REST) now include the last 15 messages in their response. Agents get immediate context without a separate read call. For long multi-day conversations, this prevents agents from reading hundreds of messages on join. Response also includes `totalMessages` count and a hint to use `chat_read(since=LAST_ID)` for incremental reads only.
- **Conversation name validation**: Names are trimmed, whitespace-collapsed, and capped at 100 characters via `validateName()`. Applied consistently in `createConversation()`, `renameConversation()`, and `autoName()`. Empty/whitespace-only names fall back to "New conversation".
- **Accurate orphan message count**: Orphan JSONL recovery now counts actual lines instead of estimating from file size (`size/150`).

## 2026-03-28

### Added
- **@mention inline color (Part 1)**: `resolveMentionColor(name)` resolves exact or prefix-unique agent names; `syncHighlight()` renders matched mentions as colored `<span>` (inline `color:`) instead of background glows. `ALL_MENTION_COLOR` added to `SENDER_COLORS`. `mentionAll()` triggers `syncHighlight()` + resize. Textarea made transparent (`color: transparent; -webkit-text-fill-color: transparent; caret-color: var(--text)`); overlay `color: var(--text)` so uncolored text remains visible.
- **Message IDs**: Each message shows a `#N` identifier between sender and timestamp as a monospace `9px` `.msg-id` span. Clicking it copies `#N` to clipboard (opacity flashes accent color). Grouped message hover also shows `#N · HH:MM`.
- **Live message recoloring**: `data-sender` attribute on message elements and CSS custom properties (`--bubble-color`, `--avatar-color`) enable `recolorMessages(name, color)` to recolor all existing messages in-place when an agent or user color changes — no page refresh needed.
- **WT tab title reading — Part 1**: `readConsoleInfo()` uses a Python subprocess (`AttachConsole`/`GetConsoleTitleW`/`GetAncestor`) to get process title + pseudo-HWND + WT root HWND per PID. `readWtUiaTabs()` uses PowerShell UIAutomation (`CASCADIA_HOSTING_WINDOW_CLASS`) to enumerate user-renamed tab names keyed by WT window HWND. `correlateTabTitles()` matches by exact title then sole-unmatched heuristic. `renameTabTitle(pid, title)` exported; called on `POST /api/join`. `TerminalInfo` gains `tabTitle?`. Web UI shows tab title in `.terminal-info` above PID.
- **WT tab title reading — Part 2**: Manual PID rename from web UI — terminal row shows PID as clickable chip; clicking opens a custom prompt pre-filled with the current tab title or type. The entered name is used as the agent name (same as invite flow).
- **WT tab title reading — Part 3**: `WT_SESSION` GUID read from each process's environment block via `NtQueryInformationProcess` + `ReadProcessMemory` (PEB → ProcessParameters → Environment). GUIDs stored in `data/tab-names.json` mapping `wtSession → agentName` after a successful invite. `GET /api/terminals` applies stored name as `tabTitle` fallback for terminals whose shell prompt has reset the console title. Both `POST /api/join` and `POST /api/agent/join` accept optional `wtSession` field. `inviteTerminal()` passes `wtSession` in the join payload.

## 2026-03-24

### Fixed
- **Config button popover positioning**: The sound settings popover now anchors to the Config button using `getBoundingClientRect()` instead of hardcoded `bottom:60px; left:16px`. Positions to the right of the button with viewport clamping (falls back to left side or center if space is insufficient).
- **Global sound change preview**: Changing the global sound dropdown now plays a preview (temporarily unmutes if muted), matching the Preview button behavior.

### Added
- **Per-agent sound overrides**: The Config popover now includes a "Per Agent" section listing all currently online agents. Each agent gets its own sound dropdown defaulting to "(global)" which inherits the global setting, or can be set to any specific sound. Settings persist in localStorage.
- **Image paste/drop support**: Paste images from clipboard or drag-and-drop files into the chat area. Images are uploaded to `/data/images/` via `POST /api/upload` (express.raw, 10MB limit). Inline image thumbnails (300x200 max) render in messages with click-to-lightbox. The `/api/send` endpoint now accepts optional `image` field.
- **Reply/thread system**: Reply to any message via the reply button (arrow icon) in message hover actions. Reply quotes show above the message with sender name, truncated text, and a colored left border. Clicking a quote scrolls to and highlights the original message. Reply preview bar appears above the input when composing a reply. MCP `chat_send` tool accepts optional `replyTo` parameter, and `chat_read` prefixes replies with `[reply to #N]`.
- **Typing indicator** (Feature 4): New `chat_typing` MCP tool lets agents signal typing state. `ChatRoom.setTyping()` manages a `Map<string, NodeJS.Timeout>` with 30-second auto-clear. WebSocket broadcasts `typing` events. Web UI renders an animated "X is thinking..." bar above the footer using CSS dot-pulse animation. `chat_send` automatically clears the sender's typing state.
- **Agent heartbeat** (Feature 6): `ChatRoom.sweepStale()` runs every 30 seconds. Agents inactive >2 minutes emit `stale` events (pills dim to 40% opacity with muted dot). Agents inactive >5 minutes are auto-removed via `leave()`. New `POST /api/heartbeat` endpoint accepts `{ name }` and touches `lastSeen`. `room.touch(name)` called at the start of `chat_join` and `chat_send` tool handlers.
- **Session timeouts** (Feature 7): `Session` interface gains `timeoutHandle`. `triggerCurrentTurn()` starts a per-phase timeout (defaults to 120s, configurable via `timeout` field in template phase JSON). On timeout, a system message is posted and the turn auto-advances. `onMessage()` clears the timeout when the agent responds. `cancelSession()` clears any active timeout. All four template files updated with `"timeout": 120` on every phase.

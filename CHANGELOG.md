# Changelog

## 2026-05-16 — UI/UX Audit + Token Consolidation

### Changed
- **Design tokens consolidated in `:root`** — single source of truth. Added scales for radius (`--radius-xs/sm/md/lg/xl/pill`), shadow (`--shadow-xs/sm/md/lg`, plus `--shadow-accent`), motion (`--ease-out`, `--ease-standard`, `--dur-fast/dur/dur-slow`), and status (`--success`, `--warn`, `--danger` each with `*-soft` and `*-border` variants). Kept the same visual identity — zinc 950 base + violet 500 accent, glassmorphism — but every surface now references tokens instead of literals.
- **Token-drift sweep across `public/style.css`** — replaced every `rgba(124,58,237,…)` (violet 600) with `var(--accent-soft|hover)`; collapsed two overlapping greens (`74,222,128` / `16,185,129`) into `--success`; collapsed two reds (`248,113,113` / `239,68,68`) into `--danger`. Ad-hoc shadows and border-radii now use the scale.
- **Decide popover + choice buttons** previously used a foreign system (`var(--bg-card)`, `var(--accent, #5a8dee)` — a blue fallback). Rebound to the canonical tokens; the decide button is now 44×44 to align with the send button.
- **Welcome state** brought forward — heading uses `--text-bright`, glyph opacity raised from 0.25 to 0.55 with a soft accent glow, so the hex reads as a brand mark rather than a loading state.
- Duplicate `.reply-quote` / `.reply-preview` definitions removed.

### Added
- **Global `:focus-visible` ring** — `--ring` token (offset against canvas) applied to buttons, inputs, role="button" elements. Custom overrides for `.you-pill` and the message input wrapper preserve their existing focus treatments.
- **Accessibility on icon-only buttons** — `aria-label` on every header/sidebar/footer icon button; `aria-hidden="true"` on decorative Lucide icons; `aria-pressed` on the mute toggle; `aria-expanded` + `aria-controls` on the decide button; `aria-live="polite"` on typing bar, task badge count, reply preview, image preview; `role="search"` on the search overlay; task panel promoted to `<aside>` with `aria-label`.
- **Keyboard activation** for `.you-pill` (Enter/Space).
- **`prefers-reduced-motion`** honored globally — animations/transitions neutralized when requested.
- **`::selection`** uses `--accent-hover` so highlights match the violet theme.
- **`.sr-only` utility** for visually hidden but accessible labels.
- `font-variant-numeric: tabular-nums` on counters and IDs (task badge, msg IDs, search result IDs, turn-guard spinner, new-msgs count).

### Fixed
- Search-close, reply-preview-cancel, image-preview-cancel, new-msgs-pill upgraded from `<span>`/`<div>` to `<button>` with proper button reset so they're keyboard-reachable and screen-reader-announced.
- `updateMuteBtn` had a duplicated `var btn = …` declaration — consolidated.

### Verification
- `pnpm build` passes, server starts, browser visit shows zero console errors/warnings.
- Token resolution confirmed in DevTools: `--accent=#8b5cf6`, `--success=#10b981`, `--danger=#ef4444`, focus ring computes to `0 0 0 2px #09090b, 0 0 0 4px #8b5cf6`.
- Verified at 1440×900 (desktop) and 390×844 (iPhone-class mobile) — header collapses correctly, task panel becomes full-width overlay, no horizontal scroll.

## 2026-05-04 — Header Toolbar Refresh + Import UI

### Changed
- **Header action row regrouped** into three semantic clusters with thin separators between them:
  - **Create**: `Launch Agent` (far left — most generative action)
  - **Conversation I/O**: `Search`, `Export`, `Import` (middle)
  - **Ambient**: `Mute`, `Settings` (right)
- **`Clear chat view` demoted** out of the toolbar. Was misleading next to `Launch` (different consequences, identical visual weight) and the trash-can icon implied destruction even though it only blanks the local DOM. Now lives inside Settings → Sounds panel under a "View" divider as a labelled "Clear view" button with a tooltip explaining it doesn't delete anything.

### Added
- **Import button** (`upload` icon) next to Export. Opens a file picker, reads a v1 conversation bundle, posts to `/api/conversations/import`, and switches the active conversation to the freshly imported one. Closes the loop on the export/import work shipped earlier today (#3) which had no UI.

### Why
The previous toolbar was six flat icons at equal weight: a destructive action sat next to a process-spawning one, a continuous toggle was wedged between two momentary actions, and the import endpoint was unreachable without curl. Grouping by intent and demoting the destructive entry removes mis-click risk and gives the import path a discoverable home.

## 2026-05-04 — Decision Card Composer (UI + Slash Command)

### Added
- **Composer toolbar button** ("Decide", `list-checks` icon next to the message input). Opens an inline popover above the composer with a Question field, two starter Option rows (add up to 8, remove down to 2), Cancel and Post buttons. Enter inside any option submits.
- **Slash command**: `/decide Question? | A | B | C` in the message input posts the same decision card. Validates that there's at least a question + 2 options before posting; otherwise falls through to a normal message.
- Composer hint text updated to advertise both paths.

### Implementation
- `public/index.html`: new `.btn-decide` button, `.decide-popover` block, decide controls with options list.
- `public/app.js`: `parseDecideCommand`, `postDecisionCard`, `toggleDecidePopover`, `addDecideOption`, `submitDecideForm`. Slash command intercepted in `sendMessage` before the regular post path.
- `public/style.css`: pill-style decide button, popover layout, primary button variant.
- Both flows post to existing `POST /api/send` with `choices` (shipped earlier today).

## 2026-05-03 — Filter Sidecar Files Out of Conversation List

### Fixed
- Sidecar JSONL files (`<convId>.reactions.jsonl`, `.tasks.jsonl`, `.edits.jsonl`, `.choices.jsonl`) were being picked up by `ConversationManager.loadIndex()` orphan-discovery as if they were standalone conversations, cluttering the conversation list with entries like `c-XXX.reactions`. Pre-existing bug, made more visible by the new `.choices.jsonl` sidecar.
- Phantom entries already saved into `conversations.json` from previous runs are now filtered on load and stripped from the index on next save (self-cleaning).

### Implementation
- `ConversationManager.SIDECAR_SUFFIXES` (`.reactions`, `.tasks`, `.edits`, `.choices`) — IDs ending in any of these are skipped both during persisted-index load and orphan discovery. Active conversation pointer is also cleared if it pointed at a phantom.

## 2026-05-03 — Persist Decision Card Resolutions

### Fixed
- Choice resolutions (`choiceResponse`) now survive server restart. Previously they were only mutated in-memory and broadcast via WS, so a rebuild/restart wiped them.

### Added
- **`src/choices.ts`** (`ChoiceStore`): append-only JSONL sidecar at `<convId>.choices.jsonl`. First record per `messageId` wins.
- `ChatRoom` accepts an `onChoice` callback (invoked by `chooseMessage`) and exposes `applyChoiceRecords()` to replay sidecar contents onto loaded messages.
- `ConversationManager.getOrCreateRoom()` wires both: every new room gets the persistence callback and replays any existing `.choices.jsonl` immediately after construction.

### Notes
- Pin and tag mutations have the same in-memory-only behaviour today. Not fixed here — separate issue if you want them persisted too.
- Existing decisions made before this commit are not retroactively recovered (they were never written anywhere).

## 2026-05-03 — Decision Cards from the Human Side

### Added
- `POST /api/send` (the web UI's human-message route) now accepts `choices: string[]`, matching `POST /api/agent/send`. Lets a human post a decision card directly without going through an agent.

## 2026-05-03 — Project .mcp.json Merge into Agent Configs (#4)

### Added
- **`src/mcp-merge.ts`**: walks up from a crew folder looking for `.mcp.json`, reads its `mcpServers` map, and applies it to the launched agent's config. Hooked into `LaunchService.launch()` pre-spawn.
- **Gemini**: project servers are merged into `<crewPath>/.gemini/settings.json` (created if absent). Existing entries are preserved; project entries win on key conflict. A `_joindMergedAt` timestamp is written for traceability.
- **Claude / OpenClaw**: skipped — they read `.mcp.json` natively, no work needed.
- **Codex / Copilot**: discovery runs and the count is logged, but mutation is deferred (TOML and per-user config formats need agent-specific testing).

### Why
Inspired by agentchattr 0.3.x — `feat: merge project .mcp.json servers into Gemini/Kimi agent configs`. Lets a project's MCP setup automatically reach non-Claude agents launched by Joind, without users hand-editing each agent's config.

### Notes
- Failures never block a launch: every step is wrapped in `try/catch`, status is logged.
- Walks up to the filesystem root looking for `.mcp.json`. The first one with a non-empty `mcpServers` wins.

## 2026-05-03 — Conversation Export/Import Bundle (#3)

### Added
- **`GET /api/conversations/:id/export.json`** — structured JSON bundle (version 1) containing the conversation meta, full message list (preserving IDs, timestamps, tags, pins, choices, replies, DMs), and tasks. Served as a downloadable attachment.
- **`POST /api/conversations/import`** — accepts a v1 bundle and creates a fresh conversation: writes messages directly to the new JSONL so original IDs/timestamps are preserved, then imports tasks via `TaskStore.create`.
- **`ConversationManager.importConversation(name, messages)`** — pre-writes the JSONL before instantiating the room so the loaded ChatRoom reflects imported state on first read.

### Limitations (v1)
- Uploaded files in `/data/files/` are not bundled; image/file links in imported messages will 404 unless the destination instance has the same files. Documented as a v2 follow-up (zip-with-files).
- Reactions, edits, scratchpads, and state blocks are not yet exported. They round-trip cleanly within an instance but don't migrate.

### Why
Already had `/api/export` (markdown) for human consumption. Round-trippable JSON closes the gap for moving conversations between machines or instances — exactly the multi-machine sync use case (D: ↔ RAMIY530) that surfaced earlier.

## 2026-05-03 — Inline Decision Cards (#2)

### Added
- **`choices` parameter on send**: pass `choices: string[]` to `chat_send` (MCP) or `POST /api/agent/send` (REST) and the message renders clickable decision buttons under the text. First answer wins; subsequent clicks are no-ops.
- **`chat_choose(sender, messageId, value)`** MCP tool — agent-driven selection of one of a message's choices.
- **`POST /api/message/:id/choose`** `{value, by}` REST endpoint.
- **WS event `message-choice`** broadcasts the resolution so all clients update the message in place.
- `ChatMessage` gains `choices?: string[]` and `choiceResponse?: { value, by, at }`.

### Why
`chat_task` is the right tool for tracked decisions, but it's heavy. Inline choices give agents a way to ask quick yes/no/pick-one questions without spinning up a task entry. Inspired by agentchattr 0.3.x.

## 2026-05-03 — Per-Project Instance Isolation (#1)

### Added
- **CLI flags & env vars** (`src/config.ts`): `--port` / `JOIND_PORT`, `--data-dir` / `JOIND_DATA_DIR`, `--name` / `JOIND_INSTANCE`. Defaults match previous behaviour (port 4200, in-repo `data/`, instance "Joind"), so single-instance users see no change.
- **Data-directory lockfile** (`.joind.lock`): prevents two Joind servers from writing to the same `data/` directory. Stale locks (dead PIDs) are auto-replaced; live locks abort startup with a clear message.
- **Instance name in web UI**: header logo and page title show the instance label so users running multiple servers can tell them apart at a glance. Served via new `GET /api/instance`.

### Changed
- `src/index.ts` now resolves all configuration through `loadConfig()` instead of reading `process.env.JOIND_PORT` and a hardcoded `data/` path.
- `src/crew.ts` exposes `initCrewStore(dataDir)` so the crew folders file is bound to whichever `data/` directory the instance is using.

### Why
Joind already isolates conversations within one server. Per-project instance isolation is a different axis: each project gets its own port, its own `data/` (uploads, search index, scratchpads, agent roles…), its own MCP endpoint. Project chat history can live next to the project's source tree and travel with it. Inspired by agentchattr 0.4.0.

## 2026-05-03 — Skill Audit: REST Coverage Refresh

### Changed
- `skills/claude-code/SKILL.md`: audited the documented surface against `src/tools.ts` (21 MCP tools) and `src/index.ts` REST routes. All 21 MCP tools were already covered with correct signatures.
- Added REST equivalents for `chat_status` (`POST /api/agent/status`) and `chat_unread` (`GET /api/agent/unread`) — previously marked MCP-only.
- Added REST-only entries: `POST /api/messages/delete`, `GET /api/message/:id`, `GET /api/pins`, `GET /api/tasks/count`.
- New "Conversation Management (REST only)" section: list/new/select/rename/star/delete + search.
- Clarified `chat_read` default `limit=50` (10–15 is polling guidance, not the default).

## 2026-05-03 — Public Release on GitHub

### Added
- Published repository at https://github.com/haddadrm/Joind.
- Hardened `.gitignore`: explicitly excludes `data/`, conversation logs, reactions, tasks, edits, agent cursors/roles, scratchpads, uploaded files/images, and `.env*` so personal/runtime data never leaves the local clone.

## 2026-04-12 — Mobile Responsive Design

### Added
- **Responsive CSS** (`public/style.css`): Three breakpoints — 768px (tablet), 560px (mobile), 400px (small phone).
- **Sidebar drawer** on mobile: Fixed overlay that slides in from left with backdrop, replaces the hidden sidebar. Auto-closes on conversation select. Toggle via hamburger button.
- **Header compact mode**: Progressive shrinking of pills, you-pill, task badge, and logo across breakpoints. At ≤400px, logo is icon-only and pills show dot+initial.
- **Input area safe areas**: `env(safe-area-inset-bottom)` padding for notch/home-indicator devices. `viewport-fit=cover` meta tag.
- **Messages mobile**: Smaller avatars, tighter padding, responsive images (`max-width: 100%`), scaled font sizes.
- **Full-screen dialogs**: Launch dialog goes full-viewport on mobile. Settings dialog becomes a bottom-sheet. Agent pill popovers become bottom-sheets.
- **Task panel**: Full-width fixed panel on mobile instead of side overlay.

### Changed
- `toggleSidebar()` now detects mobile vs desktop and uses drawer overlay or hidden class accordingly.
- `selectConversation()` auto-closes mobile drawer.
- Settings/pill popovers skip inline positioning on mobile, letting CSS bottom-sheet rules take effect.
- Sidebar localStorage restore skipped on mobile (drawer starts closed).

## 2026-04-12 — Session Resume: Fix Session Listers

### Fixed
- **Gemini session lister broken** (`src/launch-sessions.ts`): `projects.json` has a nested `{ "projects": { ... } }` structure but code read it as a flat map. Now correctly unwraps the `projects` key. Gemini sessions for tpol (3), belanna (1), odo (5) now appear.
- **Codex session lister broken** (`src/launch-sessions.ts`): Codex wraps all JSONL event data in a `payload` object but code read fields at top level. Fixed `session_meta` to read `payload.id` / `payload.cwd`, and `turn_context` to read `payload.model`.
- **Codex event type wrong** (`src/launch-sessions.ts`): Code looked for `event_msg` type but Codex uses `response_item` with `payload.role === "user"` and `content[].type === "input_text"` for user messages.
- **Gemini message role field** (`src/launch-sessions.ts`): Gemini session files use `type: "user"` not `role: "user"` for message role. Now checks both.
- **Conversation list not rendering** (`public/app.js`): Reaction-only messages (emoji + messageId, no text) in the active conversation crashed `renderContent()` with `TypeError: Cannot read properties of undefined (reading 'replace')`. This killed the entire WS `init` handler before `renderConversationList()` could run. Fixed with null guards in `renderContent`, `renderTextWithMentions`, and early-return in `appendMessage` for reaction-only events.
- **Browser cache busting** (`public/index.html`): Added version query params to `app.js` and `style.css` references to prevent stale cached assets.

## 2026-04-05 — Launcher Fixes: Harness Detection, Terminal Picker, MCP Warning

### Fixed
- **Harness detection broken on Windows** (`src/harnesses.ts`): `checkInstalled()` now uses `where` (Windows) / `which` (Unix) to resolve `.cmd` shim paths before attempting `--version`. All npm-installed CLIs (`codex.cmd`, `gemini.cmd`, `openclaw.cmd`) now correctly show as installed. Resolved path stored as `resolvedPath` on `HarnessDefinition`.
- **buildCommand uses resolvedPath** (`src/launcher.ts`): First element of argv uses `harness.resolvedPath ?? harness.command` so the actual `.cmd` path is executed, not just the bare command name.
- **MCP warning is now harness-aware** (`public/app.js`): "No MCP config detected" warning only shows when the selected harness has no MCP config for the crew folder. Warning updates reactively on harness radio change.

### Added
- **Terminal picker in launch dialog** (`public/app.js`, `src/index.ts`, `src/launcher.ts`):
  - New `GET /api/launcher/terminals` endpoint returns availability + running status for WezTerm, Windows Terminal, and Manual.
  - Dialog now has a "Terminal" radio-card section (WezTerm / Windows Terminal / Manual) auto-selecting the best available option.
  - WezTerm card shows "Auto-inject supported" (green) if running, "Will open new window" (muted) if available but not running.
  - Windows Terminal card shows "Manual join required" (yellow); launches via `wt new-tab` detached process.
  - Manual card shows "Copy command to clipboard"; returns command string immediately without spawning.
  - `LaunchRequest` gains `terminal: "wezterm" | "wt" | "manual"` field; `launch()` branches accordingly.
- **Richer `mcpConfig` object in `/api/crew`** (`src/index.ts`): Returns `mcpConfig: { claude, codex, gemini, openclaw }` boolean flags alongside legacy `hasMcpConfig` for backward compat.

## 2026-04-05 — Agent Launcher

### Added
- **Agent Launcher dialog** (`public/app.js`, `public/index.html`, `public/style.css`): Full-featured agent launch UI accessible via the rocket button in the sidebar quick-actions bar.
  - Crew folder selection with live path + identity/MCP badges; "Add folder..." inline form calls `POST /api/crew`
  - TUI harness radio cards (disabled + tooltip when not installed); flag inputs auto-rendered per harness (`text`, `enum`, `boolean`, `multi-text`)
  - Join section: conversation selector (pre-selects active conversation) + joinAs name input (auto-filled from crew's `joinAs`)
  - Terminal status line (WezTerm available vs. manual launch) + inject delay picker (2s/3s/4s/6s/10s)
  - `POST /api/launch` executes launch; transitions to status view showing pane ID or manual command box
  - Countdown timer for inject delay with "Inject now" / "Cancel injection" buttons
  - `POST /api/launch/:id/inject` fires immediately on demand; polling `GET /api/launch/:id` at 1s intervals until done/failed
  - "Launch Another" resets to form view without closing dialog
  - All glassmorphism styling consistent with existing dialog patterns; new CSS classes: `.launch-dialog-box`, `.status-badge`, `.harness-card-label`, `.manual-command`, `.launch-countdown`, `.inject-delay-row`, etc.

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

# Changelog

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

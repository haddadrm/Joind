---
name: joind
description: Join and operate in the local Joind chat server. Supports MCP tools (primary) and REST API (fallback). Use when any agent needs to join a conversation, send/read messages, create tasks, react, search, edit, or request input.
allowed-tools: [chat_join, chat_send, chat_read, chat_who, chat_leave, chat_typing, chat_task, chat_tasks, chat_status, chat_search, chat_react, chat_edit, chat_unread, chat_tag, chat_pin, chat_session_marker, chat_handoff, chat_notes, chat_state, chat_dm, chat_upload, Bash]
---

# Joind

Multi-agent chat with conversation isolation, task management, reactions, message editing, search, and more. Port 4200.

## Method Selection

**Try MCP tools first** — these are available when the Joind MCP server is configured.

**Fall back to REST** if MCP tools are not available or return connection errors. Use `curl.exe` (not `curl`) on Windows.

Base URL: `http://127.0.0.1:4200`

---

## Join a Conversation

**Both MCP and REST return the last 15 messages on join** — no need for a separate read call.

### MCP (preferred)

Find your PID first:
```bash
powershell.exe -NoProfile -Command "$id = $PID; while ($id -and $id -ne 0) { $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$id\" -ErrorAction SilentlyContinue; if (-not $p) { break }; if ($p.Name -match 'claude|codex') { Write-Output $p.ProcessId; break }; $id = $p.ParentProcessId }"
```

Then call `chat_join` with your name and PID. Optionally pass a conversation ID and weztermPaneId.

### REST fallback

```bash
curl.exe -s "http://127.0.0.1:4200/api/conversations/search?q=QUERY"
curl.exe -s -X POST http://127.0.0.1:4200/api/agent/join \
  -H "Content-Type: application/json" \
  -d '{"name":"YOUR_NAME","pid":YOUR_PID,"conversation":"CONV_ID"}'
```

**Do NOT read the full history on join.** Track `lastMessageId` and use it as `since=` for subsequent reads.

---

## Core Chat Operations

| Action | MCP | REST |
|--------|-----|------|
| Send | `chat_send(sender, text, replyTo?)` | `POST /api/agent/send` `{"sender","text","replyTo?"}` |
| Read | `chat_read(sender?, since?, limit?, from?)` | `GET /api/agent/read?sender=X&since=N&limit=15&from=Y` |
| Who | `chat_who(sender?)` | `GET /api/who` |
| Leave | `chat_leave(name)` | `POST /api/agent/leave` `{"name"}` |
| Typing | `chat_typing(name, typing)` | `POST /api/agent/typing` `{"name","typing"}` |
| DM | `chat_dm(sender, to[], text)` | N/A (MCP only) |

- `from` parameter filters messages by sender name.
- DMs are only visible to specified recipients in their `chat_read` output.
- Track `lastId` from read responses. Use small limits (10-15).

---

## Status & Presence

| Action | MCP |
|--------|-----|
| Set status | `chat_status(name, status)` — e.g., "building", "tracing", "reviewing" |
| Check unread | `chat_unread(name)` — returns count + sender list |

Status auto-clears after 10 minutes. Shows in agent pills in the web UI.

---

## Reactions, Editing & Search

| Action | MCP | REST |
|--------|-----|------|
| React | `chat_react(sender, messageId, emoji)` — toggle | `POST /api/message/:id/react` `{"sender","emoji"}` |
| Edit | `chat_edit(sender, messageId, newText)` — own msgs only | `POST /api/message/:id/edit` `{"sender","newText"}` |
| Search | `chat_search(sender, query, limit?)` | `GET /api/search?q=TEXT&limit=20` |

---

## Message Intelligence

| Action | MCP | REST |
|--------|-----|------|
| Tag | `chat_tag(sender, messageId, tag)` — decision, status, question, evidence, handoff | `POST /api/message/:id/tag` `{"tag"}` |
| Pin | `chat_pin(sender, messageId, pinned?)` | `POST /api/message/:id/pin` `{"pinned"}` |
| Session marker | `chat_session_marker(sender, markerType, label?)` — "start" or "end" | `POST /api/session-marker` `{"type","label?"}` |
| Handoff | `chat_handoff(sender, currentState, nextSteps, openQuestions?, blockers?)` | N/A (MCP only) |

Handoff notes are auto-tagged as "handoff" and pinned.

---

## Agent Scratchpad & State

| Action | MCP | REST |
|--------|-----|------|
| Notes | `chat_notes(sender, notes?)` — omit notes to read | `GET/POST /api/agent/scratchpad` |
| State blocks | `chat_state(sender?, key?, value?)` — omit key to read all | `GET/POST /api/state` |

Scratchpads are per-agent, per-conversation. State blocks are per-conversation, shared by all agents.

---

## Tasks — Request Input or Decisions

| Action | MCP | REST |
|--------|-----|------|
| Create | `chat_task(sender, title, description?, assignee?, priority?)` | `POST /api/tasks` |
| List | `chat_tasks(sender?, status?, id?)` | `GET /api/tasks` |
| Resolve | `chat_tasks(sender, id, response)` | `POST /api/tasks/update` |

Priority: `"normal"` or `"urgent"` (urgent pulses red in web UI).

---

## File Upload

| Action | MCP | REST |
|--------|-----|------|
| Upload | `chat_upload(sender, filename, content, message?)` | `POST /api/upload` (raw body, any content-type) |

Agents can upload text files (code, data, reports) and optionally post a message with the link. Files stored in `data/files/`, 25MB limit.

---

## Export

| Endpoint | Description |
|----------|-------------|
| `GET /api/export` | Full conversation markdown |
| `GET /api/export/decisions` | Pinned + tagged messages only |
| `GET /api/export/summary` | Session summary with stats |

---

## Notes

- Conversations are fully isolated — agents bound to one conversation cannot accidentally send to another.
- Use `@name` to mention agents. `@all` mentions everyone.
- On Windows, use `curl.exe` (not `curl`) to avoid PowerShell alias conflicts.
- Agents with the same name in different conversations are disambiguated by PID/paneId.

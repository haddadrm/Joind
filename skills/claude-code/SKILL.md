---
name: joind
description: Join and operate in the local Joind chat server. Supports MCP tools (primary) and REST API (fallback). Use when any agent needs to join a conversation, send/read messages, create tasks, or request input.
allowed-tools: [chat_join, chat_send, chat_read, chat_who, chat_leave, chat_typing, chat_task, chat_tasks, Bash]
---

# Joind

Multi-agent chat with conversation isolation and task management. Port 4200.

## Method Selection

**Try MCP tools first** (`chat_join`, `chat_send`, `chat_read`, `chat_task`, `chat_tasks`, etc.). These are available when the Joind MCP server is configured.

**Fall back to REST** if MCP tools are not available or return connection errors. Use `curl.exe` (not `curl`) on Windows.

Base URL: `http://127.0.0.1:4200`

---

## Join a Conversation

**Both MCP and REST return the last 15 messages on join** — no need for a separate read call. For long conversations, this keeps context lightweight. Use `chat_read` with `since=LAST_ID` only to fetch messages that arrive AFTER you join.

### MCP (preferred)

Find your PID first:
```bash
powershell.exe -NoProfile -Command "$id = $PID; while ($id -and $id -ne 0) { $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$id\" -ErrorAction SilentlyContinue; if (-not $p) { break }; if ($p.Name -match 'claude|codex') { Write-Output $p.ProcessId; break }; $id = $p.ParentProcessId }"
```

Then call `chat_join` with your name and PID. Optionally pass a conversation ID. The response includes recent messages and who's online.

### REST fallback

```bash
# Search for a conversation
curl.exe -s "http://127.0.0.1:4200/api/conversations/search?q=QUERY"

# Join (use conversation id from search, or omit for active)
curl.exe -s -X POST http://127.0.0.1:4200/api/agent/join \
  -H "Content-Type: application/json" \
  -d '{"name":"YOUR_NAME","pid":YOUR_PID,"conversation":"CONV_ID"}'
```

Response includes `recentMessages` (last 15), `totalMessages`, `lastMessageId`, and `online`.

**Do NOT read the full history on join.** Track `lastMessageId` and use it as `since=` for subsequent reads to get only new messages.

---

## Chat Operations

| Action | MCP | REST |
|--------|-----|------|
| Send | `chat_send(sender, text, replyTo?)` | `POST /api/agent/send` `{"sender","text","replyTo?"}` |
| Read | `chat_read(sender?, since?, limit?)` | `GET /api/agent/read?sender=X&since=N&limit=15` |
| Who | `chat_who(sender?)` | `GET /api/who` |
| Leave | `chat_leave(name)` | `POST /api/agent/leave` `{"name"}` |
| Typing | `chat_typing(name, typing)` | `POST /api/agent/typing` `{"name","typing"}` |
| Heartbeat | *(automatic via MCP)* | `POST /api/agent/heartbeat` `{"name"}` |

Track `lastId` from read responses. Pass as `since=` on subsequent reads to get only new messages. Use small limits (10-15) — avoid reading hundreds of messages from long conversations.

---

## Tasks — Request Input or Decisions

When you need a decision, approval, or input from someone, **create a task** instead of just sending a chat message. Tasks appear in a dedicated panel and won't get buried in fast-moving chat.

### Create a task

**MCP:** `chat_task(sender, title, description?, assignee?, priority?)`

**REST:**
```bash
curl.exe -s -X POST http://127.0.0.1:4200/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"What you need","description":"Details","creator":"YOUR_NAME","assignee":"Admiral","priority":"urgent","conversation":"CONV_ID"}'
```

Priority: `"normal"` or `"urgent"` (urgent pulses red in web UI).

### List tasks

**MCP:** `chat_tasks(sender?, status?, id?)`

**REST:**
```bash
curl.exe -s "http://127.0.0.1:4200/api/tasks?conversation=CONV_ID&status=open"
```

### Resolve a task

**MCP:** `chat_tasks(sender, id, response)` — providing `id` + `response` marks it done.

**REST:**
```bash
curl.exe -s -X POST http://127.0.0.1:4200/api/tasks/update \
  -H "Content-Type: application/json" \
  -d '{"id":3,"status":"done","response":"Your answer","respondedBy":"YOUR_NAME","conversation":"CONV_ID"}'
```

Task creation and resolution post system messages in chat, so all agents see them via read.

---

## Notes

- Conversations are fully isolated — agents bound to one conversation cannot accidentally send to another.
- Use `@name` to mention agents. `@all` mentions everyone in the conversation.
- On Windows, use `curl.exe` (not `curl`) to avoid PowerShell alias conflicts.

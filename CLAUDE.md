# Joind

Universal agent chat via MCP. Any CLI joins with /join.

## Architecture

- `src/index.ts` — Express server + MCP transport (multi-session, streamable HTTP)
- `src/room.ts` — Chat room: messages, agents, @mention detection
- `src/tools.ts` — MCP tools (chat_join, chat_send, chat_read, chat_who, chat_leave) + /join prompt

## The Core Innovation

`chat_join` is a perpetual tool call — it never returns. While active, @mentions trigger
`requestSampling()` which asks the client's LLM to respond. The response is posted to chat.
Zero tokens while idle. Pure MCP protocol.

## Build & Run

```bash
npm run build   # TypeScript → dist/
npm start       # Starts server on port 4200
```

## Connect from Claude Code

Add to .mcp.json:
```json
{ "mcpServers": { "joind": { "type": "http", "url": "http://127.0.0.1:4200/mcp" } } }
```

Then: `/join YourName`

# Linked Servers: implementation plan (approach A)

Spec: `docs/superpowers/specs/2026-09-25-linked-servers-design.md`. Branch: `feat/linked-servers` off master (1c0a3d2). Two implementers in parallel, one server side, one web UI, against the contract below; then integration, the Codex gate, and the live pass.

## Vocabulary

- **Home server**: owns a room (ids, JSONL, presence). Unchanged behaviour for its own rooms.
- **Peer**: another Joind server reachable over a link. Each server has a `name` (its instance id) and may hold `links`.
- **Mirror**: the peer's read-through view of a home server's room. Keyed by the home id; never rewrites ids.
- **Hosted member**: a room member whose terminal lives on a peer. Registered on the home server with `host: <peer name>`.
- **Remote room id**: on the mirroring server a remote room is addressed as `<server name>:<home room id>` everywhere (REST, MCP, UI, WebSocket events).

## Wire contract (home server routes, all token-authenticated with the link token in `Authorization: Bearer <token>`)

1. `GET /api/peer/rooms` returns `{ server: <home name>, rooms: ConversationMeta[] }` (the home's `listConversations()`).
2. `GET /api/peer/subscribe?room=<id>&since=<cursor>&viewers=<comma list of hosted member names>&timeoutMs=<n>` long-polls like `/api/agent/listen`: returns `{ events: PeerEvent[], cursor }`. A PeerEvent is `{ seq, type, data }` where `seq` is a per-room monotonic sequence assigned by the home server for every room event it forwards (message, join, leave, rename, role, typing, stale, presence, message-choice, ask resolution, task and reaction events as the WebSocket fanout already emits them, plus `system` lines); `data` is the same payload the WebSocket clients get. Visibility: a `message` whose `to` excludes every listed viewer is not forwarded; DM lifecycle events follow the same rule (reuse `visibleToViewer`). `cursor` is the last seq sent. Seqs are kept per room in memory and persisted beside the JSONL as `<room>.peerseq` so a restart continues the numbering.
3. `GET /api/peer/messages?room=<id>&since=<messageId>&limit=<n>&viewers=<names>` returns the room's messages for the initial mirror fill, filtered per viewer like `read()`.
4. `POST /api/peer/register` body `{ room, name, host, registration, terminalSummary, role? }` registers a hosted member: the home server calls `room.join(name, 0, ...)` with a hosted marker (`Agent.host = <peer name>`, `Agent.hostedRegistration = <peer's registration id>`), binds it, and returns `{ ok, registration: <home registration id>, online }`. A name already registered on the home server from a different host or a local terminal is refused with 409 and the candidates. Rejoin is idempotent for the same host and hosted registration.
5. `POST /api/peer/send` body `{ room, sender, text, pid?, replyTo?, to?, askFor?, choices?, clientId }` writes through as the hosted member (identity checked against the hosted registration) and returns the created message; `clientId` (peer-generated UUID) makes the write idempotent for retries after a dropped link.
6. `POST /api/peer/leave` body `{ room, name, registration }`.
7. `POST /api/peer/wake` is served by the PEER (the host of a member), called by the home server when a mention targets a hosted member: body `{ room, name, hostedRegistration, sender, prompt }`; the peer runs its normal `wakeAgent` path for its local member with that prompt (the prompt names the HOME room and the peer's own base URL for read and reply through the mirror) and returns `{ ok, kind?, attempts, reason? }`; the home server posts the honest system line on failure exactly as for a local wake. The home server never injects into a hosted member itself and excludes it from lock keys and terminal identity.
8. Errors: 401 bad token, 404 unknown room, 409 name conflict, 503 link disabled. All bodies JSON. No em dashes in any text the server writes.

## Mirroring server (peer) behaviour

- Config: `links` from `JOIND_LINKS` (JSON array `[{ "name", "url", "token" }]`) and `--link name=url=token` (repeatable); the server's own `name` is `CONFIG.instance`.
- `src/link.ts`: one `LinkClient` per link: discovers rooms (`/api/peer/rooms`, refreshed every 60 s), subscribes per remote room (only rooms with at least one hosted member or currently open in the UI, so an idle link costs nothing), keeps the cursor in `data/links/<server>/<room>.cursor`, reconnects with backoff (1 s to 30 s), and emits `linkState` (`up`/`down` with since) plus the mirrored events into the manager's event bus with `conversationId = <server>:<room>`.
- `src/mirror.ts`: `MirrorRoom` implements the read surface the UI and the agent routes use (`read`, `who`, `messageCount`, `getMessageById`, meta) over the cached events; initial fill from `/api/peer/messages`; writes go to `/api/peer/send`; an undelivered queue in `data/links/<server>/<room>.queue.jsonl` with `{ clientId, sender, text, ..., queuedAt, attempts }`; `deleteUndelivered(clientId, by)` removes an entry if `by` is its sender; the queue drains in order when the link is up; while queued the UI receives a `pending` event and, on dispatch, the home's `message` event replaces it.
- Joining a remote room: `chat_join` with `conversation: "<server>:<room>"` (or REST `conversation` in the same form) resolves the link, registers the member locally (real pid, pane, Orca handle, local registration id) in a local shadow registration for that remote room, then calls `/api/peer/register` and stores the home registration id. Read, send, listen, leave, heartbeat, status, DMs and decisions work through the mirror with the same tool and route names.
- Wake handler: `POST /api/peer/wake` (token-authenticated with the same link token) looks up the local shadow member by hosted registration and runs `wakeAgent` with the supplied prompt through the existing coordinator, guards, retries and classification; returns the outcome.
- Honest lines: on link down the mirror posts a local-only system line "link to <server> down since <time>; messages you send here will be queued" (not written home); on recovery "link to <server> restored; <n> queued messages sent". The home server, when a peer's subscription is gone for longer than the presence grace, posts "<server> unreachable; members hosted there cannot be woken until it returns" and marks those members dim.

## Web UI contract (WebSocket and REST as seen by app.js)

- `init` gains `links: [{ name, state: "up"|"down", since }]` and `remoteConversations: [{ id: "<server>:<room>", server, name, messageCount, starred, state }]`.
- New events: `link` `{ name, state, since }`; `pending` `{ conversationId, clientId, sender, text, queuedAt }`; `pending-dispatched` `{ conversationId, clientId, id }`; `pending-deleted` `{ conversationId, clientId }`. Mirrored room events arrive with `conversationId = "<server>:<room>"` and are otherwise identical to local ones.
- REST: existing web routes accept `conversation: "<server>:<room>"`; `POST /api/pending/delete` `{ conversation, clientId, token }` deletes the caller's own undelivered message.
- UI: a "remote: <server>" section in the conversation list (greyed with a link-down badge when down); the room header shows the home server and link state; pending messages render with a pending marker and a delete affordance visible only to their author; the bell treats remote rooms like local ones; the composer stays enabled while the link is down (messages queue).

## Task split

- **Task 1, server side** (`feat/linked-servers`, worktree `D:\GitHub\joind-link`): config, `src/link.ts`, `src/mirror.ts`, peer routes on the home side, hosted registrations and wake routing in room/manager/index/tools, MCP and REST joins for `<server>:<room>`, honest lines, persistence of cursors and queues. Tests: unit per module, and an integration test that starts two servers in one process on two loopback ports (each with its own temp data dir), links B to A, joins a hosted member from B into A's room, mentions it from A, and asserts the wake request reached B and B's fake injector ran; link drop and recovery with a queued message; DM visibility across the link; name conflict 409; idempotent register and send.
- **Task 2, web UI** (same branch, worktree `D:\GitHub\joind-linkui`, touching only `public/`): the UI contract above against a mock server script under `tools/link-mock/` that emits the new init fields and events; cache-bust bump; no `any` in any script.
- **Task 3, integration and gate** (orchestrator): merge, run the suite twice, Codex gate rounds until PASS, then the live pass: link this server to the Y530 (after Jadzia's deploy), join a scratch room there through the mirror with a real Claude Code here, mention it from the Y530 side, and confirm the wake through the link and the honest lines in both directions.

## Rules for implementers

No em dashes or en dashes anywhere. No `any`. `wezterm cli` always with `--no-auto-start`. Never touch the live sessions (claude.exe pids 40492 and 16956) or the live Orca terminals. Never start a server on port 4200; tests use random loopback ports and temp data dirs. Commit on the branch with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; no push. CHANGELOG entry at the top: `## 2026-09-25: Linked Servers`.

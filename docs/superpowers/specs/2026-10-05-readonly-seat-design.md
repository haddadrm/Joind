# Read-only room seats: design note

Date: 5 Oct 2026. Branch `readonly-seat` from master 6e3d590. Status: implemented, not merged;
gate 1 (on 6ab3e39) failed on two findings, both fixed in cd313e8 (sections 4 and 5); gate 2 (on
cd313e8) failed on one, fixed in the next commit (section 5). Sits beside the agent credentials
(`docs/superpowers/specs/2026-09-29-agent-credentials-design.md`).

## 1. The need

One named seat must READ one room and never SEND. The crew's requirement, verbatim in
substance:

- **R1.** The credential reads messages of the room it was made for. It cannot post, upload or
  act in any room, under its own name or any other.
- **R2.** It is created with no terminal bound and no terminal discovery, so a mention of the
  seat is never typed into a console. A mention simply waits to be read.
- **R3.** Reading with it does not move or touch any other seat's read cursor or activity record.
- **R4.** It is scoped to one room and can be revoked by the Admiral (whoever holds the web
  token) without disturbing other seats.
- **R5.** The web token and the registrations keep working as they do today.

Neither existing credential fits. A read and a send pass the same gate (`agentRoom` in
`src/index.ts`: a binding, proved by the agent key or the registration, admits both
`/api/agent/read` and `/api/agent/send`), and the web token accepts any sender name on
`/api/send`.

## 2. Threat model

The holder of a seat token is assumed hostile: it will present the token on every route, in
every credential slot, with every method and path spelling, and it will try to turn its name
into a terminal-bound member so a mention of it becomes a wake.

What the seat token must never do, whatever the server's `--agent-auth` mode:

1. Reach any route other than its four reads (no send, upload, edit, delete, react, tag, pin,
   choose, resolve, task, decision, state, notes, session marker, join, leave, heartbeat,
   typing, status, rename, settings, launcher, crew, peer route, MCP, static files).
2. Read a room other than the one it was minted for, or any DM (section 4: a DM is routed by
   name, and a name is not a principal).
3. Change any state on read: no cursor, no `lastSeen`, no presence or typing event, no
   notification read mark, no room creation.
4. Be mistaken for another credential: a seat token in `Authorization: Bearer`,
   `X-Joind-Agent-Key`, `X-Joind-Token` or any query parameter is refused, never tried as the
   agent key or the web token.
5. Let its name be taken by a member (local, hosted through a link, or a linked peer's human)
   in its room, so its name can never be woken; or share a name with a human viewer (section 5).
6. Open a WebSocket, alone or beside the web token.

Out of scope, stated so the gate can judge it:

- **What the server already serves to anyone.** In `off` or `warn` mode the agent API needs no
  credential at all (that is the agent credentials lane's migration path), so anyone who can
  reach the port, the seat holder included, can join and post without any token. The seat
  token adds nothing to that; it grants exactly its four reads. A seat holder that must not be
  able to post at all needs the server in `require`, where an agent call without the key or a
  registration is refused. The same holds for `/data/files/*` (served without credentials, as
  today; the seat header itself is refused there).
- **The web token holder.** The operator can still post under any name, the seat's included,
  with `/api/send` (R5 keeps that). The seat cannot.
- **An attacker who reads the data dir.** It holds only digests, but such an attacker also
  holds the agent key and the web token.

## 3. Shape of the credential

| | |
|---|---|
| Token | `jrs_` plus 32 random bytes, base64url (47 characters). Shown once, in the mint reply. |
| Presented as | `X-Joind-Seat-Token: <token>`, and only that header. No query form (it would land in logs and browser history), no Bearer form (Bearer is the agent key's). |
| Stored | `<data dir>/readonly-seats.json`, mode 0600, written atomically (temp file then rename). Each record: id (`seat-<12 hex>`), name, room id, the token's SHA-256, created and revoked times. Never the token. The data dir is git-ignored, and the file name is also ignored explicitly. |
| Compared | SHA-256 of the presented token against every record with `timingSafeEqual`. |
| Bound to | One name in one local room. The name follows the mention grammar (`[A-Za-z0-9_][A-Za-z0-9_-]{0,63}`), is not `all` or `system`, and at most one active seat holds a name in a room (case-insensitive). |
| Home only | A seat is minted only for a room whose home is this server. A remote room (`<server>:<room>`, a mirror) is refused (400). Mirrors never learn of seats; a linked server's member or human registering the seat's name on the home is refused there (409). Link and peer trust are unchanged. |
| Independent | Rotating the agent key, changing `--agent-auth`, or restarting does not touch seats. Revoking a seat does not touch the agent key or any registration. |

A corrupt seat file is never overwritten: the server starts, no seat is valid, mint and revoke
answer 503, and the log says why. A person fixes or removes the file.

## 4. The gate and the allowlist

`seatGate` (`src/readonly-seats.ts`) is the first middleware on the app, before the agent
credentials gate and every route. It decides alone:

| Request | Answer |
|---|---|
| Seat header, valid token, method and path on the allowlist | Served by the seat's own handler (`Cache-Control: no-store`). |
| Seat header, valid token, anything else (any method, any other path, `/mcp`, `/api/peer/*`, `/`, static files) | 403. |
| Seat header, unknown, revoked or empty token | 401. |
| No seat header, path `/api/seat` or under it | 401 (the seat routes take no other credential). |
| No seat header, a seat token (active or revoked) in `Authorization`, `X-Joind-Agent-Key`, `X-Joind-Token` or any query parameter | 403. |
| Anything else | Passed on untouched (every existing flow). |

A request with the seat header is never passed to `next()`: no route registered after the gate,
today or later, can ever see it. That is the default deny, and it does not depend on anyone
remembering to add a check to a new route. Paths are normalized the way Express matches them
(lower case, doubled slashes collapsed, trailing slash dropped); an encoded spelling such as
`/api/seat/%2e%2e/agent/read` matches nothing and is 403.

**Sockets.** The WebSocket server handles `/ws` upgrades on the HTTP server, outside Express, so
the gate's rule is repeated there (`seatUpgradeRefusal`, the `verifyClient` hook): an upgrade
carrying the seat header (any value, valid or not) or a seat token in `Authorization`, the
agent-key or web-token header, or any query parameter, is refused with 403 before the socket
opens and before the web-token check. A seat never holds a socket, even beside a valid web token
(gate 1 on 6ab3e39 found a mixed-credential upgrade accepted and able to `web-rename`).

**The allowlist** (GET only; HEAD and OPTIONS are refused):

| Route | Answer |
|---|---|
| `GET /api/seat/me` | The seat's id, name and room. |
| `GET /api/seat/read?since=&limit=&from=` | `{ conversation, messages, lastId, more }`, oldest first, newest `limit` (default 50, at most 500) after `since`. |
| `GET /api/seat/search?q=&limit=&before=` | The room search grammar of `src/search.ts`, one page, newest first. |
| `GET /api/seat/message/:id` | One message. |

The room is always the seat's own; a `conversation` parameter is ignored. Each handler reads
the room's message array through `readAll` (a copy) and filters it; none calls `touch`,
`setTyping`, the cursor store, the notification store or anything that writes.

**What a seat sees.** The public messages of its room, and nothing else: no DM, not even one
addressed to its own name. Mirror-local lines (negative ids) never appear.

Why no DMs at all: Joind routes a DM by recipient NAME, and a name is not a principal. The same
name can be a human viewer's, a browser tab still holding a name its owner has since renamed
away from, or a member of another room. Gate 1 on 6ab3e39 showed both directions: a seat minted
under a name an open tab still held, and a human registering a seat's name after minting, each
let the seat read the human's DMs. Section 5 now closes both, but the only rule that holds
whatever the next identity path turns out to be is that a seat reads no DM. A seat that must
receive private instructions is a future case for a distinct seat principal (see the backlog
item on seat permissions); a mention in the room (`@Watcher`) reaches it in the next read. The
first version's DM floor (a DM to the name above the room's high-water id at minting) is gone.

**Read position.** Choice: the seat keeps no server-side cursor. It passes `since` (the
`lastId` of its previous read). This is the simplest choice that satisfies R3 by construction:
nothing is stored, for the seat or for anyone, by a read. No long-poll listen route (a seat
polls); see section 8.

**MCP.** Not exposed. An MCP session would need a second, read-only tool registry with the
same default deny; `/mcp` with the seat header is 403. REST only.

## 5. Name reservation and the wake path (R2)

Minting calls nothing in the terminal layer: no `discoverTerminals`, no process tree, no pane or
Orca resolution, no target classification, no wake. The seat is not a room member, so a mention
of it finds no agent and `wakeAgent` returns before any injection.

Two rules keep it that way if someone tries to make the name a member:

1. **The name is held.** `ChatRoom.seatReserved(name)` is set on every local room by the server.
   `peerOwnerRefusal` (`src/tools.ts`), which every join and rename path already calls (the
   REST join, the MCP `chat_join`, the web invite `/api/join`, `/api/rename`), answers 409 for a
   held name; the joins ask again after their awaits, so a join that started before the seat was
   minted cannot slip in. The peer route `/api/peer/register` refuses a linked server's member
   or human under the name (409). `ChatRoom.rename` refuses it too.
2. **The room never wakes it.** Even if a member held the name, `ChatRoom.send` skips a held
   name when queuing mentions (`@all` included), and `wakeAgent` returns for it. This is the
   backstop.

Minting refuses a name that is already a member, a binding, a linked peer's member or human in
that room, or a human viewer's name: `--human-names`, the registered web name, and the name every
open browser socket holds (a `web-rename` moves only the tab that sent it; the others keep the
old name until they reconnect). In the other direction, `POST /api/web/register` (409) and the
socket's `web-rename` (an error reply) refuse a name an active seat holds in ANY room, case
insensitive, because DMs route by name across rooms. Revoking frees the name. Every mint check
ignores case (`ChatRoom.holdsNameIgnoringCase` over local and hosted members and peer humans,
`hasBindingIgnoringCase` for bindings, lower-cased human names), as the reservation does: gate 2
on cd313e8 found that a seat `reader` minted beside a peer human `Reader` made that human's
next unchanged re-registration fail with 409 (an R5 regression). With section 4's
no-DM rule these are belt and braces: a collision could no longer disclose a DM, but two
principals sharing a name is wrong on its own.

## 6. Mint, list, revoke (R4)

Operator routes, web token only (header `X-Joind-Token`, as the page sends it; body or query
also work as on every web write):

| Route | Effect |
|---|---|
| `POST /api/readonly-seats` `{ name, conversation }` | Mints. `conversation` is a room id or a unique room name. Returns `{ seat, token, conversation, header }` once, `no-store`. Needs a user-set web token (409 while the web token is the generated one that `/` serves to anyone, the same rule as the agent key's Reveal). |
| `GET /api/readonly-seats` | Lists every seat: id, name, room, created, revoked, a 12-hex fingerprint, last read this run. Never a token or digest. |
| `POST /api/readonly-seats/:id/revoke` | Revokes that seat only (idempotent; 404 for an unknown id). The next request with its token is 401. Other seats, the agent key and every registration are untouched. |

Revoked seats stay listed (with `revokedAt`) for the record. Deleting a room does not revoke its
seats; their reads answer 404 ("room no longer exists") until revoked.

## 7. How each requirement is met, and the test that proves it

All in `tests/readonly-seat.test.ts` (26 tests).

| | How | Proving tests |
|---|---|---|
| R1 read | Four GET routes over the seat's own room, public messages only (`seatCanSee`). | "R1: reads its room's public messages (never a DM, even to its name) with since, limit, search and by id"; "R1: never reads another room, a DM to someone else, or a DM to its name sent before or after minting"; unit "sees public messages only, never a DM, even one to its own name" |
| R1 human names (gate 1) | Mint refuses names open sockets hold; register and rename refuse seat names; no DMs. | "R1: a seat cannot be minted under a name a browser socket still holds"; "R1: a human cannot register or rename onto a seat's name, and the seat reads no DM sent to that name"; unit "knows a seat's name in any room, case-insensitive, until revoked" |
| R1 sockets (gate 1) | `verifyClient` refuses any upgrade carrying a seat token. | "R1: a socket upgrade carrying a seat token is refused even beside a valid web token" (seat header, a junk `jrs_` header, a query value and Bearer: 403 each, no frame received) |
| R1 never act | The gate answers every seat-header request; only the allowlist is served. | "R1: default deny, every route of the server refuses the seat token and nothing changes" (walks every `app.*` route in `src/index.ts`, plus `/mcp`, the peer routes, `/`, static files and off-list seat paths, with the seat header beside the web token and the agent key; 403 for all, and message counts, members and rooms unchanged); "R1: an MCP session cannot be opened"; "R1: a seat token in any other credential slot is refused"; "R1, R2: no member can take the seat's name" |
| R2 no console | No terminal call at mint; name held; room never wakes it. | "R2: minting and mentioning the seat never reach injection, discovery, Orca, classification or the Codex queue" (every function export of `inject`, `terminals`, `orca`, `target` and `codex-queue` is recorded: zero calls across mint and two mentions; a real member's mention is the positive control); "R2: even a member that somehow holds the name is not woken by @name or @all" (backstop, with control) |
| R3 no side effect | Handlers read a copy; no cursor is stored. | "R3: reading moves no other seat's cursor, presence or activity record" (another member's unread count, both members' `lastSeen`, the notification unread count and the high-water id unchanged after repeated reads) |
| R4 scoped, revocable | One room per seat; operator routes; per-seat revoke. | "R4: operator-only minting, listing and revoking; revoking one seat leaves the others and every member alone"; unit "revocation is per seat and idempotent"; "R5 ... the seat survives a restart" (revocation persists) |
| R5 unchanged | The gate passes every request without the seat header through untouched, unless it smuggles a seat token in another slot. Minting checks owners case-insensitively, so a seat never blocks an existing registration. | "R5: a seat reads under require with no agent key; web token and registrations behave as before"; "R5: minting ignores case when it checks owners, so a case variant cannot lock out an existing peer human, hosted or local member"; the full existing suite (840 passing and 6 skipped on master, unchanged) |
| Linked servers | Home only; peer registration refused. | "is minted only for a room whose home is this server, and a peer cannot register a member or human under the seat's name" |

## 8. Limits

- In `off` and `warn`, the server serves agent calls without any credential (section 2). The
  seat token cannot post, but its holder could post without it, as anyone on the network can.
  Run `require` when that matters.
- No DMs, by design (section 4). Private instructions to a seat wait for a distinct seat
  principal.
- No listen (long poll) route; the seat polls `read` with `since`.
- No MCP tools for seats.
- No UI. Mint, list and revoke are REST calls (below).
- `lastUsedAt` is kept in memory only (a read never writes to disk).
- The seat is invisible in the member list; a mention of it looks like a mention of nobody to
  the room (no "could not wake" line, by design).

## 9. Operator how-to

Placeholders: `$WEB` is the web token, `$SEAT` the seat token, `http://127.0.0.1:4200` the
home server of the room. The web token must be user-set (`JOIND_WEB_TOKEN` or `--web-token`).

Mint a seat named `Watcher` in the room `Ops` (id or exact name):

```
curl -s -X POST http://127.0.0.1:4200/api/readonly-seats -H "X-Joind-Token: $WEB" -H "Content-Type: application/json" -d '{"name":"Watcher","conversation":"Ops"}'
```

The reply carries `token` (`jrs_...`) once. Hand it to the seat out of band (an environment
variable such as `JOIND_SEAT_TOKEN` on its machine); never paste it into a room, a file in git,
or a prompt.

The seat reads:

```
curl -s http://127.0.0.1:4200/api/seat/me -H "X-Joind-Seat-Token: $SEAT"
curl -s "http://127.0.0.1:4200/api/seat/read?limit=50" -H "X-Joind-Seat-Token: $SEAT"
curl -s "http://127.0.0.1:4200/api/seat/read?since=1234" -H "X-Joind-Seat-Token: $SEAT"
curl -s "http://127.0.0.1:4200/api/seat/search?q=decision" -H "X-Joind-Seat-Token: $SEAT"
curl -s http://127.0.0.1:4200/api/seat/message/1234 -H "X-Joind-Seat-Token: $SEAT"
```

Keep `lastId` from each read and pass it as `since` next time. A mention of `@Watcher` in the
room is simply in the next read; a DM to it is never shown (section 4), so do not send it one.
The name must not be a human viewer's or one any open browser tab holds (the mint answers 409).

List and revoke:

```
curl -s http://127.0.0.1:4200/api/readonly-seats -H "X-Joind-Token: $WEB"
curl -s -X POST http://127.0.0.1:4200/api/readonly-seats/seat-0123456789ab/revoke -H "X-Joind-Token: $WEB"
```

After a revoke the token answers 401 at once, and the name may be used by a member or a human
viewer again.

# Linked servers UI mock

A dependency-free Node script that serves `public/` and speaks enough of the
Joind WebSocket and REST protocol to exercise the linked-servers web UI
without the real server. It follows the "Web UI contract" section of
`docs/superpowers/plans/2026-09-25-linked-servers-plan.md`.

## Run it

```
node tools/link-mock/mock-server.mjs              # random loopback port, timer-driven script
node tools/link-mock/mock-server.mjs --manual     # no timer: GET /mock/advance runs the next step
node tools/link-mock/mock-server.mjs --port 47311 --step-ms 2000 --name rami9ipro
```

It binds `127.0.0.1` only and refuses port 4200 (the live Joind). The URL is
printed on start. Open it in a browser. The web token is injected into
`index.html` the way the real server does it, so there is no token prompt.

## What it serves

- `init` with two local rooms (`general`, `joind-dev`), one link `ramiy530`
  (up) and two remote rooms `ramiy530:cpm-engine` (active) and
  `ramiy530:scratch`, plus the optional `pending` list (empty at start).
- The scripted timeline, one step every `--step-ms` (default 3000 ms) after
  the first WebSocket connection, or one per `GET /mock/advance`:
  1. a mirrored `message` in `ramiy530:cpm-engine`
  2. a `pending` from the viewer while the link is up
  3. `pending-dispatched`, then the real `message` 300 ms later
  4. `link` down, plus the local-only system line
  5. a `pending` from the viewer (it gets the Delete affordance)
  6. a `pending` from `curzon` (no Delete for the viewer)
  7. a pending DM from the viewer to `curzon` (`to: ["curzon"]`): it shows
     only in curzon's mailbox, never in the channel
  8. `link` up, the queue drains (one entry message first, the next
     dispatched first, so both arrival orders are exercised), and the
     "restored" system line
- REST: `/api/conversations` (with `links` and `remoteConversations`),
  `/api/conversations/select` (with the room's `pending`), `/api/send`
  (queues while the link is down), `/api/pending/delete` (author only, emits
  `pending-deleted`), `/api/dms` (partners and threads across rooms, one
  seeded DM from curzon), and plausible JSON for the other routes the UI
  calls.
- `GET /mock/state` shows the viewer, active room, link and queue.

Screenshots go to `tools/link-mock/shots/` (gitignored).

## Notes for integration (UI side of the contract)

Choices the UI made where the contract left room. The server implementer
can match these or tell the UI side to change them:

1. **Where `conversationId` lives on the pending events.** The UI reads
   `data.conversationId` first and falls back to the envelope's
   `event.conversationId` (the convention of every other event). Sending both,
   as the mock does, is safest.
2. **Order of `pending-dispatched` and the real `message`.** Either order
   works. Whichever lands second removes the pending row. If the real message
   carries `clientId`, the row is removed on that alone. A dispatched row whose
   real message never reaches this view is removed after 15 s.
3. **Remote rooms after init.** The contract gives remote rooms only in
   `init`. The UI also accepts `links` and `remoteConversations` on
   `GET /api/conversations` (it already refetches that on
   `conversation-created`, `conversation-renamed` and `conversation-deleted`).
   Without that, rooms discovered by the 60 s refresh appear only after a
   reconnect.
4. **Queued messages across a reload.** The UI accepts an optional
   `pending: [{ conversationId, clientId, sender, text, queuedAt }]` in `init`
   and `/api/conversations`, and `pending: [...]` (for the selected room) in
   the `/api/conversations/select` response. Without it, a reload hides queued
   messages until they dispatch.
5. **Remote room ids.** A room is treated as remote when it is in
   `remoteConversations`, or when its id starts with `<link name>:`. Local ids
   (`c-...`) never match.
6. **No room menu for remote rooms.** Star, rename and delete are left out
   for remote rooms (administration stays on the home server, per the spec's
   out-of-scope list).
7. **Queued DMs.** A `pending` payload may carry `to` (the server sends it
   for DMs). The UI keeps it and applies the same view rule as a real
   message: a queued DM renders only in the mailbox of its recipient (or of
   the sender's partner), from any room, and never in the channel. A queued
   channel message never renders in a mailbox. On dispatch the real DM
   arrives through the mailbox branch of the `message` handler, which
   settles the pending row the same way the channel branch does.
8. **`since`** may be epoch milliseconds or an ISO string.
9. **Theme.** `public/style.css` has a single dark palette in `:root` and no
   light block. The new styles use existing tokens only, so they follow any
   theme block added later. Light and dark screenshots are identical today.
10. **Unrelated fix.** Long system lines (the link lines among them) now wrap
   inside the message pane. Before this change they overflowed it at 400 px.

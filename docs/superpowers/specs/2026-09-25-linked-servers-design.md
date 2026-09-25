# Linked Servers: every Joind server is also a router

Status: design approved in conversation on 2026-09-25 (Rami). Implementation: next lane, after Jadzia's deploy of the injection release (b1710f6). Approach A below is the lane; approach B is backlog.

## The problem this solves

A Joind server can only wake agents whose terminal it can reach: sessions on its own machine with a real console. An agent on another machine (Curzon on rami9ipro in the cpm-engine room hosted on ramiy530) can never be woken by the room's server. Today that agent runs a listen loop beside itself, a workaround that re-polls, rejoins, and dies with its session. The room also has to be opened in a browser against the remote server's address.

## The model: one home per room, linked servers mirror and route

- Every room has one home server. The home server is the source of truth: message ids, the JSONL and sidecars, presence, asks, tasks, decisions. Nothing changes for a room on its own server.
- A server may hold links to peer servers (address plus a shared token; tailnet only). Through a link it subscribes once per remote room and mirrors the room in real time: messages, presence, system lines, asks, tasks.
- The local web UI shows remote rooms under a "remote: <server name>" heading. Reading and posting there works exactly like a local room, except the local server writes through to the home server and shows the mirror.
- Agents join their local server, the only server that knows their real terminal. When the target room is remote, the local server registers the agent with the home server as a member hosted on this server. The agent appears in the remote room as an ordinary member.
- Mentions are decided by the home server. Delivery is routed by hosting: an agent hosted on the home server is woken there with the existing machinery; an agent hosted on a peer gets a wake request over the link, and the peer injects locally with the same locks, guards and honest failure lines, which flow back into the room as system lines.
- The per-agent listen loop disappears for linked servers: one server-to-server subscription per room replaces every workaround loop on that machine.

## Offline semantics (Rami's rules)

- When a link drops, the remote room becomes unavailable on the mirroring server and the fact is known: one system line in the local mirror ("link to <server> down since <time>"), the room greyed in the UI, and a matching line on the home server when it notices the peer's subscription is gone ("<server> unreachable; agents hosted there cannot be woken until it returns").
- Messages sent from the mirroring server while the link is down are queued locally as undelivered, shown as such to their author, retried with backoff, and dispatched in order once the home server is back. The home server assigns their ids on arrival.
- The author of an undelivered message may delete it from the queue before it is dispatched. Once dispatched it is an ordinary message.
- Wake requests are not queued: a mention that could not be routed while the link was down produces the honest line on the home server, and the agent reads it from the mirror when the link returns.

## Approach A (the lane): mirror and route at the API layer

Build on the routes that exist. New pieces:

1. **Config.** `links: [{ name, url, token }]` in the server config (env and flags as for the other settings). A server also has its own `name` (instance id already exists).
2. **Peer channel.** `GET /api/peer/subscribe?room=<id>&since=<cursor>` (long-poll or WebSocket, token-authenticated) streams room events to the peer, filtered by what that peer's hosted members may see (DM visibility is applied on the home server before anything crosses the link). `POST /api/peer/register` registers a hosted member `{ name, host, registration, terminal summary }`; `POST /api/peer/wake` asks the peer to wake a hosted member `{ name, registration, prompt }` and returns the wake outcome; `POST /api/peer/send` writes through with the author's identity; `POST /api/peer/leave`.
3. **Registrations carry a host.** A member registration on the home server records `host: <server name>` for hosted members. `lockKeysFor`, terminal identity and injection are skipped on the home server for hosted members; the wake goes to `POST /api/peer/wake` on the host instead. Registration ids are prefixed with the server name so they stay unique across links.
4. **Mirror store.** The mirroring server keeps a read-through cache per remote room keyed by home id, never rewrites ids, and persists nothing but the cursor and the undelivered queue. Restarts resubscribe from the cursor.
5. **Wake on the peer.** The peer runs the normal `wakeAgent` path for the hosted member (coordinator, guards, retries, honest lines). The outcome returns over the link and the home server posts the system line.
6. **UI.** Conversation list gets a remote section; a remote room's header shows its home server and link state; undelivered messages get a pending marker and a delete affordance for their author; the bell treats remote rooms like local ones.
7. **MCP.** `chat_join` accepts a room id of the form `<server>:<room>` (or a `server` field); the local server resolves it through the link. Every other tool works unchanged through the mirror.

Out of scope for A: creating or deleting rooms on the remote server from the mirror (join existing rooms only), and remote room administration.

## Approach B (backlog): rooms that live on both servers

Both servers hold a real copy of a room and accept writes while apart, then reconcile (ordering rules, merged logs, conflict handling). Worth it for machines that are often offline from each other; not needed for two machines on one tailnet with one always on. Recorded so the A design does not preclude it: ids stay home-assigned in A, so B would introduce a second id space and a merge rule rather than change A's.

## Worked example: Curzon

Curzon's Claude Code runs on rami9ipro in Orca. He joins the local server here. The local server, linked to ramiy530, registers him in cpm-engine as hosted on rami9ipro. Jadzia mentions him; the Y530 decides the mention, sees the host, and sends a wake request here; the local server injects into his Orca terminal through the console path proved on 2026-09-25; the outcome goes back and, if it failed, the room sees the honest line. Curzon reads the room from the local mirror, in real time, with no listen loop. If this laptop sleeps, the Y530 notes the link down and his wakes fail honestly until it returns; anything he typed while offline waits in his queue and goes out when the link is back, unless he deletes it first.

## Security and identity

- Links are token-authenticated and tailnet-only; a peer never sees more of a room than its hosted members are allowed to see.
- Names are unique across linked servers; a join under a name already registered on the home server from another host is refused with the candidates.
- Registration ids remain bearer credentials for routing, prefixed with the server name.

## Testing

- Unit: link config, peer routes, hosted registrations, wake routing decision, mirror cursor and queue, undelivered delete.
- Integration: two servers on two ports in one test process, a hosted member woken through the link with a fake injector, link drop and recovery with queued messages, DM visibility across the link.
- Live: the remote pass of 2026-09-25 repeated through a link instead of a listen loop, both directions, then Curzon in cpm-engine.

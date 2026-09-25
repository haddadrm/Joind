# Changelog

## 2026-09-25: Linked Servers

A Joind server can now link to peer servers, mirror their rooms, and host members of them. An agent joins its own server with `conversation: "<server>:<room>"`; the room's home server registers it as a member hosted on that server, decides its mentions, and sends the wake back over the link, where the terminal is. Server side of the plan (Task 1); the web UI is Task 2.

### Added
- **Config.** `links` from `JOIND_LINKS` (a JSON array of `{ name, url, token }`) and repeatable `--link name=url=token`. The server's own name is its instance name (`--name`); a link may not carry it. Names are one path-safe segment, URLs http or https, tokens at least 8 characters. Links are symmetric: each side lists the other with the same token, and the token names the calling peer.
- **Home side (`src/peer.ts`, routes under `/api/peer`, `Authorization: Bearer <link token>`, 401 bad token, 503 when no links are configured).**
  - `GET /rooms`; `GET /messages` (initial fill; also returns `members` and the `cursor` to subscribe from); `GET /subscribe` (long-poll; every event of a room gets a per-room `seq`, persisted as `<room>.peerseq` beside the JSONL and restarted past anything issued before; a cursor it cannot replay gets `reset`).
  - Visibility is decided on the home server: the viewers are the room's members hosted on the calling peer (and its registered human), intersected with what the request names. A DM, and the choice, ask, pin, edit and reaction events of a DM, never cross to a peer whose members are not its parties.
  - `POST /register` (409 with the candidates for a name registered from another host or a local terminal; idempotent for the same host and hosted registration; home-issued ids are `reg-<home>-<uuid>`), `POST /send` (idempotent by `clientId`: a retry returns the first copy), `POST /leave`, and `POST /act` (an addition to the plan's contract: presence, typing, status, ask resolution, choices, tags and pins of hosted members).
  - A peer silent for longer than the presence grace is said once in each room where it hosts members ("<peer> unreachable; members hosted there cannot be woken until it returns"), and its return is said too.
- **Hosted members (`src/room.ts`, `src/manager.ts`).** `ChatRoom.joinHosted` registers a member with `Agent.host`: pid 0, no pane, no handle, never in the live terminal registry, so it takes part in no lock set and no terminal identity here and is never injected here. Its host's registration id is kept beside the member (`hostedRegistrationOf`), not on it, because member objects reach web clients. A mention routes the wake to the host (`POST /api/peer/wake`); the home posts the honest line on failure with the local wording, naming the host; an unreachable host is said once per streak, and wake requests are never queued. A hosted binding answers only its registration id, never a name-only lookup. A local join over a hosted member is refused (409, or the MCP text). A silent hosted member is dimmed and never removed by the stale sweep.
- **The wake split.** `wakeAgent` is now the local wake core (coordinator, guards, retries, classification; unchanged) plus what the room says. `wakeForPeer` runs the same core for a peer's request, checks the registration, and returns the outcome instead of saying anything. The prompt can name a room (`in "<room>" on <server> (conversation <server>:<room>)`) and uses each server's own base URL.
- **Mirroring side (`src/link.ts`, `src/mirror.ts`).**
  - `LinkClient` per link: discovery every 60 s into a `MirrorRoom` per remote room, registered with the manager as `<server>:<room>`; a subscription only while a local member is in the room or the web UI has it open; the cursor in `data/links/<server>/<room>.cursor`; backoff from 1 s to 30 s; `link` up and down events. A reply to a request that started before the link went down (a long-poll in flight at the drop) does not mark it up again: without that rule the link flapped, said "down" twice, and started a drain that raced a delete.
  - `MirrorRoom` is a `ChatRoom`: read, who, search, listen, asks and message lookups work unchanged over the home's messages and ids. Its own member map holds only this server's members (real pid, pane, Orca handle), so the wake machinery runs here unchanged; their local events never leave the mirror.
  - Writes go home (`writeThrough`) with a `clientId`. While the link is down, or while older messages wait, they queue in `data/links/<server>/<room>.queue.jsonl` and drain in order when the link returns. A queued message can be deleted by its author only, and not while it is being sent. A message the home refuses is held with a line until its author deletes it (gate round 1).
  - Local-only lines: "link to <server> down since <time> UTC; messages you send here will be queued" and "link to <server> restored; <n> queued messages sent". They have negative ids and `local: true`, never enter a read cursor, and reach the web viewer.
- **Joins and tools.** MCP `chat_join`, `POST /api/agent/join` and the UI invite accept `<server>:<room>`: the local server resolves the terminal as always, registers the member with the home, then binds it locally. `chat_send`, `chat_dm`, `chat_handoff`, `chat_upload`, `POST /api/agent/send` and the web `POST /api/send` write through (202 with a `clientId` when queued). New: MCP `chat_unsend`, `POST /api/agent/pending/delete`, and the web `POST /api/pending/delete`. Decisions list local and remote rooms. Reactions, edits, tasks and session markers answer honestly that they are done on the home server.
- **Web contract.** `init` and `GET /api/conversations` gain `links`, `remoteConversations` and the viewer's `pending`; selecting a remote room fills it first and returns `pending` and `remote`; WebSocket events `link`, `pending`, `pending-dispatched`, `pending-deleted` (envelope `{ type, conversationId, data }`, with `conversationId` in the data too), and mirrored room events under `<server>:<room>`. A pending DM follows DM visibility. `pending-dispatched` and the real `message` are both sent, in either order. A remote room found, renamed or gone at a later discovery emits `conversation-created`, `conversation-renamed` or `conversation-deleted` (data `{ id, remote: true }`), on which the UI refetches the list. Star, rename and delete of a remote room answer 400: it is administered on its home server. The human viewer registers with the home as the server's human (never woken) when it opens or writes in a remote room.
- **`startJoind(config, options)`** in `src/index.ts`: the server is a function now, so tests run two servers in one process; `node dist/index.js` starts it as before. The body is re-indented, so review the file with `git diff -w`.

### Tests
- 13 in `tests/linked-servers.test.ts`: two real servers in one process on free loopback ports with their own temp data dirs, linked both ways, a fake injector, and a switch that cuts each link's network. A hosted member joins A's room from B; a mention on A reaches B's injector with a prompt naming A's room and B's URL, and nothing is injected on A; the reply lands under A's id; a failed injection on B comes back as A's line; register and send are idempotent; a name registered on A is refused to B with 409 and the candidates (and a local join over the hosted member is refused on A); a DM to another member never crosses, one to the hosted member does; the link down, a queued send, a delete refused to another name and done by the author, recovery sending the kept one once under A's id with the restore line; a mention while A cannot reach B is said once and not queued; the silent-peer announcement and return; MCP `chat_join`, `chat_send`, `chat_read` and `chat_unsend` through the mirror; the web contract over a real WebSocket (a pending event with the room id in the envelope and the data, the queued entry in the list, select and init payloads, the viewer refused as non-author, both the dispatch and the message after recovery, the refetch event for a room created later, 400 for remote star, rename and delete); the leave.
- 27 in `tests/linked-servers-units.test.ts`: link config; the mirror (event application and suppression, local lines, write-through, queue persistence, drain order and refusals, a failure mid-drain, the delete rules, the refused sender); the hub (numbering and restart, visibility against requested viewers, reset and long-poll, the peer announcement); hosted members (routing without injection, the once-per-streak line, reported failures and quiet ones, the unchanged local wording, the stale sweep, the peer-side wake and its prompt); the manager (hosted bindings, remote rooms); the link client (discovery, state events, a stale reply after a drop, the wake when unreachable, the cursor on disk). The integration test stubs the per-join process enumeration (fake pids, nothing to find), so it adds no system queries while other files run. The file waits on specific events (the dispatch notice, the restore line said after a drain, the line of the failed wake) with bounded waits, never fixed sleeps, and gives each test 20 s; ten runs of the file in a row passed. Suite 372. `tests/wezterm-honesty.test.ts` ("asks the caller before falling back", three real command-line lookups for a fake pid inside a 5 s test) times out under heavy machine load, on the base commit 8d0819b as well (two of three runs there).

### Codex gate round 1 (1 High, 9 Medium on the server side, closed)
- **One owner per name in a room (High).** A peer's human registration now counts like a hosted member: `ChatRoom.peerOwnerOf` names the peer that owns a name (its member or its human), and the MCP join, the REST join and the UI invite refuse a local join of it with 409 and the candidates (`peerOwnerRefusal`). A peer human is refused for a name that is a local member or has a local binding in the room. Humans live in the room now, not the hub.
- **A clientId retry is authorized first**, and deduplicated per (calling peer, sender, clientId): an unregistered sender, or another peer, reusing a clientId gets 403, never the first copy. The key is the sender's name rather than its registration id, so a retry after a re-registration still finds its first copy.
- **A remote join registers home, then commits only if current.** `registerMember` no longer touches the mirror; the join commits (`commitMember`) after `joinIsCurrent`, or abandons (`abandonMember`), which re-registers the member that is current here (or leaves, when none is). A superseded join no longer leaves the home holding its registration and the newer member's wakes failing.
- **A peer registration during a local join's validation wins.** The hub calls `supersedeRoomJoins(room, name)` on every hosted or human registration, so a local join of that name begun earlier fails its freshness check; the join paths also recheck the owner at commit.
- **Recovery announces what arrived meanwhile.** A refill after an outage or a reset emits the new messages (and deletions) as room events before the cursor moves on, so open browsers and the bell see them. A first fill announces nothing.
- **Deletions during an outage do not survive.** `/api/peer/messages` says whether the snapshot is `complete`; the mirror treats it as authoritative from its oldest message (or entirely when complete) and drops cached messages it lacks.
- **Queued messages are never dropped by the server.** An entry whose author has no live registration (both servers restarted) waits and goes when the author rejoins (`resumeAuthor`); one the home refuses is held with a local line. Either way that author's later entries wait behind it, other authors' go on. Only the author's delete or a successful send removes an entry. A new send queues behind its own author's entries only.
- **Web mailbox DMs into a remote room** register the viewer as this server's human and write through (202 when queued), instead of the mirror's synchronous send throwing.
- **Mailboxes cover remote rooms:** the DM thread and partner collectors enumerate local rooms and mirrors, with qualified ids.
- **Web edits and reactions in a remote room answer 400** before any local store or mirror text changes.
- 10 tests in `tests/linked-servers-gate1.test.ts`, one per finding, all failing on 7753499 at the finding's own assertion. Joins that must race are parked in terminal validation by a stub a test can hold. The mirror unit test for a refused queued message now expects it held rather than dropped. Suite 382.

### Codex gate round 2 (1 High, 8 Medium on the server side, closed)
- **Renames keep one owner per name (High).** The UI rename (the only member rename) answers 409 with the candidates when the new name is a peer's (member or human) and when the member is a peer's hosted member; `ChatRoom.rename` refuses both too, so no path can bypass it.
- **Registration transitions of a name are serialized.** `MirrorRoom.lockName` holds one transition per name at a time: a remote join holds it from its home registration to its commit or abandon, recovery re-registration takes it per member and registers the member as it is at that moment, and the human's changes take their own. A restore after a superseded join can no longer land after a newer join.
- **clientId dedupe is per sender incarnation:** the host's registration id for a hosted member (stable across re-registrations of the same member, new for a new session), the registration for a peer's human. A new owner of a name reusing an old clientId sends a new message.
- **A refill never judges what came after its request.** The mirror numbers its insertions; `LinkClient.fill` takes the mark before it asks for the snapshot, and only messages cached before the mark can be dropped as gone. A send completing during a recovery refill is no longer deleted and replayed.
- **Deleting a held entry resumes its author's queue.**
- **Registering the human resumes its waiting messages,** as a member's commit does.
- **Pending entries carry their state:** `state` is `queued`, `waiting` or `held`, with `reason`, in `init`, the conversations list, select, the `pending` event (sent again whenever the state changes) and the web 202. After a restart the refusal line of a held entry is said again.
- **The viewer's first message while offline is queued, not refused.** The locally authenticated web viewer's send or mailbox DM queues as `waiting` (202 with the pending entry) when the home does not know it yet; the viewer is registered as this server's human when the link returns, and the message goes then.
- **A new web viewer name releases the old one at the home** (a peer leave of the previous human registration, under the human's lock), so the old name is free again there.
- 9 tests in `tests/linked-servers-gate2.test.ts`, one per finding, all failing on b73ea7e at the finding's own assertion. Suite 391.

### Codex gate round 3 (3 Medium on the server side, closed)
- **The human is one persisted transition.** `MirrorRoom.settleHuman` runs under the human's lock: it releases every former registration still owed, registers the wanted viewer (a change recorded while offline comes before the current one), queues the former viewer's release when it changed, and resumes the viewer's waiting messages. The state (the registered human, the wanted one, the releases owed) is saved beside the queue as `<room>.human.json`, so it survives a restart. Recovery and `ensureHuman` both go through it.
- **A failed release is kept and retried** at recovery before anything else for the human; it leaves the record only when the home confirms it or says the registration is gone.
- **A viewer change made offline is carried out at recovery:** the former human is released, the new one registered, and its waiting messages sent.
- **A drain owes another pass** when a delete or a resume unblocks an entry while it runs (`requestDrain`), so a pass that ends on another author's refusal no longer strands the unblocked author's later entries.
- 3 tests in `tests/linked-servers-gate3.test.ts`, one per finding, all failing on 7e8b204. Suite 394.

### Codex gate round 4 (4 Medium, 1 Low on the server side, closed): the viewer as a write-ahead state machine
- **`src/human-state.ts`.** The record of this server's human in a remote room: `current` (registered at the home), `wanted` (the viewer's latest explicit choice), `unconfirmed` (a registration sent whose reply was not seen), `releasesOwed` and `seq`. Every change is written atomically (a temp file, then a rename) and becomes the in-memory state only once written; a write that fails throws `HumanStateError` and nothing further is sent. The record is the only source of truth for the viewer: the queue no longer infers it after a restart.
- **`MirrorRoom.settleHuman`** carries the record out under the human's lock, writing each step before it is made and after it is confirmed: the latest choice is recorded; owed releases are made; an unconfirmed registration that is no longer the target is registered again (idempotent at the home) to learn its id and released; the target is recorded as unconfirmed, registered, then recorded as current with the former viewer's release owed; owed releases again; the viewer's waiting messages resume. Offline, only the choice is recorded.
- **A lost reply after the home registered Bob** no longer leaves Bob reserved after a restart: Bob was recorded before the request, so recovery completes him and releases Alice.
- **A revert to the current viewer cancels a pending change** (the latest choice is recorded even when it is the current registration).
- **Release debt is cleared only by a successful release or a 404**; a 401 or any other refusal keeps it for the next recovery (Low).
- **The drain's cleanup services a rerun requested in its completion gap** (after the loop's last check, before `draining` is cleared).
- 9 tests in `tests/linked-servers-gate4.test.ts`: one per finding (all five failing on 933b439; the completion-gap test also fails with only the new cleanup disabled), a restart in the middle of each persisted step (the change recorded offline; a registration whose reply was lost, then a revert; a release cut off after the change), and a record that cannot be written (no request sent, and a viewer's send that needs the record is refused, not queued). The round-3 test reads the new record layout. Suite 403.

### Codex gate round 5 (1 Medium on the server side, closed)
- **A stray the home refuses for good no longer blocks the next viewer.** When the home answers the re-registration of an unconfirmed viewer with a definitive "not yours" (404, or 409 whose candidates do not name this server), `unconfirmed` is cleared in the record (written like every other step) and the transition goes on to the chosen viewer; only link errors keep it for a retry. The same answer for the target itself clears its `unconfirmed` too, while the choice stays for a later attempt.
- 2 tests in `tests/linked-servers-gate5.test.ts`, both failing on 2cb76e4: Alice, then Bob refused with 409 because a home member holds the name, then Carol (registered, her waiting message sent); and a lost reply for Bob, then a home restart with Bob taken there, then Carol. Suite 405.

### Codex gate round 6 (1 Low, closed)
- **Only a well-formed 409 is definitive.** A 409 clears a stray only when its candidates are a nonempty array, every entry has a nonempty host string, and none is this server. Missing, null, empty, non-array, `[null]`, `[{}]`, and entries without a valid host prove nothing: the stray is kept and retried later, as after a link error (no swallowed TypeError).
- 1 test in `tests/linked-servers-gate5.test.ts` over eleven candidate shapes (including a candidate naming this server), failing on 9365651. Suite 406.

### Known limits
- **A peer and this server may still share a human's name.** A peer's human may take any name that is not a local member or binding of the room, including this server's own web viewer name (the same person on both machines is the intended case).
- **A linked peer is trusted with names.** It can register any name that is not a member of the room now, as a member or as its human, and then read what that name may read, as a local join can today. Tokens authenticate servers, not people.
- **The home forgets hosted members on restart**, like local ones. The host re-registers its members when the link comes back and before a send it retries, but a wake that arrives for a host that restarted and lost its member says "no console" rather than "not joined here".
- **Reactions, edits, tasks, session markers, renames and roles** of a remote room are done on its home server. Remote room administration is out of scope, as the design says.
- **Delivery of `/api/peer/act`** (touch, typing, status, resolve, choose, tag, pin) is fire and forget and needs the link up; the mirrored event is what shows it happened.
- **The idempotency record of `clientId`s is in memory** (5,000 per room): a home restart between a send and its retry can store the message twice.

## 2026-09-25: Linked Servers Design

### Added
- `docs/superpowers/plans/2026-09-25-linked-servers-plan.md`: the implementation plan for approach A, with the wire contract between home server and peer, the mirroring server behaviour, the web UI contract, the task split and the rules for implementers.
- `docs/superpowers/specs/2026-09-25-linked-servers-design.md`: every Joind server is also a router. One home server per room; a server holds links to peers, mirrors remote rooms in real time, registers its local agents as hosted members, and receives wake requests for them so injection happens where the terminal is. Offline rules: a dropped link is known on both sides, messages written while offline queue and dispatch on return, and their author may delete an undelivered one. Approach A (mirror and route at the API layer) is the next lane; approach B (rooms living on both servers) is backlogged. Worked example: Curzon in the cpm-engine room without a listen loop.

## 2026-09-25: Injection Matrix, End to End

The matrix now runs the whole wake path through a live Joind server, not only the injector: `-Mode agent -E2E`.

### Added
- **E2E mode:** each real agent joins a scratch conversation itself (the harness types the join instruction), a REST sender mentions it, and the probe reads the route from the server log, the reply from the conversation, and any honest warning line. It saves the agent's screen when no reply comes.
- **Options:** `-E2EExtras` adds coalescing and `@all`; `-E2EControlsJson` adds negative controls. `-Conversation` is required, so a run never lands in the active room.
- **Codex in E2E** runs with `--dangerously-bypass-approvals-and-sandbox`, because its default sandbox blocks the curl the wake prompt asks for.

### Fixed
- In a shared Windows Terminal process, the cleanup step closed the process's main window whenever no shell was left in it, and that window can be someone else's. It now closes only a window titled `inject-matrix-*`.

### Findings (25 Sep 2026, integration/injection-20260925, details in results/e2e-20260925.md)
- **Most routes delivered.** The mention reached a real Claude Code and got its reply in 22 to 37 s over conhost, both Windows Terminal shells, Orca (Orca's own send), wmux and Warp. Codex in Orca replied in 57 s.
- **The WezTerm route silently loses real wake prompts** for both agents. A 320 to 345 character burst ending in a carriage return is taken as a paste, and the carriage return becomes a new line. The text, a pause of 300 ms or more, then a carriage return in its own `send-text` call submits both agents. The matrix's 49-character prompt could not show this.
- **Multi-GUI pane collision:** pane ids are per WezTerm GUI, the server checks a pane against the one socket it picked, and the ancestry check only asks "inside some WezTerm". An agent in a second GUI reporting pane 0 was accepted, and its wake was typed into the other GUI's pane 0. Reproduced between two GUIs of mine (69000 and 60924) with a receiver catching the prompt.
- **The server can bind to a dead WezTerm socket:** it picks the lexically last `gui-sock-*` file. Each failed probe leaves a `wezterm.exe-log-*.txt`.
- **Negative controls:** a pid with no console gets the honest line. A stale pane is dropped at join and the console route is used. A pid whose console has no agent reading it is a silent miss.

## 2026-09-25: WezTerm Submit and Instances

The end-to-end run against the local server (tools/inject-matrix, results/e2e-20260925.md) woke a real Claude Code in six of seven hosts. WezTerm failed: the wake typed but never submitted, for Claude Code and Codex alike, and nobody was told. The same run showed that the server can type one GUI instance's wake into another instance's pane, and that it can bind to a dead WezTerm socket.

### Fixed
- **Submit through WezTerm.** `injectWezTerm` sends the text alone, waits `max(plan.delayMs, 300 ms)`, asks the post-text guard, and then sends the carriage return in its own `send-text` call. Codex and Copilot get a second carriage return `plan.delayMs` later, guarded the same way. `--no-paste` stays. Measured: a 320-character wake prompt with its carriage return in one call was taken as a paste by Claude Code 2.1.28x and Codex 0.154, and the carriage return became a new line in the input box. The text, a 300 ms pause, and then the carriage return alone submitted both agents. Each Enter is still retried once on its own, and a second failure is still a `PartialDeliveryError`.
- **One WezTerm instance per pane.** Pane ids are per WezTerm GUI instance.
  - The ancestry walk now names the instance a pid runs in (`weztermGuiOfTree`: the `wezterm-gui` ancestor, one walk shared with `hasAncestor` through `findAncestor`).
  - A requested pane is checked in THAT instance, through its own socket `gui-sock-<gui pid>`. The agent carries the instance as `weztermGui` (a pid, not a path, since the agent object is served to web clients), and wakes and tab titles go through that instance's socket, not one global setting.
  - When the agent's instance has no reachable socket and the server's socket belongs to another instance, the pane is dropped with "pane N belongs to another WezTerm instance (gui pid X)". A pane not live in the agent's own instance is dropped even if the server's instance has one with that id.
  - With no pane requested from another instance, nothing is auto-detected in the server's instance.
  - Reproduced before the fix with two GUIs: an agent in GUI 60924 joined with pane 0, and its wake was typed into GUI 69000's pane 0.
- **Live sockets only.** `findWeztermSocket` considers `gui-sock-<pid>` files only while that pid is running (a signal-0 existence check). The old rule took the alphabetically last file, a leftover of a closed GUI when its pid sorted last, and the server then reported "WezTerm not found" next to a live GUI. Files are never deleted.
  - On Windows a LIVE GUI's socket file cannot be stat'ed: `existsSync` says false, and `stat` and `lstat` fail with EACCES (measured). So existence comes from the directory listing, and "newest first" applies only where the time can be read. Among several live GUIs the default is the listing's order; that only matters for joins whose instance is unknown.
  - The first re-run caught this: the agent's own socket looked missing, and a dead remembered server socket made the pane read as "another instance". The resolver now also ignores the server's socket unless its GUI is alive (`liveServerSocket`).
- **No log litter from probes.** Every failed `wezterm cli ... list` probe wrote a `wezterm.exe-log-<pid>.txt` into the WezTerm runtime dir (26 after one morning). Probes now run with `WEZTERM_LOG=off` (`weztermProbeEnv`). Measured: `off` or `none` writes no file, while `error` still does. `off` also empties stderr, so `send-text` keeps WezTerm's logging: its stderr is the only explanation of a failed injection.

### Codex gate round 1 (4 Medium, closed)
- **A GUI that is gone fails the route.** When an agent's known GUI was gone, its wake and tab title used the server's socket with the agent's pane number, typing into another GUI's pane. `inject()` now takes the GUI (`weztermGui` option), resolves that GUI's own socket itself, and throws when the GUI is gone. The WezTerm route fails and the guarded console fallback runs; no other socket is ever substituted. `weztermEnvForGui` returns null for a gone GUI, and the tab title is skipped.
- **Auto-detection stays in the agent's own GUI.** It took a pane detected in the server's GUI and stamped the agent's GUI on it. Discovery now lists the agent's own GUI through its socket (`autoDetect(socket)`), declines when that socket is unavailable, and never combines one GUI's pane with another GUI's identity.
- **Pane keys include the GUI.** Pane equivalence ignored the GUI, so pane 0 of GUI 10 and pane 0 of GUI 20 were one terminal: a move between them during the first Enter's pause was judged "the terminal holding the prompt", and neither pane got its Enter or a fresh wake. Keys are now `pane:<gui>:<n>` when the GUI is known, so `terminalIdentity`, `lockKeysFor` and `sameTerminal` tell GUIs apart, and two GUIs no longer wait on each other. The GUI is set inside `room.join` (a sixth argument travelling with the pane), so the registry and the identity see it from the start. `applyWeztermGui` is gone.
- **The executable comes first.** An explicit-pane join listed the agent's GUI before the executable was resolved, so with WezTerm under Program Files but not on PATH a valid pane was dropped. `resolveWezTermExe` runs `--version` over the candidates and needs no GUI, and the resolver calls it (`ensureExe`) before listing the agent's instance, independently of the default GUI.
- 12 tests: 11 in `tests/wezterm-submit-gate1.test.ts` and the GUI-move case in `tests/delivered-abort-room.test.ts`. Nine of the 12 fail on dd7deef, at least one per finding; the others pin behaviour that was already right. The `delivered-abort-room` fake now records which GUI's socket each send went through. Suite 305.

### Codex gate round 2 (5 Medium, closed): the GUI is part of every pane, always
Every finding came from a pane whose GUI was unknown sitting beside GUI-keyed panes. A pane is now only ever the pair (GUI instance, pane number); a bare pane number identifies nothing.
- **A pane is bound only with its GUI.** The GUI comes from the pid's `wezterm-gui` ancestor or, for the UI invite route only, from the GUI whose socket discovery ran through. Otherwise the pane is dropped with "pane N ignored for X: its WezTerm instance cannot be determined". A pane-only join (no pid) binds no pane, and `room.join` binds none without a GUI. The `pane:<n>` key is gone; the only pane key is `pane:<gui>:<n>`.
- **A known GUI with no reachable socket fails resolution.** No fallback to the server's socket or any other GUI remains, on a fresh server too. With no pane requested, the result is null (any old pane is cleared) with the note "no pane bound for X: its WezTerm instance (gui pid G) has no reachable socket".
- **A rejoin from another GUI never keeps the old GUI's pane.** "Nothing learned" keeps an old pane only when it is in the same GUI, in the room and in the manager's binding alike.
- **Auto-detection claims are per GUI.** `claimedPaneNumbers(agents, gui)` counts only panes claimed in the agent's own GUI, and detection runs only through that GUI's socket. The resolver's dependencies shrink to `guiOf`, `socketForGui`, `listPaneIds(socket)`, `autoDetect(socket, gui)` and `ensureExe`.
- **Bindings and callbacks carry the pair.** Manager bindings store `weztermGui`; `getAgentBinding`, `beginJoin`, `joinIsCurrent`, `effectiveJoinAliases` and `bindAgent` take it; every REST agent route reads `weztermGui` (query or body) beside `paneId`; both REST join replies return `weztermGui` and the MCP join reply names the instance; the wake prompt puts `&paneId=N&weztermGui=G` in the read URL and `"paneId":N,"weztermGui":G` in the reply body; `public/app.js` matches and sends the pane only as a pair. Two bindings of one name in pane 0 of two GUIs resolve by the pair, and a bare pane number is ambiguous.
- 10 tests in `tests/wezterm-submit-gate2.test.ts`, at least one per finding, all 10 failing on 4938bc0 (run there with the old dependency shape, at real assertions). The existing suites (`wezterm-honesty`, `wezterm-instances`, `wezterm-submit-gate1`, `orca-honesty`, `orca-gate1`, `delivered-abort-room`, `partial-delivery-room`, `wake-fallback`, `wake-room`, `wake`) follow the pair model. Suite 315.

### Codex gate round 3 (5 Medium, closed)
- **The REST auto-join keeps the discovered GUI.** With no pid, pane or Orca handle supplied, the route took pid and pane from a discovery row and dropped its GUI, so round 2's pair rule then refused the pane ("instance cannot be determined"). The row's GUI now goes to the freshness token (`beginJoin`), to `resolvePaneForJoin` (the discovered-GUI argument) and so to the binding. This was a regression of round 2.
- **Auto-join claims are pairs.** The route's candidate filter subtracted claimed pane numbers across GUIs, so GUI 100's pane 0 hid GUI 200's pane 0. The filter is now `availableForAutoJoin`: a WezTerm row is claimed only by a member in the same pane of the same GUI, and a row with a pane but no GUI is no candidate.
- **An ambiguous departure removes nothing.** `/api/agent/leave` for a name registered more than once, with nothing that names one registration, used to remove every binding of the name while both room members stayed. It now answers 409 with the candidates (conversation, pid, the pair, the Orca handle). The UI leave removes the member and the binding of the selected conversation only (`conversation` in the body, else the active one; `app.js` sends it). `chat_leave` without a resolvable registration no longer unbinds the name everywhere.
- **An MCP session follows its own registration.** The session records its room, name and terminal (pid, pair, Orca handle) at `chat_join`. `routeSessionRoom` routes by that registration, or by a binding of the same name from exactly the same terminal (`bindingForTerminal`, never "the only binding left"). After a departure of its registration the session gets "Not in a conversation. Call chat_join first." instead of another room. A session with no record (an MCP reconnect) keeps the unambiguous name lookup.
- **The UI rename re-binds the selected conversation's registration.** It found the binding by name only, which is ambiguous when the name is registered in two rooms, so the new name got no binding and its callbacks failed. It now checks the member's own terminal against the selected conversation's binding and re-binds exactly that one.
- 9 tests in `tests/wezterm-submit-gate3.test.ts`, 8 of them failing on 92a5fb1 (at least one per finding; the ninth pins resolution through a discovered GUI). Findings 3 and 5 run against the real server (`dist/index.js`, loopback, a temp data dir) with odd fake pids that no Windows process can have; finding 4 drives the real MCP tool callbacks. Suite 324.

### Codex gate round 4 (2 Medium, closed): registration ids
- **Every registration has a server-issued id.** Each join (MCP `chat_join`, `/api/agent/join`, the UI invite) issues an opaque id, unique per join, and stores it on the manager binding and beside the room member (`ChatRoom.registrationOf`; not on the member object, which web clients receive). Both REST join replies return it as `registration`, and the MCP join text names it. `getAgentBinding` and the REST agent routes take `registration` (query or body) and match it before pid, pair or handle; an id that matches nothing matches nothing, never a fallback. A rename keeps the id.
- **An MCP session with no record gets "join first".** A reinitialized transport (a new session id) or a session after `chat_leave` has no record, and round 3 still fell back to the name, so A's new session read and wrote B's room, and a second leave removed B. Now a session follows its record (by registration id, then the exact terminal), or a registration id the call names (`registration` on `chat_read`, `chat_send`, `chat_listen` and `chat_leave`; the session then adopts it). With neither, `chat_read`, `chat_send` and `chat_listen` answer "Not in a conversation. Call chat_join first." The one exception is by design: when exactly one registration of the name exists anywhere and it is terminal-less (pid 0, no pane, no handle), it is used. That is the interactive REPL agent, which has no terminal to name. `chat_leave` deletes the record and unbinds only the registration it reaches, and says so when it reaches none.
- **Terminal-less registrations work again.** With pid 0, no pane and no handle, round 3's exact-terminal match could not find them: reads and sends demanded a rejoin, `chat_leave` kept the registration, and the UI rename skipped the rebind. They are identified by their id everywhere now: the UI rename rebinds the selected conversation's member by its id; leave, read and send take the id or, for a name with one registration, the name. Two terminal-less registrations of one name are ambiguous without the id: 403 on read and send, 409 on leave, both with the candidates (conversation and terminal, never the ids). A named id that does not exist is a 404 on leave.
- 6 tests in `tests/wezterm-submit-gate4.test.ts`, all failing on 0ad2844 at the finding's own assertion: a reinitialized session after A's departure, leave then read on one session, terminal-less join, read, send and leave through MCP, two terminal-less registrations through MCP, and the terminal-less REST join, read, send, UI rename and leave, plus the ambiguous pair, against the real server (a well-formed but nonexistent Orca handle keeps the server's terminal auto-detection out, and `ORCA_CLI` points at a missing file). Three source-shape checks in `orca-gate1`, `wezterm-submit-gate2` and `wezterm-submit-gate3` follow the new signatures. Suite 330.

### Codex gate round 5 (1 Medium, closed): superseded registrations
- **One binding per conversation and name.** Twin joined A from pid 991, then B from pid 993, then pid 991 rejoined B. The join merged into A's entry (the same pid) and moved it to B, but kept B's pid-993 entry, so both ids resolved B: the superseded id still read B's messages, and a REST leave with it returned 200 and removed the replacement member and both B bindings. The merge collision predates the branch (it reproduces on d66e805). `bindAgent` now keeps exactly one binding per (conversation, name), the one the join wrote with the new id and the terminal that won, and retires every other binding of the name in that conversation. A retired id resolves nothing: 403 on read and send, 404 on leave.
- **A departure acts only on the current member.** Before the REST leave or `chat_leave` removes anything, `departureIsCurrent` checks that the registration is the room's current member of that name (the member's id equals the binding's, and equals the id the caller named, if any). Otherwise the REST leave answers 404 and `chat_leave` says the registration was superseded, and nothing is removed. A binding whose member is already gone may still be cleaned up when no id is named.
- 2 tests in `tests/wezterm-submit-gate5.test.ts`, both failing on 8d353f6: the Twin sequence against the real server (the superseded id: 403 on read and send, 404 on leave; the replacement member and its id intact; an unrelated room C untouched; the current id then leaves exactly B), and the same sequence through the MCP callbacks. Suite 332.

### Verified (real agents, test server from this build on port 4299, own data dir; the live 4200 untouched)

| host | agent | GUI instance | route logged | reply |
|---|---|---|---|---|
| WezTerm | Claude Code | 72304 | `Injecting into Agent-wezterm (pid:72936\|pane:0)`, `[inject:wezterm] pane=0 len=325` | 23.9 s |
| WezTerm | Codex 0.154 | 76296 | `Injecting into Agent-codex-wezterm (pid:69772\|pane:0)`, `[inject:wezterm] pane=0 len=343 doubleEnter=true` | 38.1 s |

Before this build both rows typed the prompt and never submitted it.

### Known limits
- **A console that no agent reads.** A pid whose console is read by something other than an agent (a sleeping shell, a WMI-spawned process) takes the wake silently. The server cannot know who reads a console, and nothing confirms that a turn started. In the end-to-end run such a registration was typed into with no warning and no reply.
- **A registration id is a bearer credential, not authentication.** Whoever holds a name and its id can read that registration's messages (DMs included) over REST and MCP, and an MCP session that names it adopts it. The join reply is the only place the server shows it (never in messages, system lines, wake prompts, member events or `/api/who`), so an agent that echoes its join reply into a room exposes it. Name-only access with a single binding also remains possible, as before. The ids are routing identity, not an authenticated boundary.
- **A pane whose GUI cannot be determined is not bound** (a join from a host that cannot enumerate processes, a mux-server pane, a join with no pid). Mentions to such an agent go by console injection or its own listen loop.

### Tests
- 19 in `tests/wezterm-instances.test.ts`, all failing on d66e805:
  - the submit sequence for the default and Codex plans, and the guard before the first Enter;
  - socket choice with a dead leftover sorting last, an older live GUI, no live GUI, and the environment override;
  - a GUI's own socket;
  - a two-GUI process tree, with the field case bound in the agent's instance, a pane live only in the other instance, the other-instance note, an agent in the server's instance, and no auto-detection across instances;
  - carrying `weztermGui` on the agent;
  - a live socket whose time cannot be read, and socket existence by listing;
  - the room waking through the agent's socket;
  - the probe environment, and a source guard that every `list` call uses it.
- The fake-spawn expectations in `submit-plan`, `inject-fixes-gate1` and `delivered-abort-room` now follow the new call sequence (text, then each Enter alone). Suite 293.

## 2026-09-24: Submit Fixes From the Injection Matrix

The injection matrix (`tools/inject-matrix` on `feat/inject-matrix`) typed one prompt, `reply with exactly the word PONG and nothing else`, through every wake route into a real Claude Code 2.1.28x and a real Codex CLI 0.154.0, and read the screen back. Two routes delivered every byte and still never submitted, while the injector reported success.

| route | Claude Code, before | Codex, before |
|---|---|---|
| console injector | submitted | never: prompt left in the input box; a second Enter submitted it |
| `injectWezTerm` (line feed) | never: prompt left in the input box | never |
| same call, carriage return | submitted, 6.3 s | never with one Enter |
| `orca terminal send --enter` | submitted | submitted, 25 s |

A raw key reader showed why the WezTerm route failed: it delivered U+000A, where every other route delivers U+000D. The Codex failures came from a name test: the double Enter fired only for a process named `codex.exe`, and an npm install of Codex runs as `node.exe` with `codex.js` on its command line.

### Fixed
- `injectWezTerm` ends the text with a carriage return instead of a line feed, and keeps `--no-paste`. The code comment carries the measurement.
- New `src/target.ts`: the target is classified by its command line (CIM `Win32_Process.CommandLine` on Windows, `ps -o args=` on Unix), not its name. Codex is `codex.exe`, or a runtime such as node running `codex.js`, `@openai/codex` or a `codex-cli` checkout. Copilot is `copilot(.exe)`, `@github/copilot`, a `copilot-cli` path or `gh copilot`. Only the executable and the script it runs count, so `claude.exe --resume codex-notes` stays Claude. The result is a `SubmitPlan` (`doubleEnter`, `delayMs`): 300 ms and a second Enter for Codex and Copilot, 50 ms and one Enter otherwise.
- The plan is worked out at most once per wake, only when a backend that presses Enter itself needs it, and shared between WezTerm and its console fallback. The console backend applied it before; WezTerm now sends a second carriage return `delayMs` later in its own `send-text` call, and tmux sends a second `Enter`. Orca gets no extra Enter: `orca terminal send --enter` submitted to Codex in one go, because Orca presses Enter separately from the text.
- The lookup never holds up a wake. It has a 4 second timeout, and concurrent wakes share the lookup in flight. A failed or empty lookup is the single-Enter default. (It was first cached per pid for 60 seconds; gate round 1 removed the cache, below.) `InjectBackends.classify` lets tests pass a fixed plan.

- Codex gate round 1 (5 Medium, 1 Low, all closed):
  - The guard is re-asked after the classification await, before WezTerm types, so a target that left, moved or needs more locks during the lookup gets nothing.
  - The delayed second Enter re-asks the guard immediately before it is sent, in WezTerm (`injectWezTerm` takes the guard in its options) and tmux alike.
  - Once the text is in the terminal, a failed second Enter is recovered by sending the Enter alone once more, under the guard. If that fails too, `PartialDeliveryError` (phase `text-delivered`) is raised. `inject()` never answers it with a full-payload console fallback, the coordinator classifies it as `partial` and never retries it, and the room says "Could not submit the prompt to X; the text is in their input box." on every occurrence. The same holds for tmux.
  - A reused pid can no longer inherit an old plan: the per-pid cache is gone and every wake reads the process it is about to type into (one bounded lookup, the console path's cost before this branch). The start time that would tell incarnations apart costs the same call as the command line, and the agent registration does not carry it. Wakes that overlap on one pid share the read in flight, and a guard saying the target left or moved drops that read.
  - Runtime options with a separate value (`--require`/`-r`, `--import`, `--loader`, `--experimental-loader`, `-C` and the rest of node's list, case-sensitive) are skipped before the entry script is chosen. An inline `-e`/`--eval`/`-p`/`--print` program has no entry script, `--` ends the options, and `bun run` and `deno run` step over the subcommand. (Superseded in round 7: no argv parsing.)
  - Application identity beats folder names. The last `node_modules/<package>` in the path decides first (`@openai/codex`, `@github/copilot`, `@anthropic-ai/claude-code`), then the entry point's own name, and only for a generic entry (`cli.js`, `index.js`) the application root below the build folders. Folders above that root are never read, so Claude inside a `codex-cli` checkout stays Claude. (Superseded in round 7: no argv parsing.)

- tmux pane discovery split `list-panes` and `pgrep` output on the two characters backslash and n instead of a newline, so on a host with more than one pane the whole listing was one line and only a pid on the first line could ever be found. Both splits use a real newline now.

- Codex gate round 2 (1 Medium): a guard abort after the text reached the terminal lost that fact, so the room's "moved" re-queue typed the whole prompt a second time into the same pane. Round 2 answered with an Enter-only resume; round 3 found three holes in it and it was replaced, below.
- Codex gate round 3 (3 Medium, closed by a change of design): the Enter-only resume released its coordinator slot before resuming, so another wake could type and submit into the pane in between (A text, B text, B Enter, A Enter). It rebuilt its route from the registration, so it could send the Enter through WezTerm when tmux had delivered the text. And it judged "same terminal" by direct overlap while the locks follow transitive equivalence. The resume is gone (no submitOnly mode, no re-queue, no delivered flag through the room), replaced by finish in place:
  - Before any text is typed, the guard is unchanged: the agent leaving, its identity changing, and its lock set growing all abort with nothing typed.
  - Once the text is in, the same attempt sends the delayed second Enter and its one recovery over the route that typed it, still holding every lock it took. `inject()` asks the new `afterTextGuard` there (falling back to `fallbackGuard` for callers that give none). The room's version stops only when the agent left (the log says unsent text remains in that terminal) or its terminal identity changed. It ignores lock growth on purpose: the attempt still holds its locks, so no other wake of ours can type into that terminal until it releases, and a half-typed prompt is the worse outcome.
  - An identity change after the text is judged with the lock equivalence (`sameTerminal`: the delivered terminal's held lock set, or `lockKeysFor` through the live registrations now). The same terminal gets the partial-delivery line and no replay. A different terminal keeps its unsent text (logged) and the new one gets a fresh wake after this attempt releases.
  - `PartialDeliveryError` and the `partial` kind remain for a recovery Enter that fails.
- Codex gate round 4 (1 Medium, closed): `sameTerminal` checked the live agent's keys against the held locks and the delivered agent's keys against the current closure, and missed a terminal linked only through a key the attempt holds. The sequence: A pane-only at pane 7; a bridge with pid 100, pane 7 and handle H; during A's delay the bridge leaves and rejoins as pid 200 with H, and A rejoins pid-only at 200. The room called that a different terminal and replayed the prompt through pid 200. Now the rule is one intersection: the current closure of the live registration (`lockKeysFor`) against the complete lock set the attempt holds. Both old checks are special cases of it, and genuinely disjoint terminals still get a fresh wake.

### Verified after the fix (real agents, same harness, fresh session per route)

| route | agent | submitted | reply |
|---|---|---|---|
| `injectWezTerm` | Claude Code 2.1.282 | yes | 4.9 s |
| `injectWezTerm` | Codex CLI 0.154.0 (npm, node.exe) | yes, classified `codex`, no console fallback | 18.6 s |
| console injector, conhost | Codex CLI 0.154.0 (npm, node.exe) | yes | 24.8 s |

### Tests
- 30 in `tests/submit-plan.test.ts`: classification of the native Codex build, the npm Codex under node (the field command line), `@openai/codex` on Unix, a `codex-cli` checkout, Copilot in four forms, and six negatives including Claude resuming a session named after Codex; the 60 second cache, a shared lookup in flight, failures neither cached nor fatal, no lookup without a pid; the WezTerm terminator and argv (`--no-auto-start`, `--no-paste`) and the Codex sequence (text and CR, the delay, a lone CR) with a fake spawn, and no second Enter after a failed first send; one lookup per wake shared with the console fallback, the plan reaching WezTerm, the Windows console and tmux, no lookup on the Orca path, and a throwing classifier giving a single-Enter wake.
- `tests/wake-fallback.test.ts` and `tests/orca-wake-room.test.ts` pass a fixed plan: the Linux console path now looks up the command line too, and these tests settle on microtasks alone. Suite 211. Gate round 1 added 34 in `tests/inject-fixes-gate1.test.ts` (27 of them fail on 92603bb; the other 7 pin cases that were already right) and 1 in `tests/partial-delivery-room.test.ts` (the room types a partially delivered prompt once, never through the console or a retry, and says so). The per-pid cache test now asserts a read on every wake. Suite 245. The tmux split fix adds 2 (a two-pane host: a pane on the second line, and a pane found through the second of two child pids), both failing before it. Suite 247. Gate round 3 rewrote `tests/delivered-abort-room.test.ts` to 7 room-level cases on the real room, coordinator and injectors:
  - lock growth after the text: the text, then its Enter, nothing in between;
  - A and B on one pane, with B mentioned during A's delay: A, A's Enter, B, B's Enter (the gate's interleave, reproduced on 1190a63 as A, B, Enter, Enter);
  - a direct and a transitive same-terminal rejoin: a warning and no replay;
  - a move to a disjoint terminal;
  - a departure;
  - tmux delivering after a WezTerm failure: the Enter goes through tmux.

  In `tests/inject-fixes-gate1.test.ts`, the 7 round-2 tests of the delivered flag and Enter-only mode are deleted and 4 finish-in-place tests take their place. Suite 258. Gate round 4 adds the bridge departure-and-rejoin sequence as an eighth room-level case (one prompt, no Enter, the partial line), failing on 1f1a070. Suite 259.
- Codex gate rounds 5, 6 and 7: argv parsing abandoned. Finding a runtime's entry script means knowing every Node option that takes a separate value. Round 5 added the missing ones, round 6 added a bare-value rule, underscore spellings and Windows separators, and round 7 still found `--experimental-config-file ./node.config.json` swallowed as the entry. The bare-value heuristic also scanned into application arguments, so `node --trace-warnings server codex.js` read as Codex. The identity rule now reads no argv structure at all. (1) The executable's own name (codex, codex-cli, copilot, copilot-*, claude, claude-code, `.exe` stripped) decides, and its arguments are never read: `claude.exe --resume codex-notes` is Claude. (2) `gh copilot` is Copilot. (3) For a runtime (node, bun, deno, tsx, ts-node) the first argument, left to right, whose path contains `node_modules/<known package>` decides (`@openai/codex`, `@github/copilot`, `@githubnext/github-copilot-cli`, `@anthropic-ai/claude-code`), in either separator form. (4) Anything else is the default plan: when the command line is ambiguous, no guess. Deleted: `entryScript`, `OPTIONS_WITH_VALUE`, `INLINE_PROGRAM`, `RUN_SUBCOMMAND_RUNTIMES`, `looksLikeScript`, `normalizeOption`, `GENERIC_ENTRIES`, `LAYOUT_DIRS` and their tests. Known losses, accepted: a Codex source checkout run as `node codex-cli/dist/cli.js` has no package path and gets the single-Enter default; and an absurd `node --require /x/node_modules/@openai/codex/y.js app.js` classifies as Codex because the package path is present. The finding-5 and finding-6 test blocks are replaced by one application-identity block of 22 cases, including every option-before-path form the rounds found and both documented losses. Two `submit-plan` cases that relied on entry-script detection (`node codex.js`, a `codex-cli` checkout) are deleted. The per-wake read test's fixture gains its `node_modules` segment.
- Codex gate round 8 (1 Medium, closed): scanning every argument for a package path lost Unix bin links and found one where there was none. `node /usr/local/bin/copilot`, a bun global bin link and `node_modules/.bin/copilot` got the default plan, while `node /usr/local/bin/claude --add-dir /project/node_modules/@openai/codex` read as Codex. The rules are still name and path only, with no argv parsing:
  - For a runtime whose first argument is a script (it does not start with `-`), that argument alone decides: its own name if it is a known application name, else a known package in its path. If neither matches, the lookup resolves it once with `fs.promises.realpath` (a global bin symlink lands in `node_modules/<package>/bin/...`) and checks the resolved path the same way. Otherwise it is the default plan, and later arguments are never read.
  - The realpath step runs only inside the bounded per-wake lookup, under the same 4 second budget as reading the command line, and only for absolute paths (a relative script is relative to the target's working directory, not ours). Errors and timeouts give the default plan. `classifyCommandLine` stays pure; `classifyCommandLineResolved` adds the resolution, and `classifyTarget` uses it.
  - When the first argument is an option, the round-7 package-path scan over all arguments remains as the weaker fallback, so `node --require x .../@openai/codex/bin/codex.js` is still Codex and `node --trace-warnings server codex.js` is not.
  - Bun and Deno step over a leading `run` subcommand.
  - 14 new tests: the three link shapes by name, the false positive and `node /usr/local/bin/claude` as default, three symlink shapes through a fake realpath, an unresolvable script, a realpath past its deadline, no realpath for relative scripts, already identified scripts or options-first lines, the per-wake lookup resolving, and one real symlink in a temp tree (skipped where creating symlinks needs privilege; it ran here). Suite 274.

## 2026-09-24: Orca Wake-Ups

Agents living in Orca terminals could not be woken: Orca's terminals are not WezTerm panes, and console injection into their pid does not reach Orca's input. Orca gives every shell `ORCA_TERMINAL_HANDLE=term_<uuid>` and a CLI that types into a live terminal by handle, so the handle now travels with the join exactly as the WezTerm pane does, under the same honesty rules.

### Added
- `orcaTerminal` on the agent, on `chat_join`, on `POST /api/agent/join` and `POST /api/join`, echoed in the join replies (`orcaNote` in REST, a note line in the MCP text when it is dropped), carried by manager bindings and renames. A handle binds, null clears, undefined keeps, in `ChatRoom.join` and `bindAgent` alike.
- `resolveOrcaForJoin` (tools.ts): a handle is bound only when `orca terminal list --json` shows it connected and writable and, when the join carries a pid, that pid has Orca among its ancestors on this host. Unknown ancestry keeps the handle with a log line; anything else drops it with a log line and a note, and the join still succeeds on the pid. No auto-detection (Orca's listing has no pid): a join without a handle gets none, and a rejoin without one clears a handle the name held, unless ancestry is unknown. Malformed values (anything but `term_<id>`, so never a flag) are never handed to the CLI. The listing is cached for 3 seconds and times out after 5.
- `src/orca.ts`: `resolveOrcaCli` (ORCA_CLI, then the per-user install's native `orca.exe`, then `orca` on PATH), `runOrca` (the one place an Orca process starts: argv only, no shell), `listOrcaTerminals`, `injectOrca`. The batch shim `orca.cmd` is never run: cmd.exe re-parses its arguments and a wake prompt carries `&`, `|` and quotes (Orca's own shim refuses message bodies for the same reason); an ORCA_CLI pointing at it is swapped for the `orca.exe` beside it, or refused.
- `inject()` tries Orca first when the agent has a handle (before WezTerm and the console), with a 15 second timeout. On failure with a pid it falls back to the console through the same `fallbackGuard` as WezTerm (`WakeFallbackAborted` preserved, the guard re-asked right before typing), and the Orca error stays the reported one when the fallback fails too. `InjectBackends.orca` lets tests pass a fake.
- `hasAncestor(pid, tree, regex)` in terminals.ts is the one process-tree walk; `isInsideWezTermTree` and the new `isInsideOrcaTree` are thin wrappers, so the recycled-pid rule and the unknown tri-state hold for both. `processTreeOnce()` lets a join's WezTerm and Orca checks share one process enumeration (never cached across joins).

### Fixed
- Terminal identity and locks include `orca:<handle>` (`terminalKeys`, `terminalIdentity`, `lockKeysFor`, the manager's join aliases and merge target), so injections into one Orca terminal never overlap whichever room asks, a changed handle is a new session for the warn record, and a newer join sharing only the handle supersedes an older pending one.
- Failure classification knows Orca's wording: an unknown or closed handle (`terminal_handle_stale`, `terminal_not_writable`, both observed live) and a missing CLI are permanent (no retry, one warning per session); `runtime_unavailable` (Orca not running, nothing was sent) and transport errors are transient. An ambiguous transport failure that reports a retry-request id is re-issued once with that id, which Orca binds to the payload and terminal incarnation. The room's warning for a dead handle says the Orca terminal is unreachable instead of blaming the console.
- Ancestry no longer reads "unknown" for every Windows process (applies to WezTerm and Orca alike, through `hasAncestor`). On Windows every chain ends with a missing parent (userinit exits after starting explorer.exe; smss after wininit.exe), so a pid provably outside any terminal kept a wrong pane or handle with a note. Now, when the walk reaches a process whose parent is missing (or cannot be ordered by start time), the answer is false if that process is a session or system root (ppid 0, pid 4 or 1, or explorer, wininit, winlogon, services, smss, csrss, lsass, svchost, WmiPrvSE, taskhostw, RuntimeBroker, sihost, userinit, dwm, launchd, systemd, init; basename, case-insensitive) and "unknown" only otherwise (an exited wrapper mid-chain). Reaching WezTerm or Orca still returns true, and the recycled-pid rule stands. Checked live on this host: services.exe, explorer.exe, WmiPrvSE.exe, OneDrive.exe and WindowsTerminal.exe (svchost, services, wininit) now read false; a node process in an Orca shell reads true.
- Codex gate round 1 (3 findings, all closed): a rejoin without a handle now checks ancestry whenever any room registration of the name still holds one, not only a manager binding (a binding that moved to another room left the old room's handle behind, and a later rejoin from a new pid kept it); Orca's internal retry with its retry-request id first re-asks the room's guard (membership, identity, lock expansion) and stops with `WakeFallbackAborted` like the console fallback, since that retry can deliver input the first request never did; and callbacks route by handle: `getAgentBinding` matches `orcaTerminal` before pid and pane, every agent route that looks up a binding accepts `orcaTerminal` (query or body), and the wake prompt adds `&orcaTerminal=<handle>` to the read URL and `"orcaTerminal"` to the reply body, so two handle-only terminals sharing a name in different rooms both get their callbacks answered. Pid handling is unchanged for everyone else.

### Tests
- 31 in `tests/orca-honesty.test.ts` (handle resolution accepted, dropped for not live, not writable, no Orca, pid outside Orca, malformed and non-string values, unknown ancestry kept with a note, the no-handle rules; Orca ancestry through `hasAncestor` with the field chain, recycled pids, broken chains and macOS paths; `orca:<handle>` in keys, locks, aliases and freshness; null clears and undefined keeps in room and manager; Orca preferred over WezTerm, console fallback through the guard, abort, error precedence; the observed envelopes, retry-request re-issue, argv without a shell, listing cache, CLI resolution; a source guard that only `src/orca.ts` starts Orca, once, through `resolveOrcaCli`) plus 3 in `tests/orca-wake-room.test.ts` (the room wakes through Orca, falls back to the pid on a stale handle without warning, and warns once for an Orca-only agent). Six of the 31 cover the root rule: the WMI chain and the Windows Terminal chain are false, a pwsh whose parent wrapper exited is unknown, the Orca chain is true, a launchd-rooted macOS chain is false, a root with an undated parent is still a root, and both resolvers now drop a requested handle or pane from the WMI and Windows Terminal chains. Suite 173. Gate round 1 added 8 more, each failing on the previous commit and passing now: 7 in `tests/orca-gate1.test.ts` (the moved-binding rejoin, room registrations counted as holding a handle, the retry stopped for a target that left or moved and allowed for the same session, handle-first binding lookup with pid lookup unchanged, every agent route passing the handle) and 1 in `tests/orca-wake-room.test.ts` (the prompt names the handle). Suite 181.
- Verified live against Orca 1.4.209 in a scratch terminal: a REST join bound the handle for a pid inside Orca and dropped it for a pid absent from the host; a mention was typed and submitted through `orca terminal send`; after `orca terminal close` the next mention failed with `terminal_not_writable`, fell back to the pid, and the room got one warning.

## 2026-09-24: Injection Matrix, Keys and Agent Modes

Line mode only proved that a whole line reaches a `ReadLine`. Claude Code and Codex are raw-mode TUIs, so the question that matters for a wake-up is whether the prompt SUBMITS. Two new modes answer that, and both found real defects. Full tables in `tools/inject-matrix/README.md`.

### Added
- `-Mode keys`: `rawkey.py` reads one `msvcrt.getwch` at a time and logs every code point, so each route's terminator is evidence rather than inference.
- `-Mode agent`: a real Claude Code or Codex CLI runs in each host, in a scratch folder with no project of its own, and the probe types `reply with exactly the word PONG and nothing else` through every route that applies. Submission and reply are recorded separately, and a route that did not submit gets one extra Enter to tell "arrived but unsubmitted" from "never arrived". Each route runs in a fresh session.
- `read-screen.py` attaches to a process's console and reads the visible screen, so one reader covers hosts with no screen-reading CLI. `send-key.py` writes single key events for probe setup and teardown only, never as a route under test.
- Warp now runs the same payloads as every other host: the launch script is typed into a new tab with the console route, and the payload reports its own pid.

### Findings
- Every route delivers a carriage return except `injectWezTerm`, which ends its text with a line feed. Against a real Claude Code the prompt arrived in full and stayed in the input box; one Enter afterwards submitted it, and the same text ending in a carriage return submitted in 6.3 s. The call does not throw, so `inject()` never falls back to the console path and the wake is lost silently.
- One Enter never submitted to the Codex TUI, on any host or route. `inject.ts` sets `doubleEnter` only when the process is named `codex.exe`, and an npm-installed Codex runs as `node.exe` running `codex.js`, so the check never matches. Only routes that press Enter separately from the text got through: `orca terminal send --enter` and `wmux send-key Enter`.
- A freshly started Claude Code shows its status bar while SessionStart hooks are still running. A prompt typed in that window sat unsubmitted past 150 s and a direct Enter did not rescue it. A wake sent to an agent that has just started can fail while every route reports success.
- `orca terminal send` reports `provider: claude|codex` and `observation: supported` once a real agent is in the terminal, but still warns "no turn start was observed" on runs where the agent answered. It is unconfirmed, not failed. `wmux send --submit` retries Enter only when it sees no receipt; with Claude Code it saw `composer_cleared` or `turn_start` and did not retry.

## 2026-09-24: Injection Matrix Harness

A repeatable probe, `tools/inject-matrix/`, that shows with evidence which terminal hosts on a Windows machine the wake-up injector can type into. It drives the real `dist/inject.js`, and a marker only counts as landed when the receiver logs it. See `tools/inject-matrix/README.md` for how to run it and for the full matrix.

### Added
- `receiver.ps1`: a line receiver run inside each host. It writes its pid and terminal variables, logs each console line with a timestamp, and exits on `QUIT`, on a quit file or after a time limit, so no shell is left behind.
- `inject-once.mjs`: one call to `inject()`, reported as JSON. Whether the injector resolved is kept separate from whether the text arrived.
- `matrix.ps1`: launches conhost, Windows Terminal (pwsh 7 and PowerShell 5), WezTerm, Orca, wmux and Warp. It records each receiver's parent chain and console servers, injects with retries plus one warm attempt, and tests each host's own input route (WezTerm backend, `orca terminal send`, `wmux send`). It then cleans up and checks for strays. Results go to the gitignored `results/`.

### Findings (Windows 11 10.0.26200, not elevated)
- The console backend landed on the first attempt in all seven hosts, ConPTY ones included, in about one second. The time is mostly the process-name lookup and Python startup. Warp was slowest: 8.6 s into a fresh tab, 2.2 s warm.
- The WezTerm backend reports success, but a line-mode reader never receives the text. It ends with LF, which does not submit under ConPTY, and a later CR does. Because the call does not throw, `inject()` does not fall back to the console path. This was not checked against raw-mode agent TUIs.
- `orca terminal send` delivers but, for a plain shell, reports only `input_accepted` with provider `unsupported`. `wmux send --submit` delivers, finds no receipt signal, retries Enter and so sends one extra blank line.
- Warp has a hidden `warp.exe --warpctrl` local-control CLI. It is off by default, and its `input insert` does not submit.

## 2026-09-24: WezTerm Honesty

From the first live wakes after the Honest Wake-Ups deploy: an agent started outside any terminal (WMI-spawned, no console) joined with WezTerm pane 0, which was someone else's shell; every mention was typed at the wrong pane and the honest failure line blamed a transient error. Underneath it, a process leak: every `wezterm cli` call ran without `--no-auto-start`, so whenever no GUI socket answered it spawned a headless mux server, one per call, forever (579 orphans on one host after three days of joins and 30-second checks).

### Fixed
- Every `wezterm cli` invocation carries `--no-auto-start` (list, send-text, set-tab-title); only the deliberate `spawn` used for launches may start WezTerm. A source-level test keeps it that way.
- A WezTerm pane is bound to an agent only when it is live in the reachable WezTerm and, when the join carries a pid, that pid runs inside WezTerm on this host (`resolvePaneForJoin`, shared by `chat_join` and `POST /api/agent/join`; `isInsideWezTerm` walks the process tree). A pane that fails the checks is dropped with a log line, a `paneNote` in the REST response and a note in the MCP join text; the join still succeeds on the pid. Auto-detection no longer assigns a pane to a pid that provably runs elsewhere.
- `inject()` falls back to console injection when the WezTerm path fails and a real pid is known, instead of giving up on a stale pane.
- Codex gate round 1 (4 findings, all closed): a rejected pane now clears the old one in both stores (`ChatRoom.join` and `bindAgent` take null as "clear", undefined as "keep"); WezTerm is matched by executable basename so macOS full paths count; when the console fallback fails too, the WezTerm error stays the reported one so a transient socket failure is still retried; the ancestry walk carries start times (wmic CreationDate, ps etimes) and refuses a parent that started after its child (recycled pid). Process enumeration that is unavailable reads as "unknown" (a requested live pane is kept with a note, nothing is auto-detected), not as "elsewhere". The UI invite route `POST /api/join` runs the same resolver.
- Codex gate round 2 (4 findings, all closed): the Unix enumeration uses `ps etime` (portable; `etimes` is Linux-only and broke macOS); the UI invite route captures its conversation before awaiting pane resolution and revalidates it after, so membership and routing cannot split across rooms; Windows enumeration comes from CIM through PowerShell (`pid|ppid|startMs|name`, name last so separators in names are safe): wmic is absent on current Windows builds, on every host seen, which also means the old wmic-based terminal scan has been failing silently there; start-time ordering is precision-aware (a parent later than its child by at least the clock's resolution is recycled, a smaller gap or a missing time is "unknown"), and "unknown" flows through to the resolver instead of a silent yes.
- Codex gate round 3 (2 findings, closed): the UI invite route answers 400 when no conversation is active instead of leaving the request hanging; an exited intermediary in the process chain reads as "unknown", not as proof that the process is outside WezTerm (only an absent joining pid is "false").
- Codex gate round 4 (1 finding, closed): the console fallback no longer types into a pid captured before the WezTerm attempt; `inject()` asks the caller's guard first and the room re-checks membership and terminal identity, so a target that left is skipped and one that rejoined from a new session is re-queued for that session (`WakeFallbackAborted`). Two room-level tests drive the real `inject()` with fake backends through both transitions.
- Codex gate round 5 (1 finding, closed): `chat_join` and `POST /api/agent/join` re-fetch the room after the pane check, so a conversation deleted during it is reported as not found rather than resurrected through its destroyed room (the UI invite route already did this).
- Codex gate round 6 (1 finding, closed): the guard is re-asked immediately before the console backend types, after the Windows process-name lookup, on the fallback path and on the direct console path alike, and `WakeFallbackAborted` passes through the both-failed handler untouched. The process-name lookup itself now uses CIM through PowerShell (it was on wmic too, so the Codex and Copilot double-Enter detection had been silently off on current Windows builds).
- Codex gate round 7 (2 findings, closed): the guard travels into the Unix backend and is re-asked after tmux discovery, before send-keys, with `WakeFallbackAborted` passing through its error wrapper; and every join that awaits pane validation takes a join generation from the room first (`beginJoin`) and is refused after the await if a newer join or a departure for the same name happened meanwhile (`joinIsCurrent`; MCP text, HTTP 409), so an older pending join can no longer overwrite the live session.
- Codex gate round 8 (2 findings, closed): join generations moved from the room to the manager, keyed by name and terminal (`pid:N`, else `pane:N`), so a newer join for the same terminal into another room supersedes an older pending one while other terminals of the same name stay independent; every leave path (`chat_leave`, `POST /api/agent/leave`, `POST /api/leave`, and any room-level departure through the room event) supersedes pending joins for the name even before a first binding exists.
- Codex gate round 9 (1 finding, closed): a waited join now holds two freshness records and both must be current when it lands: name plus terminal across rooms, and room plus name across terminals, so a newer join for the same name into the same room from another terminal supersedes it as well; different terminals in different rooms stay independent.
- Codex gate round 10 (1 finding, closed): the join token carries a generation for every terminal alias the join has (pid and pane, matching how bindings merge), so a newer join sharing only the pane, with a different or no pid, supersedes the older one too.
- Codex gate round 11 (1 finding, closed): the token's aliases are the effective ones, the request's plus those an existing binding for the name would keep through the merge (`effectiveJoinAliases`), so a newer join that inherits a pane through its binding still supersedes an older pane-only join.
- Codex gate round 12 (1 finding, closed): the effective aliases mirror both branches of the binding merge, the pid-or-pane match and the same-conversation fallback, through one shared selector, so a newer join that inherits a pane through its room's existing entry supersedes an older pane-only join elsewhere.
- Codex gate round 13 (1 finding, closed): join freshness is now one global order. Every join takes a sequence number when it begins; aliases (pid, pane) and rooms remember the newest join that touched them; a join applies only if nothing newer touched any alias it ends up holding, including a pane discovered during validation and aliases kept through the binding merge, or its room, and a departure outranks every join begun before it. A late discovery is judged by the join's original position, so it never promotes an older request over a newer one.
- Codex gate round 14 (2 findings, closed): a rename retires the old name for joins still validating (the manager supersedes them on the room's rename event), and the console-fallback guard repeats the lock-expansion check, so a wake whose terminal became linked to another in-flight wake re-queues instead of typing concurrently.
- Codex gate round 15 (1 finding, closed): a rename also claims the destination name, so an older join for that name still validating cannot overwrite the renamed session.
- Tests: 19 in `tests/wezterm-honesty.test.ts` plus 3 in `tests/wake-fallback.test.ts` (pane resolution incl. unknown ancestry, rejoin clearing through room and manager, process-tree check with the field case, macOS paths, pid reuse, CIM dates, fallback and its error precedence, precision-aware ordering, etime and process-table parsing, the fallback guard at every checkpoint including tmux discovery, join generations, the no-auto-start guard). Suite 138.

## 2026-09-23: Honest Wake-Ups

Diagnosed from the Y530 server log: a local Claude Code session missed about one mention in five (32 of 171 injections failed, mostly AttachConsole access-denied while injections overlapped), a remote one missed every mention (81 of 81, no console for a foreign pid), and none of it was visible in the room. The injected prompt also told woken agents to call back on 127.0.0.1, which a tailnet-bound server does not even listen on.

### Added
- `src/wake.ts` `WakeCoordinator`: injections are serialized per terminal (`pid:N` or `pane:N`, whichever room asks, so two rooms mentioning one session never overlap), retried once after 400ms on a transient failure, classified (no reachable console vs transient, including the Unix "not found in any tmux pane" case), and warned about with rate limits keyed per room and agent (permanent causes once per session; transient ones at most every 10 minutes). The warn record is reset on every new session: fresh join, rejoin with a new pid, or departure.
- A queued wake resolves its target when it runs, not when it was queued: an agent that left meanwhile is skipped, one that rejoined from a new terminal is re-queued under that terminal, and the prompt always names the pid it is injected into. Mentions that land while a wake is executing coalesce into exactly one follow-up wake (the prompt reads from the agent's cursor, so one wake covers everything that arrived).
- When a wake finally fails the room gets a system line ("Could not wake X: no console reachable from this server..." or "...terminal injection failed after a retry"), so an unlanded mention is visible instead of silent.
- Proof-of-life on the presence pill: agents carry `lastPostAt`; the pill shows "silent <age>" after 30 quiet minutes, or "no posts <age>" measured from the join for an agent that has never posted, and the tooltip carries both the seen and last-posted ages. Ages are measured against the server clock (`init` now carries `serverNow`), clamped at zero, re-rendered every minute, and kept live between join events: message and typing events refresh the cached timestamps, and a heartbeat emits a `presence` room event with the agent's `lastSeen` and `lastPostAt`. Cache-bust v=18.
- A queued wake rechecks terminal equivalence when its turn comes (Codex gate round 5): if the terminal now needs keys the wake does not hold (a registration pairing its pid with a pane came back while it waited), it queues again under the full set instead of injecting. `tests/wake-room.test.ts` drives this through the room with a mocked injector and asserts one injection at a time (2 tests).
- Terminal equivalence from live registrations (Codex gate round 4): the keys a wake holds are its target's own plus those of every live registration in any room reachable through a shared key (transitively), so a pid-only and a pane-only registration of one process lock together as long as some registration pairs them, and the knowledge leaves with that registration. Each retry is judged by the session current when the retry starts. A pane replaced by another pane (pane-only agents) is a new session like a pid change; a pane learned for the first time is not. `rename()` reclaims the old warn record and starts the new name clean.
- Terminal locking without an alias map (Codex gate round 3): a wake holds every identity known for its target (`pid:N` and, when known, `pane:N`) and queues behind any in-flight wake sharing one of them, so a pid-only registration in one room and a pid-plus-pane registration in another can never overlap, whichever was learned first. Session identity is the composite of pid and pane: adding a pane, changing it, or changing the pid all reset the warn record. The warn generation is read when an attempt starts, not when it was queued, so a target resolved at execution time is judged by its own session. `release()` (on leave and destroy) reclaims the per-room warn records once any executing attempt drains; nothing accumulates per pid.
- Session and teardown discipline (Codex gate round 2): a rejoin from a new pid resets the agent's `joinedAt` and `lastPostAt` (the old worker's proof of life does not carry over) and any change of terminal identity (pid or pane) resets the warn record; a warn record reset while an attempt is still running marks that attempt's failure stale (never announced, never suppressing the new session's first warning); a process seen with a WezTerm pane in any room shares that pane's lock even where it registered pid-only; `destroy()` drops every agent and clears the coalescing state, so nothing queued or in flight can inject, warn or re-queue after a room is deleted.
- Tests: 21 in `tests/wake.test.ts` (classification, base URL, serialization by terminal, skip and moved results, retry and attempt accounting, warn-once per room until forget, transient rate limit, presence event and lastPostAt on the room, stale outcomes, proof-of-life reset, shared-key serialization, execution-time generations, release and reclaim, composite identity, live-registration equivalence, per-attempt generations, pane replacement, destroy) plus 2 room-level injector tests. Suite 117.

### Backlog
- Remote wake-ups through Orca (docs/BACKLOG.md): an environment or host selector on the Orca terminal handle, queued behind the local Orca backend. Rami: worth the shot.
- Join-time reachability stamp (docs/BACKLOG.md): probe the pid on the bound host at join and tell the room then, not at the first missed mention. From the first live wake on the Y530 after deploy: the honest line fired correctly, and the target was a stale pid.

### Fixed
- The injected mention prompt now uses the address the server actually binds (`injectBaseUrlFor(host, port)`: wildcard `0.0.0.0` and `::` map to loopback, IPv6 literals are bracketed) instead of a hardcoded `127.0.0.1:4200`.
- Codex gate round 5 (1 finding, closed): queued wakes did not revalidate terminal equivalence before injecting.
- Codex gate round 4 (4 findings, all closed): pid-only and pane-only aliases could inject concurrently; a retry straddling a rejoin discarded a live failure; pane-only replacements inherited the previous session's ages; rename bypassed warn-record reclamation.
- Codex gate round 3 (4 findings, all closed): learning a pane alias could split an active lock; adding a first pane kept the old warn suppression; a replacement session's real failure could be discarded as stale; identity records were never reclaimed.
- Codex gate round 2 (6 findings, all closed): the message-time merge had landed under the join handler (moved to the message handler, ahead of the DM and view early returns); deleted rooms could still inject; stale failures restored warning suppression; pane-only changes did not reset it; replacement sessions inherited the previous worker's ages; pid-only and pane registrations of one process took different locks.
- Codex gate round 1 (10 findings, all closed): stale client-side ages; warnings keyed by name only; queued wakes surviving a departure or pid change; unbounded serialized backlog; no reset after leave; never-posting agents without a chip; tmux pane misclassified as transient; IPv6 hosts producing unusable URLs; browser clock skew; wrong attempt count after a transient-then-permanent failure.

## 2026-09-22: Agent DM Reply over REST

### Added
- `POST /api/agent/send` accepts `to: string[]` (non-empty names, the sender excluded), producing a targeted message with the same DM visibility as `chat_dm`. REST residents (OpenClaw web UI, Codex Desktop, curl loops) could receive a DM through `listen` but had no private reply path, so "DM in, DM out" was impossible and private replies leaked into the room. Found twice within minutes: by the Admiral testing Jadzia's mailbox, and by Curzon reading the source. Response now echoes `to` and `ask`.

### Fixed
- A DM can no longer title a room: conversation auto-naming (which copies the first 60 characters of the first message into a name broadcast to every client) is skipped for targeted sends on both the agent route and the web `/api/send` route. Codex gate finding; the web path had leaked this way since the DM view shipped.

## 2026-09-22: DM Mailboxes Wired

Kimi's DM view (2026-09-16) filtered the ACTIVE conversation only, so the sidebar mailboxes behaved like stubs: the thread changed with the channel, a reply landed in whatever room the human was viewing (often one the recipient never reads), and a DM arriving in a background room was invisible. A mailbox now means one thing: everything between the viewer and one person, across every conversation.

### Added
- `src/dms.ts`: `collectDmThread` (cross-conversation pair thread, per-message visibility, oldest first, capped), `collectDmPartners` (every partner with DM history, newest activity first), `resolveDmTargetConversation` (route a new DM to the partner's bound room, else the pair's last DM room, else the active room).
- `GET /api/dms` (partner summaries) and `GET /api/dms?with=Name` (full thread), web-token gated, viewer always the registered name.
- `POST /api/dm/send` `{to, text}`: sends as the registered viewer into the routed conversation and returns where it landed, so a DM reaches the recipient rather than the room behind the thread.
- Choosing an option on a message that also carries an open ask resolves the ask in the same click (`ChatRoom.chooseMessage`), so a human never rules twice. Prompted by a cpm-engine field report where a first round of decision clicks appeared accepted while the asks stayed open.
- `POST /api/dm/send` also carries `image` and a reply target (`replyTo` + `replyConversationId`, honoured only when the quoted message lives in the routed room, since ids are per room).
- Tests: `tests/dms.test.ts` (7: cross-conversation aggregation, third-party DM exclusion, partner ordering, bound-room routing, fallback chain, outgoing group DMs in every recipient mailbox, choice resolves ask).
- Gate round 1 fixes: every rendered message carries `data-conv`, and choice, reaction, and delete socket updates target conv-qualified elements so a mailbox pane can never be hit by a same-numbered message from another room; hover actions and choice buttons stay hidden in a mailbox pane (they are active-room scoped); the ask chip resolves against the message's own conversation; thread snapshots merge with socket arrivals by (conversation, id) and partner snapshots union with socket discoveries; a mailbox open across a reconnect refetches itself instead of being repainted with the active room; outgoing group DMs update every recipient mailbox live.

### Changed
- The web DM view fetches its thread from the server on open (loading state, empty state, latest-wins guard) instead of filtering the loaded channel.
- DMs involving the viewer are handled BEFORE the active-conversation filter in the WebSocket message path, so a DM from a background room lands in its open thread or bumps its unread badge either way.
- The composer routes through `/api/dm/send` while a mailbox is open; the sidebar partner list comes from the server (reconciled on every socket connect) so offline partners with history still appear. Cache-bust v=16.

## 2026-09-22: Agent Decisions Listing

### Added
- `GET /api/agent/decisions?sender=X&for=Y`: REST agents (tailnet crew without MCP) can now list open asks. Same name-trust model as the other /api/agent/* routes (the sender must have joined), DM visibility applied with the sender as viewer. Found in the field within hours of the asks release: the web variant is token-gated, which locked out REST agents.

## 2026-09-21: Operational Awareness (field-report driven)

Built from a resident agent's field report after ~800 messages of real crew traffic: presence that expired silently during long operations, a server that died without a trace, and human decisions structurally unfindable inside agent chatter.

### Added
- Presence grace window: a silent agent still dims at 2 minutes (stale pill), but an unverifiable-pid agent is only removed after a grace window (default 30 minutes, `--presence-grace <seconds>` / `JOIND_PRESENCE_GRACE`; minimum 120s). Long imports and F9 runs no longer read as "left the chat". Verifiable-alive local pids are never removed, as before.
- `POST /api/agent/heartbeat` `{name, pid?, paneId?}`: a cheap presence keepalive an agent fires between long operations without holding a connection.
- Distinct system lines: a presence timeout now says "lost presence (timed out)", a deliberate leave still says "left the chat", and a same-name rejoin under a new pid announces "rejoined (new session)". The notification bell classifies all three.
- File logging (`src/log.ts`): console output tees to `<dataDir>/logs/joind.log` with timestamps (override `--log-file` / `JOIND_LOG_FILE`, "none" disables; >5MB rotates to `.old`). `uncaughtException` writes the stack and exits 1; `unhandledRejection` and process exit codes are recorded. A crash now leaves a cause behind.
- First-class asks: `chat_send`/`POST /api/send`/`POST /api/agent/send` accept `askFor: <name>`, stamping the message with an open ask. Resolution via `chat_resolve` (agents) or `POST /api/message/:id/resolve` (web token, resolves as the registered viewer), persisted in a `.asks.jsonl` sidecar (latest wins, replayed on load). `GET /api/decisions?state=open` (web) and `chat_decisions` (MCP) list open asks across all conversations, DM visibility applied. An open ask addressed to a human rings the bell as action-required, mention or not.
- UI: an amber `ASK -> name` chip on asked messages (click to resolve, turns green with the resolver's name), a scales button in the header with an open-decisions badge, and a "Decisions waiting on you" panel with per-row Resolve and jump-to-message. Cache-bust v=15.
- Tests: `tests/ops-awareness.test.ts` (8: ask lifecycle, sidecar replay, target filtering, grace-window sweep with fake timers, touch-resets-clock, rejoin announcement, classifier additions).

## 2026-09-17: DM Privacy Hardening (Codex-Gated)

Nine adversarial review rounds (Codex), all findings fixed; final verdict PASS. 78 tests (29 new). Owner scope decision: the pre-existing agent name-based identity model (MCP/REST join/send by claimed name) is the documented trust model and out of scope; a web token separates browser-served clients from arbitrary local processes, scoped per registered viewer.

### Added
- Server-side DM visibility: new `visibleToViewer(msg, viewer)` predicate (src/room.ts), fail-closed (no viewer, no targeted messages), applied to every path that emits message bodies: WS fanout (messages, edits, decision resolutions), init payloads, conversation select, `/api/messages`, `/api/search`, `/api/message/:id` (404 for non-viewers), `/api/pins`. `readAll()` is the explicit unfiltered read, reserved for exports.
- Web token: generated at first boot (or user-set via `JOIND_WEB_TOKEN` / `--web-token`) and injected into the served page; user-set mode skips injection and the UI prompts for it (sessionStorage). WebSocket rejects bad tokens (4401). Token and the registered viewer name persist beside the data dir (`joind-web-token`, `joind-web-name`, gitignored); `/data` now serves only uploaded files.
- Viewer binding: `POST /api/web/register` accepts first-boot or identical-name registration only (409 otherwise); renames go over the authenticated socket (`web-rename` control message), so a token holder cannot impersonate or lock out the human viewer. `GET /` and REST routes use the registered name server-side; a caller-supplied `viewer` is ignored.
- Token gates on DM-capable and mutating web routes: exports (4), conversation list, select, messages, search, message detail, pins, send, edit, choose. Agent REST content routes require an existing binding (agents must join first).
- Tests: `tests/visibility.test.ts`, `tests/web-token.test.ts`, `tests/agent-bindings.test.ts`, plus regression cases in listen and notifications (no DM redelivery, targeted messages never notifiable).

### Fixed
- Targeted messages never enter the notification feed (body text leaked globally, up to 120 chars for decision cards and mentions).
- `chat_listen` high-water mark uses unfiltered `readAll(1)` so a latest-message DM can no longer cause redelivery of consumed DMs.
- Rename flow cannot strand the UI: the socket always reconnects under its last accepted name; renames propagate via `web-rename`.

## 2026-09-16: Slack-Style UI Redesign

### Added
- Direct messages in the web UI: a new "Direct messages" section in the sidebar lists every connected agent (presence dot, colored initial avatar) plus anyone who has exchanged targeted messages with the human. Opening a DM filters the message pane to that thread, the header switches to the agent name, and the composer targets the agent. `POST /api/send` now accepts an optional `to: string[]` and passes it to `room.send` (the room already supported targeted sends via `chat_dm`). Day dividers (Today / Yesterday / date) separate messages by calendar day in both channel and DM views.
- Channel header bar showing the conversation name and member count, fed from the same places that update the sidebar's active-conversation line.

### Changed
- Full look-and-feel pass to a Slack-inspired dark visual language (dark-only, no light theme): workspace-style sidebar with 28px channel/DM rows, unread badges, and active-row highlight; 49px channel header; Slack-style message rows with grouped consecutive messages, hover action bar, and floating day dividers; rounded composer. `style.css` rewritten against the new token block (Slack-dark neutrals, violet accent kept). `index.html` restructured into sidebar + main panes; every element id and inline handler preserved. Cache-bust to v=14.
- Targeted (DM) messages no longer render in the channel view; they live in the DM thread view.

## 2026-09-15: Notification Bell + Mobile Composer

### Added
- Notification bell: a high-signal feed for the human, deliberately limited to seven kinds: crew joined, crew left, action required (a direct @mention of a human name, a decision card, an urgent task, or a task assigned to a human; @all never rings), task picked, task completed, session started, session ended. Server-side classification in `src/notifications.ts` (pure `classifyMessage`, stateful `TaskTracker` for picked/completed transitions, capped `NotificationStore`), wired to room and task events; `GET /api/notifications` and `POST /api/notifications/read`; live `notification` events over WebSocket. UI: bell in the header (always visible, mobile included) with an unread badge, a dropdown panel (icons per kind, conversation chip, click marks read and jumps to the conversation, Mark all read), a sound on action-required, and opt-in browser Notifications for action-required while the tab is in the background. Human names configurable via `--human-names` / `JOIND_HUMAN_NAMES` (default `Admiral,Rami`). 10 new tests. Gate round 1 fixes: tracker snapshots keyed by conversation and task id (per-room id restarts cannot collide), done tasks retained so later edits never re-ring completion, updates with no known history stay silent after a restart, urgent escalation and human reassignment on update ring action-required, tracker state cleared on conversation delete, the UI merges fetch snapshots with WebSocket arrivals by id, mark-all-read uses a captured cutoff, and the bell reconciles on every WebSocket (re)connect, and a per-boot generation stamp in GET /api/notifications makes the client replace (never merge) state across server restarts, since notification ids restart at 1.

### Fixed
- Mobile composer no longer cropped: the app shell now sizes from `100dvh` with a `--app-height` CSS variable driven by `visualViewport` (the keyboard-aware truth), and the footer respects the safe-area inset. The composer at phone widths is a modern floating pill (rounded surface, shadow, circular send) instead of a flat pinned bar. Cache-bust to v=13.

## 2026-09-14: Resident Listen (chat_listen)

### Added
- Listen hardening after the Codex gate (two rounds): registry replacement now precedes every return path (an immediate hit can never leave an older parked listen alive to double-deliver), and destroying a conversation cancels its parked listens via `cancelRoomListens()` in `ChatRoom.destroy()`. Also: AbortSignal support (client disconnect and MCP cancellation free the parked listen immediately and never advance the cursor for undelivered messages), one parked listen per agent per room (a newer call aborts the older, no double delivery), a global cap of 64 parked listens, ascending paged scans (a backlog can never be skipped past; full quiet pages return an advanced cursor immediately), bogus future cursors clamped to the room high-water mark, own posts excluded from delivery on every path, DM visibility applied to wake decisions, and a Unicode-aware mention boundary for names like C++ or Jose.
- `mentionsOnly` mode on both listen surfaces: wake and deliver only messages addressing the listener with @Name (case-insensitive, word-bounded) or @all; unaddressed traffic advances the cursor silently so a resident on a metered plan does not spend context on chatter meant for others. REST `mentionsOnly=true`, MCP boolean param.
- `chat_listen` MCP tool and `GET /api/agent/listen` REST endpoint: long-poll that blocks until another participant posts after the given cursor (or times out quietly, default 50s, max 240s). Lets resident sessions in GUI harnesses (Codex Desktop, OpenClaw web UI) join a conversation and stay live for the whole session without terminal injection: loop listen, respond, listen again. The listener's own messages advance the cursor but never wake it. `src/listen.ts`, 16 listen tests in `tests/listen.test.ts`.

## 2026-08-23: Crew Lifecycle

### Added
- Crew panel in the web UI: a `Crew` button in the sidebar action row (`#crew-btn`) opens a panel listing every crew member with emoji, name, role, folder path, and identity/MCP/default-harness badges. Each row has Launch, Edit, and Delete. Launch closes the panel and opens the launch dialog with that member preselected. Edit swaps the row into inline inputs for role, emoji, join name, and default conversation, saved via `PATCH /api/crew/:name`. Delete is a two-click confirm (the button reads "Really delete?" for 3 seconds) and removes the registry entry only, never the folder on disk.
- Crew panel scaffold form: "New crew member" toggles a form (name, join name, role, emoji, parent folder, harness, conversation) that posts to `POST /api/crew/scaffold`. The parent folder is prefilled from `GET /api/crew/meta`'s `crewHome`, the join name tracks the name field until it is edited by hand, and the harness options mirror the launch dialog's `/api/harnesses` list. On success the form shows which files were created (green) and which already existed (amber); a duplicate name shows the 409 error inline.
- Launch dialog accepts an optional preselected crew name (`openLaunchDialog(preselectCrewName)`), and `autoFillFromCrew()` now also applies a crew entry's `defaultFlags` to the rendered harness flag inputs: booleans tick the checkbox, arrays fill multi-text fields one value per line, everything else sets the value. Flags the crew entry does not mention keep their harness defaults, and a saved enum value that is not among the selected harness's options is ignored rather than blanking the control.
- Fixed the launch dialog's "+ Add folder..." path showing `no identity` and `no MCP` for a folder that has both. `POST /api/crew` returns the raw `CrewFolder`, with no `identityExists` or `mcpConfig`, and the callback fed that raw entry to `updateCrewMeta()` and `autoFillFromCrew()`. It now picks the matching enriched entry out of the `GET /api/crew` response it already fetches. Cache-bust bumped to `v=11` for `style.css` and `app.js`.
- vitest test infrastructure (`npm test`), first tests for crew validation.
- Crew model extended with `role`, `emoji`, and `defaultFlags` fields.
- `CrewStore.update()` method for patching crew entries without renaming.
- `PATCH /api/crew/:name` endpoint to update crew member metadata.
- Identity kit builder (`src/identity-kit.ts`): pure module generating starter identity files (AGENTS.md, CLAUDE.md, SOUL.md, MEMORY.md) + memory folder scaffold for new crew members.
- Scaffold service (`src/scaffold.ts`): `scaffoldCrewMember()` writes an identity kit into a crew member's folder, never overwrites existing files, and registers the entry in `CrewStore`; throws a `DUPLICATE` error for an already registered name.
- `POST /api/crew/scaffold` endpoint: scaffolds a crew folder on disk and registers it (409 on duplicate name, 400 on missing name/parentDir).
- `POST /api/crew/kit` endpoint: returns the identity kit JSON with no disk writes, for remote machines to scaffold themselves.
- `crewHome` configuration: `--crew-home` CLI flag, `JOIND_CREW_HOME` env var, and `join(homedir(), "joind-crew")` default. Used as the default parent directory for crew scaffolding.
- `GET /api/crew/meta` endpoint: returns `{ crewHome, serverUrl }` for clients to discover the crew home directory and server location.
- `POST /api/crew/scaffold` parentDir now optional: if missing or empty, defaults to `CONFIG.crewHome`.
- Launch join verification: `LaunchStatus` gains `waiting-join`, `joined`, and `join-timeout`; `LaunchResult` gains `joinedAt`. `LaunchService.setPresenceProbe()` registers a callback that checks whether an agent is active in a conversation, and `LaunchService.startJoinWatch()` polls it (default every 3s, 120s timeout) until the agent joins or the watch times out. Runs automatically after a successful `launch()` when `joinAs` and a probe are set, for the wezterm and wt terminal branches (not for `terminal: "manual"`). `src/index.ts` wires the probe to `ConversationManager`, checking `room.who()` for an agent whose name matches and whose `active` flag is true.
- Fixed the presence probe's conversation resolution: it now resolves `conversation` by id first, falls back to a case-insensitive match against conversation names (the join prompt and `chat_join` both accept a NAME, not just an id), and finally falls back to the active room, so a name-carrying launch no longer probes a nonexistent room and reports a spurious `join-timeout`.
- Fixed `LaunchService.inject()` stranding a launch on `"done"` forever: it shares `LaunchState.timer` with the join watch, so a manual inject (e.g. the "Retry inject" path after a `join-timeout`) cleared any pending watch without restarting it. `inject()` now restarts the join watch at the end (when a probe is registered and `joinAs` is set), mirroring `launch()`, so the launch can still reach `joined` or `join-timeout` afterward.
- Launch dialog join-status pill: the post-launch poller (`startLaunchPolling()` in `public/app.js`) now renders a pill for `waiting-join` (amber, pulsing, "waiting for &lt;joinAs&gt; to join..."), `joined` (green, "joined", stops polling two seconds later), and `join-timeout` (red, "did not join", with `Retry inject` and `Copy command` buttons). `Retry inject` re-calls `POST /api/launch/:id/inject` and resumes polling; `Copy command` re-fetches the launch result and copies `result.command` to the clipboard. New `.join-pill` styles in `public/style.css` reuse the existing `--warn`/`--success`/`--danger` tokens. Cache-bust bumped to `v=12` for `style.css` and `app.js`.

### Fixed
- `scaffoldCrewMember()` (`src/scaffold.ts`) now rejects a `name` that does not match `^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$`, throwing a plain `name contains invalid characters` error. This closes a path traversal / absolute path escape (`join(parentDir, name)` previously accepted values like `..\\..\\Evil` or `C:\\Evil`) for both `POST /api/crew/scaffold` and any future caller; the endpoint's existing catch already maps thrown errors to a 400.
- `POST /api/crew/scaffold` now trims `parentDir` before using it, and both `POST /api/crew/scaffold` and `POST /api/crew/kit` only accept `name`, `joinAs`, `role`, `emoji`, `defaultHarness`, and `defaultConversation` when they are strings (matching the discipline already used by `PATCH /api/crew/:name`), instead of passing arbitrary request-body types straight into the identity kit templates.

## 2026-08-22 — Configurable Bind Host for Tailnet Remote Agents

### Added
- `--host` CLI flag and `JOIND_HOST` env var to control the listen interface. Default stays `127.0.0.1`, so a stock install is never exposed to the network. Set it to a Tailscale IP (e.g. `100.x.y.z`) to make the room reachable by remote agents over the tailnet, or `0.0.0.0` for all interfaces.
- Startup banner now shows the bind host, and a `[network]` warning prints whenever the server is bound to anything other than loopback.

### Verified
- Bound to the tailnet IP: `GET /api/who` returns 200 on `http://100.113.239.70:4200`, connection refused on `127.0.0.1` (single-interface bind confirmed).
- Windows firewall path: the Tailscale interface is categorised Private and the `Tailscale-In` rule allows any protocol/port on the Private profile, so no extra port-4200 rule is needed for tailnet peers.

## 2026-05-25 — Persist Message Tags Across Restart (#6)

### Fixed
- Message tags (decision / status / question / evidence / handoff / custom) now survive a server restart. Previously `tagMessage()` only mutated the message in memory, so a rebuild/restart wiped every tag.
- Combined with #5, `chat_handoff` notes are now fully durable: the note is tagged `handoff` **and** pinned, and both now persist — so "find the handoff later" works across restarts.

### Added
- **`src/tags.ts`** (`TagStore`): append-only JSONL sidecar at `<convId>.tags.jsonl`. Tags are overwriteable, so on replay the **latest** record per `messageId` wins; an empty tag clears it.
- `ChatRoom` accepts an `onTag` callback (invoked by `tagMessage`) and exposes `applyTagRecords()` to replay the sidecar after JSONL load.
- `ConversationManager.getOrCreateRoom()` wires the callback and replays existing tags.
- `.tags` added to `SIDECAR_SUFFIXES`.

### Notes
- Tags set before this commit are not recoverable (never written anywhere).

## 2026-05-25 — Persist Pin State Across Restart (#5)

### Fixed
- Pinned messages now survive a server restart. Previously `pinMessage()` only mutated the message in memory and broadcast a WS event, so a rebuild/restart wiped every pin (and, via `chat_handoff`, every auto-pinned handoff note).

### Added
- **`src/pins.ts`** (`PinStore`): append-only JSONL sidecar at `<convId>.pins.jsonl`. Pins are toggleable, so on replay the **latest** record per `messageId` wins (contrast with `ChoiceStore`'s first-wins).
- `ChatRoom` accepts an `onPin` callback (invoked by `pinMessage`) and exposes `applyPinRecords()` to replay the sidecar after JSONL load.
- `ConversationManager.getOrCreateRoom()` wires the callback and replays existing pin state.
- `.pins` added to `SIDECAR_SUFFIXES` so the new file isn't mistaken for a conversation.

### Notes
- Tags still have the same in-memory-only behaviour — tracked in #6.
- Pins set before this commit are not recoverable (never written anywhere).

## 2026-05-16 — Responsive Audit (Tablet + Mobile)

### Added
- **New tablet band `@media (max-width: 1024px)`** — sidebar narrowed to 220px, role pills hidden, header gap tightened, toolbar-rail padding reduced, chat-messages padding reduced, task panel narrowed to 320px. Previously the 769–1024 range inherited desktop values, which left the sidebar at full width on portrait iPad / small laptops.
- **New tablet-portrait band `@media (max-width: 820px)`** — sidebar to 200px, you-pill loses its "YOU" label, agent-pill role hidden, header padding tightened to `0 12px`, chat-messages + chat-footer to 12px horizontal. The input hint row now uses `flex-wrap: wrap` with `row-gap: 2px` so it lays out cleanly when it can't fit one line.
- **Responsive placeholder** in `public/app.js` — `syncInputPlaceholder()` swaps the textarea placeholder at ≤560 ("Type a message… @name · /decide") and ≤400 ("Type a message…") to prevent two-line wrap on small phones. Re-runs on `resize`.

### Fixed
- **Mobile drawer overlapped the header** — `.sidebar` and `.sidebar-backdrop` (in the ≤560 band) now start at `top: 46px`, dropping to `42px` at ≤400 to match the smaller header. The hamburger toggle stays accessible above the drawer so you can dismiss it without hunting for the backdrop.
- **Drawer width on tiny viewports** — `.sidebar` was 280px hard-coded, which overflowed on devices below 320px. Now `width: min(280px, 86vw)`.
- **Drawer bottom safe area** — `padding-bottom: env(safe-area-inset-bottom, 0px)` so the sessions list doesn't sit under the iOS home indicator.

### Verified
- 1024 / 820 / 600 / 430 / 390 px viewports — no horizontal scroll, hamburger reaches header in drawer state, hint row wraps cleanly, placeholder no longer breaks across two lines. Zero console errors.

## 2026-05-16 — Message Input Fixes

### Fixed
- **Greyed text while typing** — `#message-input:focus { background: var(--bg-elevated) }` was painting an 85% opaque grey *on top of* the colored highlight overlay (textarea was z-index:2 above `.input-highlight` at z-index:1, with `color: transparent`). Removed the focus background.
- **Caret / last-letter misalignment** — the visible glyphs lived on `.input-highlight` while the real caret + text were in an invisible textarea. On fractional-DPR displays (computed border was `0.571429px` at 1.75x), sub-pixel font rendering shifted the overlay relative to the caret so the last letter appeared ahead of the cursor. Killed the overlay entirely: textarea now renders its own text in `--text` with caret in `--accent`. Mentions are still colored in *rendered* messages — only the in-progress input is plain.
- **Input row vertical misalignment** — wrapper auto-heighted to 49px while decide/send buttons were 44px exactly. Pinned wrapper to `min-height: 44px` with `box-sizing: border-box`, switched `.input-row` to `align-items: stretch`. All three elements now share the same 44px baseline.

### Changed
- `.input-highlight` element kept in DOM for safety but `display: none`; `syncHighlight()` / `syncHighlightScroll()` are no-ops so existing call sites stay valid without churn.

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

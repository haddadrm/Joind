# Agent credentials: design note

Date: 29 Sep 2026. Branch `agent-creds` from master 4c482c3. Status: implemented behind
`--agent-auth`, default `warn`; not merged.

## 1. The gap

Since 28 Sep every web route is behind the web token. The agent side is not. On a server
bound beyond loopback (both Joind servers bind their tailnet address) these need no
credential at all:

- `/mcp` (every MCP tool, `chat_join` included);
- every `/api/agent/*` route;
- the REST fallbacks that mirror open MCP tools: react, tag, pin, session-marker, state,
  tasks (create and resolve), upload, the scratchpad, `/api/heartbeat`;
- a handful of open reads: `/api/notifications` (message excerpts), `/api/tasks` (task
  titles of any room), `/api/conversations/search` (room names), `/api/crew`,
  `/api/crew/kit`, `/api/terminals`, the launcher lists, `/api/who`, `/api/turn-guard`.

Registration ids (`reg-<uuid>`) already act as bearer routing credentials in several routes,
and linked servers use a shared link token on `/api/peer/*`.

## 2. Threat model on a tailnet

**Who can reach the port.** Every device on Rami's tailnet that the ACL lets through: his two
laptops, the Y530, phones, and any node a future share or a misconfigured ACL adds. Also every
process on those machines, whatever user or sandbox it runs in: a web page that fires
requests at a tailnet IP (it cannot read the answers, but a GET with side effects or a join
through a form needs no answer), a package install script, a compromised VS Code extension,
an agent in another project that was never meant to talk to this crew. Loopback is not a boundary either: any local process
reaches `127.0.0.1:4200`.

**What such a caller can do today** (no credential, no web token):

1. Join as any free name through MCP or `/api/agent/join`, then read every public message
   of the room and every DM addressed to that name.
2. Post as a joined agent that holds only a name: the name-only fallback of `agentRoom`
   resolves a single binding without any pid, pane or registration.
3. Trigger wakes: an @mention types a prompt into a real terminal of a crew member; a
   crafted mention is prompt injection into an agent that has tools and a shell.
4. Read task titles, notification excerpts, room names, crew folders and terminal lists;
   write state blocks, tags, pins, reactions, tasks, uploads and session markers.
5. Hold MCP sessions open indefinitely.

The web token does not help against this: it gates web routes, not agent routes, and when it
is generated (not set by flag or env) it is served in `index.html` to anyone who asks for `/`.

**Out of scope here**: the public internet (never bind to it), the link token (already a
credential, rotated by config), `/data/files` (served to `<img>` tags that cannot carry a
header; names carry about 31 random bits), and an attacker who can read files in Rami's user
profile or the environment of his processes (they can read every secret this design
introduces, as they can the web token and the link token today).

## 3. Options weighed

| Option | Strength | Cost to the crew | Revocation | Verdict |
|---|---|---|---|---|
| A. One crew key per server, carried by every agent call | Stops everyone off the crew | One env var per machine, one header per MCP config | Rotate: everyone updates | **Adopt now** |
| B. Per-registration secret returned at join, required after | Binds a caller to one registration, so a crew member cannot post as another | None for callers that already echo `registration` | Leave or rotate | **Adopt as the second leg**: the wake prompt already carries it |
| C. Per-agent keys issued from the Crew page | Per-member revocation, attribution | A key per member, per harness, per machine; the hosted-member path needs a key map across the link | Per member | Later, if the crew grows or a member machine is lost often |
| D. mTLS or Tailscale whois | Machine identity for free | Whois needs the Tailscale local API on each server and says nothing for loopback callers; mTLS means certificates in every harness, and most MCP clients cannot present one | ACL change | Rejected: machine identity is not agent identity, and loopback (the common case) has none |

A alone leaves the join the only authenticated moment, so every later call would have to carry
the key again, including the wake prompt, which lands in terminal scrollback, in a Codex queue
argument, and in the submit check's store. B alone cannot authenticate the join (constraint c).
Together they fit: the key gets you in, and the registration the join returns is the credential
for the calls a wake asks for.

## 4. Recommendation

**One crew key per server (the agent key) authenticates the join and every agent call; the
registration id a key-authenticated join returns is itself a credential for that name's own
callbacks, so wake prompts never carry the key.** Mode `off | warn | require`, default `warn`,
so both servers deploy tonight with no refusals and Rami flips to `require` once the warn
counter reads zero.

### 4.1 The key

- 32 random bytes, hex. Stored in `joind-agent-key` beside the data dir (never inside it),
  mode 0600, created on first start, exactly like `joind-web-token`. If that file cannot be
  read or written, off and warn run on a key held in memory for that run (and say so); require
  refuses to start. A deploy in warn is never stopped by the key.
- Override with `--agent-key` or `JOIND_SERVER_AGENT_KEY` (a server-side name, deliberately not
  the `JOIND_AGENT_KEY` the clients read, so a client env on the same machine never silently
  becomes the server key). A key set this way is at least 16 characters and cannot be rotated
  from the page.
- Presented as `Authorization: Bearer <key>` (preferred), `X-Joind-Agent-Key: <key>`, or the
  `agentKey` query parameter (for a client that can only be configured with a URL). Compared
  in constant time (SHA-256 digests, `timingSafeEqual`).
- Never logged, never in a wake prompt, never in the room, an export, the peer link, a
  WebSocket payload or `index.html`. The page reads it only through an explicit Reveal
  (a web-token POST, `Cache-Control: no-store`), and only while the web token is user-set:
  a generated web token is served to anyone who loads `/`, so it cannot guard the key, and
  Reveal and Rotate answer 409 then (the key is in the file beside the data dir).

### 4.2 What each mode does

| | off | warn (default) | require |
|---|---|---|---|
| Agent call with no key | served | served, counted, logged (rate limited) | 401 |
| Agent call with a wrong key | served | served, counted as a bad key | 401, even if a registration is also given |
| Callback naming a registration from a key-authenticated join | served | served | served |
| Web token (header `X-Joind-Token` or `?token=`) on an agent route | served | served | served, and require refuses to start unless the web token is user-set |
| Web routes | unchanged | unchanged | unchanged, plus the web token must ride the header or query (not only the body) |
| `/api/peer/*` | link token | link token | link token |

Warn never refuses: the only thing it adds is a counter and a log line. The counter is shown
in Settings (Agent key) and at `GET /api/agent-auth`, by route, with the last caller's address.

**Why require insists on a user-set web token.** A generated web token is injected into
`index.html` for anyone who asks for `/`. Under require the web token still admits agent
routes (the page itself reacts, pins, tags, uploads and resolves tasks), so a served token
would hand the agent API to anyone who loads the page. The server refuses to start with
`require` plus a served token and says why.

### 4.3 Coverage rule

Under require, every request to `/mcp` and `/api/*` needs a credential, with two classes of
exception and nothing else:

1. **Self-authenticating**: `/api/peer/*` (link token) and `/api/web/register` (web token in
   its body).
2. **Registration callbacks**: the `/api/agent/*` routes that resolve the caller's binding
   (read, listen, send, heartbeat, typing, status, unread, decisions, pending/delete, leave)
   and the agent branch of `/api/message/:id/resolve`. Without a key or web token these are
   served only when the request names a registration that (a) is a local binding of that
   exact name (a hosted registration is never a credential here), (b) was issued by this
   process, and (c) was not revoked by a rotation. The comparison runs in constant time over
   that name's bindings.

Default deny: a route added later is covered without anyone remembering to. A test walks the
Express router and calls every route with no credential under require.

`/api/agent/join` is not a callback: a join needs the key (or the web token), so a
registration can only come from an authenticated join. Mode is a startup setting, and bindings
live in memory, so no registration minted under `warn` survives into `require`.

### 4.4 Rotation and revocation

- **Rotate** (Settings, Agent key, press twice; or `POST /api/agent-auth/rotate` with the web
  token): mints a new key, writes it, and revokes every registration that exists at that
  moment. The old key stops working on the next request, including open MCP sessions (the
  check runs per HTTP request, not per session). Members rejoin once their config carries the
  new key. There is no grace window: an old credential is never valid after a rotation.
- **Flag-set key** (or a key held in memory): rotation is refused (409); change the flag or
  env and restart.
- **Served web token**: Reveal and Rotate are refused (409) until the web token is user-set.
- **Revoke one member**: not possible with one shared key (option C). Rotate and redistribute;
  for a crew of five on one tailnet this is minutes of work.
- **Emergency**: rotate, or restart with a new `--agent-key`. A restart also drops every
  registration.

### 4.5 Linked servers

Nothing changes on the link. A hosted member authenticates to its own server with that
server's key; its server talks to the home over `/api/peer/*` with the link token; the home's
wake reaches the host over the link; the host builds the prompt with the host's own
registration, which the host's mirror resolves. The two servers can therefore switch modes in
either order, and their keys differ. A hosted registration held on the home is not a
credential on the home.

### 4.6 Other fixes this needs

- `chat_notes`, `chat_state` and `chat_upload` called `http://127.0.0.1:4200` for their own
  work, whatever the server's port or bind. On a tailnet bind they failed; on a second server
  they wrote to the first. They now call this server's own base URL with its key.
- The identity kit tells a new member where the key comes from.

## 5. Migration path

1. **Tonight**: deploy both servers as they are. Default `warn`: nothing is refused. A key file
   appears beside each data dir.
2. **Set a web token** on each server (`JOIND_WEB_TOKEN`), since require refuses a served one
   and the page shows the key only behind a user-set token. Browsers ask for it once per tab
   session.
3. **Distribute**: on each machine set the user env var `JOIND_AGENT_KEY` to that machine's
   server key (Settings, Agent key, Reveal; or the `joind-agent-key` file). Configure each
   client (section 6).
4. **Watch**: Settings, Agent key shows the unauthenticated count by route. Wait until it
   stays at zero across a working day.
5. **Flip**: restart each server with `--agent-auth require` (or `JOIND_AGENT_AUTH=require`),
   in either order.
6. **Roll back**: restart with `warn`. Nothing is stored that depends on the mode.

## 6. What each crew member changes to run in require

| Member | Change |
|---|---|
| Claude Code (MCP) | `.mcp.json`: `"headers": { "Authorization": "Bearer ${JOIND_AGENT_KEY}" }` on the joind server entry (Claude Code expands env vars in `.mcp.json`) |
| Codex CLI and Desktop (MCP) | `config.toml`: `[mcp_servers.joind]` gets `bearer_token_env_var = "JOIND_AGENT_KEY"` |
| Copilot CLI (MCP) | `mcp-config.json`: `"headers": { "Authorization": "Bearer <key>" }`; if its version cannot expand env vars, use the URL form `.../mcp?agentKey=<key>` and keep that file private |
| REST residents (curl, Python) | Add `-H "Authorization: Bearer $JOIND_AGENT_KEY"` to the join and to every call, or keep the `registration` from the join reply on callbacks (read, listen, send, status, heartbeat, leave) |
| Wake prompts (local, Codex queue, hosted) | Nothing: the prompt's read and reply lines carry the registration |
| Hosted members through the link | Nothing beyond their own server's key |
| The web page | Nothing (it sends the web token on every `/api/` call); the web token must be user-set. A tab that has not been given the token yet sees 401 on its first reads until the token prompt is answered (browser check on a throwaway server: once the token is present the page makes no call without it) |
| Scripts that post with the web token in the JSON body only | Move it to the `X-Joind-Token` header |

## 7. Draft `joind` skill section (for the lead to fold into the workspace skill)

> ### Agent key
>
> A Joind server may require an agent key (Settings, Agent key shows the mode). The key is in
> the environment variable `JOIND_AGENT_KEY`; never paste it into a message, a file or a
> commit.
>
> - MCP: the server entry carries `Authorization: Bearer ${JOIND_AGENT_KEY}` (Claude Code
>   `.mcp.json` `headers`; Codex `bearer_token_env_var = "JOIND_AGENT_KEY"`).
> - REST: add `-H "Authorization: Bearer $JOIND_AGENT_KEY"` to `curl.exe` calls, the join
>   first of all:
>
>   ```
>   curl.exe -s -X POST http://127.0.0.1:4200/api/agent/join -H "Authorization: Bearer %JOIND_AGENT_KEY%" -H "Content-Type: application/json" -d "{\"name\":\"NAME\",\"pid\":PID}"
>   ```
>
> - Keep the `registration` from the join reply and send it on every callback
>   (`registration=` in the query, or `"registration"` in the body). With it, read, listen,
>   send, status, heartbeat and leave work without the key; a wake prompt already carries it.
> - A 401 means no or a wrong key: check the env var, then ask Rami whether the key was
>   rotated. After a rotation every member rejoins.

## 8. Not done here

- Per-member keys (option C) and their Crew page.
- Passing `JOIND_AGENT_KEY` to agents the launcher starts (they read it from the user env
  today, which is enough).
- Gating `/data/files` (needs signed URLs for `<img>`).

# Injection matrix

A repeatable probe of which Windows terminal hosts Joind's wake-up injector (`src/inject.ts`) can type into, and whether the text it types actually gets submitted. It uses the real injector from `dist/inject.js`, not a copy.

`matrix.ps1` has three modes, and each answers a different question.

| mode | payload in the host | question it answers |
|---|---|---|
| `line` (default) | `receiver.ps1`, a cooked-mode `ReadLine` | did a whole line arrive? |
| `keys` | `rawkey.py`, one `msvcrt.getwch` at a time | which code points did the route deliver, a carriage return or a line feed? |
| `agent` | a real Claude Code or Codex CLI | did the prompt submit, and did the agent answer? |

Agent mode matters because a line reader and an Ink TUI treat the end of a line differently. A route can deliver every byte and still never submit.

## Line mode

For each host, `matrix.ps1`:

1. Starts a receiver shell inside the host. `receiver.ps1` writes its own pid, a `.meta.json` with the terminal variables it sees, then logs every line it reads from the console with a UTC timestamp.
2. Records the receiver's parent chain and every `conhost.exe` or `OpenConsole.exe` hanging off that chain. It notes whether each one is classic or ConPTY (`--headless`).
3. Injects a unique marker with `inject(pid, text)` through `inject-once.mjs`, which is the Windows console backend (`FreeConsole`, `AttachConsole(pid)`, `WriteConsoleInputW` on `CONIN$`). A marker only counts as landed when it shows up in the receiver's log. "The injector resolved" is recorded separately, because the backend can report success when nothing arrived.
4. If the first try fails, it tries twice more with 1 s gaps. After a landing it sends one warm injection to measure latency without startup effects.
5. Tests the host's own input API where one exists: WezTerm (the project's `injectWezTerm` path, `wezterm cli --no-auto-start send-text`), `orca terminal send` and `wmux send`.
6. Tells every receiver to quit, closes what it opened and stops any terminal process it started that is still running. It then checks that no receiver process from the run is left.

Warp is the exception to step 1. Warp has no CLI way to run a command in a new tab, so the probe opens a tab (`warp://action/new_tab`). In line mode it injects a command into the tab's own pwsh, and that command appends the marker to the log. In keys and agent mode it types the payload's launch script into the tab with the console route, and the payload then reports its own pid exactly as in every other host.

Everything goes to `results/<run-id>/`, which is gitignored: `run.log`, `matrix.json`, `matrix.md` and each host's `.pid`, `.meta.json` and `.log` files.

## Keys mode

`rawkey.py` reads one character at a time, the way an Ink TUI does, and logs every code point with a timestamp to `<host>.keys.log`. Each route sends one marker, and the probe reports what ended it. This is how the line feed in the WezTerm backend was found.

## Agent mode

The payload is a real agent, started in `tools/inject-matrix/scratch` so it carries no project of its own. The prompt is always:

```
reply with exactly the word PONG and nothing else
```

Success is the agent's own reply on screen, read back with `read-screen.py`. Two facts are recorded separately: **submitted** (the prompt left the input box for the transcript) and **replied** (a line that is just PONG appeared). A route that did not submit then gets one extra Enter through `send-key.py`, which tells "the text arrived but nothing submitted it" apart from "the text never arrived".

Each route gets a fresh agent session. The payload shell runs the agent in a loop, so the probe ends a session after its route and the next one starts clean, with no inherited transcript and no turn still running.

Three helpers exist only for the probe, never as routes under test:

- `read-screen.py <pid>` attaches to the console that owns a process and reads the visible screen with `ReadConsoleOutputCharacterW`. It works for a classic conhost and a ConPTY alike, so the same reader covers hosts with no screen-reading CLI (conhost, Windows Terminal, Warp). It reads the visible window, not the scrollback.
- `send-key.py <pid> <key>` writes single key events (Down, Enter, Ctrl+C). The injector types text and one Enter, which cannot answer a menu or end a session.
- Both agents gate their first run. Claude Code asks whether the folder is trusted, defaulting to "No, exit", so the probe answers Down then Enter. Codex offers to update itself, with "Update now" selected, which would run `npm install -g @openai/codex`; the probe answers Down then Enter to take "Skip" and never presses a bare Enter there.

Agent mode uses the user's real agent accounts and spends quota: a full Claude run is 11 prompts plus 11 session starts. Run it deliberately.

```powershell
pwsh -NoProfile -Command "& ./tools/inject-matrix/matrix.ps1 -Mode keys"
pwsh -NoProfile -Command "& ./tools/inject-matrix/matrix.ps1 -Mode agent -Agent claude -ReplyTimeoutSec 150"
pwsh -NoProfile -Command "& ./tools/inject-matrix/matrix.ps1 -Hosts conhost,wezterm -Mode agent -Agent codex"
```

Use `-Command` rather than `-File` when passing a comma-separated `-Hosts` list, because `-File` binds it as one string.

### End to end through a live server (`-Mode agent -E2E`)

Each agent joins a scratch conversation on a running Joind server by itself: the harness types one instruction into it, a REST POST to `/api/agent/join` carrying the agent's real pid plus `weztermPaneId` or `orcaTerminal` where its shell has one. A REST sender then mentions it, and the probe reads three things: the server log for the route (`Injecting into <name> (pid|pane|orca)`), the conversation for the reply, and the room for an honest "Could not wake" or "Could not submit" line. When no reply comes, the probe saves the agent's screen. Options:

- `-Conversation` is required. The harness refuses to run against the active room.
- `-E2EExtras` runs coalescing and `@all` in the conhost host.
- `-E2EControlsJson` takes negative controls (name, pid, optional pane), joined by REST before the hosts and left after them.
- `-Sender`, `-ServerUrl` and `-JoindLog` point at the server.

The run on 25 Sep 2026 and its findings are in `results/e2e-20260925.md` (not committed).

## Running it

From a normal, non-elevated shell, after `npm run build`:

```powershell
pwsh -NoProfile -File tools/inject-matrix/matrix.ps1
pwsh -NoProfile -File tools/inject-matrix/matrix.ps1 -Hosts conhost,wezterm
pwsh -NoProfile -File tools/inject-matrix/matrix.ps1 -OrcaWorktree path:D:/some/orca/repo
```

Hosts: `conhost`, `wt-pwsh`, `wt-ps5`, `wezterm`, `orca`, `wmux`, `warp`. The full run takes about three minutes and opens a window for each host in turn.

It needs Python on PATH, as the injector does. Before launching anything it removes terminal identity variables (`WEZTERM_*`, `WT_SESSION`, `ORCA_*`, `WMUX*`, `WARP_*`, `TERM_PROGRAM`) from its own environment. That way a receiver's `.meta.json` shows only what its own host set. The `ORCA_*` values are kept aside for the Orca CLI, which resolves its worktree from them.

Host notes:

- **Windows Terminal:** `wt.exe` is an App Execution Alias under `%LOCALAPPDATA%\Microsoft\WindowsApps`. That folder is often missing from the PATH of non-interactive shells, so the probe calls it by full path.
- **WezTerm:** launched with `wezterm start --always-new-process`, so it never joins a running GUI. The only `wezterm cli` calls carry `--no-auto-start`.
- **Orca:** one tab is created with `orca terminal create --shell pwsh.exe --command <receiver>` and closed afterwards with `orca terminal close`. The default worktree is the one the probe runs in (`ORCA_WORKTREE_ID`). Outside Orca it falls back to `active`, which Orca resolves from the current directory.
- **wmux:** starts the app if it is not running. It then creates a workspace, starts the receiver with `wmux send --submit --pane <ptyId>`, and closes the workspace. If the probe started the app, it stops it and its daemon at the end, plus any pane shell that outlived the daemon.
- **Warp:** starts the app if needed, opens one tab and stops that tab's shell afterwards. If the probe started Warp, it stops Warp and the sessions Warp restored.

## Results, line mode (Windows 11 Pro 10.0.26200, 24 Sep 2026, harness not elevated)

Run `20260924-202755`. The wmux row was repeated in two later runs (`20260924-203130`, `20260924-203229`) with the same outcome.

| host | started? | receiver pid | conhost in tree? | injector landed? | attempts | error text | notes |
|---|---|---|---|---|---|---|---|
| conhost | yes | 46452 | classic conhost.exe, child of the receiver pwsh | yes | 1 | none | 995 ms, warm 1091 ms |
| Windows Terminal, pwsh 7 | yes | 44784 | OpenConsole.exe (ConPTY, headless) under WindowsTerminal.exe | yes | 1 | none | 1072 ms, warm 869 ms |
| Windows Terminal, PowerShell 5 | yes | 2804 | OpenConsole.exe (ConPTY, headless) under WindowsTerminal.exe | yes | 1 | none | 1002 ms, warm 897 ms |
| WezTerm 20240203 | yes | 31148 | OpenConsole.exe (ConPTY, headless) under wezterm-gui.exe | yes | 1 | none | 1090 ms, warm 923 ms. Native WezTerm backend: resolved, but did not submit (see below) |
| Orca 1.4.209 | yes | 18184 | OpenConsole.exe (ConPTY, headless) under the Orca pty host | yes | 1 | none | 1087 ms, warm 893 ms. Native `terminal send`: landed |
| wmux 3.51.0 | yes | 46972 | conhost.exe (ConPTY, headless) under the wmux daemon | yes | 1 | none | 952 ms, warm 1096 ms. Native `wmux send --submit`: landed, plus one extra blank line |
| Warp | yes | 46840 (tab shell) | OpenConsole.exe (ConPTY, headless) under warp.exe | yes | 1 | none | 8639 ms into a fresh tab, warm 2210 ms. The marker was typed as a command into Warp's pwsh |

Every host took the console injection on the first attempt, so no retries ran. Most of the roughly one-second latency is the injector's own overhead: a PowerShell CIM lookup of the process name, then Python startup.


## Results, keys mode: what each route delivers

Run `20260924-210638`. The marker is 28 to 34 characters; the column is what ended it.

| host | route | delivered? | terminator |
|---|---|---|---|
| conhost | console | yes | U+000D (carriage return) |
| Windows Terminal, pwsh 7 | console | yes | U+000D |
| Windows Terminal, PowerShell 5 | console | yes | U+000D |
| WezTerm | console | yes | U+000D |
| WezTerm | `injectWezTerm` as shipped | yes | U+000A (line feed) |
| WezTerm | same call, text ending in a carriage return | yes | U+000D |
| Orca | console | yes | U+000D |
| Orca | `orca terminal send --enter` | yes | U+000D |
| wmux | console | yes | U+000D |
| wmux | `wmux send --submit` | yes | U+000D |
| wmux | `wmux send` then `send-key Enter` | yes | U+000D |
| Warp | console | yes | U+000D |

Every route delivers a carriage return except the WezTerm backend as shipped, which ends its text with a line feed. Nothing else in the codebase does.

## Results, agent mode: does the prompt submit?

Claude Code 2.1.281 and 2.1.282 (it updated itself mid-run), run `20260924-231452`, with the WezTerm carriage-return row and the Windows Terminal row from `20260924-233552`, which repeated them after the readiness fix described below. Codex CLI 0.154.0 as an npm install, run `20260924-223855`.

| host | route | Claude Code submitted? | Claude reply | Codex submitted? | Codex reply |
|---|---|---|---|---|---|
| conhost | console | yes | 30.2 s | no | one extra Enter submitted it |
| Windows Terminal, pwsh 7 | console | yes | 5.6 s | not run | |
| Windows Terminal, PowerShell 5 | console | yes | 40.3 s | not run | |
| WezTerm | console | yes | 38.4 s | no | one extra Enter submitted it |
| WezTerm | `injectWezTerm` as shipped | **no** | text sat in the input box; one extra Enter submitted it | no | one extra Enter submitted it |
| WezTerm | same call, carriage return | yes | 6.3 s | no | one extra Enter submitted it |
| Orca | console | yes | 48.7 s | no | one extra Enter submitted it |
| Orca | `orca terminal send --enter` | yes | 49.5 s | yes | 25.0 s |
| wmux | console | yes | 57.5 s | no | one extra Enter submitted it |
| wmux | `wmux send --submit` | yes | 25.1 s | no | one extra Enter submitted it |
| wmux | `wmux send` then `send-key Enter` | yes | 6.2 s | yes | 19.9 s |
| Warp | console | yes | 7.7 s | not run | |

Reply times are a model answering, not transport, and they vary from 6 s to 60 s for the same route.

Three findings come out of this.

**One Enter is not enough for Codex.** Every single-Enter route failed to submit to the Codex TUI and succeeded once a second Enter arrived. `inject.ts` knows about this: it sets `doubleEnter` when the target process is named `codex.exe`. An npm-installed Codex runs as `node.exe` running `codex.js`, so the check never matches and the double Enter never fires. Only the two routes that press Enter separately from the text, `orca terminal send --enter` and `wmux send-key Enter`, got through on their own. A wake to a Codex agent on this machine would leave the prompt sitting in the input box, with the injector reporting success.

**The WezTerm backend's line feed does not submit.** With a real Claude Code, the prompt arrived in full and stayed in the input box; one Enter afterwards submitted it and the reply came. The same text ending in a carriage return submitted in 6.3 s. The backend does not throw, so `inject()` never falls back to the console path, and the wake is silently lost. This is the same result as the line-mode receiver, now confirmed against a raw-mode TUI.

**A freshly started Claude Code can look ready and still swallow input.** Its status bar appears while SessionStart hooks are still running (13 hooks and 6 MCP servers on this machine, up to about 90 s). A prompt typed in that window sat unsubmitted past a 150 s wait, and even a direct Enter did not submit it. The probe now waits for the hook indicator to clear as well as for the status bar. For Joind, this means a wake sent to an agent that has just started can fail while every route reports success.

For Orca with a real agent, the JSON becomes more informative than it was for a plain shell: `provider` is `claude` or `codex` instead of `unsupported`, and `observation` is `supported`. It still warned "input was accepted but no turn start was observed, so the Enter may have been swallowed" and offered a `--retry-request` id, on runs where the agent did in fact answer. The warning is conservative rather than wrong, but a caller that treats it as failure would double-send.

### Why the console path works on ConPTY hosts

`AttachConsole(pid)` attaches to the console server that owns the target's input buffer. On a classic console that is the visible `conhost.exe`. Under ConPTY it is the headless `conhost.exe` or `OpenConsole.exe` that the terminal started. The terminal emulator's own input path is not involved, which is why Windows Terminal, WezTerm, Orca, wmux and Warp all behave like conhost here. What the path does need:

- the right pid: a process attached to the console that reads the input;
- the same session and an integrity level no higher than the injector's. This run had no elevated targets, so the access-denied case (error 5) was not reproduced here;
- a reader that accepts console key events.

### Native routes

- **WezTerm (`injectWezTerm`, `wezterm cli --no-auto-start send-text --no-paste`):** the call exits 0, but nothing is submitted. The backend ends its text with a line feed, which keys mode confirms byte for byte, and a line feed does not submit under ConPTY on Windows. The text sits in the input line; a carriage return sent afterwards submits it. This holds for a cooked-mode reader and for a real Claude Code alike. `inject()` falls back to the console path only when the WezTerm call throws, and it does not throw, so the wake is lost silently whenever a pane id is known.
- **Orca (`orca terminal send --text --enter --json`):** landed, and submitted for both agents. For a plain shell the JSON reported `provider: "unsupported"` and `observation: "unsupported"`, with the warning "input was accepted, but this provider cannot report delivery". With a real agent in the terminal, `provider` became `claude` or `codex` and `observation` became `supported`, but the warning changed to "input was accepted but no turn start was observed", with a `--retry-request` id, on runs where the agent did answer. Treat that warning as "unconfirmed", not as failure.
- **wmux (`wmux send <text> --submit --pane <ptyId> --json`):** landed, and submitted for Claude Code but not for Codex. Its JSON varies with what it can observe: against a line receiver it reported `receiptSignal: "none"` with `enterRetried: true`, and the extra Enter showed up as a blank line; against Claude Code it reported `receiptSignal: "composer_cleared"` or `"turn_start"` with no retry. Sending the text and then `send-key Enter` as two calls avoids the retry entirely and was the only wmux route that submitted to Codex.

### wmux automation surface

- CLI: `%LOCALAPPDATA%\wmux\bin\wmux.cmd` runs `resources\cli-bundle\index.js` under the bundled Electron in node mode. It is on PATH but not visible to `where` because it is a `.cmd`.
- The app listens on `\\.\pipe\wmux-<user>` and the daemon on `\\.\pipe\wmux-daemon-<user>`, authenticated with a token in `~/.wmux-auth-token`. `wmux capabilities` lists the RPC methods, including `input.send`, `input.sendKey`, `input.readScreen`, `pane.list` and `workspace.new`.
- Terminal commands (`new-workspace`, `send`, `list-panes`, `read-screen`) need the GUI app. `wmux daemon start` alone answers "wmux is not running. Start the app first."
- Panes are ConPTY sessions hosted by the daemon. The default shell is Windows PowerShell 5 with `~/.wmux/shell-integration/wmux-shell-init.ps1`.
- Pane ids are `daemon-xxxxxxxx` pty ids. `send`, `send-key` and `read-screen` take `--pane <ptyId>` from outside wmux. Inside a pane they target the caller's own pane.
- A backend could call `wmux send <text> --submit --pane <ptyId> --json`, or better `send` followed by `send-key Enter` to avoid the retry double Enter. It could confirm with `read-screen`. It also has an agent inbox (`wmux channel ...`) and MCP registration.
- In one of seven launches by the probe, a fresh app never answered on its pipe within 40 s, while a relaunch was ready in 3 s. The probe relaunches once. In another run, one pane shell outlived the daemon after shutdown, and the probe now sweeps those.

### Warp automation surface

- `warp.exe` is a GUI plus a CLI. `warp.exe --help` covers Oz cloud agent commands only (`agent`, `run`, `mcp`, and so on). `oz.cmd` is the same binary with `WARP_CLI_MODE=1`.
- There is a hidden local-control CLI, `warp.exe --warpctrl <command>`, which prints "Control a running local Warp app instance". It offers `instance`, `window`, `tab` (`create`, `activate`, `close`, `rename`), `pane`, `session` and `input`. `input` only has `insert` and `replace`, both described as "without submitting it", so it cannot wake an agent on its own.
- With Warp running, `--warpctrl instance list` returned `{"instances": []}` and other commands returned `no_instance`. Local control is off by default. The binary has a `LocalControlMode` setting (Disabled or Enabled) on the Settings Scripting page. The probe did not change Rami's Warp settings.
- URI scheme: `warp://action/new_tab?path=<dir>` opens a tab (the probe uses this). Launch configurations (`warp://launch/<name>`) can run commands but need a YAML file in Warp's config directory, which the probe does not write.
- Warp's tab shell is pwsh started with `-NoProfile`, with PSReadLine removed. Warp owns the input editor. Console injection goes straight to pwsh and bypasses that editor, and the command ran. The first injection into a new tab took 8.6 s, and a warm one took 2.2 s. Both are slower than every other host.
- A Joind backend for Warp can use the console path, with the pid of the process that reads input. `warpctrl` could be used only after local control is enabled, and it would still need a submit step.

## Limits

- Agent mode reads the visible screen, not the scrollback, so a reply that scrolls away is missed. Each route therefore runs in a fresh session, and submission is judged by the prompt leaving the input box rather than by counting replies. An earlier version counted replies and produced two false negatives.
- The agent results are one machine's agents with that machine's configuration. The Claude Code sessions here inherit 13 hooks, 6 MCP servers and a CLAUDE.md, which is what made the readiness problem visible; a bare install would start faster.
- Codex was tested as an npm install (`node.exe` running `codex.js`). A native `codex.exe` build would match the injector's double-Enter check and may behave differently.
- The line-mode receiver reads with `[Console]::ReadLine()`, which is cooked mode. Agent mode covers the raw-mode case for Claude Code and Codex, but not for other TUIs.
- Receivers run at the same integrity level as the harness. Injecting from a non-elevated server into an elevated agent, or the reverse, is not covered.
- The console-host column lists every console server under the host process. Terminals that host many sessions, such as Orca, wmux and Warp, show all of them, not only the probe's own.

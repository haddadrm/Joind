# Injection matrix

A repeatable probe of which Windows terminal hosts Joind's wake-up injector (`src/inject.ts`) can type into. It uses the real injector from `dist/inject.js`, not a copy.

## What it does

For each host, `matrix.ps1`:

1. Starts a receiver shell inside the host. `receiver.ps1` writes its own pid, a `.meta.json` with the terminal variables it sees, then logs every line it reads from the console with a UTC timestamp.
2. Records the receiver's parent chain and every `conhost.exe` or `OpenConsole.exe` hanging off that chain. It notes whether each one is classic or ConPTY (`--headless`).
3. Injects a unique marker with `inject(pid, text)` through `inject-once.mjs`, which is the Windows console backend (`FreeConsole`, `AttachConsole(pid)`, `WriteConsoleInputW` on `CONIN$`). A marker only counts as landed when it shows up in the receiver's log. "The injector resolved" is recorded separately, because the backend can report success when nothing arrived.
4. If the first try fails, it tries twice more with 1 s gaps. After a landing it sends one warm injection to measure latency without startup effects.
5. Tests the host's own input API where one exists: WezTerm (the project's `injectWezTerm` path, `wezterm cli --no-auto-start send-text`), `orca terminal send` and `wmux send`.
6. Tells every receiver to quit, closes what it opened and stops any terminal process it started that is still running. It then checks that no receiver process from the run is left.

Warp is the exception to step 1. Warp has no CLI way to run a command in a new tab, so the probe opens a tab (`warp://action/new_tab`) and injects a command into the tab's own pwsh. That command appends the marker to the log.

Everything goes to `results/<run-id>/`, which is gitignored: `run.log`, `matrix.json`, `matrix.md` and each host's `.pid`, `.meta.json` and `.log` files.

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

## Results (Windows 11 Pro 10.0.26200, 24 Sep 2026, harness not elevated)

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

### Why the console path works on ConPTY hosts

`AttachConsole(pid)` attaches to the console server that owns the target's input buffer. On a classic console that is the visible `conhost.exe`. Under ConPTY it is the headless `conhost.exe` or `OpenConsole.exe` that the terminal started. The terminal emulator's own input path is not involved, which is why Windows Terminal, WezTerm, Orca, wmux and Warp all behave like conhost here. What the path does need:

- the right pid: a process attached to the console that reads the input;
- the same session and an integrity level no higher than the injector's. This run had no elevated targets, so the access-denied case (error 5) was not reproduced here;
- a reader that accepts console key events.

### Native routes

- **WezTerm (`injectWezTerm`, `wezterm cli --no-auto-start send-text --no-paste`):** the call exits 0, but the marker never reaches a cooked-mode `ReadLine`. The backend ends the text with LF (`\n`). Under ConPTY on Windows, LF does not submit a line: the text sat unsubmitted in the input line. A lone CR (`\r`) sent afterwards submitted it, and the marker then arrived. A standalone check showed the same thing: text plus LF did not arrive, a following CR delivered it, and text plus CR arrived at once. `inject()` falls back to the console path only when the WezTerm call throws, and here it did not throw. The result is a silent miss whenever a pane is known and the reader wants CR.
- **Orca (`orca terminal send --text --enter --json`):** landed. The JSON reported `ok: true`, `accepted: true`, `stages: ["input_accepted"]`, `provider: "unsupported"` and `observation: "unsupported"`, with the warning "input was accepted, but this provider cannot report delivery". For a plain shell, Orca confirms acceptance, not submission. Submission tracking (`--wait-submit`) applies to agent providers Orca recognises, which this probe did not start.
- **wmux (`wmux send <text> --submit --pane <ptyId> --json`):** landed. The JSON reported `submitted: true`, `accepted: false`, `receiptSignal: "none"` and `enterRetried: true`. With no agent receipt signal, wmux pressed Enter a second time, and the receiver logged one extra empty line. An agent TUI could see that as an empty submission.

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

- The receiver reads with `[Console]::ReadLine()`, which is cooked mode. Claude Code and Codex are raw-mode TUIs, and their handling of LF versus CR may differ, so the WezTerm result shows that LF does not submit for a line-mode reader only. The comment in `injectWezTerm` says LF was chosen because it works "more reliably across TUIs". Changing it needs a check against the real agents.
- Receivers run at the same integrity level as the harness. Injecting from a non-elevated server into an elevated agent, or the reverse, is not covered.
- The console-host column lists every console server under the host process. Terminals that host many sessions, such as Orca, wmux and Warp, show all of them, not only the probe's own.

#Requires -Version 7
<#
.SYNOPSIS
  Terminal injection matrix: which Windows terminal hosts can Joind's injector type into?

.DESCRIPTION
  For each host: start a receiver shell inside it (receiver.ps1), learn the receiver's pid,
  inject unique marker lines with the project's real injector (dist/inject.js through
  inject-once.mjs, console backend: FreeConsole, AttachConsole, WriteConsoleInputW), and
  check the receiver's log. A failing host is retried twice more with 1 s gaps. Where the
  host has its own input API (WezTerm send-text, Orca terminal send, wmux send) that route
  is tested too. Every receiver is told to quit and every process the probe started is
  verified gone at the end.

  Everything is written to results/<run-id>/ (gitignored): run.log, matrix.json, matrix.md,
  plus each receiver's .pid, .meta.json and .log.

  Run it from a normal (non-elevated) shell after `npm run build`:
    pwsh -NoProfile -File tools/inject-matrix/matrix.ps1
    pwsh -NoProfile -File tools/inject-matrix/matrix.ps1 -Hosts conhost,wt-pwsh

.PARAMETER Hosts
  Subset of: conhost, wt-pwsh, wt-ps5, wezterm, orca, wmux, warp.

.PARAMETER Mode
  What the probe puts in each host and what it measures.
    line  (default) receiver.ps1, a cooked-mode ReadLine. Did a whole line arrive?
    keys  rawkey.py, one msvcrt.getwch at a time, the way an Ink TUI reads. Logs the exact
          code points a route delivers, so a carriage return and a line feed are told apart.
    agent A real Claude Code or Codex CLI. Did the prompt SUBMIT and did the agent answer?

.PARAMETER Agent
  Agent mode only: claude (default) or codex. Started in tools/inject-matrix/scratch so it
  carries no project of its own.

.PARAMETER OrcaWorktree
  Orca worktree selector for the probe terminal, for example path:D:/some/repo. Default:
  the worktree of the Orca session the probe runs in (ORCA_WORKTREE_ID), else "active",
  which Orca resolves from the current directory. The probe opens one tab there and
  closes it again.
#>
[CmdletBinding()]
param(
  [ValidateSet('conhost', 'wt-pwsh', 'wt-ps5', 'wezterm', 'orca', 'wmux', 'warp')]
  [string[]]$Hosts = @('conhost', 'wt-pwsh', 'wt-ps5', 'wezterm', 'orca', 'wmux', 'warp'),
  [string]$OrcaWorktree = '',
  [int]$LandTimeoutMs = 10000,
  [int]$ReceiverMaxMinutes = 10,
  [ValidateSet('line', 'keys', 'agent')]
  [string]$Mode = 'line',
  [ValidateSet('claude', 'codex')]
  [string]$Agent = 'claude',
  [int]$ReplyTimeoutSec = 120
)

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $Here '..\..')).Path
$RunId = Get-Date -Format 'yyyyMMdd-HHmmss'
$Results = Join-Path $Here "results\$RunId"
New-Item -ItemType Directory -Force $Results | Out-Null
$Receiver = Join-Path $Here 'receiver.ps1'
$InjectOnce = Join-Path $Here 'inject-once.mjs'
$RawKey = Join-Path $Here 'rawkey.py'
$ReadScreen = Join-Path $Here 'read-screen.py'
$SendKey = Join-Path $Here 'send-key.py'
$Scratch = Join-Path $Here 'scratch'
New-Item -ItemType Directory -Force $Scratch | Out-Null

if (-not (Test-Path (Join-Path $RepoRoot 'dist\inject.js'))) { throw "dist/inject.js missing: run npm run build in $RepoRoot first" }

# Receivers started with Start-Process inherit this process's environment. Drop terminal
# identity variables so a receiver's .meta.json shows only what its own host set.
# The Orca CLI itself resolves "--worktree active" from the ORCA_* variables, so they are
# kept aside and restored around Orca CLI calls only (Invoke-Orca).
$OrcaEnv = @{}
Get-ChildItem Env: | Where-Object { $_.Name -like 'ORCA_*' } | ForEach-Object { $OrcaEnv[$_.Name] = $_.Value }
Get-ChildItem Env: | Where-Object { $_.Name -match '^(WEZTERM_|WT_SESSION|WT_PROFILE_ID|ORCA_|WMUX|WARP_|TERM_PROGRAM)' } |
  ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
if (-not $OrcaWorktree) { $OrcaWorktree = if ($OrcaEnv['ORCA_WORKTREE_ID']) { "id:$($OrcaEnv['ORCA_WORKTREE_ID'])" } else { 'active' } }
function Invoke-Orca([string[]]$a) {
  foreach ($k in $OrcaEnv.Keys) { Set-Item -LiteralPath "Env:$k" -Value $OrcaEnv[$k] }
  try { (& $OrcaCmd @a 2>&1 | Out-String).Trim() }
  finally { foreach ($k in $OrcaEnv.Keys) { Remove-Item -LiteralPath "Env:$k" -ErrorAction SilentlyContinue } }
}

$WtExe = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
$WezExe = (Get-Command wezterm -ErrorAction SilentlyContinue).Source
if (-not $WezExe -and (Test-Path 'C:\Program Files\WezTerm\wezterm.exe')) { $WezExe = 'C:\Program Files\WezTerm\wezterm.exe' }
$OrcaCmd = (Get-Command orca -ErrorAction SilentlyContinue).Source
if (-not $OrcaCmd) { $c = Join-Path $env:LOCALAPPDATA 'Programs\orca\resources\bin\orca.cmd'; if (Test-Path $c) { $OrcaCmd = $c } }
$WmuxCmd = Join-Path $env:LOCALAPPDATA 'wmux\bin\wmux.cmd'
$WmuxExe = Join-Path $env:LOCALAPPDATA 'wmux\wmux.exe'
$WarpExe = Join-Path $env:LOCALAPPDATA 'Programs\Warp\warp.exe'

function Log([string]$m) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  Add-Content -LiteralPath (Join-Path $Results 'run.log') -Value $line
}

function Q([string]$s) { if ($s -match '[\s"]') { '"' + $s.Replace('"', '\"') + '"' } else { $s } }
function ArgString([string[]]$a) { ($a | ForEach-Object { Q $_ }) -join ' ' }
# Every payload is launched the same way, as one generated -File script. Hosts that take a
# command line (Orca, wmux) would otherwise have to carry nested quotes through two layers.
function Payload-Args([string]$name) {
  $script = Join-Path $Results "launch-$name.ps1"
  # receiver.ps1 writes its own metadata; the other payloads get it from this preamble, so
  # every mode leaves the same <name>.meta.json (terminal variables, pid, parent).
  $metaPath = Join-Path $Results "$name.meta.json"
  $preamble = @(
    '$m = [ordered]@{ pid = $PID; ppid = (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID)).ParentProcessId; psVersion = "" + $PSVersionTable.PSVersion; env = [ordered]@{} }',
    '$m.env = [ordered]@{}',
    '$keep = "^(WEZTERM_|WT_|ORCA_|WMUX|WARP|TERM_PROGRAM|TERM$|SESSIONNAME)"',
    'Get-ChildItem Env: | Where-Object { $_.Name -match $keep } | ForEach-Object { $m.env[$_.Name] = $_.Value }',
    "`$m | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath '$metaPath' -Encoding utf8"
  ) -join "`r`n"
  $body = switch ($Mode) {
    'line' { "& '$Receiver' -Name '$name' -ResultsDir '$Results' -MaxMinutes $ReceiverMaxMinutes" }
    'keys' { $preamble + "`r`n" + "& python '$RawKey' '$name' '$Results' $ReceiverMaxMinutes" }
    'agent' {
      # The shell reports its own pid; the agent process is found underneath it.
      $cmd = if ($Agent -eq 'claude') { 'claude --dangerously-skip-permissions' } else { 'codex' }
      # One agent per route: the probe ends a session after its route and the loop starts
      # the next one, so no route inherits another's transcript or a turn still running.
      $cmd = "for (`$i = 1; `$i -le 8; `$i++) { $cmd; Start-Sleep -Seconds 1 }"
      @(
        $preamble,
        "Set-Content -LiteralPath '$(Join-Path $Results "$name.pid")' -Value `$PID -Encoding ascii",
        "Set-Location '$Scratch'",
        $cmd
      ) -join "`r`n"
    }
  }
  Set-Content -LiteralPath $script -Value $body -Encoding utf8
  # No -NoExit: when the payload ends, the shell ends and the host window closes itself.
  @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script)
}
function Receiver-Args([string]$name) { Payload-Args $name }
function Receiver-CommandLine([string]$name) { 'pwsh ' + (ArgString (Payload-Args $name)) }

function Wait-Receiver([string]$name, [int]$sec = 30) {
  $f = Join-Path $Results "$name.pid"
  $deadline = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $f) { $t = (Get-Content $f -Raw).Trim(); if ($t -match '^\d+$') { return [int]$t } }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

function Snapshot {
  $h = @{}
  foreach ($p in Get-CimInstance Win32_Process) { $h[[int]$p.ProcessId] = $p }
  $h
}

# Parent chain, stopping at an exited parent or a recycled pid (parent newer than child).
function Get-Chain($snap, [int]$procId) {
  $out = [System.Collections.Generic.List[object]]::new()
  $cur = $procId
  $seen = @{}
  while ($cur -and $snap.ContainsKey($cur) -and -not $seen.ContainsKey($cur)) {
    if ($HarnessLineage.ContainsKey($cur)) {
      # Shared with the harness. A terminal host (the probe may itself run inside Orca)
      # is still named and scanned for its console hosts; anything else is cut here.
      $n = $snap[$cur].Name
      if ($n -in $TerminalHostNames) { $out.Add([pscustomobject]@{ pid = $cur; name = $n }) }
      $out.Add([pscustomobject]@{ pid = $cur; name = '(probe harness lineage)' }); break
    }
    $seen[$cur] = $true
    $p = $snap[$cur]
    $out.Add([pscustomobject]@{ pid = $cur; name = $p.Name })
    $par = [int]$p.ParentProcessId
    if (-not $snap.ContainsKey($par)) { if ($par) { $out.Add([pscustomobject]@{ pid = $par; name = '(exited)' }) }; break }
    if ($snap[$par].CreationDate -gt $p.CreationDate) { $out.Add([pscustomobject]@{ pid = $par; name = "(recycled pid, now $($snap[$par].Name))" }); break }
    $cur = $par
  }
  $out
}
# The harness and its ancestors: a receiver launched with Start-Process is our child, and
# the walk must not wander into the session that runs the probe.
$TerminalHostNames = @('Orca.exe', 'WindowsTerminal.exe', 'wezterm-gui.exe', 'warp.exe', 'wmux.exe')
$HarnessLineage = @{}
$snap0 = Snapshot
$cur0 = $PID
while ($cur0 -and $snap0.ContainsKey($cur0) -and -not $HarnessLineage.ContainsKey($cur0)) { $HarnessLineage[$cur0] = $true; $cur0 = [int]$snap0[$cur0].ParentProcessId }
Remove-Variable snap0, cur0

function Chain-String($chain) { ($chain | ForEach-Object { "$($_.name)($($_.pid))" }) -join ' <- ' }

# conhost.exe / OpenConsole.exe whose parent is the receiver or one of its ancestors.
# Classic console: conhost is a child of the first console process (the shell), not headless.
# ConPTY: conhost/OpenConsole runs "--headless" as a child of the terminal emulator.
function Get-ConsoleHosts($snap, $chain) {
  $ids = @($chain | Where-Object { $_.name -notlike '(*' } | ForEach-Object { $_.pid })
  @($snap.Values | Where-Object { $_.Name -in 'conhost.exe', 'OpenConsole.exe' -and ([int]$_.ParentProcessId) -in $ids } | ForEach-Object {
      [pscustomobject]@{
        pid = [int]$_.ProcessId; name = $_.Name; parentPid = [int]$_.ParentProcessId
        parentName = $snap[[int]$_.ParentProcessId].Name
        headless = [bool]($_.CommandLine -match '--headless'); cmd = $_.CommandLine
      }
    })
}
function ConsoleHosts-String($hosts) {
  if (-not $hosts -or $hosts.Count -eq 0) { return 'none in chain' }
  $groups = $hosts | Group-Object name, parentName, headless
  ($groups | ForEach-Object {
      $h = $_.Group[0]
      $kind = if ($h.headless) { 'ConPTY --headless' } else { 'classic' }
      "$($_.Count)x $($h.name) ($kind) under $($h.parentName)($($h.parentPid))"
    }) -join '; '
}

function Invoke-Inject([int]$procId, [string]$text, $pane = $null, [string]$sock = $null) {
  $nodeArgs = @($InjectOnce, "$procId")
  if ($null -ne $pane) { $nodeArgs += "$pane"; if ($sock) { $nodeArgs += $sock } }
  $env:MATRIX_TEXT = $text
  Push-Location $RepoRoot
  try { $raw = & node @nodeArgs 2>&1 | Out-String } finally { Pop-Location; Remove-Item Env:MATRIX_TEXT -ErrorAction SilentlyContinue }
  $jsonLine = $raw -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1
  if ($jsonLine) { return $jsonLine | ConvertFrom-Json }
  [pscustomobject]@{ resolved = $false; error = "no JSON from inject-once: $($raw.Trim())"; ms = $null; log = @() }
}

function Wait-Landed([string]$name, [string]$marker, [datetime]$sentUtc, [int]$timeoutMs) {
  $f = Join-Path $Results "$name.log"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    if (Test-Path $f) {
      foreach ($l in (Get-Content -LiteralPath $f)) {
        $parts = $l -split "`t", 2
        if ($parts.Count -eq 2 -and $parts[1].Trim() -eq $marker) {
          $at = [DateTimeOffset]::Parse($parts[0].Trim([char]0xFEFF)).UtcDateTime
          return [pscustomobject]@{ landed = $true; exact = $true; latencyMs = [int]($at - $sentUtc).TotalMilliseconds; line = $parts[1] }
        }
        if ($l -like "*$marker*") { return [pscustomobject]@{ landed = $true; exact = $false; latencyMs = $null; line = $l } }
      }
    }
    Start-Sleep -Milliseconds 100
  }
  [pscustomobject]@{ landed = $false; exact = $false; latencyMs = $null; line = $null }
}

function New-Marker([string]$name, [string]$tag) { 'INJECT-{0}-{1}-{2}' -f $name, $tag, (Get-Random -Minimum 10000000 -Maximum 99999999) }

# Console backend, up to three attempts with 1 s gaps. Mode "receiver" types the marker
# into receiver.ps1; mode "shell-exec" types a command that appends the marker to the log
# (used where no receiver can be started without typing, i.e. Warp).
function Probe-Console([string]$name, [int]$procId, [string]$mode) {
  $attempts = [System.Collections.Generic.List[object]]::new()
  for ($i = 1; $i -le 3; $i++) {
    $marker = New-Marker $name "a$i"
    $text = $marker
    if ($mode -eq 'shell-exec') {
      $log = Join-Path $Results "$name.log"
      $text = "Add-Content -LiteralPath '$log' -Value ([DateTime]::UtcNow.ToString('o') + [char]9 + '$marker')"
    }
    $sent = [DateTime]::UtcNow
    $r = Invoke-Inject $procId $text
    $l = Wait-Landed $name $marker $sent $LandTimeoutMs
    $a = [pscustomobject]@{
      attempt = $i; marker = $marker; injectorResolved = $r.resolved; error = $r.error; helperMs = $r.ms
      landed = $l.landed; exact = $l.exact; latencyMs = $l.latencyMs; injectorLog = (@($r.log) -join ' | ')
    }
    $attempts.Add($a)
    Log ("  console attempt {0}: resolved={1} landed={2} latency={3}ms error={4}" -f $i, $r.resolved, $l.landed, $l.latencyMs, $r.error)
    if ($l.landed) { break }
    Start-Sleep -Seconds 1
  }
  $warm = $null
  if (@($attempts | Where-Object landed).Count) {
    # One more once the host is known to be reading: latency without startup effects.
    Start-Sleep -Seconds 1
    $marker = New-Marker $name 'warm'
    $text = if ($mode -eq 'shell-exec') { "Add-Content -LiteralPath '$(Join-Path $Results "$name.log")' -Value ([DateTime]::UtcNow.ToString('o') + [char]9 + '$marker')" } else { $marker }
    $sent = [DateTime]::UtcNow
    $r = Invoke-Inject $procId $text
    $l = Wait-Landed $name $marker $sent $LandTimeoutMs
    $warm = [pscustomobject]@{ landed = $l.landed; latencyMs = $l.latencyMs; resolved = $r.resolved; error = $r.error }
    Log ("  console warm: resolved={0} landed={1} latency={2}ms" -f $r.resolved, $l.landed, $l.latencyMs)
  }
  [pscustomobject]@{ attempts = $attempts.ToArray(); warm = $warm }
}

function Stop-Receiver([string]$name, $procId) {
  if (-not $procId) { return 'no receiver' }
  New-Item -ItemType File -Force (Join-Path $Results "$name.quit") | Out-Null
  $deadline = (Get-Date).AddSeconds(6)
  while ((Get-Date) -lt $deadline) { if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { return 'exited on quit file' }; Start-Sleep -Milliseconds 250 }
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  return 'did not exit, stopped'
}

# Terminal GUI processes the probe started (in a receiver chain, not running before the
# run) must be gone once their last shell has exited; stop any that linger.
$GuiNames = @('WindowsTerminal.exe', 'wezterm-gui.exe', 'wezterm.exe')
$PreExisting = @{}
foreach ($p in Get-Process -ErrorAction SilentlyContinue) { $PreExisting[$p.Id] = $true }
function Reap-Gui($chain) {
  $notes = @()
  foreach ($c in $chain) {
    if ($c.name -eq 'WindowsTerminal.exe' -and $PreExisting.ContainsKey($c.pid)) {
      # Shared process: the probe's window lives in someone else's WindowsTerminal.exe, so
      # it cannot be stopped by pid. Close it only once no shell runs under it at all.
      Start-Sleep -Seconds 2
      $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($c.pid)" | Where-Object { $_.Name -notin 'conhost.exe', 'OpenConsole.exe' })
      $proc = Get-Process -Id $c.pid -ErrorAction SilentlyContinue
      if ($proc -and $kids.Count -eq 0 -and $proc.MainWindowHandle -ne 0) {
        $proc.CloseMainWindow() | Out-Null
        $notes += "closed an empty window in the shared WindowsTerminal.exe($($c.pid))"
      } elseif ($kids.Count) {
        $notes += "left WindowsTerminal.exe($($c.pid)) alone: $($kids.Count) other shell(s) still in it"
      }
      continue
    }
    if ($c.name -in $GuiNames -and -not $PreExisting.ContainsKey($c.pid)) {
      $deadline = (Get-Date).AddSeconds(6)
      while ((Get-Date) -lt $deadline -and (Get-Process -Id $c.pid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 300 }
      if (Get-Process -Id $c.pid -ErrorAction SilentlyContinue) { Stop-Process -Id $c.pid -Force -ErrorAction SilentlyContinue; $notes += "$($c.name)($($c.pid)) lingered, stopped" }
      else { $notes += "$($c.name)($($c.pid)) exited by itself" }
    }
  }
  $notes -join '; '
}

function Invoke-Wmux([string[]]$a) { (& $WmuxCmd @a 2>&1 | Out-String).Trim() }
function Warp-Shells {
  @(Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='powershell.exe'" | Where-Object { $_.CommandLine -match '_warpSessionId' } | ForEach-Object { [int]$_.ProcessId })
}

# --------------------------------------------------------------------------------------
# Launchers. Each returns @{ started; pid; mode; note; ctx } and never throws.
# --------------------------------------------------------------------------------------

function Launch-Conhost {
  $p = Start-Process pwsh -ArgumentList (ArgString (Receiver-Args 'conhost')) -PassThru
  $rp = Wait-Receiver 'conhost'
  @{ started = [bool]$rp; pid = $rp; mode = 'receiver'; note = "Start-Process pwsh (launcher pid $($p.Id))"; ctx = @{} }
}

function Launch-WT([string]$name, [string]$shell) {
  if (-not (Test-Path $WtExe)) { return @{ started = $false; note = "wt.exe not found at $WtExe" } }
  $a = "-w new --title inject-matrix-$name $shell " + (ArgString (Receiver-Args $name))
  Start-Process $WtExe -ArgumentList $a | Out-Null
  $rp = Wait-Receiver $name
  @{ started = [bool]$rp; pid = $rp; mode = 'receiver'; note = "wt.exe -w new $shell"; ctx = @{} }
}

function Launch-WezTerm {
  if (-not $WezExe) { return @{ started = $false; note = 'wezterm not on PATH nor in C:\Program Files\WezTerm' } }
  $ver = (& $WezExe --version 2>&1 | Out-String).Trim()
  # "start" launches a GUI; it never touches the cli mux, so no --no-auto-start concern here.
  Start-Process $WezExe -ArgumentList ('start --always-new-process -- pwsh ' + (ArgString (Receiver-Args 'wezterm'))) | Out-Null
  $rp = Wait-Receiver 'wezterm'
  @{ started = [bool]$rp; pid = $rp; mode = 'receiver'; note = "wezterm start --always-new-process ($ver)"; ctx = @{} }
}

function Launch-Orca {
  if (-not $OrcaCmd) { return @{ started = $false; note = 'orca CLI not found' } }
  $raw = Invoke-Orca @('terminal', 'create', '--worktree', $OrcaWorktree, '--shell', 'pwsh.exe', '--title', 'inject-matrix-orca', '--command', (Receiver-CommandLine 'orca'), '--json')
  Set-Content -LiteralPath (Join-Path $Results 'orca-create.json') -Value $raw
  $handle = if ($raw -match '"handle"\s*:\s*"(term_[^"]+)"') { $Matches[1] } else { $null }
  if (-not $handle) { return @{ started = $false; note = "orca terminal create gave no handle: $($raw.Trim())"; ctx = @{} } }
  $rp = Wait-Receiver 'orca' 45
  @{ started = [bool]$rp; pid = $rp; mode = 'receiver'; note = "orca terminal create --worktree $OrcaWorktree --shell pwsh.exe, handle $handle"; ctx = @{ handle = $handle } }
}

function Launch-Wmux {
  if (-not (Test-Path $WmuxCmd)) { return @{ started = $false; note = "wmux CLI not found at $WmuxCmd" } }
  $ctx = @{ startedApp = $false; appPids = @() }
  $probe = Invoke-Wmux @('list-workspaces', '--json')
  if ($probe -match 'not running') {
    $before = @(Get-Process wmux -ErrorAction SilentlyContinue | ForEach-Object Id)
    $ctx.startedApp = $true
    # Two tries: once in testing a fresh launch never answered on its pipe within 40 s,
    # while a relaunch came up in 3 s.
    for ($try = 1; $try -le 2 -and $probe -match 'not running'; $try++) {
      if ($try -gt 1) {
        Get-Process wmux -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $before } | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        Log '  wmux did not answer within 40 s; relaunching once'
      }
      Start-Process $WmuxExe | Out-Null
      $deadline = (Get-Date).AddSeconds(40)
      do { Start-Sleep -Seconds 2; $probe = Invoke-Wmux @('list-workspaces', '--json') } while ($probe -match 'not running' -and (Get-Date) -lt $deadline)
    }
    $ctx.appPids = @(Get-Process wmux -ErrorAction SilentlyContinue | ForEach-Object Id | Where-Object { $_ -notin $before })
  }
  if ($probe -match 'not running') { return @{ started = $false; note = 'wmux app did not answer on its pipe after two launches of 40 s each'; ctx = $ctx } }
  $created = ''
  $deadline = (Get-Date).AddSeconds(60)
  do {
    $created = Invoke-Wmux @('new-workspace', '--name', 'inject-matrix', '--json')
    if ($created -notmatch 'still starting|paneGate=pending|"retryable"\s*:\s*true') { break }
    Log '  wmux is still starting (paneGate pending); retrying new-workspace'
    Start-Sleep -Seconds 4
  } while ((Get-Date) -lt $deadline)
  Set-Content -LiteralPath (Join-Path $Results 'wmux-new-workspace.json') -Value $created
  $wsId = if ($created -match '"id"\s*:\s*"(ws-[^"]+)"') { $Matches[1] } elseif ($created -match '(ws-[0-9a-f-]{36})') { $Matches[1] } else { $null }
  if (-not $wsId) { return @{ started = $false; note = "wmux new-workspace gave no id: $created"; ctx = $ctx } }
  $ctx.workspace = $wsId
  Start-Sleep -Seconds 3
  $list = Invoke-Wmux @('list-workspaces', '--json') | ConvertFrom-Json
  $ws = $list | Where-Object id -eq $wsId
  $pty = $ws.activePtyId
  $ctx.pty = $pty
  $send = Invoke-Wmux @('send', (Receiver-CommandLine 'wmux'), '--submit', '--pane', $pty, '--json')
  $ctx.bootstrapSend = $send
  $rp = Wait-Receiver 'wmux' 30
  @{ started = [bool]$rp; pid = $rp; mode = 'receiver'; note = "wmux new-workspace $wsId, receiver started with wmux send --submit --pane $pty"; ctx = $ctx }
}

function Launch-Warp {
  if (-not (Test-Path $WarpExe)) { return @{ started = $false; note = "warp.exe not found at $WarpExe" } }
  $ctx = @{ startedApp = $false; appPids = @() }
  $running = @(Get-Process warp -ErrorAction SilentlyContinue | ForEach-Object Id)
  if ($running.Count -eq 0) {
    Start-Process $WarpExe | Out-Null
    $ctx.startedApp = $true
    $deadline = (Get-Date).AddSeconds(30)
    do { Start-Sleep -Seconds 2 } while ((Warp-Shells).Count -eq 0 -and (Get-Date) -lt $deadline)
    Start-Sleep -Seconds 2
    $ctx.appPids = @(Get-Process warp -ErrorAction SilentlyContinue | ForEach-Object Id)
  }
  $ctx.shellsBefore = Warp-Shells
  $uriPath = [Uri]::EscapeDataString($Results)
  Start-Process "warp://action/new_tab?path=$uriPath" | Out-Null
  $new = $null
  $deadline = (Get-Date).AddSeconds(20)
  while (-not $new -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $new = Warp-Shells | Where-Object { $_ -notin $ctx.shellsBefore } | Select-Object -First 1
  }
  if (-not $new) { return @{ started = $false; note = 'warp://action/new_tab produced no new Warp shell within 20 s'; ctx = $ctx } }
  Start-Sleep -Seconds 5   # let the Warp bootstrap reach its first prompt
  $ctl = & $WarpExe --warpctrl instance list --output-format json 2>&1 | Out-String
  $ctx.warpctrlInstances = $ctl.Trim()
  if ($Mode -eq 'line') {
    # Line mode measures the tab's own shell: the marker is a command that logs itself.
    return @{ started = $true; pid = $new; mode = 'shell-exec'; note = "warp://action/new_tab, tab shell pid $new (no receiver: Warp has no CLI way to run a command in a new tab)"; ctx = $ctx }
  }
  # Keys and agent modes need the payload running inside the tab. Warp has no CLI to start
  # a command in a new tab, so the payload is typed into the tab's shell with the console
  # route, which conhost and every other host already proved. The payload then reports its
  # own pid, exactly as in the other hosts.
  $script = Join-Path $Results 'launch-warp.ps1'
  Payload-Args 'warp' | Out-Null    # writes the launch script
  $boot = Invoke-Inject $new "& '$script'"
  $ctx.bootstrap = "typed the payload into the Warp tab shell: resolved=$($boot.resolved) $($boot.error)"
  $rp = Wait-Receiver 'warp' 60
  @{ started = [bool]$rp; pid = $rp; mode = 'receiver'; note = "warp://action/new_tab, tab shell pid $new, payload typed in (pid $rp)"; ctx = $ctx }
}

# --------------------------------------------------------------------------------------
# Native routes
# --------------------------------------------------------------------------------------

function Native-WezTerm([string]$name, $meta) {
  $pane = $meta.env.WEZTERM_PANE; $sock = $meta.env.WEZTERM_UNIX_SOCKET
  if (-not $pane) { return [pscustomobject]@{ route = 'wezterm cli send-text (project backend)'; landed = $false; detail = 'receiver saw no WEZTERM_PANE' } }
  $marker = New-Marker $name 'native'
  $sent = [DateTime]::UtcNow
  # pid 0: no console fallback, so this measures the WezTerm backend alone.
  $r = Invoke-Inject 0 $marker ([int]$pane) $sock
  $l = Wait-Landed $name $marker $sent $LandTimeoutMs
  $detail = $r.error
  if (-not $l.landed -and $r.resolved) {
    # Diagnostic: was the text delivered but left unsubmitted? Send a lone CR the same way
    # (wezterm cli send-text --no-paste) and see whether the marker then arrives.
    $psi = [Diagnostics.ProcessStartInfo]::new($WezExe)
    foreach ($a in @('cli', '--no-auto-start', 'send-text', '--pane-id', "$pane", '--no-paste')) { $psi.ArgumentList.Add($a) }
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
    if ($sock) { $psi.Environment['WEZTERM_UNIX_SOCKET'] = $sock }
    $p = [Diagnostics.Process]::Start($psi); $p.StandardInput.Write("`r"); $p.StandardInput.Close(); $p.WaitForExit(5000) | Out-Null
    $l2 = Wait-Landed $name $marker $sent $LandTimeoutMs
    $detail = if ($l2.landed) { 'inject resolved; text stayed unsubmitted in the line (backend ends with LF); a lone CR sent afterwards submitted it' } else { 'inject resolved; nothing arrived, not even after a lone CR' }
  }
  [pscustomobject]@{ route = "inject(0, text, pane $pane) with WEZTERM_UNIX_SOCKET"; landed = $l.landed; latencyMs = $l.latencyMs; resolved = $r.resolved; detail = $detail }
}

function Native-Orca([string]$name, $ctx) {
  $marker = New-Marker $name 'native'
  $sent = [DateTime]::UtcNow
  $raw = Invoke-Orca @('terminal', 'send', '--terminal', $ctx.handle, '--text', $marker, '--enter', '--json')
  Set-Content -LiteralPath (Join-Path $Results 'orca-send.json') -Value $raw
  $l = Wait-Landed $name $marker $sent $LandTimeoutMs
  $sum = try {
    $j = $raw | ConvertFrom-Json
    $pr = $j.result.send.prompt
    "ok=$($j.ok) accepted=$($j.result.send.accepted) stages=$(@($pr.stages) -join ',') provider=$($pr.provider) observation=$($pr.observation) warnings=$(@($j.result.warnings) -join ' ')"
  } catch { 'unparsed' }
  [pscustomobject]@{ route = 'orca terminal send --text --enter --json'; landed = $l.landed; latencyMs = $l.latencyMs; detail = $raw; summary = $sum }
}

function Native-Wmux([string]$name, $ctx) {
  $marker = New-Marker $name 'native'
  $sent = [DateTime]::UtcNow
  $raw = Invoke-Wmux @('send', $marker, '--submit', '--pane', $ctx.pty, '--json')
  $l = Wait-Landed $name $marker $sent $LandTimeoutMs
  Start-Sleep -Milliseconds 1500   # let any Enter retry land so the blank-line count is honest
  $blank = @(Get-Content -LiteralPath (Join-Path $Results "$name.log") | Where-Object { ($_ -split "`t", 2)[1] -eq '' }).Count
  $sum = try {
    $j = $raw | ConvertFrom-Json
    "ok=$($j.ok) submitted=$($j.submitted) accepted=$($j.accepted) receiptSignal=$($j.receiptSignal) enterRetried=$($j.enterRetried); blank lines received=$blank"
  } catch { 'unparsed' }
  [pscustomobject]@{ route = "wmux send --submit --pane $($ctx.pty)"; landed = $l.landed; latencyMs = $l.latencyMs; detail = $raw; summary = $sum }
}

# --------------------------------------------------------------------------------------
# Routes, shared by keys mode and agent mode
# --------------------------------------------------------------------------------------

# Which routes apply to a host. "console" is the injector's Windows backend; the others
# are the host's own input API, as Joind would use it.
function Routes-For([string]$hostName) {
  switch ($hostName) {
    'wezterm' { @('console', 'wezterm-lf', 'wezterm-cr') }
    'orca' { @('console', 'orca-send') }
    'wmux' { @('console', 'wmux-submit', 'wmux-sendkey') }
    default { @('console') }
  }
}

function WezTerm-SendText([string]$pane, [string]$sock, [string]$payload) {
  $psi = [Diagnostics.ProcessStartInfo]::new($WezExe)
  foreach ($a in @('cli', '--no-auto-start', 'send-text', '--pane-id', "$pane", '--no-paste')) { $psi.ArgumentList.Add($a) }
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  if ($sock) { $psi.Environment['WEZTERM_UNIX_SOCKET'] = $sock }
  $p = [Diagnostics.Process]::Start($psi)
  $p.StandardInput.Write($payload)
  $p.StandardInput.Close()
  $p.WaitForExit(8000) | Out-Null
  "exit $($p.ExitCode) $($p.StandardError.ReadToEnd().Trim())"
}

# Sends $text through one route. $procId is the process that reads input (the receiver, or
# the agent). Returns what the route itself reported, never whether anything arrived.
function Send-Route([string]$route, [int]$procId, [string]$text, $meta, $ctx) {
  switch ($route) {
    'console' {
      $r = Invoke-Inject $procId $text
      "inject() resolved=$($r.resolved)$(if ($r.error) { " error=$($r.error)" })"
    }
    'wezterm-lf' {
      # The backend as shipped: injectWezTerm writes the text and a line feed.
      $r = Invoke-Inject 0 $text ([int]$meta.env.WEZTERM_PANE) $meta.env.WEZTERM_UNIX_SOCKET
      "injectWezTerm resolved=$($r.resolved)$(if ($r.error) { " error=$($r.error)" })"
    }
    'wezterm-cr' {
      # Same call path, but the text ends with a carriage return instead.
      WezTerm-SendText $meta.env.WEZTERM_PANE $meta.env.WEZTERM_UNIX_SOCKET ($text + "`r")
    }
    'orca-send' {
      $raw = Invoke-Orca @('terminal', 'send', '--terminal', $ctx.handle, '--text', $text, '--enter', '--json')
      Add-Content -LiteralPath (Join-Path $Results 'orca-send-routes.json') -Value $raw
      try {
        $j = $raw | ConvertFrom-Json
        $pr = $j.result.send.prompt
        "ok=$($j.ok) accepted=$($j.result.send.accepted) stages=$(@($pr.stages) -join ',') provider=$($pr.provider) observation=$($pr.observation)$(if ($j.result.warnings) { " warnings=$(@($j.result.warnings) -join ' ')" })"
      } catch { $raw }
    }
    'wmux-submit' { (Invoke-Wmux @('send', $text, '--submit', '--pane', $ctx.pty, '--json')) -replace '\s+', ' ' }
    'wmux-sendkey' {
      # Text and Enter as two calls, which avoids wmux's own Enter retry.
      $a = Invoke-Wmux @('send', $text, '--pane', $ctx.pty, '--json')
      Start-Sleep -Milliseconds 400
      $b = Invoke-Wmux @('send-key', 'Enter', '--pane', $ctx.pty, '--json')
      ("send: $a; send-key: $b") -replace '\s+', ' '
    }
  }
}

# --------------------------------------------------------------------------------------
# Keys mode: which code points does each route actually deliver?
# --------------------------------------------------------------------------------------

function Read-Keys([string]$name) {
  $f = Join-Path $Results "$name.keys.log"
  if (Test-Path $f) { @(Get-Content -LiteralPath $f) } else { @() }
}

# What ended the text: the trailing control code points, in order.
function Keys-Summary($lines) {
  $codes = @($lines | ForEach-Object { ($_ -split "`t")[1] })
  $tail = @()
  for ($i = $codes.Count - 1; $i -ge 0 -and $codes[$i] -in 'U+000D', 'U+000A', 'U+0009', 'U+001B'; $i--) { $tail = , $codes[$i] + $tail }
  [pscustomobject]@{ total = $codes.Count; terminator = ($tail -join ' + '); all = ($codes -join ' ') }
}

function Probe-Keys([string]$name, [int]$procId, $meta, $ctx) {
  $out = [System.Collections.Generic.List[object]]::new()
  foreach ($route in (Routes-For $name)) {
    $before = (Read-Keys $name).Count
    $marker = New-Marker $name $route
    $sent = [DateTime]::UtcNow
    $detail = try { Send-Route $route $procId $marker $meta $ctx } catch { "route threw: $($_.Exception.Message)" }
    Start-Sleep -Milliseconds 2000
    $after = Read-Keys $name
    $new = @($after | Select-Object -Skip $before)
    $sum = Keys-Summary $new
    $delivered = $new.Count -gt 0
    $term = if ($sum.terminator) { $sum.terminator } elseif ($delivered) { 'none: no Enter key arrived' } else { 'nothing arrived' }
    $lat = $null
    if ($delivered) { $lat = [int]([DateTimeOffset]::Parse((($new[0]) -split "`t")[0]).UtcDateTime - $sent).TotalMilliseconds }
    $out.Add([pscustomobject]@{
        route = $route; delivered = $delivered; codePoints = $new.Count; terminator = $term
        latencyMs = $lat; routeSaid = $detail
      })
    Log "  keys/$route : delivered=$delivered codePoints=$($new.Count) terminator=$term"
  }
  $out.ToArray()
}

# --------------------------------------------------------------------------------------
# Agent mode: does a real Claude Code or Codex TUI actually submit the prompt?
# --------------------------------------------------------------------------------------

$AgentPrompt = 'reply with exactly the word PONG and nothing else'

function Read-AgentScreen([int]$procId, [int]$lines = 60) {
  $raw = & python $ReadScreen $procId $lines 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { return '' }
  $raw
}

# A reply is a screen line that is just PONG, box drawing and bullets aside. The prompt is
# a whole sentence, so its echo never matches.
function Pong-Count([string]$screen) { @([regex]::Matches($screen, '(?m)^[^A-Za-z0-9]*PONG[^A-Za-z0-9]*$')).Count }

# Submission and reply are different facts. A prompt that sits in the input box was never
# submitted; one that has moved up into the transcript was, even if the answer is slow (a
# Claude Code session running SessionStart hooks took 84 s to answer once). The input box
# is the last few lines of the screen, under the status rows.
function Prompt-Submitted([string]$screen) {
  $lines = @($screen -split "`r?`n" | Where-Object { $_.Trim() })
  if ($lines.Count -eq 0) { return $false }
  $tail = @($lines | Select-Object -Last 8)
  $inBox = @($tail | Where-Object { $_ -like "*$AgentPrompt*" }).Count -gt 0
  $anywhere = @($lines | Where-Object { $_ -like "*$AgentPrompt*" }).Count -gt 0
  (-not $inBox) -and $anywhere
}

function Find-AgentPid([int]$shellPid) {
  $wanted = if ($Agent -eq 'claude') { @('claude.exe') } else { @('codex.exe', 'node.exe') }
  $snap = Snapshot
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($shellPid)
  $seen = 0
  while ($queue.Count -gt 0 -and $seen -lt 400) {
    $seen++
    $cur = $queue.Dequeue()
    foreach ($c in $snap.Values | Where-Object { [int]$_.ParentProcessId -eq $cur }) {
      if ($c.Name -in $wanted) { return [int]$c.ProcessId }
      $queue.Enqueue([int]$c.ProcessId)
    }
  }
  0
}

# Both agents ask once whether the folder is trusted. That menu needs an arrow key, which
# the injector cannot send, so setup uses send-key.py. Claude Code defaults to "No, exit",
# so it takes Down then Enter; Codex defaults to "Yes, continue", so Enter is enough.
function Wait-AgentReady([int]$agentPid, [int]$timeoutSec = 240) {
  $ready = if ($Agent -eq 'claude') { 'bypass permissions|for shortcuts|Welcome back' } else { 'Ask Codex to do anything' }
  $trust = 'trust the contents|I trust this folder|Quick safety check|Do you trust'
  # Codex offers to update itself on startup, with "Update now" selected. A bare Enter
  # there would run npm install -g and upgrade the user's Codex, which a probe must never
  # do, so this answers with Down then Enter to take "Skip".
  $update = 'Update available|Update now \(runs|Skip until next version'
  $answered = $false
  $skippedUpdate = $false
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $agentPid -ErrorAction SilentlyContinue)) { return 'agent exited before it was ready' }
    $screen = Read-AgentScreen $agentPid 40
    # The status bar appears before the session is really usable: Claude Code can still be
    # running SessionStart hooks, and a prompt typed then can sit unsubmitted for over a
    # minute. Wait for the work indicator to clear too.
    if ($screen -match $ready -and $screen -notmatch 'SessionStart hooks|esc to interrupt') { return 'ready' }
    if ($screen -match 'SessionStart hooks') { Start-Sleep -Seconds 3; continue }
    if (-not $skippedUpdate -and $screen -match $update -and $screen -match 'Press enter to continue') {
      & python $SendKey $agentPid down enter | Out-Null
      $skippedUpdate = $true
      Log '  declined the agent self-update prompt (Down, Enter: Skip)'
      Start-Sleep -Seconds 4
      continue
    }
    if (-not $answered -and $screen -match $trust) {
      $keys = if ($Agent -eq 'claude') { @('down', 'enter') } else { @('enter') }
      & python $SendKey $agentPid @keys | Out-Null
      $answered = $true
      Log "  answered the folder-trust prompt with: $($keys -join ' ')"
      Start-Sleep -Seconds 4
    }
    Start-Sleep -Seconds 2
  }
  'never reached its input box'
}

# read-screen.py sees the visible window, not the scrollback, so an older reply scrolls out
# of view as the transcript grows and a plain count of PONG lines can fall as well as rise.
# Each route therefore starts from a cleared transcript, so one PONG line means this route's
# own reply. The clear goes through the console route, which every host accepted.
function Reset-AgentScreen([int]$agentPid) {
  $cmd = if ($Agent -eq 'claude') { '/clear' } else { '/new' }
  for ($i = 1; $i -le 2; $i++) {
    Invoke-Inject $agentPid $cmd | Out-Null
    # Codex leaves the line unsubmitted after one Enter, so the reset gets a second one.
    if ($Agent -eq 'codex') { Start-Sleep -Seconds 2; & python $SendKey $agentPid enter | Out-Null }
    Start-Sleep -Seconds 4
    if ((Pong-Count (Read-AgentScreen $agentPid)) -eq 0) { return $true }
  }
  $false
}

# Do not type over a turn that is still running.
function Wait-AgentIdle([int]$agentPid, [int]$timeoutSec = 60) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    $screen = Read-AgentScreen $agentPid
    if ($screen -notmatch 'esc to interrupt|to interrupt\)') { return $true }
    Start-Sleep -Seconds 2
  }
  $false
}

$ShellPidForAgent = 0
$AgentPidsSeen = [System.Collections.Generic.List[int]]::new()
function Probe-Agent([string]$name, [int]$agentPid, $meta, $ctx) {
  $out = [System.Collections.Generic.List[object]]::new()
  foreach ($route in (Routes-For $name)) {
    if (-not (Get-Process -Id $agentPid -ErrorAction SilentlyContinue)) {
      $out.Add([pscustomobject]@{ route = $route; submitted = $false; routeSaid = 'agent had exited before this route ran' })
      continue
    }
    $baseline = Pong-Count (Read-AgentScreen $agentPid)
    if ($baseline -ne 0) { Log "  warning: $route starts with $baseline PONG line(s) already on screen" }
    $sent = [DateTime]::UtcNow
    $said = try { Send-Route $route $agentPid $AgentPrompt $meta $ctx } catch { "route threw: $($_.Exception.Message)" }
    $replied = $false
    $submitted = $false
    $screen = ''
    $deadline = (Get-Date).AddSeconds($ReplyTimeoutSec)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 2
      $screen = Read-AgentScreen $agentPid
      if (-not $submitted -and (Prompt-Submitted $screen)) { $submitted = $true }
      if ((Pong-Count $screen) -gt $baseline) { $replied = $true; $submitted = $true; break }
    }
    $ms = [int]([DateTime]::UtcNow - $sent).TotalMilliseconds
    # Not submitted: one extra Enter tells "arrived but unsubmitted" apart from "never arrived".
    $afterEnter = $null
    $inputLine = $null
    if (-not $replied -and -not $submitted) {
      $inputLine = (@($screen -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -Last 14) -join ' / '
      & python $SendKey $agentPid enter | Out-Null
      $afterEnter = $false
      $d2 = (Get-Date).AddSeconds($ReplyTimeoutSec)
      while ((Get-Date) -lt $d2) {
        Start-Sleep -Seconds 2
        if ((Pong-Count (Read-AgentScreen $agentPid)) -gt $baseline) { $afterEnter = $true; break }
      }
    }
    Set-Content -LiteralPath (Join-Path $Results "$name.$route.screen.txt") -Value $screen -Encoding utf8
    if (-not $replied) { Set-Content -LiteralPath (Join-Path $Results "$name.$route.after-extra-enter.txt") -Value (Read-AgentScreen $agentPid) -Encoding utf8 }
    $out.Add([pscustomobject]@{
        route = $route; submitted = $submitted; replied = $replied; replyMs = $(if ($replied) { $ms } else { $null })
        submittedAfterExtraEnter = $afterEnter; inputLineWhenNotSubmitted = $inputLine; routeSaid = $said
      })
    Log "  agent/$route : submitted=$submitted replied=$replied replyMs=$(if ($replied) { $ms } else { 'n/a' }) extraEnterWorked=$afterEnter"
    # End this session and pick up the fresh one the payload loop starts.
    if ($route -ne (Routes-For $name)[-1]) {
      $old = $agentPid
      Log "  ending the session after $route : $(Stop-Agent $old)"
      $agentPid = 0
      $deadline = (Get-Date).AddSeconds(90)
      while (-not $agentPid -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $found = Find-AgentPid $ShellPidForAgent
        if ($found -and $found -ne $old) { $agentPid = $found }
      }
      if (-not $agentPid) { Log '  no fresh agent session appeared; the remaining routes stop here'; break }
      $AgentPidsSeen.Add($agentPid)
      $state = Wait-AgentReady $agentPid
      Log "  fresh agent pid $agentPid : $state"
      if ($state -ne 'ready') { break }
    }
  }
  $out.ToArray()
}

function Stop-Agent([int]$agentPid) {
  if (-not $agentPid -or -not (Get-Process -Id $agentPid -ErrorAction SilentlyContinue)) { return 'agent already exited' }
  if ($Agent -eq 'claude') { Invoke-Inject $agentPid '/exit' | Out-Null } else { & python $SendKey $agentPid ctrl-c | Out-Null }
  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $agentPid -ErrorAction SilentlyContinue)) { return "agent exited on $(if ($Agent -eq 'claude') { '/exit' } else { 'ctrl-c' })" }
    Start-Sleep -Milliseconds 500
  }
  & python $SendKey $agentPid ctrl-c | Out-Null
  Start-Sleep -Seconds 3
  if (Get-Process -Id $agentPid -ErrorAction SilentlyContinue) { Stop-Process -Id $agentPid -Force -ErrorAction SilentlyContinue; return 'agent did not exit, stopped' }
  'agent exited on ctrl-c'
}


# --------------------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------------------

$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Log "run $RunId, elevated=$elevated, hosts: $($Hosts -join ', ')"
$rows = [System.Collections.Generic.List[object]]::new()

foreach ($h in $Hosts) {
  Log "== $h"
  $launch = $null; $row = $null
  try {
    $launch = switch ($h) {
      'conhost' { Launch-Conhost }
      'wt-pwsh' { Launch-WT 'wt-pwsh' 'pwsh' }
      'wt-ps5' { Launch-WT 'wt-ps5' 'powershell' }
      'wezterm' { Launch-WezTerm }
      'orca' { Launch-Orca }
      'wmux' { Launch-Wmux }
      'warp' { Launch-Warp }
    }
  } catch { $launch = @{ started = $false; note = "launcher threw: $($_.Exception.Message)"; ctx = @{} } }
  if (-not $launch.ctx) { $launch.ctx = @{} }
  Log "  launch: started=$($launch.started) pid=$($launch.pid) $($launch.note)"

  $row = [ordered]@{ host = $h; started = [bool]$launch.started; pid = $launch.pid; mode = $launch.mode; launchNote = $launch.note; chain = $null; consoleHosts = @(); meta = $null; attempts = @(); warm = $null; native = $null; routes = @(); agentPid = $null; agentState = $null; cleanup = $null; ctx = $launch.ctx }
  $chain = @()
  try {
    if ($launch.started) {
      $snap = Snapshot
      $chain = Get-Chain $snap $launch.pid
      $row.chain = Chain-String $chain
      $row.consoleHosts = Get-ConsoleHosts $snap $chain
      $metaFile = Join-Path $Results "$h.meta.json"
      if (Test-Path $metaFile) { $row.meta = Get-Content $metaFile -Raw | ConvertFrom-Json }
      Log "  chain: $($row.chain)"
      Log "  console hosts: $(ConsoleHosts-String $row.consoleHosts)"
      if ($Mode -eq 'line') {
        $probe = Probe-Console $h $launch.pid $launch.mode
        $row.attempts = $probe.attempts
        $row.warm = $probe.warm
        switch ($h) {
          'wezterm' { $row.native = Native-WezTerm $h $row.meta }
          'orca' { $row.native = Native-Orca $h $launch.ctx }
          'wmux' { $row.native = Native-Wmux $h $launch.ctx }
        }
        if ($row.native) { Log "  native: $($row.native.route) landed=$($row.native.landed) $(if ($row.native.summary) { $row.native.summary } else { $row.native.detail })" }
      }
      elseif ($Mode -eq 'keys') {
        $row.routes = Probe-Keys $h $launch.pid $row.meta $launch.ctx
      }
      else {
        # The shell reported its pid; the agent underneath it is the process that reads input.
        $agentPid = 0
        $deadline = (Get-Date).AddSeconds(60)
        while (-not $agentPid -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2; $agentPid = Find-AgentPid $launch.pid }
        $row.agentPid = $agentPid
        if (-not $agentPid) { $row.agentState = "no $Agent process appeared under shell $($launch.pid) within 60 s" }
        else {
          $row.agentState = Wait-AgentReady $agentPid
          Log "  agent pid $agentPid ($Agent): $($row.agentState)"
          $script:ShellPidForAgent = $launch.pid
          $AgentPidsSeen.Add($agentPid)
          if ($row.agentState -eq 'ready') { $row.routes = Probe-Agent $h $agentPid $row.meta $launch.ctx }
        }
        $launch.ctx.agentPid = $agentPid
      }
    }
  } catch { Log "  probe threw: $($_.Exception.Message)"; $row.launchNote += " | probe error: $($_.Exception.Message)" }
  finally {
    $notes = @()
    try {
      if ($Mode -eq 'agent') {
        # The payload shell restarts the agent, so stop the shell first, then whatever
        # agent process is still up.
        if ($launch.pid -and (Get-Process -Id $launch.pid -ErrorAction SilentlyContinue)) { Stop-Process -Id $launch.pid -Force -ErrorAction SilentlyContinue; $notes += 'stopped the payload shell' }
        Start-Sleep -Seconds 1
        $stopped = 0
        foreach ($ap in ($AgentPidsSeen | Select-Object -Unique)) {
          if (Get-Process -Id $ap -ErrorAction SilentlyContinue) { Stop-Process -Id $ap -Force -ErrorAction SilentlyContinue; $stopped++ }
        }
        $AgentPidsSeen.Clear()
        Start-Sleep -Seconds 1
        $notes += $(if ($stopped) { "stopped $stopped agent session(s) still running" } else { 'agent sessions ended by themselves' })
      }
      elseif ($launch.mode -eq 'receiver') { $notes += "receiver: $(Stop-Receiver $h $launch.pid)" }
      switch ($h) {
        'orca' {
          if ($launch.ctx.handle) { $c = Invoke-Orca @('terminal', 'close', '--terminal', $launch.ctx.handle, '--json'); $notes += "orca close: $(if ($c -match '"ok"\s*:\s*true') { 'ok' } else { $c })" }
        }
        'wmux' {
          if ($launch.ctx.workspace) { $notes += "wmux close-workspace: $(Invoke-Wmux @('close-workspace', $launch.ctx.workspace))" }
          if ($launch.ctx.startedApp) {
            $notes += "wmux daemon stop: $(Invoke-Wmux @('daemon', 'stop'))"
            Start-Sleep -Seconds 2
            $left = @(Get-Process wmux -ErrorAction SilentlyContinue | Where-Object { -not $PreExisting.ContainsKey($_.Id) })
            if ($left.Count) { $left | Stop-Process -Force -ErrorAction SilentlyContinue; $notes += "stopped $($left.Count) wmux app processes the probe started" }
            # Pane shells can outlive the daemon that hosted them (seen once in testing).
            Start-Sleep -Seconds 1
            $orph = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'wmux-shell-init' -and -not $PreExisting.ContainsKey([int]$_.ProcessId) })
            if ($orph.Count) { $orph | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $notes += "stopped $($orph.Count) orphaned wmux pane shells" }
          }
        }
        'warp' {
          if ($launch.pid) { Stop-Process -Id $launch.pid -Force -ErrorAction SilentlyContinue; $notes += "stopped probe tab shell $($launch.pid)" }
          foreach ($extra in @(Warp-Shells | Where-Object { -not $PreExisting.ContainsKey($_) -and $_ -notin $ctx.shellsBefore })) {
            Stop-Process -Id $extra -Force -ErrorAction SilentlyContinue
          }
          if ($launch.ctx.startedApp) {
            Get-Process warp -ErrorAction SilentlyContinue | Where-Object { -not $PreExisting.ContainsKey($_.Id) } | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
            $orphans = Warp-Shells | Where-Object { -not $PreExisting.ContainsKey($_) }
            if ($orphans) { Stop-Process -Id $orphans -Force -ErrorAction SilentlyContinue }
            $notes += "stopped the Warp app the probe started and $(@($orphans).Count) restored shells"
          }
        }
      }
      $g = Reap-Gui $chain
      if ($g) { $notes += $g }
    } catch { $notes += "cleanup error: $($_.Exception.Message)" }
    $row.cleanup = $notes -join '; '
    Log "  cleanup: $($row.cleanup)"
  }
  $rows.Add([pscustomobject]$row)
}

# Stray check: any process still running receiver.ps1 for this run.
Start-Sleep -Seconds 1
$strays = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($RunId) -and ($_.CommandLine.Contains('launch-') -or $_.CommandLine.Contains($Receiver) -or $_.CommandLine.Contains($RawKey)) })
if ($strays.Count) {
  Log "STRAYS: $(($strays | ForEach-Object { "$($_.Name)($($_.ProcessId))" }) -join ', '); stopping"
  $strays | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} else { Log 'stray check: no receiver processes left' }

$summary = [ordered]@{ runId = $RunId; mode = $Mode; agent = $(if ($Mode -eq 'agent') { $Agent } else { $null }); elevated = $elevated; os = [Environment]::OSVersion.VersionString; strays = $strays.Count; rows = $rows }
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Results 'matrix.json') -Encoding utf8

function Cell([string]$s) { if ($null -eq $s) { '' } else { $s.Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ') } }
$md = [System.Collections.Generic.List[string]]::new()
$md.Add("Run $RunId, mode $Mode$(if ($Mode -eq 'agent') { " ($Agent)" }), harness elevated: $elevated, $($summary.os)")
$md.Add('')
if ($Mode -eq 'keys') {
  $md.Add('| host | started? | receiver pid | route | delivered? | code points | terminator | latency | route said |')
  $md.Add('|---|---|---|---|---|---|---|---|---|')
  foreach ($r in $rows) {
    if (-not $r.started) { $md.Add(('| {0} | no | | | n/a | | | | {1} |' -f $r.host, (Cell $r.launchNote))); continue }
    foreach ($x in $r.routes) {
      $md.Add(('| {0} | yes | {1} | {2} | {3} | {4} | {5} | {6} | {7} |' -f $r.host, $r.pid, $x.route, $(if ($x.delivered) { 'yes' } else { 'no' }), $x.codePoints, (Cell $x.terminator), $(if ($x.latencyMs) { "$($x.latencyMs) ms" } else { '' }), (Cell $x.routeSaid)))
    }
  }
  $md | Set-Content -LiteralPath (Join-Path $Results 'matrix.md') -Encoding utf8
  Log "wrote $(Join-Path $Results 'matrix.md')"
  $md | ForEach-Object { Write-Host $_ }
  return
}
if ($Mode -eq 'agent') {
  $md.Add('| host | agent pid | agent state | route | submitted? | replied? | time to reply | extra Enter submitted it? | input line when not submitted | route said |')
  $md.Add('|---|---|---|---|---|---|---|---|---|---|')
  foreach ($r in $rows) {
    if (-not $r.started -or -not $r.routes -or $r.routes.Count -eq 0) {
      $md.Add(('| {0} | {1} | {2} | | n/a | n/a | | | | {3} |' -f $r.host, $r.agentPid, (Cell $r.agentState), (Cell $r.launchNote)))
      continue
    }
    foreach ($x in $r.routes) {
      $md.Add(('| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} | {8} | {9} |' -f $r.host, $r.agentPid, (Cell $r.agentState), $x.route, $(if ($x.submitted) { 'yes' } else { 'no' }), $(if ($x.replied) { 'yes' } else { 'no' }), $(if ($x.replyMs) { "$([math]::Round($x.replyMs / 1000, 1)) s" } else { '' }), $(if ($null -eq $x.submittedAfterExtraEnter) { '' } elseif ($x.submittedAfterExtraEnter) { 'yes' } else { 'no' }), (Cell $x.inputLineWhenNotSubmitted), (Cell $x.routeSaid)))
    }
  }
  $md | Set-Content -LiteralPath (Join-Path $Results 'matrix.md') -Encoding utf8
  Log "wrote $(Join-Path $Results 'matrix.md')"
  $md | ForEach-Object { Write-Host $_ }
  return
}
$md.Add('| host | started? | receiver pid | conhost in tree? | injector landed? | attempts | error text | notes |')
$md.Add('|---|---|---|---|---|---|---|---|')
foreach ($r in $rows) {
  $landed = @($r.attempts | Where-Object landed).Count -gt 0
  $errs = @($r.attempts | Where-Object { -not $_.landed } | ForEach-Object { if ($_.error) { $_.error } elseif ($_.injectorResolved) { 'injector resolved, nothing arrived' } }) | Select-Object -Unique
  $lat = ($r.attempts | Where-Object landed | Select-Object -First 1).latencyMs
  $notes = @($r.launchNote)
  if ($r.chain) { $notes += "chain: $($r.chain)" }
  if ($lat) { $notes += "latency $lat ms" }
  if ($r.warm) { $notes += "warm injection: landed=$($r.warm.landed), $($r.warm.latencyMs) ms" }
  if ($r.native) {
    $extra = if ($r.native.summary) { $r.native.summary } elseif ($r.native.detail) { $r.native.detail } else { '' }
    $notes += "native $($r.native.route): landed=$($r.native.landed)$(if ($extra) { " ($extra)" })"
  }
  if ($r.ctx.warpctrlInstances) { $notes += "warpctrl instance list: $(($r.ctx.warpctrlInstances -replace '\s+', ' '))" }
  $md.Add(('| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} |' -f $r.host, $(if ($r.started) { 'yes' } else { 'no' }), $r.pid, (Cell (ConsoleHosts-String $r.consoleHosts)), $(if (-not $r.started) { 'n/a' } elseif ($landed) { 'yes' } else { 'no' }), @($r.attempts).Count, (Cell ($errs -join ' / ')), (Cell ($notes -join '. '))))
}
$md | Set-Content -LiteralPath (Join-Path $Results 'matrix.md') -Encoding utf8
Log "wrote $(Join-Path $Results 'matrix.md')"
$md | ForEach-Object { Write-Host $_ }

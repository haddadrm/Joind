# Injection matrix receiver. Runs inside the terminal host under test.
# Writes its own PID to <results>/<name>.pid, then appends every line it reads
# from the console to <results>/<name>.log with a timestamp. Exits on the line
# "QUIT", when <results>/<name>.quit appears, or after -MaxMinutes (safety net
# so a host the injector cannot reach never leaves a stray shell behind).
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$ResultsDir,
  [int]$MaxMinutes = 15
)
$ErrorActionPreference = 'Stop'
$pidFile  = Join-Path $ResultsDir "$Name.pid"
$logFile  = Join-Path $ResultsDir "$Name.log"
$quitFile = Join-Path $ResultsDir "$Name.quit"

# A thread-pool timer keeps working while the main thread blocks in ReadLine.
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Threading;
public static class MatrixQuitWatch {
  static Timer t;
  public static void Start(string quitFile, int maxMinutes) {
    DateTime deadline = DateTime.UtcNow.AddMinutes(maxMinutes);
    t = new Timer(_ => {
      if (File.Exists(quitFile) || DateTime.UtcNow > deadline) Environment.Exit(0);
    }, null, 500, 500);
  }
}
"@
[MatrixQuitWatch]::Start($quitFile, $MaxMinutes)

$host.UI.RawUI.WindowTitle = "inject-matrix $Name"
Write-Host "inject-matrix receiver '$Name' pid $PID (PS $($PSVersionTable.PSVersion)). Waiting for lines; QUIT exits."
# Terminal identity as the shell sees it: the runner uses WEZTERM_PANE and
# WEZTERM_UNIX_SOCKET for the native WezTerm route and records the rest.
$envKeys = Get-ChildItem Env: | Where-Object { $_.Name -match '^(WEZTERM_|WT_|ORCA_|WMUX|WARP|TERM_PROGRAM|TERM$|ConEmu|SESSIONNAME)' }
$meta = [ordered]@{
  pid = $PID
  ppid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
  psVersion = "$($PSVersionTable.PSVersion)"
  stdinRedirected = [Console]::IsInputRedirected
  env = [ordered]@{}
}
foreach ($e in $envKeys) { $meta.env[$e.Name] = $e.Value }
$meta | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $ResultsDir "$Name.meta.json") -Encoding utf8
# The pid file is written last: its presence means the receiver is ready to read.
Set-Content -LiteralPath $pidFile -Value $PID -Encoding ascii

while ($true) {
  $line = [Console]::ReadLine()
  if ($null -eq $line) { Start-Sleep -Milliseconds 200; continue }
  $stamp = [DateTime]::UtcNow.ToString('o')
  Add-Content -LiteralPath $logFile -Value "$stamp`t$line" -Encoding utf8
  Write-Host "got: $line"
  if ($line.Trim() -eq 'QUIT') { break }
}
exit 0

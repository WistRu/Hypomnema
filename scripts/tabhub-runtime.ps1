<#
.SYNOPSIS
Starts the TabHub runtime if, and only if, it is not already serving.

.DESCRIPTION
Issue #37: the host lost power, the runtime died with it, and eight hours
passed before anyone noticed. This is the launcher a scheduled task calls —
both at logon and on a repeat, so a runtime that dies mid-day comes back
without waiting for the next reboot.

Deliberately idempotent, and it checks two things rather than one. A port
check alone is not enough: a node process that is alive but not yet listening
-- booting, hung, mid-crash -- still holds the SQLite file, and starting a
second one alongside it is the worst outcome this script could produce. So it
looks for our own entry point among running processes as well.

Run install-autostart.ps1 to register it. This script only starts things; it
never stops or restarts a healthy runtime.
#>
[CmdletBinding()]
param(
  [int] $Port = 7717,
  [string] $RepositoryRoot
)

$ErrorActionPreference = 'Stop'

# Resolved here, not as a parameter default: $PSScriptRoot is not populated
# during parameter binding under -File, so the default silently bound $null and
# every path built from it was wrong. Found by running the script, which is the
# only way this class of bug is ever found.
if (-not $RepositoryRoot) {
  $RepositoryRoot = Split-Path -Parent $PSScriptRoot
}

$entry = Join-Path $RepositoryRoot 'packages/server/dist/main.js'
if (-not (Test-Path $entry)) {
  Write-Error "TabHub server build not found at $entry. Build it before enabling autostart."
  exit 1
}

# Loopback specifically. The runtime binds 127.0.0.1, so a listener on some
# other address is somebody else's process and says nothing about ours.
$listening = $null
try {
  $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') }
} catch {
  $listening = $null
}

if ($listening) {
  Write-Output "TabHub is already serving on 127.0.0.1:$Port. Nothing to do."
  exit 0
}

# Not listening is not the same as not running. A process that holds the
# database but has not reached (or has left) the listening state must not be
# joined by a second one.
$entryPattern = '*' + (Split-Path -Leaf $RepositoryRoot) + '*packages*server*dist*main.js*'
$alreadyRunning = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like $entryPattern }

if ($alreadyRunning) {
  $pids = ($alreadyRunning | ForEach-Object { $_.ProcessId }) -join ', '
  Write-Output "A TabHub process is already running (PID $pids) but is not serving on 127.0.0.1:$Port."
  Write-Output "Not starting a second one: two servers on one database is worse than none."
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Error 'node was not found on PATH. The scheduled task cannot start TabHub without it.'
  exit 1
}

Start-Process -FilePath $node -ArgumentList $entry -WorkingDirectory $RepositoryRoot -WindowStyle Hidden
Write-Output "Started TabHub from $entry."

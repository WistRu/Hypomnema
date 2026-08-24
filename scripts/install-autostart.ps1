<#
.SYNOPSIS
Registers (or removes) the scheduled task that keeps the TabHub runtime up.

.DESCRIPTION
Issue #37. Two triggers, because a reboot is not the only way the runtime
dies:

  * at logon — survives a restart, planned or not;
  * every 5 minutes — brings it back if it died on its own, without waiting
    for the next reboot.

Both call scripts/tabhub-runtime.ps1, which refuses to start a second server
when one is already serving or is running but not yet listening, so the repeat
is free and does not risk two processes on one database.

Registered for the current user only, and runs with ordinary privileges. It
needs none: the runtime binds loopback and writes inside the repository.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/install-autostart.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/install-autostart.ps1 -Remove
#>
[CmdletBinding()]
param(
  [switch] $Remove,
  [string] $TaskName = 'TabHub runtime',
  [int] $Port = 7717
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'tabhub-runtime.ps1'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($Remove) {
  if (-not $existing) {
    Write-Output "No scheduled task named '$TaskName'. Nothing to remove."
    exit 0
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Removed the scheduled task '$TaskName'. TabHub will no longer start by itself."
  exit 0
}

if (-not (Test-Path $launcher)) {
  Write-Error "Launcher not found at $launcher."
  exit 1
}

$entry = Join-Path $repositoryRoot 'packages/server/dist/main.js'
if (-not (Test-Path $entry)) {
  Write-Error "No server build at $entry. Run: corepack pnpm --filter @tabhub/server build"
  exit 1
}

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -Port $Port") `
  -WorkingDirectory $repositoryRoot

$atLogon = New-ScheduledTaskTrigger -AtLogOn
# -RepetitionDuration is not optional in practice: omitting it lets Task
# Scheduler expire the repetition, and a restart task that quietly stops
# repeating is the worst failure mode this could have.
$repeating = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration ([TimeSpan]::MaxValue)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

if ($existing) {
  Write-Output "Replacing the existing scheduled task '$TaskName'."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger @($atLogon, $repeating) `
  -Settings $settings `
  -Description 'Starts the TabHub runtime at logon and brings it back if it dies (issue #37).' | Out-Null

Write-Output "Registered '$TaskName': starts at logon, and checks every 5 minutes."
Write-Output ''
Write-Output 'This is not proven until the machine has actually been rebooted.'
Write-Output 'After the next reboot, check that the runtime is serving, then read the'
Write-Output 'availability record with:  corepack pnpm --filter @tabhub/server availability'

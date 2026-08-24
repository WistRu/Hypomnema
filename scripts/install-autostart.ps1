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

If the scheduled task cannot be registered -- and on some machines it cannot,
because security policy or protection software denies it to an ordinary user --
this falls back to a Startup-folder entry running the launcher in -Watch mode.
That needs no privileges at all and covers both jobs: it starts at logon and
keeps checking while it runs. It is weaker in one way, and worth knowing: if the
watcher itself is killed, nothing restores it until the next logon.

Registered for the current user only either way. Neither form needs elevation:
the runtime binds loopback and writes inside the repository.

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
  $removed = $false
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed the scheduled task '$TaskName'."
    $removed = $true
  }
  $startupEntry = Join-Path ([Environment]::GetFolderPath('Startup')) 'TabHub runtime.cmd'
  if (Test-Path $startupEntry) {
    Remove-Item $startupEntry -Force
    Write-Output "Removed $startupEntry."
    $removed = $true
  }
  if (-not $removed) {
    Write-Output 'Nothing to remove: TabHub was not set to start by itself.'
  } else {
    Write-Output 'TabHub will no longer start by itself. Any running watcher survives until it exits.'
  }
  exit 0
}

if (-not (Test-Path $launcher)) {
  Write-Error "Launcher not found at $launcher."
  exit 1
}

# A missing build is not a reason to refuse. This runs from postinstall on a
# fresh clone, where the build has not happened yet; the launcher checks for
# the build every time it fires, so a task registered early simply does
# nothing until there is something to start.
$entry = Join-Path $repositoryRoot 'packages/server/dist/main.js'
$buildMissing = -not (Test-Path $entry)

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -Port $Port") `
  -WorkingDirectory $repositoryRoot

$atLogon = New-ScheduledTaskTrigger -AtLogOn
# -RepetitionDuration is not optional in practice: omitting it lets Task
# Scheduler expire the repetition, and a restart task that quietly stops
# repeating is the worst failure mode this could have. [TimeSpan]::MaxValue is
# the obvious value and is rejected outright -- registration fails with an
# unhelpful XML format error -- so this is a large finite duration instead.
$repeating = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

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

$startupFolder = [Environment]::GetFolderPath('Startup')
$startupEntry = Join-Path $startupFolder 'TabHub runtime.cmd'
$registered = $false

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger @($atLogon, $repeating) `
    -Settings $settings `
    -Description 'Starts the TabHub runtime at logon and brings it back if it dies (issue #37).' `
    -ErrorAction Stop | Out-Null
  $registered = $true
  Write-Output "Registered '$TaskName': starts at logon, and checks every 5 minutes."
  if (Test-Path $startupEntry) {
    Remove-Item $startupEntry -Force
    Write-Output 'Removed the Startup-folder fallback: the scheduled task supersedes it.'
  }
} catch {
  Write-Output "Scheduled task refused: $($_.Exception.Message)"
  Write-Output 'Falling back to the Startup folder, which needs no privileges.'
}

if (-not $registered) {
  # A .cmd rather than a shortcut: no COM, nothing to go stale, and the command
  # it runs is readable by anyone who opens the file.
  $command = @(
    '@echo off',
    ('start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
      $launcher + '" -Port ' + $Port + ' -Watch')
  ) -join "`r`n"
  Set-Content -Path $startupEntry -Value $command -Encoding ASCII
  Write-Output "Wrote $startupEntry -- TabHub will be watched from the next logon."
  Write-Output 'To start watching now without logging out, run:'
  Write-Output ("  powershell -ExecutionPolicy Bypass -File `"$launcher`" -Watch")
}
if ($buildMissing) {
  Write-Output ''
  Write-Output "No server build at $entry yet, so the task will do nothing until you run:"
  Write-Output '  corepack pnpm --filter @tabhub/server build'
}
Write-Output ''
Write-Output 'This is not proven until the machine has actually been rebooted.'
Write-Output 'After the next reboot, check that the runtime is serving, then read the'
Write-Output 'availability record with:  corepack pnpm --filter @tabhub/server availability'

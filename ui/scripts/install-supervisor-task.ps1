[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Action = 'install',
  [string]$TaskName = 'SquidRun Supervisor'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$uiRoot = Join-Path $projectRoot 'ui'
$daemonScript = Join-Path $uiRoot 'supervisor-daemon.js'
$runtimeDir = Join-Path $projectRoot '.squidrun\runtime'
$taskLog = Join-Path $runtimeDir 'supervisor-task.log'
$hiddenTaskRunner = Join-Path $PSScriptRoot 'hm-hidden-task.js'
$hiddenLauncher = Join-Path $PSScriptRoot 'hm-run-hidden.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

if (-not (Test-Path $daemonScript)) {
  throw "Supervisor daemon not found at $daemonScript"
}
if (-not (Test-Path -LiteralPath $hiddenTaskRunner)) { throw "Hidden task runner not found at $hiddenTaskRunner" }
if (-not (Test-Path -LiteralPath $hiddenLauncher)) { throw "Hidden launcher not found at $hiddenLauncher" }
if (-not (Test-Path -LiteralPath $wscript)) { throw "wscript executable not found at $wscript" }

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

$nodeCommand = Get-Command node -ErrorAction Stop
$nodePath = $nodeCommand.Source
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function ConvertTo-TaskArgument {
  param([string]$Value)
  if ($Value.Contains('"')) { throw "task argument contains an unsafe quote: $Value" }
  return '"' + $Value + '"'
}

$hiddenActionParts = @(
  $hiddenLauncher,
  $nodePath,
  $hiddenTaskRunner,
  '--cwd',
  $uiRoot,
  '--append-log',
  $taskLog,
  '--',
  $nodePath,
  $daemonScript,
  '--daemon'
)
$hiddenActionArguments = ($hiddenActionParts | ForEach-Object {
  ConvertTo-TaskArgument -Value ([string]$_)
}) -join ' '

switch ($Action) {
  'install' {
    $taskAction = New-ScheduledTaskAction `
      -Execute $wscript `
      -Argument $hiddenActionArguments `
      -WorkingDirectory $uiRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
      -MultipleInstances IgnoreNew `
      -RestartCount 3 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -StartWhenAvailable

    Register-ScheduledTask `
      -TaskName $TaskName `
      -Action $taskAction `
      -Trigger $trigger `
      -Settings $settings `
      -Description 'Runs the SquidRun durable supervisor daemon inside the signed-in user session.' `
      -User $currentUser `
      -RunLevel Limited `
      -Force | Out-Null

    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Installed scheduled task '$TaskName' for $currentUser"
  }
  'uninstall' {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Output "Removed scheduled task '$TaskName'"
    } else {
      Write-Output "Scheduled task '$TaskName' is not installed"
    }
  }
  'status' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
      Write-Output "Scheduled task '$TaskName' is not installed"
      exit 1
    }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    [pscustomobject]@{
      TaskName = $TaskName
      State = $task.State
      LastRunTime = $info.LastRunTime
      LastTaskResult = $info.LastTaskResult
      NextRunTime = $info.NextRunTime
      Command = "$wscript $hiddenActionArguments"
      LogPath = $taskLog
    } | Format-List
  }
}


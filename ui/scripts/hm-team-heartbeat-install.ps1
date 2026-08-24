param(
  [string]$Actor = 'builder',
  [string]$Reason = 'Reconcile the durable team heartbeat cadence'
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runner = Join-Path $PSScriptRoot 'hm-team-heartbeat.js'
if (-not (Test-Path -LiteralPath $runner)) { throw "missing heartbeat runner: $runner" }

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$node = $nodeCommand.Source
if (-not (Test-Path -LiteralPath $node)) { throw "node executable not found: $node" }
if ([string]::IsNullOrWhiteSpace($Actor)) { throw 'Actor is required for cadence audit' }
if ([string]::IsNullOrWhiteSpace($Reason)) { throw 'Reason is required for cadence audit' }

$configText = & $node $runner config-show --json
if ($LASTEXITCODE -ne 0) { throw 'heartbeat config validation failed' }
$config = $configText | ConvertFrom-Json
$cadence = @($config.cadence)
if ($cadence.Count -lt 2) { throw 'heartbeat cadence cannot be reconciled below two daily beats' }

$taskPrefix = 'SquidRun-Team-Heartbeat-'
$desired = @($cadence | ForEach-Object {
  $id = [string]$_.id
  $time = [string]$_.time
  if ($id -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { throw "unsafe cadence id: $id" }
  if ($time -notmatch '^(?:[01]\d|2[0-3]):[0-5]\d$') { throw "unsafe cadence time: $time" }
  [pscustomobject]@{
    id = $id
    time = $time
    taskName = $taskPrefix + $id.ToUpperInvariant()
  }
})

function Get-OwnedHeartbeatTasks {
  return @(Get-ScheduledTask -TaskName "$taskPrefix*" -ErrorAction SilentlyContinue)
}

function Get-TaskSnapshot {
  param([object[]]$Tasks)
  return @(@($Tasks) | Where-Object {
    $null -ne $_ -and -not [string]::IsNullOrWhiteSpace([string]$_.TaskName)
  } | ForEach-Object {
    $task = $_
    $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -ErrorAction SilentlyContinue
    [ordered]@{
      taskName = $task.TaskName
      state = [string]$task.State
      execute = [string]$task.Actions.Execute
      arguments = [string]$task.Actions.Arguments
      workingDirectory = [string]$task.Actions.WorkingDirectory
      startBoundary = [string]$task.Triggers.StartBoundary
      startWhenAvailable = [bool]$task.Settings.StartWhenAvailable
      restartCount = [int]$task.Settings.RestartCount
      restartInterval = [string]$task.Settings.RestartInterval
      multipleInstances = [string]$task.Settings.MultipleInstances
      lastRunTime = if ($info) { $info.LastRunTime.ToString('o') } else { $null }
      lastTaskResult = if ($info) { [int64]$info.LastTaskResult } else { $null }
      nextRunTime = if ($info) { $info.NextRunTime.ToString('o') } else { $null }
    }
  })
}

function Write-CadenceAudit {
  param(
    [string]$Event,
    [object]$Payload
  )
  $json = $Payload | ConvertTo-Json -Depth 10 -Compress
  $json | & $node $runner audit-event --event $Event --actor $Actor --reason $Reason
  if ($LASTEXITCODE -ne 0) { throw "heartbeat cadence audit failed: $Event" }
}

$beforeTasks = @(Get-OwnedHeartbeatTasks)
$before = @(Get-TaskSnapshot -Tasks $beforeTasks)
$desiredAudit = @($desired | ForEach-Object {
  [ordered]@{
    taskName = $_.taskName
    scheduledWindow = $_.id
    time = $_.time
    execute = $node
    runner = $runner
    workingDirectory = $projectRoot
    startWhenAvailable = $true
    restartCount = 6
    restartIntervalMinutes = 15
  }
})

Write-CadenceAudit -Event 'cadence_reconcile_planned' -Payload ([ordered]@{
  before = $before
  after = $desiredAudit
})

try {
  $principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew `
    -Hidden `
    -StartWhenAvailable `
    -RestartCount 6 `
    -RestartInterval (New-TimeSpan -Minutes 15)

  foreach ($entry in $desired) {
    $at = [DateTime]::ParseExact($entry.time, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
    $action = New-ScheduledTaskAction `
      -Execute $node `
      -Argument "`"$runner`" run --scheduled-window $($entry.id)" `
      -WorkingDirectory $projectRoot
    $trigger = New-ScheduledTaskTrigger -Daily -At $at
    Register-ScheduledTask `
      -TaskName $entry.taskName `
      -Action $action `
      -Trigger $trigger `
      -Principal $principal `
      -Settings $settings `
      -Description "Bounded autonomous SquidRun team heartbeat ($($entry.id) at $($entry.time)); exact delivery is proven in the main comms ledger." `
      -Force `
      -ErrorAction Stop | Out-Null
  }

  $desiredNames = @($desired.taskName)
  foreach ($existing in Get-OwnedHeartbeatTasks) {
    if ($existing.TaskName -notin $desiredNames) {
      Unregister-ScheduledTask -TaskName $existing.TaskName -Confirm:$false
    }
  }

  $afterTasks = @(Get-OwnedHeartbeatTasks)
  $after = @(Get-TaskSnapshot -Tasks $afterTasks)
  foreach ($entry in $desired) {
    $task = $afterTasks | Where-Object TaskName -EQ $entry.taskName | Select-Object -First 1
    if (-not $task) { throw "registered task is missing: $($entry.taskName)" }
    $expectedArgs = "`"$runner`" run --scheduled-window $($entry.id)"
    if ([string]$task.Actions.Execute -ne $node) { throw "wrong executable for $($entry.taskName)" }
    if ([string]$task.Actions.Arguments -ne $expectedArgs) { throw "wrong arguments for $($entry.taskName)" }
    if ([string]$task.Actions.WorkingDirectory -ne $projectRoot) { throw "wrong working directory for $($entry.taskName)" }
    if (-not [bool]$task.Settings.StartWhenAvailable) { throw "StartWhenAvailable is off for $($entry.taskName)" }
    if ([int]$task.Settings.RestartCount -ne 6) { throw "bounded retry count is wrong for $($entry.taskName)" }
    if ([string]$task.Settings.MultipleInstances -ne 'IgnoreNew') { throw "reentry policy is wrong for $($entry.taskName)" }
  }

  Write-CadenceAudit -Event 'cadence_reconcile_applied' -Payload ([ordered]@{
    before = $before
    after = $after
  })
} catch {
  try {
    $failedAfter = @(Get-TaskSnapshot -Tasks @(Get-OwnedHeartbeatTasks))
    Write-CadenceAudit -Event 'cadence_reconcile_failed' -Payload ([ordered]@{
      before = $before
      after = $failedAfter
      error = $_.Exception.Message
    })
  } catch {}
  throw
}

Get-OwnedHeartbeatTasks |
  Sort-Object TaskName |
  Select-Object TaskName,State,
    @{Name='Execute';Expression={$_.Actions.Execute}},
    @{Name='Arguments';Expression={$_.Actions.Arguments}},
    @{Name='WorkingDirectory';Expression={$_.Actions.WorkingDirectory}},
    @{Name='StartBoundary';Expression={$_.Triggers.StartBoundary}},
    @{Name='StartWhenAvailable';Expression={$_.Settings.StartWhenAvailable}},
    @{Name='RestartCount';Expression={$_.Settings.RestartCount}},
    @{Name='RestartInterval';Expression={$_.Settings.RestartInterval}}

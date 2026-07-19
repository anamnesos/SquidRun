[CmdletBinding()]
param(
  [ValidateSet('render', 'register', 'status', 'disable', 'unregister')]
  [string]$Action = 'render',
  [string]$TaskName = 'SquidRun-Build1B-MainE28-Restoration',
  [int]$IntervalMinutes = 5,
  [int]$DebounceMinutes = 10,
  [int]$RestoreTimeoutHours = 3,
  [int]$ExecutionTimeLimitHours = 4
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptsRoot = Split-Path -Parent $ScriptPath
$UiRoot = Split-Path -Parent $ScriptsRoot
$ProjectRoot = Split-Path -Parent $UiRoot
$WatcherScript = Join-Path $ScriptsRoot 'hm-main-e28-restoration-watch.js'
$RestoreScript = Join-Path $ScriptsRoot 'hm-restore-main-e28-coherence.ps1'
$SyncModule = Join-Path $ScriptsRoot 'hm-main-e28-tree-sync.psm1'
$RehearsalScript = Join-Path $ScriptsRoot 'hm-rehearse-main-e28-tree-sync.ps1'
$NoticeConsumer = Join-Path $ScriptsRoot 'hm-next-session-notices.js'
$RolesPath = Join-Path $ProjectRoot 'ROLES.md'
$WatcherTest = Join-Path $UiRoot '__tests__\hm-main-e28-restoration-watch.test.js'
$NoticeTest = Join-Path $UiRoot '__tests__\hm-next-session-notices.test.js'
$ReceiptRoot = Join-Path $ProjectRoot '.squidrun\coord\build1b-e29-s480\main-e28-restoration-watcher'
$RegistrationProofPath = Join-Path $ReceiptRoot 'registration-proof.json'
$OwnershipAnchorPath = Join-Path $ReceiptRoot 'task-ownership-anchor.json'
$TaskOwnerMarker = 'SquidRun.Build1B.MainE28Restoration.v1'
$TaskMutationMutexName = 'Global\SquidRun.Build1B.MainE28Restoration.TaskMutation.v1'
$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
$StablePowerShellAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'
$PowerShellPath = if (Test-Path -LiteralPath $StablePowerShellAlias -PathType Leaf) {
  $StablePowerShellAlias
} else {
  (Get-Command pwsh.exe -ErrorAction Stop).Source
}
$SchtasksPath = Join-Path $env:SystemRoot 'System32\schtasks.exe'
$ScPath = Join-Path $env:SystemRoot 'System32\sc.exe'
$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$UserName = $CurrentIdentity.Name
$UserSid = $CurrentIdentity.User.Value
$RegistrationEpochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$StartBoundary = [DateTimeOffset]::Now.AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:sszzz')
$IntervalMinutes = [Math]::Max(5, $IntervalMinutes)
$DebounceMinutes = [Math]::Max(10, $DebounceMinutes)
$RestoreTimeoutHours = [Math]::Max(1, $RestoreTimeoutHours)
$ExecutionTimeLimitHours = [Math]::Max($RestoreTimeoutHours + 1, $ExecutionTimeLimitHours)
$DebounceMs = $DebounceMinutes * 60 * 1000
$RestoreTimeoutMs = $RestoreTimeoutHours * 60 * 60 * 1000
function Escape-XmlText {
  param([string]$Value)
  return [Security.SecurityElement]::Escape($Value)
}

function Invoke-Captured {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [int]$TimeoutSeconds = 60
  )
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $FilePath
  $start.WorkingDirectory = $ProjectRoot
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.RedirectStandardInput = $true
  $start.CreateNoWindow = $true
  foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    [void]$process.Start()
    # No owned child may inherit an interactive prompt. In particular, a
    # concurrent same-name schtasks collision must fail on EOF, never wait for
    # or consume input from the parent pane.
    $process.StandardInput.Close()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $completed = $process.WaitForExit([Math]::Max(1, $TimeoutSeconds) * 1000)
    $timedOut = -not $completed
    $exitedAfterKill = $true
    if ($timedOut) {
      try { $process.Kill($true) } catch {}
      $exitedAfterKill = $process.WaitForExit(5000)
    } else {
      $process.WaitForExit()
    }
    if (-not $exitedAfterKill) {
      return [pscustomobject]@{
        file = $FilePath
        arguments = $Arguments
        exitCode = 124
        timedOut = $true
        exitedAfterKill = $false
        stdout = ''
        stderr = 'owned_child_timeout_kill_failed_streams_not_awaited'
      }
    }
    $streamsCompleted = [Threading.Tasks.Task]::WaitAll(
      [Threading.Tasks.Task[]]@($stdoutTask, $stderrTask),
      5000
    )
    if (-not $streamsCompleted) {
      return [pscustomobject]@{
        file = $FilePath
        arguments = $Arguments
        exitCode = 124
        timedOut = $true
        exitedAfterKill = $exitedAfterKill
        streamDrainCompleted = $false
        stdout = ''
        stderr = 'owned_child_stream_drain_timeout'
      }
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    return [pscustomobject]@{
      file = $FilePath
      arguments = $Arguments
      exitCode = if ($timedOut) { 124 } else { $process.ExitCode }
      timedOut = $timedOut
      exitedAfterKill = $exitedAfterKill
      streamDrainCompleted = $true
      stdout = $stdout
      stderr = $stderr
    }
  } finally {
    $process.Dispose()
  }
}

function Get-TextSha256 {
  param([string]$Value)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $hash = [Security.Cryptography.SHA256]::HashData($bytes)
  return [Convert]::ToHexString($hash).ToLowerInvariant()
}

function Read-JsonFile {
  param([string]$Path)
  try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-JsonAtomic {
  param([string]$Path, [object]$Value)
  [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
  $temporaryPath = "$Path.$PID.$([guid]::NewGuid().ToString('n')).tmp"
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 16))
    $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
    [IO.File]::Move($temporaryPath, $Path, $true)
  } finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Write-TextAtomic {
  param([string]$Path, [string]$Value)

  [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
  $temporaryPath = "$Path.$PID.$([guid]::NewGuid().ToString('n')).tmp"
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Value)
    $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
    [IO.File]::Move($temporaryPath, $Path, $true)
  } finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Enter-TaskMutationMutex {
  $mutex = [Threading.Mutex]::new($false, $TaskMutationMutexName)
  $acquired = $false
  try {
    try {
      $acquired = $mutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
      $acquired = $true
    }
    if (-not $acquired) {
      $mutex.Dispose()
      return [pscustomobject]@{ ok = $false; reason = 'task_mutation_already_in_progress' }
    }
    return [pscustomobject]@{
      ok = $true
      mutex = $mutex
      name = $TaskMutationMutexName
      staleStory = 'The OS mutex is released automatically on process exit; an abandoned mutex is acquired with an explicit abandoned state rather than leaving a filesystem lock wedged.'
    }
  } catch {
    if ($acquired) {
      try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
    throw
  }
}

function Exit-TaskMutationMutex {
  param([object]$Ownership)
  if ($null -eq $Ownership -or $Ownership.ok -ne $true) { return }
  try { $Ownership.mutex.ReleaseMutex() } catch {}
  $Ownership.mutex.Dispose()
}

function New-ReceiptPath {
  param([string]$Suffix)
  return Join-Path $ReceiptRoot "$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))-$([guid]::NewGuid().ToString('n').Substring(0, 8))-$Suffix.json"
}

if ($Action -eq 'status') {
  if (-not (Test-Path -LiteralPath $SchtasksPath -PathType Leaf)) {
    throw "Task Scheduler CLI is missing: $SchtasksPath"
  }
  [void][IO.Directory]::CreateDirectory($ReceiptRoot)
  $arguments = switch ($Action) {
    'status' { @('/Query', '/TN', $TaskName, '/V', '/FO', 'LIST') }
    'disable' { @('/Change', '/TN', $TaskName, '/Disable') }
    'unregister' { @('/Delete', '/TN', $TaskName, '/F') }
  }
  $operation = Invoke-Captured -FilePath $SchtasksPath -Arguments $arguments
  $receipt = [ordered]@{
    schema = 'squidrun.build1b.main_e28_restoration_task_control.v1'
    capturedAt = [DateTime]::UtcNow.ToString('o')
    action = $Action
    taskName = $TaskName
    ok = ($operation.exitCode -eq 0)
    operation = $operation
  }
  $receiptPath = Join-Path $ReceiptRoot "$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))-$([guid]::NewGuid().ToString('n').Substring(0, 8))-$Action.json"
  $receipt['receiptPath'] = $receiptPath
  Write-JsonAtomic -Path $receiptPath -Value $receipt
  $receipt | ConvertTo-Json -Depth 10
  exit $(if ($operation.exitCode -eq 0) { 0 } else { 1 })
}

function Get-SourceIntegritySnapshot {
  $entries = [ordered]@{}
  $sourcePaths = [ordered]@{
    watcher = $WatcherScript
    restore = $RestoreScript
    syncModule = $SyncModule
    rehearsal = $RehearsalScript
    noticeConsumer = $NoticeConsumer
    registration = $ScriptPath
    roles = $RolesPath
    watcherTest = $WatcherTest
    noticeTest = $NoticeTest
  }
  foreach ($item in $sourcePaths.GetEnumerator()) {
    $entries[$item.Key] = [ordered]@{
      path = $item.Value
      sha256 = (Get-FileHash -LiteralPath $item.Value -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  return $entries
}

function Get-HeadSourceBinding {
  param([string]$Head)

  $actualHead = (& git -C $ProjectRoot rev-parse HEAD 2>$null).Trim()
  $headQueryExitCode = $LASTEXITCODE
  $rows = [Collections.Generic.List[object]]::new()
  foreach ($entry in $SourceIntegrity.GetEnumerator()) {
    $relativePath = [IO.Path]::GetRelativePath($ProjectRoot, [string]$entry.Value.path).Replace('\', '/')
    $trackedOutput = @(& git -C $ProjectRoot ls-files --error-unmatch -- $relativePath 2>&1)
    $trackedExitCode = $LASTEXITCODE
    & git -C $ProjectRoot diff --quiet -- $relativePath 2>$null
    $workingTreeDiffExitCode = $LASTEXITCODE
    & git -C $ProjectRoot diff --cached --quiet -- $relativePath 2>$null
    $indexDiffExitCode = $LASTEXITCODE
    $rows.Add([pscustomobject]@{
      name = $entry.Key
      relativePath = $relativePath
      trackedAtHead = ($trackedExitCode -eq 0)
      trackedQuery = @($trackedOutput | ForEach-Object ToString)
      workingTreeMatchesHead = ($workingTreeDiffExitCode -eq 0)
      indexMatchesHead = ($indexDiffExitCode -eq 0)
    })
  }
  $invalid = @($rows | Where-Object { -not $_.trackedAtHead -or -not $_.workingTreeMatchesHead -or -not $_.indexMatchesHead })
  return [ordered]@{
    head = $Head
    actualHead = $actualHead
    headMatchesExpected = ($headQueryExitCode -eq 0 -and $actualHead -eq $Head)
    ok = ($headQueryExitCode -eq 0 -and $actualHead -eq $Head -and $invalid.Count -eq 0)
    files = @($rows)
    invalidFiles = $invalid
  }
}

function Test-SourceIntegritySnapshotMatch {
  param([object]$Expected, [object]$Actual)
  $rows = foreach ($name in @($Expected.Keys)) {
    [pscustomobject]@{
      name = $name
      expectedPath = [string]$Expected[$name].path
      actualPath = [string]$Actual[$name].path
      expectedSha256 = [string]$Expected[$name].sha256
      actualSha256 = [string]$Actual[$name].sha256
      match = (
        [string]$Expected[$name].path -eq [string]$Actual[$name].path -and
        [string]$Expected[$name].sha256 -eq [string]$Actual[$name].sha256
      )
    }
  }
  $invalid = @($rows | Where-Object { -not $_.match })
  return [ordered]@{
    ok = ($invalid.Count -eq 0 -and @($rows).Count -eq @($Expected.Keys).Count)
    files = @($rows)
    invalidFiles = $invalid
  }
}

function Get-WatcherArgumentsForBinding {
  param(
    [string]$Head,
    [int64]$EpochMs,
    [string]$WatcherSha256,
    [string]$RestoreSha256,
    [string]$ModuleSha256,
    [string]$RegistrationSha256
  )
  return @(
    ('"{0}"' -f $WatcherScript),
    'run',
    '--project-root',
    ('"{0}"' -f $ProjectRoot),
    '--powershell-path',
    ('"{0}"' -f $PowerShellPath),
    '--task-name',
    ('"{0}"' -f $TaskName),
    '--debounce-ms',
    [string]$DebounceMs,
    '--restore-timeout-ms',
    [string]$RestoreTimeoutMs,
    '--expected-head',
    $Head,
    '--registration-epoch-ms',
    [string]$EpochMs,
    '--registration-proof-path',
    ('"{0}"' -f $RegistrationProofPath),
    '--watcher-sha256',
    $WatcherSha256,
    '--restore-sha256',
    $RestoreSha256,
    '--module-sha256',
    $ModuleSha256,
    '--registration-sha256',
    $RegistrationSha256,
    '--quiet-watch-poll-ms',
    '10'
  ) -join ' '
}

function Get-WatcherArguments {
  return Get-WatcherArgumentsForBinding `
    -Head $CurrentHead `
    -EpochMs $RegistrationEpochMs `
    -WatcherSha256 $SourceIntegrity.watcher.sha256 `
    -RestoreSha256 $SourceIntegrity.restore.sha256 `
    -ModuleSha256 $SourceIntegrity.syncModule.sha256 `
    -RegistrationSha256 $SourceIntegrity.registration.sha256
}

function Get-TaskSemanticContract {
  param([Parameter(Mandatory = $true)][string]$Arguments)

  return [ordered]@{
    schema = 'squidrun.build1b.main_e28_restoration_task_semantic_contract.v1'
    actionPath = $NodePath
    actionWorkingDirectory = $ProjectRoot
    actionArguments = $Arguments
    triggerType = 1
    triggerEnabled = $true
    triggerId = 'FiveMinutePoll'
    repetitionInterval = "PT${IntervalMinutes}M"
    repetitionStopAtDurationEnd = $false
    principalSid = $UserSid
    logonType = 3
    runLevel = 0
    taskUri = "\$TaskName"
    description = "$TaskOwnerMarker - one-shot Build 1B main E28 coherence restoration watcher. Stateless five-minute checks; self-disables after success or terminal failure."
    settings = [ordered]@{
      multipleInstances = 2
      disallowStartIfOnBatteries = $false
      stopIfGoingOnBatteries = $false
      allowHardTerminate = $true
      startWhenAvailable = $true
      runOnlyIfNetworkAvailable = $false
      idleDuration = 'PT10M'
      idleWaitTimeout = 'PT1H'
      idleStopOnIdleEnd = $false
      idleRestartOnIdle = $false
      allowDemandStart = $true
      hidden = $false
      runOnlyIfIdle = $false
      disallowStartOnRemoteAppSession = $false
      useUnifiedSchedulingEngine = $true
      wakeToRun = $false
      executionTimeLimit = "PT${ExecutionTimeLimitHours}H"
      priority = 7
    }
  }
}

function Get-TaskSemanticContractSha256 {
  param([Parameter(Mandatory = $true)][object]$Contract)
  return Get-TextSha256 -Value ($Contract | ConvertTo-Json -Depth 8 -Compress)
}

function New-TaskXml {
  $argumentText = $WatcherArguments

  $escapedUser = Escape-XmlText $UserSid
  $escapedTaskName = Escape-XmlText $TaskName
  $escapedNode = Escape-XmlText $NodePath
  $escapedArguments = Escape-XmlText $argumentText
  $escapedWorkingDirectory = Escape-XmlText $ProjectRoot
  return @"
<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>$([DateTime]::Now.ToString('s'))</Date>
    <Author>$(Escape-XmlText $UserName)</Author>
    <URI>\$escapedTaskName</URI>
    <Description>$TaskOwnerMarker - one-shot Build 1B main E28 coherence restoration watcher. Stateless five-minute checks; self-disables after success or terminal failure.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger id="FiveMinutePoll">
      <Repetition>
        <Interval>PT${IntervalMinutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>$StartBoundary</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$escapedUser</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <Duration>PT10M</Duration>
      <WaitTimeout>PT1H</WaitTimeout>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>false</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT${ExecutionTimeLimitHours}H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$escapedNode</Command>
      <Arguments>$escapedArguments</Arguments>
      <WorkingDirectory>$escapedWorkingDirectory</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

function Get-TaskXmlValidation {
  param(
    [string]$Xml,
    [bool]$ExpectedTaskEnabled = $false,
    [Parameter(Mandatory = $true)][object]$ExpectedContract,
    [bool]$RequireFutureStartBoundary = $true
  )

  $xmlForCom = $Xml -replace '^<\?xml[^?]*\?>\s*', ''
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $definition = $service.NewTask(0)
  $definition.XmlText = $xmlForCom
  $action = $definition.Actions.Item(1)
  $trigger = $definition.Triggers.Item(1)
  $triggerStartBoundary = [DateTimeOffset]::Parse([string]$trigger.StartBoundary)
  $principalUserId = [string]$definition.Principal.UserId
  $principalSid = try {
    if ($principalUserId -match '^S-\d-') {
      ([Security.Principal.SecurityIdentifier]::new($principalUserId)).Value
    } else {
      ([Security.Principal.NTAccount]::new($principalUserId)).Translate([Security.Principal.SecurityIdentifier]).Value
    }
  } catch { $null }
  $checks = [ordered]@{
    actionCount = ([int]$definition.Actions.Count -eq 1)
    triggerCount = ([int]$definition.Triggers.Count -eq 1)
    actionPath = ([string]$action.Path -eq [string]$ExpectedContract.actionPath)
    actionWorkingDirectory = ([string]$action.WorkingDirectory -eq [string]$ExpectedContract.actionWorkingDirectory)
    actionArguments = ([string]$action.Arguments -eq [string]$ExpectedContract.actionArguments)
    triggerType = ([int]$trigger.Type -eq [int]$ExpectedContract.triggerType)
    triggerEnabled = ([bool]$trigger.Enabled -eq [bool]$ExpectedContract.triggerEnabled)
    triggerStartBoundaryUsable = if ($RequireFutureStartBoundary) {
      $triggerStartBoundary -gt [DateTimeOffset]::Now.AddMinutes(2)
    } else {
      $triggerStartBoundary.Year -ge 2000
    }
    triggerId = ([string]$trigger.Id -eq [string]$ExpectedContract.triggerId)
    repetitionInterval = ([string]$trigger.Repetition.Interval -eq [string]$ExpectedContract.repetitionInterval)
    repetitionStopAtDurationEnd = ([bool]$trigger.Repetition.StopAtDurationEnd -eq [bool]$ExpectedContract.repetitionStopAtDurationEnd)
    executionTimeLimit = ([string]$definition.Settings.ExecutionTimeLimit -eq [string]$ExpectedContract.settings.executionTimeLimit)
    multipleInstancesIgnoreNew = ([int]$definition.Settings.MultipleInstances -eq [int]$ExpectedContract.settings.multipleInstances)
    interactiveToken = ([int]$definition.Principal.LogonType -eq [int]$ExpectedContract.logonType)
    leastPrivilege = ([int]$definition.Principal.RunLevel -eq [int]$ExpectedContract.runLevel)
    principalUserId = ($principalSid -eq [string]$ExpectedContract.principalSid)
    taskEnabled = ([bool]$definition.Settings.Enabled -eq $ExpectedTaskEnabled)
    disallowStartIfOnBatteries = ([bool]$definition.Settings.DisallowStartIfOnBatteries -eq [bool]$ExpectedContract.settings.disallowStartIfOnBatteries)
    stopIfGoingOnBatteries = ([bool]$definition.Settings.StopIfGoingOnBatteries -eq [bool]$ExpectedContract.settings.stopIfGoingOnBatteries)
    startWhenAvailable = ([bool]$definition.Settings.StartWhenAvailable -eq [bool]$ExpectedContract.settings.startWhenAvailable)
    allowHardTerminate = ([bool]$definition.Settings.AllowHardTerminate -eq [bool]$ExpectedContract.settings.allowHardTerminate)
    runOnlyIfNetworkAvailable = ([bool]$definition.Settings.RunOnlyIfNetworkAvailable -eq [bool]$ExpectedContract.settings.runOnlyIfNetworkAvailable)
    idleDuration = ([string]$definition.Settings.IdleSettings.IdleDuration -eq [string]$ExpectedContract.settings.idleDuration)
    idleWaitTimeout = ([string]$definition.Settings.IdleSettings.WaitTimeout -eq [string]$ExpectedContract.settings.idleWaitTimeout)
    idleStopOnIdleEnd = ([bool]$definition.Settings.IdleSettings.StopOnIdleEnd -eq [bool]$ExpectedContract.settings.idleStopOnIdleEnd)
    idleRestartOnIdle = ([bool]$definition.Settings.IdleSettings.RestartOnIdle -eq [bool]$ExpectedContract.settings.idleRestartOnIdle)
    allowDemandStart = ([bool]$definition.Settings.AllowDemandStart -eq [bool]$ExpectedContract.settings.allowDemandStart)
    hidden = ([bool]$definition.Settings.Hidden -eq [bool]$ExpectedContract.settings.hidden)
    runOnlyIfIdle = ([bool]$definition.Settings.RunOnlyIfIdle -eq [bool]$ExpectedContract.settings.runOnlyIfIdle)
    disallowStartOnRemoteAppSession = ([bool]$definition.Settings.DisallowStartOnRemoteAppSession -eq [bool]$ExpectedContract.settings.disallowStartOnRemoteAppSession)
    useUnifiedSchedulingEngine = ([bool]$definition.Settings.UseUnifiedSchedulingEngine -eq [bool]$ExpectedContract.settings.useUnifiedSchedulingEngine)
    wakeToRun = ([bool]$definition.Settings.WakeToRun -eq [bool]$ExpectedContract.settings.wakeToRun)
    priority = ([int]$definition.Settings.Priority -eq [int]$ExpectedContract.settings.priority)
    ownerMarker = ([string]$definition.RegistrationInfo.Description -eq [string]$ExpectedContract.description)
    taskUri = ([string]$definition.RegistrationInfo.URI -eq [string]$ExpectedContract.taskUri)
  }
  $failedChecks = @($checks.GetEnumerator() | Where-Object { -not [bool]$_.Value } | ForEach-Object Key)
  if ($failedChecks.Count -gt 0) {
    throw "Task XML semantic validation failed: $($failedChecks -join ', ')"
  }
  return [ordered]@{
    accepted = $true
    parser = 'Schedule.Service.NewTask.XmlText'
    xmlDeclarationHandling = 'UTF-8 declaration retained in the on-disk file and stripped only from the UTF-16 COM validation string.'
    actionPath = $action.Path
    actionWorkingDirectory = $action.WorkingDirectory
    actionArguments = $action.Arguments
    triggerType = $trigger.Type
    triggerEnabled = $trigger.Enabled
    triggerStartBoundary = $trigger.StartBoundary
    repetitionInterval = $trigger.Repetition.Interval
    executionTimeLimit = $definition.Settings.ExecutionTimeLimit
    multipleInstancesPolicyValue = $definition.Settings.MultipleInstances
    principalUserId = $definition.Principal.UserId
    principalSid = $principalSid
    logonTypeValue = $definition.Principal.LogonType
    runLevelValue = $definition.Principal.RunLevel
    taskEnabled = $definition.Settings.Enabled
    expectedTaskEnabled = $ExpectedTaskEnabled
    actionCount = $definition.Actions.Count
    triggerCount = $definition.Triggers.Count
    taskUri = $definition.RegistrationInfo.URI
    description = $definition.RegistrationInfo.Description
    checks = $checks
  }
}

function Get-ExistingTaskOwnership {
  param([object]$TaskStatus)

  $presence = Get-TaskPresence
  if (-not $presence.ok) {
    return [ordered]@{
      exists = $null
      owned = $false
      enabled = $null
      query = $null
      presence = $presence
      reason = 'task_presence_unavailable'
    }
  }
  if (-not $presence.exists) {
    return [ordered]@{
      exists = $false
      owned = $false
      enabled = $null
      query = $null
      presence = $presence
      reason = 'task_absent_confirmed_by_com'
    }
  }
  $query = Invoke-Captured -FilePath $SchtasksPath -Arguments @('/Query', '/TN', $TaskName, '/XML')
  if ($query.exitCode -ne 0 -or -not $query.stdout) {
    return [ordered]@{
      exists = $true
      owned = $false
      enabled = $null
      query = $query
      presence = $presence
      reason = 'existing_task_xml_unavailable'
    }
  }
  try {
    $anchor = Read-JsonFile -Path $OwnershipAnchorPath
    $proof = Read-JsonFile -Path $RegistrationProofPath
    $watcherSha256 = if ($anchor) { [string]$anchor.sourceIntegrity.watcher.sha256 } else { '' }
    $restoreSha256 = if ($anchor) { [string]$anchor.sourceIntegrity.restore.sha256 } else { '' }
    $moduleSha256 = if ($anchor) { [string]$anchor.sourceIntegrity.module.sha256 } else { '' }
    $registrationSha256 = if ($anchor) { [string]$anchor.sourceIntegrity.registration.sha256 } else { '' }
    $anchorPathMatches = $anchor -and (
      [IO.Path]::GetFullPath([string]$anchor.anchorPath) -eq [IO.Path]::GetFullPath($OwnershipAnchorPath)
    )
    $registeredXmlPathMatches = $anchor -and (
      [IO.Path]::GetFullPath([string]$anchor.registeredXmlPath) -eq
        [IO.Path]::GetFullPath((Join-Path $ReceiptRoot 'registered-task.xml'))
    )
    $registeredXmlArtifactValid = (
      $registeredXmlPathMatches -and
      (Test-Path -LiteralPath ([string]$anchor.registeredXmlPath) -PathType Leaf) -and
      [string]$anchor.registeredXmlSha256 -match '^[a-f0-9]{64}$' -and
      (Get-FileHash -LiteralPath ([string]$anchor.registeredXmlPath) -Algorithm SHA256).Hash.ToLowerInvariant() -eq
        [string]$anchor.registeredXmlSha256
    )
    $phaseEnabledShapeValid = $anchor -and (
      ([string]$anchor.phase -eq 'prepared_disabled_verified' -and $anchor.enabled -eq $false) -or
      ([string]$anchor.phase -eq 'enabled_verified' -and $anchor.enabled -eq $true) -or
      ([string]$anchor.phase -eq 'registration_failed_disabled' -and $anchor.enabled -eq $false)
    )
    $bindingRows = if ($anchor) {
      @(
        [pscustomobject]@{ name = 'watcher'; expectedPath = $WatcherScript; anchorEntry = $anchor.sourceIntegrity.watcher },
        [pscustomobject]@{ name = 'restore'; expectedPath = $RestoreScript; anchorEntry = $anchor.sourceIntegrity.restore },
        [pscustomobject]@{ name = 'module'; expectedPath = $SyncModule; anchorEntry = $anchor.sourceIntegrity.module },
        [pscustomobject]@{ name = 'registration'; expectedPath = $ScriptPath; anchorEntry = $anchor.sourceIntegrity.registration }
      ) | ForEach-Object {
        [pscustomobject]@{
          name = $_.name
          expectedPath = [IO.Path]::GetFullPath([string]$_.expectedPath)
          anchorPath = [IO.Path]::GetFullPath([string]$_.anchorEntry.path)
          sha256 = [string]$_.anchorEntry.sha256
          pathMatches = (
            [IO.Path]::GetFullPath([string]$_.anchorEntry.path) -eq
              [IO.Path]::GetFullPath([string]$_.expectedPath)
          )
          hashShapeValid = ([string]$_.anchorEntry.sha256 -match '^[a-f0-9]{64}$')
        }
      }
    } else { @() }
    $sourceBindingShapeValid = (
      $bindingRows.Count -eq 4 -and
      @($bindingRows | Where-Object { -not $_.pathMatches -or -not $_.hashShapeValid }).Count -eq 0
    )
    $semanticContract = if ($anchor) { $anchor.semanticContract } else { $null }
    $semanticContractShapeValid = (
      $semanticContract -and
      [string]$semanticContract.schema -eq 'squidrun.build1b.main_e28_restoration_task_semantic_contract.v1' -and
      [string]$semanticContract.actionPath -and
      [string]$semanticContract.actionWorkingDirectory -and
      [string]$semanticContract.actionArguments -and
      [string]$semanticContract.principalSid -match '^S-\d-' -and
      [string]$semanticContract.taskUri -eq "\$TaskName" -and
      [string]$anchor.semanticContractSha256 -match '^[a-f0-9]{64}$'
    )
    if ($semanticContractShapeValid) {
      $semanticContractShapeValid = (
        [string]$anchor.semanticContractSha256 -match '^[a-f0-9]{64}$' -and
        [string]$anchor.semanticContractSha256 -eq (Get-TaskSemanticContractSha256 -Contract $semanticContract)
      )
    }
    $anchorShapeValid = (
      $anchor -and
      [string]$anchor.schema -eq 'squidrun.build1b.main_e28_restoration_task_ownership_anchor.v1' -and
      $anchor.ok -eq $true -and
      [string]$anchor.taskName -eq $TaskName -and
      [string]$anchor.expectedHead -match '^[a-f0-9]{40}$' -and
      [int64]$anchor.registrationEpochMs -gt 0 -and
      [string]$anchor.watcherArgumentsSha256 -match '^[a-f0-9]{64}$' -and
      [string]$anchor.registeredXmlSha256 -match '^[a-f0-9]{64}$' -and
      $anchorPathMatches -and
      $registeredXmlPathMatches -and
      $registeredXmlArtifactValid -and
      $phaseEnabledShapeValid -and
      $sourceBindingShapeValid -and
      $semanticContractShapeValid
    )
    $expectedArguments = if ($anchorShapeValid) { [string]$semanticContract.actionArguments } else { '' }
    $argumentsDigestMatches = $anchorShapeValid -and (
      [string]$anchor.watcherArgumentsSha256 -eq (Get-TextSha256 -Value $expectedArguments)
    )
    $validation = if ($argumentsDigestMatches) {
      Get-TaskXmlValidation `
        -Xml $query.stdout `
        -ExpectedTaskEnabled:([bool]$presence.enabled) `
        -ExpectedContract $semanticContract `
        -RequireFutureStartBoundary:$false
    } else { $null }
    $owned = ($argumentsDigestMatches -and $validation.accepted)
    return [ordered]@{
      exists = $true
      owned = $owned
      enabled = [bool]$presence.enabled
      query = $query
      presence = $presence
      taskStatus = $TaskStatus
      ownershipAnchorPath = $OwnershipAnchorPath
      ownershipAnchorShapeValid = $anchorShapeValid
      ownershipAnchorPhase = if ($anchor) { [string]$anchor.phase } else { $null }
      sourceBindingShapeValid = $sourceBindingShapeValid
      sourceBindings = $bindingRows
      registrationProofPresent = ($null -ne $proof)
      registrationProofPhase = if ($proof) { [string]$proof.phase } else { $null }
      watcherArgumentsDigestMatches = $argumentsDigestMatches
      registeredXmlArtifactValid = $registeredXmlArtifactValid
      semanticContractShapeValid = $semanticContractShapeValid
      semanticValidation = $validation
      reason = if ($owned) { 'existing_task_exact_immutable_anchor_contract_confirmed' } else { 'existing_task_identity_mismatch' }
    }
  } catch {
    return [ordered]@{
      exists = $true
      owned = $false
      enabled = $null
      query = $query
      presence = $presence
      reason = 'existing_task_xml_parse_failed'
      error = $_.Exception.Message
    }
  }
}

function Get-RegisteredTaskSnapshot {
  param(
    [bool]$ExpectedTaskEnabled,
    [bool]$RequireFutureStartBoundary = $true
  )

  $query = Invoke-Captured -FilePath $SchtasksPath -Arguments @('/Query', '/TN', $TaskName, '/XML')
  if ($query.exitCode -ne 0 -or -not $query.stdout) {
    return [ordered]@{
      ok = $false
      exists = $false
      expectedEnabled = $ExpectedTaskEnabled
      query = $query
      reason = 'registered_task_xml_unavailable'
    }
  }
  try {
    $validation = Get-TaskXmlValidation `
      -Xml $query.stdout `
      -ExpectedTaskEnabled $ExpectedTaskEnabled `
      -ExpectedContract $TaskSemanticContract `
      -RequireFutureStartBoundary:$RequireFutureStartBoundary
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $registered = $service.GetFolder('\').GetTask("\$TaskName")
    $nextRunTime = [DateTime]$registered.NextRunTime
    $state = [int]$registered.State
    $enabled = [bool]$registered.Enabled
    $runtimeReady = if ($ExpectedTaskEnabled) {
      $enabled -and $state -in @(2, 3, 4) -and $nextRunTime -gt [DateTime]::Now
    } else {
      -not $enabled
    }
    return [ordered]@{
      ok = ($validation.accepted -and $enabled -eq $ExpectedTaskEnabled -and $runtimeReady)
      exists = $true
      expectedEnabled = $ExpectedTaskEnabled
      enabled = $enabled
      state = $state
      nextRunTime = $nextRunTime.ToString('o')
      runtimeReady = $runtimeReady
      ownerMarkerVerified = [bool]$validation.checks.ownerMarker
      query = $query
      semanticValidation = $validation
    }
  } catch {
    return [ordered]@{
      ok = $false
      exists = $true
      expectedEnabled = $ExpectedTaskEnabled
      query = $query
      reason = 'registered_task_snapshot_failed'
      error = $_.Exception.Message
    }
  }
}

function Get-TaskPresence {
  try {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $registered = $service.GetFolder('\').GetTask("\$TaskName")
    return [ordered]@{
      ok = $true
      exists = $true
      path = $registered.Path
      name = $registered.Name
      enabled = [bool]$registered.Enabled
      state = [int]$registered.State
    }
  } catch [Runtime.InteropServices.COMException] {
    if (([int]$_.Exception.HResult -band 0xFFFF) -eq 2) {
      return [ordered]@{ ok = $true; exists = $false; hresult = $_.Exception.HResult }
    }
    return [ordered]@{ ok = $false; exists = $null; hresult = $_.Exception.HResult; error = $_.Exception.Message }
  } catch {
    if (([int]$_.Exception.HResult -band 0xFFFF) -eq 2) {
      return [ordered]@{ ok = $true; exists = $false; hresult = $_.Exception.HResult }
    }
    return [ordered]@{ ok = $false; exists = $null; error = $_.Exception.Message }
  }
}

function Get-ScheduleServiceSnapshot {
  $service = Get-CimInstance Win32_Service -Filter "Name='Schedule'" -ErrorAction SilentlyContinue
  $failureActions = Invoke-Captured -FilePath $ScPath -Arguments @('qfailure', 'Schedule')
  return [ordered]@{
    name = $service.Name
    state = $service.State
    startMode = $service.StartMode
    processId = $service.ProcessId
    pathName = $service.PathName
    failureActions = $failureActions
  }
}

if ($Action -in @('disable', 'unregister')) {
  if (-not (Test-Path -LiteralPath $SchtasksPath -PathType Leaf)) {
    throw "Task Scheduler CLI is missing: $SchtasksPath"
  }
  [void][IO.Directory]::CreateDirectory($ReceiptRoot)
  $mutationOwnership = Enter-TaskMutationMutex
  if (-not $mutationOwnership.ok) {
    throw $mutationOwnership.reason
  }
  $controlReceiptPath = New-ReceiptPath -Suffix $Action
  $controlExitCode = 1
  $controlReceipt = $null
  try {
    $statusBefore = Invoke-Captured -FilePath $SchtasksPath -Arguments @('/Query', '/TN', $TaskName, '/V', '/FO', 'LIST')
    $ownershipBefore = Get-ExistingTaskOwnership -TaskStatus $statusBefore
    $controlReceipt = [ordered]@{
      schema = 'squidrun.build1b.main_e28_restoration_task_control.v2'
      phase = 'prepared_before_mutation'
      capturedAt = [DateTime]::UtcNow.ToString('o')
      action = $Action
      taskName = $TaskName
      ok = $false
      receiptPath = $controlReceiptPath
      mutationMutex = [ordered]@{
        name = $mutationOwnership.name
        staleStory = $mutationOwnership.staleStory
      }
      statusBefore = $statusBefore
      ownershipBefore = $ownershipBefore
    }
    Write-JsonAtomic -Path $controlReceiptPath -Value $controlReceipt
    if ($statusBefore.exitCode -ne 0 -or -not $ownershipBefore.exists -or -not $ownershipBefore.owned) {
      $controlReceipt['phase'] = 'refused_before_mutation'
      $controlReceipt['reason'] = if ($statusBefore.exitCode -ne 0) { 'task_missing_or_status_unavailable' } else { 'task_ownership_mismatch' }
    } else {
      $statusImmediate = Invoke-Captured -FilePath $SchtasksPath -Arguments @('/Query', '/TN', $TaskName, '/V', '/FO', 'LIST')
      $ownershipImmediate = Get-ExistingTaskOwnership -TaskStatus $statusImmediate
      $controlReceipt['ownershipImmediateBeforeMutation'] = $ownershipImmediate
      if ($statusImmediate.exitCode -ne 0 -or -not $ownershipImmediate.owned) {
        $controlReceipt['phase'] = 'refused_before_mutation'
        $controlReceipt['reason'] = 'task_identity_changed_before_mutation'
      } else {
        $arguments = if ($Action -eq 'disable') {
          @('/Change', '/TN', $TaskName, '/Disable')
        } else {
          @('/Delete', '/TN', $TaskName, '/F')
        }
        $operation = Invoke-Captured -FilePath $SchtasksPath -Arguments $arguments
        $controlReceipt['operation'] = $operation
        $statusAfter = Invoke-Captured -FilePath $SchtasksPath -Arguments @('/Query', '/TN', $TaskName, '/V', '/FO', 'LIST')
        $presenceAfter = Get-TaskPresence
        $ownershipAfter = Get-ExistingTaskOwnership -TaskStatus $statusAfter
        $verified = if ($Action -eq 'disable') {
          $operation.exitCode -eq 0 -and
          $presenceAfter.ok -and $presenceAfter.exists -and $presenceAfter.enabled -eq $false -and
          $statusAfter.exitCode -eq 0 -and $ownershipAfter.owned -and $ownershipAfter.enabled -eq $false
        } else {
          $operation.exitCode -eq 0 -and
          $presenceAfter.ok -and $presenceAfter.exists -eq $false -and
          $ownershipAfter.exists -eq $false
        }
        $controlReceipt['statusAfter'] = $statusAfter
        $controlReceipt['taskPresenceAfter'] = $presenceAfter
        $controlReceipt['ownershipAfter'] = $ownershipAfter
        $controlReceipt['phase'] = if ($verified) { 'committed_verified' } else { 'mutation_post_state_unverified' }
        $controlReceipt['ok'] = $verified
        $controlExitCode = if ($verified) { 0 } else { 1 }
      }
    }
    $controlReceipt['completedAt'] = [DateTime]::UtcNow.ToString('o')
    Write-JsonAtomic -Path $controlReceiptPath -Value $controlReceipt
  } catch {
    if (-not $controlReceipt) {
      $controlReceipt = [ordered]@{
        schema = 'squidrun.build1b.main_e28_restoration_task_control.v2'
        action = $Action
        taskName = $TaskName
        receiptPath = $controlReceiptPath
      }
    }
    $controlReceipt['phase'] = 'control_exception_post_state_unverified'
    $controlReceipt['ok'] = $false
    $controlReceipt['error'] = $_.Exception.Message
    $controlReceipt['errorStack'] = $_.ScriptStackTrace
    $controlReceipt['completedAt'] = [DateTime]::UtcNow.ToString('o')
    try { Write-JsonAtomic -Path $controlReceiptPath -Value $controlReceipt } catch {}
    $controlExitCode = 1
  } finally {
    Exit-TaskMutationMutex -Ownership $mutationOwnership
  }
  $controlReceipt | ConvertTo-Json -Depth 16
  exit $controlExitCode
}

foreach ($requiredPath in @($WatcherScript, $RestoreScript, $SyncModule, $RehearsalScript, $NoticeConsumer, $RolesPath, $WatcherTest, $NoticeTest, $NodePath, $PowerShellPath, $SchtasksPath, $ScPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required executable or script is missing: $requiredPath"
  }
}
[void][IO.Directory]::CreateDirectory($ReceiptRoot)
$CurrentHead = (& git -C $ProjectRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $CurrentHead -notmatch '^[a-f0-9]{40}$') {
  throw 'Unable to bind the watcher task to the current Git HEAD.'
}
$SourceIntegrity = Get-SourceIntegritySnapshot
$HeadSourceBinding = Get-HeadSourceBinding -Head $CurrentHead
$WatcherArguments = Get-WatcherArguments
$WatcherArgumentsSha256 = Get-TextSha256 -Value $WatcherArguments
$TaskSemanticContract = Get-TaskSemanticContract -Arguments $WatcherArguments
$TaskSemanticContractSha256 = Get-TaskSemanticContractSha256 -Contract $TaskSemanticContract
$taskStatusBefore = Invoke-Captured -FilePath $SchtasksPath -Arguments @('/Query', '/TN', $TaskName, '/V', '/FO', 'LIST')
$taskPresenceBefore = Get-TaskPresence
if (-not $taskPresenceBefore.ok) {
  throw "Unable to determine whether the proposed task name already exists: $($taskPresenceBefore.error)"
}
$existingTaskOwnership = Get-ExistingTaskOwnership -TaskStatus $taskStatusBefore

$taskXml = New-TaskXml
$taskXmlValidation = Get-TaskXmlValidation -Xml $taskXml -ExpectedTaskEnabled:$false -ExpectedContract $TaskSemanticContract
$renderedXmlPath = Join-Path $ReceiptRoot "proposed-task-$RegistrationEpochMs-$([guid]::NewGuid().ToString('n')).xml"
Write-TextAtomic -Path $renderedXmlPath -Value $taskXml

$baseReceipt = [ordered]@{
  schema = 'squidrun.build1b.main_e28_restoration_task_registration.v2'
  capturedAt = [DateTime]::UtcNow.ToString('o')
  action = $Action
  taskName = $TaskName
  expectedHead = $CurrentHead
  registrationEpochMs = $RegistrationEpochMs
  registrationProofPath = $RegistrationProofPath
  ownershipAnchorPath = $OwnershipAnchorPath
  ok = ($taskXmlValidation.accepted -and $HeadSourceBinding.ok -and -not $taskPresenceBefore.exists)
  registeredByThisRun = $false
  taskStatusBefore = $taskStatusBefore
  taskPresenceBefore = $taskPresenceBefore
  scheduleService = Get-ScheduleServiceSnapshot
  sourceIntegrity = $SourceIntegrity
  headSourceBinding = $HeadSourceBinding
  existingTaskOwnership = $existingTaskOwnership
  userContext = [ordered]@{
    userName = $UserName
    userSid = $UserSid
    logonType = 'InteractiveToken'
    runLevel = 'LeastPrivilege'
  }
  actionContract = [ordered]@{
    nodePath = $NodePath
    watcherScript = $WatcherScript
    powershellPath = $PowerShellPath
    workingDirectory = $ProjectRoot
    intervalMinutes = $IntervalMinutes
    debounceMinutes = $DebounceMinutes
    quietWatchPollMs = 10
    restoreTimeoutMs = $RestoreTimeoutMs
    restoreTimeoutHours = $RestoreTimeoutHours
    multipleInstancesPolicy = 'IgnoreNew'
    executionTimeLimitHours = $ExecutionTimeLimitHours
    createDisabledBeforeVerification = $true
    enableOnlyAfterDisabledVerification = $true
    committedRegistrationProofRequiredByWatcher = $true
    replaceExistingTask = $false
    disarmAfterSuccess = $true
    disarmAfterTerminalFailure = $true
    watcherArguments = $WatcherArguments
    watcherArgumentsSha256 = $WatcherArgumentsSha256
  }
  renderedXmlPath = $renderedXmlPath
  renderedXmlSha256 = (Get-FileHash -LiteralPath $renderedXmlPath -Algorithm SHA256).Hash.ToLowerInvariant()
  schedulerComValidation = $taskXmlValidation
}

if ($Action -eq 'render') {
  $receiptPath = Join-Path $ReceiptRoot 'render-plan.json'
  $baseReceipt['receiptPath'] = $receiptPath
  Write-JsonAtomic -Path $receiptPath -Value $baseReceipt
  $baseReceipt | ConvertTo-Json -Depth 16
  exit 0
}

# The only mutation path. Oracle's W gate must be PASS before Builder invokes
# -Action register; the default action above only renders auditable artifacts.
if (-not $baseReceipt.ok) {
  $baseReceipt['kind'] = 'registration_precondition_refusal'
  $registrationReceiptPath = New-ReceiptPath -Suffix 'registration-refusal'
  $baseReceipt['receiptPath'] = $registrationReceiptPath
  Write-JsonAtomic -Path $registrationReceiptPath -Value $baseReceipt
  $baseReceipt | ConvertTo-Json -Depth 16
  exit 1
}

$registrationReceiptPath = New-ReceiptPath -Suffix 'registration'
$baseReceipt['receiptPath'] = $registrationReceiptPath
$mutationOwnership = Enter-TaskMutationMutex
if (-not $mutationOwnership.ok) {
  $baseReceipt['kind'] = 'registration_mutex_refusal'
  $baseReceipt['error'] = $mutationOwnership.reason
  Write-JsonAtomic -Path $registrationReceiptPath -Value $baseReceipt
  $baseReceipt | ConvertTo-Json -Depth 16
  exit 1
}
$baseReceipt['mutationMutex'] = [ordered]@{
  name = $mutationOwnership.name
  staleStory = $mutationOwnership.staleStory
}
$registrationVerified = $false
$taskCreated = $false
$registeredXmlPath = Join-Path $ReceiptRoot 'registered-task.xml'
try {
  $preCreatePresence = Get-TaskPresence
  $preCreateRenderedXmlSha256 = (Get-FileHash -LiteralPath $renderedXmlPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $preCreateBinding = Get-HeadSourceBinding -Head $CurrentHead
  $preCreateSource = Get-SourceIntegritySnapshot
  $preCreateSourceMatch = Test-SourceIntegritySnapshotMatch -Expected $SourceIntegrity -Actual $preCreateSource
  $baseReceipt['preCreateRecheck'] = [ordered]@{
    taskPresence = $preCreatePresence
    renderedXmlSha256 = $preCreateRenderedXmlSha256
    renderedXmlMatchesValidatedArtifact = ($preCreateRenderedXmlSha256 -eq $baseReceipt.renderedXmlSha256)
    headSourceBinding = $preCreateBinding
    sourceIntegrity = $preCreateSource
    sourceMatchesInitial = $preCreateSourceMatch
  }
  if (
    -not $preCreatePresence.ok -or
    $preCreatePresence.exists -or
    $preCreateRenderedXmlSha256 -ne $baseReceipt.renderedXmlSha256 -or
    -not $preCreateBinding.ok -or
    -not $preCreateSourceMatch.ok
  ) {
    throw 'Registration pre-create binding changed; refusing task creation.'
  }

  # No /F: a concurrent name collision fails instead of overwriting any task.
  $create = Invoke-Captured -FilePath $SchtasksPath -Arguments @('/Create', '/TN', $TaskName, '/XML', $renderedXmlPath)
  $baseReceipt['registerDisabled'] = $create
  if ($create.exitCode -ne 0) {
    throw "Disabled task creation failed: $($create.stderr)"
  }
  $taskCreated = $true
  $baseReceipt['registeredByThisRun'] = $true

  $disabledSnapshot = Get-RegisteredTaskSnapshot -ExpectedTaskEnabled:$false
  $postCreateBinding = Get-HeadSourceBinding -Head $CurrentHead
  $postCreateSource = Get-SourceIntegritySnapshot
  $postCreateSourceMatch = Test-SourceIntegritySnapshotMatch -Expected $SourceIntegrity -Actual $postCreateSource
  $baseReceipt['disabledVerification'] = [ordered]@{
    task = $disabledSnapshot
    headSourceBinding = $postCreateBinding
    sourceIntegrity = $postCreateSource
    sourceMatchesInitial = $postCreateSourceMatch
  }
  if (-not $disabledSnapshot.ok -or -not $postCreateBinding.ok -or -not $postCreateSourceMatch.ok) {
    throw 'Created task did not pass disabled-state, HEAD, or source verification.'
  }
  Write-TextAtomic -Path $registeredXmlPath -Value ([string]$disabledSnapshot.query.stdout)

  $disabledRegisteredXmlSha256 = (Get-FileHash -LiteralPath $registeredXmlPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $ownershipAnchor = [ordered]@{
    schema = 'squidrun.build1b.main_e28_restoration_task_ownership_anchor.v1'
    phase = 'prepared_disabled_verified'
    ok = $true
    anchorPath = $OwnershipAnchorPath
    taskName = $TaskName
    expectedHead = $CurrentHead
    registrationEpochMs = $RegistrationEpochMs
    watcherArgumentsSha256 = $WatcherArgumentsSha256
    semanticContract = $TaskSemanticContract
    semanticContractSha256 = $TaskSemanticContractSha256
    sourceIntegrity = [ordered]@{
      watcher = $SourceIntegrity.watcher
      restore = $SourceIntegrity.restore
      module = $SourceIntegrity.syncModule
      registration = $SourceIntegrity.registration
    }
    registeredXmlPath = $registeredXmlPath
    registeredXmlSha256 = $disabledRegisteredXmlSha256
    enabled = $false
    createdAt = [DateTime]::UtcNow.ToString('o')
    updatedAt = [DateTime]::UtcNow.ToString('o')
  }
  Write-JsonAtomic -Path $OwnershipAnchorPath -Value $ownershipAnchor
  $baseReceipt['ownershipAnchorPreparedSha256'] = (Get-FileHash -LiteralPath $OwnershipAnchorPath -Algorithm SHA256).Hash.ToLowerInvariant()

  $preEnableSnapshot = Get-RegisteredTaskSnapshot -ExpectedTaskEnabled:$false
  $preEnableBinding = Get-HeadSourceBinding -Head $CurrentHead
  $preEnableSource = Get-SourceIntegritySnapshot
  $preEnableSourceMatch = Test-SourceIntegritySnapshotMatch -Expected $SourceIntegrity -Actual $preEnableSource
  $baseReceipt['preEnableRecheck'] = [ordered]@{
    task = $preEnableSnapshot
    headSourceBinding = $preEnableBinding
    sourceIntegrity = $preEnableSource
    sourceMatchesInitial = $preEnableSourceMatch
  }
  if (-not $preEnableSnapshot.ok -or -not $preEnableBinding.ok -or -not $preEnableSourceMatch.ok) {
    throw 'Disabled task, HEAD, or source binding changed immediately before enable authorization.'
  }

  $preparedAtUtc = [DateTime]::UtcNow
  $preparedProof = [ordered]@{
    schema = 'squidrun.build1b.main_e28_restoration_task_registration_proof.v1'
    phase = 'prepared_enable_authorized'
    ok = $false
    proofPath = $RegistrationProofPath
    taskName = $TaskName
    expectedHead = $CurrentHead
    registrationEpochMs = $RegistrationEpochMs
    preparedAt = $preparedAtUtc.ToString('o')
    enableAuthorized = $true
    enableAuthorizationExpiresAt = $preparedAtUtc.AddMinutes(30).ToString('o')
    watcherArgumentsSha256 = $WatcherArgumentsSha256
    semanticContractSha256 = $TaskSemanticContractSha256
    sourceIntegrity = [ordered]@{
      watcher = $SourceIntegrity.watcher
      restore = $SourceIntegrity.restore
      module = $SourceIntegrity.syncModule
      registration = $SourceIntegrity.registration
    }
    registeredTask = [ordered]@{
      enabled = $false
      ownerMarkerVerified = [bool]$disabledSnapshot.ownerMarkerVerified
      runtimeReady = $false
    }
  }
  Write-JsonAtomic -Path $RegistrationProofPath -Value $preparedProof

  $enable = Invoke-Captured -FilePath $SchtasksPath -Arguments @('/Change', '/TN', $TaskName, '/Enable')
  $baseReceipt['enable'] = $enable
  if ($enable.exitCode -ne 0) {
    throw "Task enable failed: $($enable.stderr)"
  }

  $enabledSnapshot = Get-RegisteredTaskSnapshot -ExpectedTaskEnabled:$true
  $enabledStatus = Invoke-Captured -FilePath $SchtasksPath -Arguments @('/Query', '/TN', $TaskName, '/V', '/FO', 'LIST')
  $finalBinding = Get-HeadSourceBinding -Head $CurrentHead
  $finalSource = Get-SourceIntegritySnapshot
  $finalSourceMatch = Test-SourceIntegritySnapshotMatch -Expected $SourceIntegrity -Actual $finalSource
  $baseReceipt['enabledVerification'] = [ordered]@{
    task = $enabledSnapshot
    status = $enabledStatus
    headSourceBinding = $finalBinding
    sourceIntegrity = $finalSource
    sourceMatchesInitial = $finalSourceMatch
  }
  if (-not $enabledSnapshot.ok -or $enabledStatus.exitCode -ne 0 -or -not $finalBinding.ok -or -not $finalSourceMatch.ok) {
    throw 'Enabled task did not pass runtime, HEAD, or source verification.'
  }
  Write-TextAtomic -Path $registeredXmlPath -Value ([string]$enabledSnapshot.query.stdout)
  $registeredXmlSha256 = (Get-FileHash -LiteralPath $registeredXmlPath -Algorithm SHA256).Hash.ToLowerInvariant()

  $ownershipAnchor['phase'] = 'enabled_verified'
  $ownershipAnchor['enabled'] = $true
  $ownershipAnchor['registeredXmlSha256'] = $registeredXmlSha256
  $ownershipAnchor['updatedAt'] = [DateTime]::UtcNow.ToString('o')
  Write-JsonAtomic -Path $OwnershipAnchorPath -Value $ownershipAnchor

  $baseReceipt['phase'] = 'enabled_verified_pending_committed_proof'
  $baseReceipt['ok'] = $false
  $baseReceipt['registeredXml'] = [ordered]@{
    path = $registeredXmlPath
    sha256 = $registeredXmlSha256
    semanticValidation = $enabledSnapshot.semanticValidation
  }
  $baseReceipt['ownershipAnchorSha256'] = (Get-FileHash -LiteralPath $OwnershipAnchorPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-JsonAtomic -Path $registrationReceiptPath -Value $baseReceipt

  $committedProof = [ordered]@{
    schema = 'squidrun.build1b.main_e28_restoration_task_registration_proof.v1'
    phase = 'committed_enabled'
    ok = $true
    proofPath = $RegistrationProofPath
    taskName = $TaskName
    expectedHead = $CurrentHead
    registrationEpochMs = $RegistrationEpochMs
    committedAt = [DateTime]::UtcNow.ToString('o')
    watcherArgumentsSha256 = $WatcherArgumentsSha256
    semanticContractSha256 = $TaskSemanticContractSha256
    registrationReceiptPath = $registrationReceiptPath
    registeredXmlPath = $registeredXmlPath
    registeredXmlSha256 = $registeredXmlSha256
    sourceIntegrity = [ordered]@{
      watcher = $SourceIntegrity.watcher
      restore = $SourceIntegrity.restore
      module = $SourceIntegrity.syncModule
      registration = $SourceIntegrity.registration
    }
    registeredTask = [ordered]@{
      enabled = [bool]$enabledSnapshot.enabled
      state = [int]$enabledSnapshot.state
      nextRunTime = $enabledSnapshot.nextRunTime
      ownerMarkerVerified = [bool]$enabledSnapshot.ownerMarkerVerified
      runtimeReady = [bool]$enabledSnapshot.runtimeReady
    }
  }
  Write-JsonAtomic -Path $RegistrationProofPath -Value $committedProof
  $baseReceipt['phase'] = 'committed_enabled'
  $baseReceipt['ok'] = $true
  $baseReceipt['registrationProofSha256'] = (Get-FileHash -LiteralPath $RegistrationProofPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $baseReceipt['completedAt'] = [DateTime]::UtcNow.ToString('o')
  Write-JsonAtomic -Path $registrationReceiptPath -Value $baseReceipt
  $registrationVerified = $true
} catch {
  $baseReceipt['phase'] = 'registration_failed'
  $baseReceipt['ok'] = $false
  $baseReceipt['error'] = $_.Exception.Message
  $baseReceipt['errorStack'] = $_.ScriptStackTrace
} finally {
  if ($taskCreated -and -not $registrationVerified) {
    try {
      $containmentPresence = Get-TaskPresence
      $containmentOwnership = if ($containmentPresence.ok -and $containmentPresence.exists) {
        Get-RegisteredTaskSnapshot `
          -ExpectedTaskEnabled:([bool]$containmentPresence.enabled) `
          -RequireFutureStartBoundary:$false
      } else { $null }
      if ($containmentPresence.ok -and $containmentPresence.exists -and $containmentOwnership.ok) {
        $disable = Invoke-Captured -FilePath $SchtasksPath -Arguments @('/Change', '/TN', $TaskName, '/Disable')
        $disabledAfterFailure = Get-RegisteredTaskSnapshot -ExpectedTaskEnabled:$false -RequireFutureStartBoundary:$false
        $baseReceipt['verificationFailureContainment'] = [ordered]@{
          action = 'disable_exact_created_task'
          ownershipBeforeMutation = $containmentOwnership
          result = $disable
          postState = $disabledAfterFailure
          contained = ($disable.exitCode -eq 0 -and $disabledAfterFailure.ok)
        }
        if ($disable.exitCode -eq 0 -and $disabledAfterFailure.ok -and (Test-Path -LiteralPath $OwnershipAnchorPath -PathType Leaf)) {
          $failedAnchor = Read-JsonFile -Path $OwnershipAnchorPath
          if ($failedAnchor) {
            $failedAnchor.phase = 'registration_failed_disabled'
            $failedAnchor.enabled = $false
            $failedAnchor.updatedAt = [DateTime]::UtcNow.ToString('o')
            Write-JsonAtomic -Path $OwnershipAnchorPath -Value $failedAnchor
          }
        }
      } else {
        $baseReceipt['verificationFailureContainment'] = [ordered]@{
          action = 'refused_name_only_disable'
          taskPresence = $containmentPresence
          ownershipBeforeMutation = $containmentOwnership
          contained = $false
          reason = 'current_same_name_task_did_not_match_exact_created_definition'
        }
      }
    } catch {
      $baseReceipt['verificationFailureContainment'] = [ordered]@{
        action = 'containment_probe_failed_without_name_only_mutation'
        contained = $false
        error = $_.Exception.Message
      }
    }
    try {
      $failedProof = [ordered]@{
        schema = 'squidrun.build1b.main_e28_restoration_task_registration_proof.v1'
        phase = 'registration_failed_disabled'
        ok = $false
        proofPath = $RegistrationProofPath
        taskName = $TaskName
        expectedHead = $CurrentHead
        registrationEpochMs = $RegistrationEpochMs
        failedAt = [DateTime]::UtcNow.ToString('o')
        containment = $baseReceipt.verificationFailureContainment
      }
      Write-JsonAtomic -Path $RegistrationProofPath -Value $failedProof
    } catch {
      $baseReceipt['proofFailureWriteError'] = $_.Exception.Message
    }
  }
  try { Write-JsonAtomic -Path $registrationReceiptPath -Value $baseReceipt } catch {}
  Exit-TaskMutationMutex -Ownership $mutationOwnership
}
$baseReceipt | ConvertTo-Json -Depth 16
exit $(if ($registrationVerified) { 0 } else { 1 })

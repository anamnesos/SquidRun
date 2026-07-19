[CmdletBinding()]
param(
  [switch]$PreflightOnly,
  [int]$QuietWatchSeconds = 0,
  [int]$QuietWatchPollMs = 10,
  [int]$RandomSampleSize = 64,
  [int]$QuietRecheckIntervalMs = 500,
  [int]$TestTimeoutMinutes = 25
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExpectedElectronVersion = '28.3.3'
$ExpectedElectronExeSha256 = '67dc2a7036860a68e5312c212c31b8772ac463ed0289fcc44897867f55075e89'
$ExpectedH6NativeReceiptSha256 = 'c70d26297d94aa370abc3c1ba83ddda692a8a7c4ba1f4ca70b4707a326b31894'
$ExpectedH6WindowReceiptSha256 = '2711f2f68753be374a9ef8a7056146f24c900b889ab349ff7b30e56f72e62f50'
$ExpectedH6StageReceiptSha256 = '22232119828b65f30442b90880ed11eb011a26989ff0ba0ae00eafa6aadda92a'
$ExpectedDamageCharacterizationSha256 = '372e241c948f7b87c1403f25d44ee85d1db2bc8e067b970794564ef24bdef7e9'
$ProtectedElectronRelativePath = 'electron\dist\electron.exe'
$RestorationMutexName = 'Global\SquidRun.Build1B.MainE28Restoration'

$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptsRoot = Split-Path -Parent $ScriptPath
$UiRoot = Split-Path -Parent $ScriptsRoot
$ProjectRoot = Split-Path -Parent $UiRoot
$ProjectsRoot = Split-Path -Parent $ProjectRoot
$MainModules = Join-Path $UiRoot 'node_modules'
$ElectronExe = Join-Path $MainModules $ProtectedElectronRelativePath
$ReferenceRoot = Join-Path $ProjectsRoot '_archive\squidrun-worktrees\squidrun-build1b-main-e28-reference'
$ReferenceUi = Join-Path $ReferenceRoot 'ui'
$ReferenceModules = Join-Path $ReferenceUi 'node_modules'
$ReceiptRoot = Join-Path $ProjectRoot '.squidrun\coord\build1b-e29-s480\main-e28-restoration'
$H6NativeReceiptPath = Join-Path $ProjectRoot '.squidrun\coord\build1b-e29-s480\rollback-native-e28-2db3e392.json'
$H6WindowReceiptPath = Join-Path $ProjectRoot '.squidrun\coord\build1b-e29-s480\rollback-windows-e28-2db3e392\window-capture-receipt.json'
$H6StageReceiptPath = Join-Path $ProjectRoot '.squidrun\coord\build1b-e29-s480\stage-receipt-2db3e392.json'
$DamageCharacterizationPath = Join-Path $ProjectRoot '.squidrun\coord\build1b-e29-s480\main-node-modules-damage-characterization.json'
$RuntimeRoot = Join-Path $ProjectRoot '.squidrun\runtime'
$LockPath = Join-Path $RuntimeRoot 'main-e28-restoration.lock.json'
$SyncModulePath = Join-Path $ScriptsRoot 'hm-main-e28-tree-sync.psm1'

Import-Module $SyncModulePath -Force

function Get-ProcessCreationUtc {
  param([int]$ProcessId)

  $row = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if (-not $row) { return $null }
  return $row.CreationDate.ToUniversalTime().ToString('o')
}

function Get-SelfAndAncestorProcessRows {
  $rows = [Collections.Generic.List[object]]::new()
  $seen = [Collections.Generic.HashSet[int]]::new()
  $cursor = [int]$PID
  while ($cursor -gt 0 -and $seen.Add($cursor)) {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $cursor" -ErrorAction SilentlyContinue
    if (-not $row) { break }
    $rows.Add([pscustomobject]@{
      ProcessId = [int]$row.ProcessId
      ParentProcessId = [int]$row.ParentProcessId
      Name = $row.Name
      ExecutablePath = $row.ExecutablePath
      CreationDate = $row.CreationDate
      CommandLine = $row.CommandLine
    })
    $cursor = [int]$row.ParentProcessId
  }
  return @($rows)
}

function Get-ExternalRunnerAssertion {
  $ancestors = @(Get-SelfAndAncestorProcessRows)
  $watcherScriptPath = Join-Path $ScriptsRoot 'hm-main-e28-restoration-watch.js'
  $watcherSource = if (Test-Path -LiteralPath $watcherScriptPath -PathType Leaf) {
    Get-Content -Raw -LiteralPath $watcherScriptPath
  } else { '' }
  $allowedBuiltins = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($builtin in @('fs', 'path', 'crypto', 'child_process')) { [void]$allowedBuiltins.Add($builtin) }
  $watcherRequires = @([regex]::Matches($watcherSource, 'require\([''"]([^''"]+)[''"]\)') | ForEach-Object {
    $_.Groups[1].Value
  })
  $watcherNonBuiltinRequires = @($watcherRequires | Where-Object { -not $allowedBuiltins.Contains($_) })
  $watcherAncestors = @($ancestors | Where-Object {
    [int]$_.ProcessId -ne [int]$PID -and
    $_.Name -and $_.Name.Equals('node.exe', [StringComparison]::OrdinalIgnoreCase) -and
    $_.ExecutablePath -and -not $_.ExecutablePath.StartsWith($UiRoot, [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -and $_.CommandLine.IndexOf($watcherScriptPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  $inAppAncestors = @($ancestors | Where-Object {
    [int]$_.ProcessId -ne [int]$PID -and
    $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith($UiRoot, [StringComparison]::OrdinalIgnoreCase)
  })
  $unsafeRepoAncestors = @($ancestors | Where-Object {
    if ([int]$_.ProcessId -eq [int]$PID) { return $false }
    if (-not $_.CommandLine -or $_.CommandLine.IndexOf($ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      return $false
    }
    $candidatePid = [int]$_.ProcessId
    return @($watcherAncestors | Where-Object { [int]$_.ProcessId -eq $candidatePid }).Count -eq 0
  })
  $loadedUiModules = @()
  $moduleInspectionFailures = @()
  foreach ($ancestor in $watcherAncestors) {
    try {
      $modules = @(Get-Process -Id ([int]$ancestor.ProcessId) -Module -ErrorAction Stop)
      $loadedUiModules += @($modules | Where-Object {
        $_.FileName -and $_.FileName.StartsWith($UiRoot, [StringComparison]::OrdinalIgnoreCase)
      } | ForEach-Object {
        [pscustomobject]@{
          processId = [int]$ancestor.ProcessId
          processName = $ancestor.Name
          moduleName = $_.ModuleName
          fileName = $_.FileName
        }
      })
    } catch {
      $moduleInspectionFailures += [pscustomobject]@{
        processId = [int]$ancestor.ProcessId
        processName = $ancestor.Name
        error = $_.Exception.Message
      }
    }
  }
  $ok = (
    $inAppAncestors.Count -eq 0 -and
    $unsafeRepoAncestors.Count -eq 0 -and
    $watcherAncestors.Count -eq 1 -and
    $loadedUiModules.Count -eq 0 -and
    $moduleInspectionFailures.Count -eq 0 -and
    $watcherRequires.Count -gt 0 -and
    $watcherNonBuiltinRequires.Count -eq 0
  )
  return [pscustomobject]@{
    ok = $ok
    reason = if ($ok) {
      'external_bare_node_runner_confirmed'
    } elseif ($inAppAncestors.Count -gt 0) {
      'must_not_run_from_inside_the_app'
    } elseif ($unsafeRepoAncestors.Count -gt 0) {
      'ancestor_references_repo_but_is_not_the_bare_watcher'
    } elseif ($watcherAncestors.Count -ne 1) {
      'exactly_one_bare_node_watcher_ancestor_required'
    } elseif ($loadedUiModules.Count -gt 0) {
      'ancestor_has_loaded_ui_module'
    } elseif ($moduleInspectionFailures.Count -gt 0) {
      'ancestor_module_inspection_failed'
    } else {
      'watcher_is_not_builtin_only'
    }
    selfAndAncestors = $ancestors
    watcherAncestors = $watcherAncestors
    inAppAncestors = $inAppAncestors
    unsafeRepoAncestors = $unsafeRepoAncestors
    loadedUiModules = $loadedUiModules
    moduleInspectionFailures = $moduleInspectionFailures
    watcherAudit = [ordered]@{
      path = $watcherScriptPath
      sha256 = if ($watcherSource) { Get-SquidRunSha256 -LiteralPath $watcherScriptPath } else { $null }
      requireSpecifiers = $watcherRequires
      nonBuiltinRequireSpecifiers = $watcherNonBuiltinRequires
      builtInOnly = ($watcherRequires.Count -gt 0 -and $watcherNonBuiltinRequires.Count -eq 0)
    }
  }
}

function Test-SquidRunProjectProcessRow {
  param(
    [object]$Row,
    [Collections.Generic.HashSet[int]]$ExcludedProcessIds
  )

  if ($ExcludedProcessIds -and $ExcludedProcessIds.Contains([int]$Row.ProcessId)) { return $false }
  $executablePath = [string]$Row.ExecutablePath
  $commandLine = [string]$Row.CommandLine
  $uiRootPrefix = $UiRoot.TrimEnd('\', '/') + '\'
  $projectRootPrefix = $ProjectRoot.TrimEnd('\', '/') + '\'
  $normalizedExecutablePath = $executablePath.Replace('/', '\')
  $normalizedCommandLine = $commandLine.Replace('/', '\')
  $exeMatch = $executablePath -and (
    $normalizedExecutablePath.Equals($ElectronExe, [StringComparison]::OrdinalIgnoreCase) -or
    $normalizedExecutablePath.StartsWith($uiRootPrefix, [StringComparison]::OrdinalIgnoreCase)
  )
  $commandMatch = $commandLine -and $normalizedCommandLine.IndexOf($projectRootPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0
  $relativeRepoCommandMatch = $commandLine -and $Row.Name -match '^(node|npm|npx|pwsh|powershell|cmd)(\.exe|\.cmd)?$' -and (
    $commandLine -match '(?i)(^|[\s"''])(\.\.?[\\/])?(ui|scripts|node_modules)[\\/]' -or
    $commandLine -match '(?i)\bnpm(?:\.cmd)?\s+(ci|install|test|start|run)\b' -or
    $commandLine -match '(?i)(^|[\s"''])(terminal-daemon|supervisor-daemon|main|watcher-worker|evidence-ledger-worker|hm-[^\\/\s"'']+)\.js([\s"'']|$)'
  )
  return ($exeMatch -or $commandMatch -or $relativeRepoCommandMatch)
}

function Get-ProjectProcesses {
  param([int[]]$AdditionalExcludedRootProcessIds = @())

  $excluded = [Collections.Generic.HashSet[int]]::new()
  [void]$excluded.Add([int]$PID)
  $watcherScriptPath = Join-Path $ScriptsRoot 'hm-main-e28-restoration-watch.js'
  foreach ($row in @(Get-SelfAndAncestorProcessRows | Where-Object {
    $_.Name -and $_.Name.Equals('node.exe', [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -and $_.CommandLine.IndexOf($watcherScriptPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })) {
    [void]$excluded.Add([int]$row.ProcessId)
  }

  $allProcesses = @(Get-CimInstance Win32_Process)
  $pendingRoots = [Collections.Generic.Queue[int]]::new()
  foreach ($rootProcessId in @($AdditionalExcludedRootProcessIds)) {
    if ([int]$rootProcessId -gt 0 -and $excluded.Add([int]$rootProcessId)) {
      $pendingRoots.Enqueue([int]$rootProcessId)
    }
  }
  while ($pendingRoots.Count -gt 0) {
    $parentProcessId = $pendingRoots.Dequeue()
    foreach ($child in @($allProcesses | Where-Object { [int]$_.ParentProcessId -eq $parentProcessId })) {
      if ($excluded.Add([int]$child.ProcessId)) {
        $pendingRoots.Enqueue([int]$child.ProcessId)
      }
    }
  }

  return @($allProcesses | Where-Object {
    Test-SquidRunProjectProcessRow -Row $_ -ExcludedProcessIds $excluded
  } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate, CommandLine)
}

function Invoke-Captured {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [int]$TimeoutMinutes = 25,
    [scriptblock]$PollGuard,
    [int]$PollIntervalMs = 500
  )

  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $FilePath
  $start.WorkingDirectory = $WorkingDirectory
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.CreateNoWindow = $true
  foreach ($argument in $Arguments) {
    [void]$start.ArgumentList.Add($argument)
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  $startedAt = [DateTime]::UtcNow
  [void]$process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $drainStreams = {
    $completed = $false
    try {
      $completed = [Threading.Tasks.Task]::WaitAll(
        [Threading.Tasks.Task[]]@($stdoutTask, $stderrTask),
        10000
      )
    } catch {}
    if (-not $completed) {
      try { $process.StandardOutput.Close() } catch {}
      try { $process.StandardError.Close() } catch {}
      try {
        $completed = [Threading.Tasks.Task]::WaitAll(
          [Threading.Tasks.Task[]]@($stdoutTask, $stderrTask),
          1000
        )
      } catch {}
    }
    $stdoutValue = ''
    $stderrValue = ''
    if ($stdoutTask.IsCompletedSuccessfully) {
      try { $stdoutValue = $stdoutTask.GetAwaiter().GetResult() } catch {}
    }
    if ($stderrTask.IsCompletedSuccessfully) {
      try { $stderrValue = $stderrTask.GetAwaiter().GetResult() } catch {}
    }
    return [pscustomobject]@{
      completed = $completed
      stdout = $stdoutValue
      stderr = $stderrValue
    }
  }
  $timeoutMs = [Math]::Max(60000, $TimeoutMinutes * 60000)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
  $exited = $false
  $pollGuardFailure = $null
  while (-not $exited -and [DateTime]::UtcNow -lt $deadline) {
    $remainingMs = [Math]::Max(1, [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalMilliseconds))
    $waitMs = [Math]::Min([Math]::Max(100, $PollIntervalMs), $remainingMs)
    $exited = $process.WaitForExit($waitMs)
    if (-not $exited -and $PollGuard) {
      try {
        & $PollGuard ([int]$process.Id)
      } catch {
        $pollGuardFailure = $_
        break
      }
    }
  }
  if ($pollGuardFailure) {
    $guardKillSucceeded = $false
    try { $process.Kill($true) } catch {}
    try { $guardKillSucceeded = $process.WaitForExit(10000) } catch {}
    if (-not $guardKillSucceeded) {
      try { $process.StandardOutput.Close() } catch {}
      try { $process.StandardError.Close() } catch {}
    }
    [void](& $drainStreams)
    try { $process.Dispose() } catch {}
    throw $pollGuardFailure
  }
  $timedOut = -not $exited
  $killAttempted = $false
  $exitedAfterKill = $false
  if ($timedOut) {
    $killAttempted = $true
    try { $process.Kill($true) } catch {}
    try { $exitedAfterKill = $process.WaitForExit(10000) } catch {}
    if (-not $exitedAfterKill) {
      try { $process.StandardOutput.Close() } catch {}
      try { $process.StandardError.Close() } catch {}
      try { $process.Dispose() } catch {}
      return [pscustomobject]@{
        file = $FilePath
        arguments = $Arguments
        workingDirectory = $WorkingDirectory
        exitCode = 124
        timedOut = $true
        killAttempted = $true
        exitedAfterKill = $false
        timeoutMinutes = $TimeoutMinutes
        startedAtUtc = $startedAt.ToString('o')
        durationSeconds = [Math]::Round(([DateTime]::UtcNow - $startedAt).TotalSeconds, 3)
        stdout = ''
        stderr = 'owned_child_timeout_kill_failed_streams_closed_without_blocking'
      }
    }
  }
  $exitCode = if ($timedOut) { 124 } else { $process.ExitCode }
  $streamResult = & $drainStreams
  try { $process.Dispose() } catch {}
  return [pscustomobject]@{
    file = $FilePath
    arguments = $Arguments
    workingDirectory = $WorkingDirectory
    exitCode = $exitCode
    timedOut = $timedOut
    killAttempted = $killAttempted
    exitedAfterKill = $exitedAfterKill
    timeoutMinutes = $TimeoutMinutes
    startedAtUtc = $startedAt.ToString('o')
    durationSeconds = [Math]::Round(([DateTime]::UtcNow - $startedAt).TotalSeconds, 3)
    streamDrainCompleted = $streamResult.completed
    stdout = $streamResult.stdout
    stderr = $streamResult.stderr
  }
}

function Get-NativeHashRows {
  param([string]$Root)

  $rows = @()
  foreach ($file in (Get-ChildItem -LiteralPath $Root -Recurse -File -Force)) {
    $relative = Get-SquidRunRelativePath -BasePath $Root -LiteralPath $file.FullName
    $module = $null
    if ($relative -match '^better-sqlite3\\.*\.node$') { $module = 'better-sqlite3' }
    elseif ($relative -match '^node-pty\\.*\.node$') { $module = 'node-pty' }
    elseif ($relative -match '^(sharp|@img\\sharp[^\\]*)\\.*\.(dll|node)$') { $module = 'sharp' }
    elseif ($relative -match '^onnxruntime-node\\.*\.(dll|node)$') { $module = 'onnxruntime-node' }
    elseif ($relative -match '^sqlite-vec[^\\]*\\.*\.(dll|node)$') { $module = 'sqlite-vec' }
    if ($module) {
      $rows += [pscustomobject]@{
        module = $module
        path = $relative
        bytes = $file.Length
        sha256 = Get-SquidRunSha256 -LiteralPath $file.FullName
      }
    }
  }
  return @($rows | Sort-Object module, path)
}

function Compare-NativeRows {
  param([object[]]$ReferenceRows, [object[]]$MainRows)

  $referenceJson = ConvertTo-Json -InputObject @($ReferenceRows) -Depth 5 -Compress
  $mainJson = ConvertTo-Json -InputObject @($MainRows) -Depth 5 -Compress
  return $referenceJson -ceq $mainJson
}

function Get-NativePresence {
  param([object[]]$Rows)

  $requiredModules = @('better-sqlite3', 'node-pty', 'sharp', 'onnxruntime-node', 'sqlite-vec')
  $counts = [ordered]@{}
  foreach ($moduleName in $requiredModules) {
    $counts[$moduleName] = @($Rows | Where-Object { $_.module -eq $moduleName }).Count
  }
  return [ordered]@{
    requiredModules = $requiredModules
    counts = $counts
    allPresent = (@($requiredModules | Where-Object { [int]$counts[$_] -lt 1 }).Count -eq 0)
  }
}

function Get-SourceProvenance {
  param([string]$Stage)

  $currentBranch = (& git -C $ProjectRoot branch --show-current).Trim()
  Assert-SquidRunCondition ($LASTEXITCODE -eq 0) "Unable to read Git branch at $Stage."
  $currentHead = (& git -C $ProjectRoot rev-parse HEAD).Trim()
  Assert-SquidRunCondition ($LASTEXITCODE -eq 0) "Unable to read Git HEAD at $Stage."
  & git -C $ProjectRoot diff --quiet -- ui 2>$null
  $trackedUiWorktreeDiffExitCode = $LASTEXITCODE
  & git -C $ProjectRoot diff --cached --quiet -- ui 2>$null
  $trackedUiIndexDiffExitCode = $LASTEXITCODE
  $paths = @(
    (Join-Path $UiRoot 'package.json'),
    (Join-Path $UiRoot 'package-lock.json'),
    $ScriptPath,
    $SyncModulePath,
    (Join-Path $ScriptsRoot 'hm-main-e28-restoration-watch.js')
  )
  $hashes = [ordered]@{}
  foreach ($candidate in $paths) {
    Assert-SquidRunCondition (Test-Path -LiteralPath $candidate -PathType Leaf) "Provenance source missing at ${Stage}: $candidate"
    $relative = [IO.Path]::GetRelativePath($ProjectRoot, $candidate).Replace('/', '\')
    $hashes[$relative] = Get-SquidRunSha256 -LiteralPath $candidate
  }
  $currentPackage = Get-Content -Raw -LiteralPath (Join-Path $UiRoot 'package.json') | ConvertFrom-Json -AsHashtable
  $currentLock = Get-Content -Raw -LiteralPath (Join-Path $UiRoot 'package-lock.json') | ConvertFrom-Json -AsHashtable
  return [ordered]@{
    stage = $Stage
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    branch = $currentBranch
    head = $currentHead
    trackedUiWorktreeClean = ($trackedUiWorktreeDiffExitCode -eq 0)
    trackedUiIndexClean = ($trackedUiIndexDiffExitCode -eq 0)
    hashes = $hashes
    packageElectron = $currentPackage.devDependencies.electron
    lockRootElectron = $currentLock.packages[''].devDependencies.electron
    lockElectron = $currentLock.packages['node_modules/electron'].version
  }
}

function Assert-SourceProvenanceUnchanged {
  param(
    [object]$Expected,
    [object]$Actual,
    [string]$Stage
  )

  Assert-SquidRunCondition ($Actual.branch -eq $Expected.branch) "Git branch changed during restoration at ${Stage}: $($Expected.branch) -> $($Actual.branch)"
  Assert-SquidRunCondition ($Actual.head -eq $Expected.head) "Git HEAD changed during restoration at ${Stage}: $($Expected.head) -> $($Actual.head)"
  Assert-SquidRunCondition $Actual.trackedUiWorktreeClean "Tracked UI working-tree source is dirty at $Stage."
  Assert-SquidRunCondition $Actual.trackedUiIndexClean "Tracked UI index source is dirty at $Stage."
  Assert-SquidRunCondition ($Actual.packageElectron -eq $Expected.packageElectron) "package.json Electron changed during restoration at $Stage."
  Assert-SquidRunCondition ($Actual.lockRootElectron -eq $Expected.lockRootElectron) "package-lock root Electron changed during restoration at $Stage."
  Assert-SquidRunCondition ($Actual.lockElectron -eq $Expected.lockElectron) "package-lock Electron entry changed during restoration at $Stage."
  foreach ($relative in $Expected.hashes.Keys) {
    Assert-SquidRunCondition ($Actual.hashes[$relative] -eq $Expected.hashes[$relative]) "Source hash changed during restoration at ${Stage}: $relative"
  }
}

function Get-TrackedUiSourceManifest {
  param([string]$Stage)

  $trackedPaths = @(& git -C $ProjectRoot ls-files -- ui)
  Assert-SquidRunCondition ($LASTEXITCODE -eq 0) "Unable to enumerate tracked UI source at $Stage."
  $manifest = [Text.StringBuilder]::new()
  $fileCount = 0
  $totalBytes = [int64]0
  foreach ($relativePath in ($trackedPaths | Sort-Object)) {
    $fullPath = Join-Path $ProjectRoot $relativePath
    Assert-SquidRunCondition (Test-Path -LiteralPath $fullPath -PathType Leaf) "Tracked UI source missing at ${Stage}: $relativePath"
    $fileInfo = Get-Item -LiteralPath $fullPath -Force
    $fileHash = Get-SquidRunSha256 -LiteralPath $fullPath
    [void]$manifest.Append($relativePath.Replace('\', '/')).Append("`t").Append([int64]$fileInfo.Length).Append("`t").Append($fileHash).Append("`n")
    $fileCount++
    $totalBytes += [int64]$fileInfo.Length
  }
  return [ordered]@{
    stage = $Stage
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    trackedFileCount = $fileCount
    trackedBytes = $totalBytes
    sha256 = Get-SquidRunTextSha256 -Text $manifest.ToString()
  }
}

function Assert-TrackedUiSourceManifestUnchanged {
  param([object]$Expected, [object]$Actual, [string]$Stage)
  Assert-SquidRunCondition ([int]$Actual.trackedFileCount -eq [int]$Expected.trackedFileCount) "Tracked UI source file count changed at $Stage."
  Assert-SquidRunCondition ([int64]$Actual.trackedBytes -eq [int64]$Expected.trackedBytes) "Tracked UI source byte count changed at $Stage."
  Assert-SquidRunCondition ([string]$Actual.sha256 -eq [string]$Expected.sha256) "Tracked UI source manifest changed at $Stage."
}

function Get-ReferenceProvenance {
  param([string]$Stage)

  $referenceHeadNow = (& git -C $ReferenceRoot rev-parse HEAD).Trim()
  Assert-SquidRunCondition ($LASTEXITCODE -eq 0) "Unable to read reference HEAD at $Stage."
  $referenceStatus = @(& git -C $ReferenceRoot status --porcelain --untracked-files=all)
  Assert-SquidRunCondition ($LASTEXITCODE -eq 0) "Unable to read reference status at $Stage."
  $mainLockPath = Join-Path $UiRoot 'package-lock.json'
  $referenceLockPath = Join-Path $ReferenceUi 'package-lock.json'
  $mainLockSha256 = Get-SquidRunNormalizedTextSha256 -LiteralPath $mainLockPath
  $referenceLockSha256 = Get-SquidRunNormalizedTextSha256 -LiteralPath $referenceLockPath
  return [ordered]@{
    stage = $Stage
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    head = $referenceHeadNow
    trackedStatus = @($referenceStatus)
    trackedClean = (@($referenceStatus).Count -eq 0)
    lockHashMode = 'utf8_lf_normalized'
    mainLockSha256 = $mainLockSha256
    referenceLockSha256 = $referenceLockSha256
    lockMatchesMain = ($mainLockSha256 -eq $referenceLockSha256)
  }
}

function Get-H6ReceiptValidation {
  foreach ($requiredPath in @($H6NativeReceiptPath, $H6WindowReceiptPath, $H6StageReceiptPath)) {
    Assert-SquidRunCondition (Test-Path -LiteralPath $requiredPath -PathType Leaf) "Required H6 receipt missing: $requiredPath"
  }
  $native = Get-Content -Raw -LiteralPath $H6NativeReceiptPath | ConvertFrom-Json
  $window = Get-Content -Raw -LiteralPath $H6WindowReceiptPath | ConvertFrom-Json
  $stage = Get-Content -Raw -LiteralPath $H6StageReceiptPath | ConvertFrom-Json
  $nativeReceiptSha256 = Get-SquidRunSha256 -LiteralPath $H6NativeReceiptPath
  $windowReceiptSha256 = Get-SquidRunSha256 -LiteralPath $H6WindowReceiptPath
  $stageReceiptSha256 = Get-SquidRunSha256 -LiteralPath $H6StageReceiptPath
  Assert-SquidRunCondition ($nativeReceiptSha256 -eq $ExpectedH6NativeReceiptSha256) 'H6 native receipt bytes changed from the pinned evidence packet.'
  Assert-SquidRunCondition ($windowReceiptSha256 -eq $ExpectedH6WindowReceiptSha256) 'H6 window receipt bytes changed from the pinned evidence packet.'
  Assert-SquidRunCondition ($stageReceiptSha256 -eq $ExpectedH6StageReceiptSha256) 'H6 stage receipt bytes changed from the pinned evidence packet.'
  Assert-SquidRunCondition ($native.ok -eq $true) 'H6 native receipt is not ok:true.'
  Assert-SquidRunCondition ([string]$native.expectedCommit -eq '2db3e392') 'H6 native receipt commit pointer changed.'
  Assert-SquidRunCondition ([string]$native.runtime.versions.electron -eq $ExpectedElectronVersion) 'H6 native receipt did not execute Electron 28.3.3.'
  Assert-SquidRunCondition ([string]$native.package.hostExecutableSha256 -eq $ExpectedElectronExeSha256) 'H6 native host hash differs from the protected live binary hash.'
  foreach ($probeName in @('pty', 'sqlite', 'sqliteVec', 'sharp', 'onnx')) {
    Assert-SquidRunCondition ($native.probes.$probeName.ok -eq $true) "H6 native probe was not ok:true: $probeName"
  }
  Assert-SquidRunCondition ($window.ok -eq $true) 'H6 window receipt is not ok:true.'
  Assert-SquidRunCondition ([string]$window.head -eq '2db3e392ab6aaae16609eaf939058e6b35d97303') 'H6 window receipt HEAD changed.'
  Assert-SquidRunCondition ([string]$window.runtime.electron -eq $ExpectedElectronVersion) 'H6 window receipt did not execute Electron 28.3.3.'
  Assert-SquidRunCondition ([string]$stage.head -eq '2db3e392ab6aaae16609eaf939058e6b35d97303') 'H6 stage receipt HEAD changed.'
  Assert-SquidRunCondition ([string]$stage.oracleVerdict.result -eq 'conditional_pass') 'H6 stage receipt no longer carries Oracle conditional_pass.'
  $packagedExecutablePath = [IO.Path]::GetFullPath([string]$native.package.targetExecutablePath)
  $packagedAsarPath = [IO.Path]::GetFullPath([string]$native.package.asarPath)
  Assert-SquidRunPathWithin -Candidate $packagedExecutablePath -AllowedRoot $UiRoot
  Assert-SquidRunPathWithin -Candidate $packagedAsarPath -AllowedRoot $UiRoot
  Assert-SquidRunCondition (Test-Path -LiteralPath $packagedExecutablePath -PathType Leaf) 'H6 packaged executable is missing.'
  Assert-SquidRunCondition (Test-Path -LiteralPath $packagedAsarPath -PathType Leaf) 'H6 packaged ASAR is missing.'
  $packagedExecutableSha256 = Get-SquidRunSha256 -LiteralPath $packagedExecutablePath
  $packagedAsarSha256 = Get-SquidRunSha256 -LiteralPath $packagedAsarPath
  Assert-SquidRunCondition ($packagedExecutableSha256 -eq [string]$native.package.targetExecutableSha256) 'H6 packaged executable hash changed after the native probe.'
  Assert-SquidRunCondition ($packagedAsarSha256 -eq [string]$native.package.asarSha256) 'H6 packaged ASAR hash changed after the native probe.'
  return [ordered]@{
    native = [ordered]@{
      path = $H6NativeReceiptPath
      sha256 = $nativeReceiptSha256
      expectedCommit = $native.expectedCommit
      electron = $native.runtime.versions.electron
      hostExecutableSha256 = $native.package.hostExecutableSha256
      probes = $native.probes
    }
    window = [ordered]@{
      path = $H6WindowReceiptPath
      sha256 = $windowReceiptSha256
      head = $window.head
      electron = $window.runtime.electron
    }
    stage = [ordered]@{
      path = $H6StageReceiptPath
      sha256 = $stageReceiptSha256
      head = $stage.head
      oracleResult = $stage.oracleVerdict.result
    }
    packagedArtifact = [ordered]@{
      executablePath = $packagedExecutablePath
      executableSha256 = $packagedExecutableSha256
      asarPath = $packagedAsarPath
      asarSha256 = $packagedAsarSha256
    }
    ok = $true
  }
}

function Write-JsonAtomic {
  param(
    [string]$LiteralPath,
    [object]$Value,
    [int]$Depth = 12
  )

  [void][IO.Directory]::CreateDirectory((Split-Path -Parent $LiteralPath))
  $temporaryPath = "$LiteralPath.$PID.$([guid]::NewGuid().ToString('n')).tmp"
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth $Depth))
    $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
    [IO.File]::Move($temporaryPath, $LiteralPath, $true)
  } finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Write-RunReceipt {
  param(
    [string]$Kind,
    [object]$Payload,
    [string]$RunId
  )

  [void][IO.Directory]::CreateDirectory($ReceiptRoot)
  $safeKind = ($Kind -replace '[^a-zA-Z0-9_.-]', '-')
  $receiptPath = Join-Path $ReceiptRoot "$RunId-$safeKind.json"
  if ($Payload -is [System.Collections.IDictionary]) {
    $Payload['receiptPath'] = $receiptPath
  } else {
    $Payload | Add-Member -NotePropertyName receiptPath -NotePropertyValue $receiptPath -Force
  }
  Write-JsonAtomic -LiteralPath $receiptPath -Value $Payload
  return $receiptPath
}

function New-RestorationMutexAndLock {
  param([string]$RunId)

  [void][IO.Directory]::CreateDirectory($RuntimeRoot)
  $mutex = [Threading.Mutex]::new($false, $RestorationMutexName)
  $acquired = $false
  try {
    $acquired = $mutex.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $acquired = $true
  }
  if (-not $acquired) {
    $mutex.Dispose()
    return [pscustomobject]@{
      ok = $false
      reason = 'restoration_already_running_mutex_held'
      mutexName = $RestorationMutexName
      lockPath = $LockPath
    }
  }

  try {
    $existing = $null
    $staleQuarantine = $null
    if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
      try { $existing = Get-Content -Raw -LiteralPath $LockPath | ConvertFrom-Json } catch {}
      $recordedPidProperty = if ($existing) { $existing.PSObject.Properties['pid'] } else { $null }
      $recordedCreationProperty = if ($existing) { $existing.PSObject.Properties['processCreationUtc'] } else { $null }
      $recordedPid = if ($recordedPidProperty) { [int]$recordedPidProperty.Value } else { 0 }
      $recordedCreation = if ($recordedCreationProperty) { [string]$recordedCreationProperty.Value } else { '' }
      $liveCreation = if ($recordedPid -gt 0) { Get-ProcessCreationUtc -ProcessId $recordedPid } else { $null }
      if ($liveCreation -and $recordedCreation -and $liveCreation -eq $recordedCreation) {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
        return [pscustomobject]@{
          ok = $false
          reason = 'restoration_lock_owner_still_live'
          mutexName = $RestorationMutexName
          lockPath = $LockPath
          existing = $existing
        }
      }

      $stalePath = "$LockPath.stale-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))-$([guid]::NewGuid().ToString('n')).json"
      $staleReason = if (-not $existing) {
        'unparseable_metadata_global_mutex_exclusive'
      } elseif (-not $liveCreation) {
        'recorded_process_not_live_global_mutex_exclusive'
      } else {
        'recorded_pid_creation_mismatch_global_mutex_exclusive'
      }
      Move-Item -LiteralPath $LockPath -Destination $stalePath
      $staleQuarantine = [ordered]@{
        path = $stalePath
        reason = $staleReason
        existing = $existing
      }
    }

    $token = [guid]::NewGuid().ToString('n')
    $payload = [ordered]@{
      schema = 'squidrun.build1b.main_e28_restoration_lock.v1'
      token = $token
      runId = $RunId
      pid = $PID
      processCreationUtc = Get-ProcessCreationUtc -ProcessId $PID
      createdAtUtc = [DateTime]::UtcNow.ToString('o')
      mutexName = $RestorationMutexName
      scriptPath = $ScriptPath
      staleQuarantine = $staleQuarantine
    }
    $json = $payload | ConvertTo-Json -Depth 5
    $stream = [IO.File]::Open($LockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
      $writer = [IO.StreamWriter]::new($stream)
      try { $writer.Write($json); $writer.Flush() } finally { $writer.Dispose() }
    } finally {
      $stream.Dispose()
    }
  } catch {
    try { $mutex.ReleaseMutex() } catch {}
    try { $mutex.Dispose() } catch {}
    throw
  }

  return [pscustomobject]@{
    ok = $true
    mutex = $mutex
    mutexName = $RestorationMutexName
    lockPath = $LockPath
    token = $token
    payload = $payload
    staleQuarantine = $staleQuarantine
  }
}

function Remove-RestorationMutexAndLock {
  param([object]$Ownership)

  if (-not $Ownership -or -not $Ownership.ok) { return }
  try {
    if (Test-Path -LiteralPath $Ownership.lockPath -PathType Leaf) {
      $current = $null
      try { $current = Get-Content -Raw -LiteralPath $Ownership.lockPath | ConvertFrom-Json } catch {}
      if ($current -and [string]$current.token -eq [string]$Ownership.token) {
        Remove-Item -LiteralPath $Ownership.lockPath -Force
      }
    }
  } finally {
    try { $Ownership.mutex.ReleaseMutex() } catch {}
    try { $Ownership.mutex.Dispose() } catch {}
  }
}

function Get-SyncPlanSummary {
  param([object]$Plan)

  return [ordered]@{
    schema = $Plan.schema
    planDurationSeconds = $Plan.planDurationSeconds
    referenceFileCount = $Plan.referenceFileCount
    destinationFileCount = $Plan.destinationFileCount
    referenceDirectoryCount = $Plan.referenceDirectoryCount
    destinationDirectoryCount = $Plan.destinationDirectoryCount
    hashedEqualFiles = $Plan.hashedEqualFiles
    hashedEqualBytes = $Plan.hashedEqualBytes
    mutationBytes = $Plan.mutationBytes
    mutationCount = $Plan.mutationCount
    protectedMutationCount = $Plan.protectedMutationCount
    protectedDirectoryMutationCount = $Plan.protectedDirectoryMutationCount
    protectedPathStateConflictCount = $Plan.protectedPathStateConflictCount
    referenceManifestSha256 = $Plan.referenceManifestSha256
    createDirectories = @($Plan.createDirectories).Count
    copyMissing = @($Plan.copyMissing).Count
    replaceDifferent = @($Plan.replaceDifferent).Count
    deleteExtraFiles = @($Plan.deleteExtraFiles).Count
    deleteExtraDirectories = @($Plan.deleteExtraDirectories).Count
  }
}

function New-QuietSnapshot {
  param([string]$Stage)

  $active = @(Get-ProjectProcesses)
  return [ordered]@{
    ok = ($active.Count -eq 0)
    stage = $Stage
    checkedAtUtc = [DateTime]::UtcNow.ToString('o')
    activeProjectProcessCount = $active.Count
    activeProjectProcesses = $active
    reason = if ($active.Count -eq 0) { 'natural_quiet_window_present' } else { 'natural_quiet_window_absent_refusing_loaded_tree_mutation' }
  }
}

function Test-FastCandidateProcessName {
  param([string]$ProcessName)
  return [string]$ProcessName -match '^(electron|node|npm|npx|pwsh|powershell|cmd)$'
}

function Get-FastCandidateProcessRows {
  $rows = [Collections.Generic.List[object]]::new()
  foreach ($process in [Diagnostics.Process]::GetProcesses()) {
    try {
      $name = [string]$process.ProcessName
      $executablePath = $null
      $startedAtUtcTicks = $null
      try { $executablePath = [string]$process.MainModule.FileName } catch {}
      try { $startedAtUtcTicks = [int64]$process.StartTime.ToUniversalTime().Ticks } catch {}
      $identityKey = if ($null -ne $startedAtUtcTicks) {
        "$([int]$process.Id):$startedAtUtcTicks"
      } else {
        "$([int]$process.Id):start-time-unavailable"
      }
      $rows.Add([pscustomobject]@{
        ProcessId = [int]$process.Id
        Name = $name
        ExecutablePath = $executablePath
        StartedAtUtcTicks = $startedAtUtcTicks
        IdentityKey = $identityKey
      })
    } catch {
      # A process can exit between enumeration and inspection. If its name was
      # never readable it cannot be classified; the CIM event and full snapshot
      # remain independent detection layers.
    } finally {
      try { $process.Dispose() } catch {}
    }
  }
  return @($rows)
}

function Watch-SustainedProjectQuiet {
  param(
    [int]$DurationSeconds,
    [int]$PollIntervalMs
  )

  $durationSeconds = [Math]::Max(1, $DurationSeconds)
  $pollIntervalMs = [Math]::Max(10, $PollIntervalMs)
  $watchId = "$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))-$PID-$([guid]::NewGuid().ToString('n').Substring(0, 8))"
  $sourceIdentifier = "SquidRun.Build1B.QuietWatch.$watchId"
  $heartbeatPath = Join-Path $ReceiptRoot "$watchId-sustained-quiet-watch.json"
  $startedAt = $null
  $durationWatch = [Diagnostics.Stopwatch]::new()
  $snapshotCount = 0
  $processStartEventCount = 0
  $lastHeartbeatTickMs = $null
  $lastFullSnapshotTickMs = $null
  $loss = $null
  $lastQuiet = $null
  $eventExcludedProcessIdentityKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($row in @(Get-SelfAndAncestorProcessRows)) {
    $creationTicks = ([DateTime]$row.CreationDate).ToUniversalTime().Ticks
    [void]$eventExcludedProcessIdentityKeys.Add("$([int]$row.ProcessId):$creationTicks")
  }
  try {
    $creationQuery = "SELECT * FROM __InstanceCreationEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process'"
    Register-CimIndicationEvent -Namespace 'root/cimv2' -Query $creationQuery -SourceIdentifier $sourceIdentifier -ErrorAction Stop | Out-Null
    $lastQuiet = New-QuietSnapshot -Stage 'sustained_quiet_watch_armed'
    $snapshotCount++
    if (-not $lastQuiet.ok) {
      $loss = [ordered]@{
        reason = 'project_process_present_when_quiet_watch_armed'
        detectedAtUtc = [DateTime]::UtcNow.ToString('o')
        quiet = $lastQuiet
      }
    }
    $previousFastProcessKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($row in @(Get-FastCandidateProcessRows)) {
      [void]$previousFastProcessKeys.Add([string]$row.IdentityKey)
    }
    $startedAt = [DateTime]::UtcNow
    $lastFullSnapshotTickMs = [Environment]::TickCount64
    $durationWatch.Start()
    while ($durationWatch.Elapsed.TotalSeconds -lt $durationSeconds -and -not $loss) {
      $remainingMs = [Math]::Max(1, [int][Math]::Ceiling(($durationSeconds * 1000) - $durationWatch.Elapsed.TotalMilliseconds))
      Start-Sleep -Milliseconds ([Math]::Min($pollIntervalMs, $remainingMs))
      $events = @(Get-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue)
      $processStartEventCount += $events.Count

      $currentFastRows = @(Get-FastCandidateProcessRows)
      $currentFastProcessKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      foreach ($fastRow in $currentFastRows) {
        $fastPid = [int]$fastRow.ProcessId
        $fastIdentityKey = [string]$fastRow.IdentityKey
        [void]$currentFastProcessKeys.Add($fastIdentityKey)
        if ($eventExcludedProcessIdentityKeys.Contains($fastIdentityKey) -or $previousFastProcessKeys.Contains($fastIdentityKey)) { continue }
        $fastPathRow = [pscustomobject]@{
          ProcessId = $fastPid
          Name = [string]$fastRow.Name
          ExecutablePath = [string]$fastRow.ExecutablePath
          CommandLine = $null
        }
        if (Test-SquidRunProjectProcessRow -Row $fastPathRow -ExcludedProcessIds $null) {
          $loss = [ordered]@{
            reason = 'project_process_observed_by_fast_executable_path_sentinel'
            detectedAtUtc = [DateTime]::UtcNow.ToString('o')
            processId = $fastPid
            processName = [string]$fastRow.Name
            executablePath = [string]$fastRow.ExecutablePath
          }
          break
        }
        $eventProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $fastPid" -ErrorAction SilentlyContinue
        if ($eventProcess -and (Test-SquidRunProjectProcessRow -Row $eventProcess -ExcludedProcessIds $null)) {
          $loss = [ordered]@{
            reason = 'project_process_observed_by_fast_process_sentinel'
            detectedAtUtc = [DateTime]::UtcNow.ToString('o')
            processId = $fastPid
            processName = [string]$eventProcess.Name
            executablePath = [string]$eventProcess.ExecutablePath
            commandLine = [string]$eventProcess.CommandLine
          }
          break
        }
        if (-not $eventProcess -and (Test-FastCandidateProcessName -ProcessName ([string]$fastRow.Name))) {
          $loss = [ordered]@{
            reason = 'short_lived_candidate_process_unclassifiable'
            detectedAtUtc = [DateTime]::UtcNow.ToString('o')
            processId = $fastPid
            processName = [string]$fastRow.Name
          }
          break
        }
      }
      $previousFastProcessKeys = $currentFastProcessKeys

      if (-not $loss) {
        foreach ($eventRecord in $events) {
          $eventProcess = $eventRecord.SourceEventArgs.NewEvent.TargetInstance
          $eventCreationTicks = $null
          if ($eventProcess?.CreationDate) {
            try { $eventCreationTicks = ([DateTime]$eventProcess.CreationDate).ToUniversalTime().Ticks } catch {}
          }
          $eventIdentityKey = if ($eventProcess -and $null -ne $eventCreationTicks) {
            "$([int]$eventProcess.ProcessId):$eventCreationTicks"
          } else { '' }
          if ($eventIdentityKey -and $eventExcludedProcessIdentityKeys.Contains($eventIdentityKey)) { continue }
          if ($eventProcess -and (Test-SquidRunProjectProcessRow -Row $eventProcess -ExcludedProcessIds $null)) {
            $loss = [ordered]@{
              reason = 'project_process_observed_by_instance_creation_event'
              detectedAtUtc = [DateTime]::UtcNow.ToString('o')
              processId = [int]$eventProcess.ProcessId
              parentProcessId = [int]$eventProcess.ParentProcessId
              processName = [string]$eventProcess.Name
              executablePath = [string]$eventProcess.ExecutablePath
              commandLine = [string]$eventProcess.CommandLine
            }
            break
          }
          if ($eventProcess -and (Test-FastCandidateProcessName -ProcessName ([IO.Path]::GetFileNameWithoutExtension([string]$eventProcess.Name))) -and -not $eventProcess.CommandLine) {
            $loss = [ordered]@{
              reason = 'candidate_process_event_unclassifiable'
              detectedAtUtc = [DateTime]::UtcNow.ToString('o')
              processId = [int]$eventProcess.ProcessId
              processName = [string]$eventProcess.Name
            }
            break
          }
        }
      }

      foreach ($eventRecord in $events) {
        Remove-Event -EventIdentifier $eventRecord.EventIdentifier -ErrorAction SilentlyContinue
      }

      $now = [DateTime]::UtcNow
      $nowTickMs = [Environment]::TickCount64
      $durationComplete = $durationWatch.Elapsed.TotalSeconds -ge $durationSeconds
      if (-not $loss -and (($nowTickMs - $lastFullSnapshotTickMs) -ge 1000 -or $durationComplete)) {
        $lastFullSnapshotTickMs = $nowTickMs
        $lastQuiet = New-QuietSnapshot -Stage 'sustained_quiet_watch'
        $snapshotCount++
        if (-not $lastQuiet.ok) {
          $loss = [ordered]@{
            reason = 'project_process_observed_by_exact_predicate'
            detectedAtUtc = [DateTime]::UtcNow.ToString('o')
            quiet = $lastQuiet
          }
        }
      }
      if ($loss -or $null -eq $lastHeartbeatTickMs -or ($nowTickMs - $lastHeartbeatTickMs) -ge 5000 -or $durationComplete) {
        $lastHeartbeatTickMs = $nowTickMs
        Write-JsonAtomic -LiteralPath $heartbeatPath -Value ([ordered]@{
          schema = 'squidrun.build1b.sustained_quiet_watch.v1'
          watchId = $watchId
          pid = $PID
          status = if ($loss) { 'quiet_lost' } elseif ($durationComplete) { 'complete' } else { 'monitoring' }
          ok = (-not $loss -and $durationComplete)
          startedAtUtc = $startedAt.ToString('o')
          requiredDurationSeconds = $durationSeconds
          elapsedSeconds = [Math]::Round($durationWatch.Elapsed.TotalSeconds, 3)
          pollIntervalMs = $pollIntervalMs
          snapshotCount = $snapshotCount
          processStartEventCount = $processStartEventCount
          lastQuiet = $lastQuiet
          loss = $loss
          updatedAtUtc = $now.ToString('o')
        })
      }
    }
  } finally {
    Unregister-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue
    Get-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
  }

  $durationWatch.Stop()
  $completedAt = [DateTime]::UtcNow
  $elapsedSeconds = [Math]::Round($durationWatch.Elapsed.TotalSeconds, 3)
  return [ordered]@{
    ok = (-not $loss -and $durationWatch.Elapsed.TotalSeconds -ge $durationSeconds)
    watchId = $watchId
    heartbeatPath = $heartbeatPath
    startedAtUtc = $startedAt.ToString('o')
    completedAtUtc = $completedAt.ToString('o')
    requiredDurationSeconds = $durationSeconds
    elapsedSeconds = $elapsedSeconds
    pollIntervalMs = $pollIntervalMs
    snapshotCount = $snapshotCount
    processStartEventCount = $processStartEventCount
    exactPredicate = 'Get-ProjectProcesses plus all-new-process-identity executable-path/CIM sentinel'
    processCreationEvent = "Win32_Process __InstanceCreationEvent WITHIN 1"
    fastAllProcessPollIntervalMs = $pollIntervalMs
    durationClock = 'System.Diagnostics.Stopwatch monotonic elapsed time, armed after event registration and baseline snapshots'
    pollingLimit = 'Finite process snapshots cannot prove a zero-duration process start; every observed new PID is path/CIM classified, full exact snapshots run each second, and every mutation boundary rechecks the canonical predicate.'
    lastQuiet = $lastQuiet
    loss = $loss
  }
}

Assert-SquidRunCondition (Test-Path -LiteralPath $ProjectRoot -PathType Container) "Project root missing: $ProjectRoot"
Assert-SquidRunCondition (Test-Path -LiteralPath $ElectronExe -PathType Leaf) "Electron executable missing: $ElectronExe"

$branch = (& git -C $ProjectRoot branch --show-current).Trim()
Assert-SquidRunCondition ($LASTEXITCODE -eq 0) 'Unable to read Git branch.'
$head = (& git -C $ProjectRoot rev-parse HEAD).Trim()
Assert-SquidRunCondition ($LASTEXITCODE -eq 0) 'Unable to read Git HEAD.'
Assert-SquidRunCondition ($branch -eq 'main') "Restoration must run on main, not $branch."
$retainedCommitsAfterH6Coverage = @(& git -C $ProjectRoot rev-list --reverse '2db3e392ab6aaae16609eaf939058e6b35d97303..HEAD')
Assert-SquidRunCondition ($LASTEXITCODE -eq 0) 'Unable to enumerate commits retained after H6 coverage.'
$retainedCommitRows = @($retainedCommitsAfterH6Coverage | ForEach-Object {
  $commitSha = $_
  $subject = (& git -C $ProjectRoot show -s --format=%s $commitSha).Trim()
  Assert-SquidRunCondition ($LASTEXITCODE -eq 0) "Unable to read retained commit subject: $commitSha"
  [pscustomobject]@{
    commit = $commitSha
    subject = $subject
    justification = 'Retained main-only pin/restoration/watcher work is execution-covered by the full current-checkout tests and coherence verification in this receipt.'
  }
})

$package = Get-Content -Raw -LiteralPath (Join-Path $UiRoot 'package.json') | ConvertFrom-Json -AsHashtable
$lock = Get-Content -Raw -LiteralPath (Join-Path $UiRoot 'package-lock.json') | ConvertFrom-Json -AsHashtable
Assert-SquidRunCondition ($package.devDependencies.electron -eq $ExpectedElectronVersion) 'package.json is not pinned to Electron 28.3.3.'
Assert-SquidRunCondition ($lock.packages[''].devDependencies.electron -eq $ExpectedElectronVersion) 'package-lock root is not pinned to Electron 28.3.3.'
Assert-SquidRunCondition ($lock.packages['node_modules/electron'].version -eq $ExpectedElectronVersion) 'package-lock Electron entry is not 28.3.3.'

$electronHashBefore = Get-SquidRunSha256 -LiteralPath $ElectronExe
Assert-SquidRunCondition ($electronHashBefore -eq $ExpectedElectronExeSha256) "Protected Electron binary hash is unexpected: $electronHashBefore"
$h6ReceiptValidation = Get-H6ReceiptValidation
Assert-SquidRunCondition (Test-Path -LiteralPath $DamageCharacterizationPath -PathType Leaf) 'Damage characterization receipt is missing.'
$damageCharacterizationSha256 = Get-SquidRunSha256 -LiteralPath $DamageCharacterizationPath
Assert-SquidRunCondition ($damageCharacterizationSha256 -eq $ExpectedDamageCharacterizationSha256) 'Damage characterization receipt changed from the pinned evidence packet.'
$sourceProvenanceInitial = Get-SourceProvenance -Stage 'initial'
$trackedUiSourceManifestInitial = Get-TrackedUiSourceManifest -Stage 'initial'

$externalRunner = Get-ExternalRunnerAssertion
$initialQuiet = New-QuietSnapshot -Stage 'initial_preflight'
$sourceTreeBoundToHead = ($sourceProvenanceInitial.trackedUiWorktreeClean -and $sourceProvenanceInitial.trackedUiIndexClean)
$preflight = [ordered]@{
  schema = 'squidrun.build1b.main_e28_restoration_preflight.v1'
  authoredBy = 'ui/scripts/hm-restore-main-e28-coherence.ps1'
  ok = ($externalRunner.ok -and $initialQuiet.ok -and $sourceTreeBoundToHead)
  mode = if ($PreflightOnly) { 'preflight_only' } else { 'restore' }
  checkedAtUtc = [DateTime]::UtcNow.ToString('o')
  branch = $branch
  head = $head
  expectedElectron = $ExpectedElectronVersion
  electronExeSha256 = $electronHashBefore
  h6ReceiptValidation = $h6ReceiptValidation
  retainedCommitsAfterH6Coverage = $retainedCommitRows
  sourceProvenance = $sourceProvenanceInitial
  trackedUiSourceManifest = $trackedUiSourceManifestInitial
  sourceTreeBoundToHead = $sourceTreeBoundToHead
  externalRunner = $externalRunner
  quiet = $initialQuiet
  activeProjectProcessCount = $initialQuiet.activeProjectProcessCount
  activeProjectProcesses = $initialQuiet.activeProjectProcesses
  reason = if (-not $externalRunner.ok) {
    $externalRunner.reason
  } elseif (-not $sourceTreeBoundToHead) {
    'tracked_ui_source_not_clean_at_registered_head'
  } else {
    $initialQuiet.reason
  }
}

if ($PreflightOnly) {
  if ($preflight.ok -and $QuietWatchSeconds -gt 0) {
    $sustainedQuiet = Watch-SustainedProjectQuiet -DurationSeconds $QuietWatchSeconds -PollIntervalMs $QuietWatchPollMs
    $sourceProvenanceAfterQuietWatch = Get-SourceProvenance -Stage 'after_sustained_quiet_watch'
    Assert-SourceProvenanceUnchanged -Expected $sourceProvenanceInitial -Actual $sourceProvenanceAfterQuietWatch -Stage 'after_sustained_quiet_watch'
    $externalRunnerAfterQuietWatch = Get-ExternalRunnerAssertion
    $quietAfterQuietWatch = New-QuietSnapshot -Stage 'after_sustained_quiet_watch'
    $preflight['sustainedQuiet'] = $sustainedQuiet
    $preflight['sourceProvenanceAfterSustainedQuiet'] = $sourceProvenanceAfterQuietWatch
    $preflight['externalRunnerAfterSustainedQuiet'] = $externalRunnerAfterQuietWatch
    $preflight['quietAfterSustainedQuiet'] = $quietAfterQuietWatch
    $preflight['ok'] = ($sustainedQuiet.ok -and $externalRunnerAfterQuietWatch.ok -and $quietAfterQuietWatch.ok)
    $preflight['reason'] = if (-not $sustainedQuiet.ok) {
      'sustained_quiet_window_lost'
    } elseif (-not $externalRunnerAfterQuietWatch.ok) {
      $externalRunnerAfterQuietWatch.reason
    } else {
      $quietAfterQuietWatch.reason
    }
  }
  $preflight | ConvertTo-Json -Depth 9
  exit 0
}

$runId = "$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))-$PID-$([guid]::NewGuid().ToString('n').Substring(0, 8))"
$ownership = $null
try {
  $ownership = New-RestorationMutexAndLock -RunId $runId
} catch {
  $payload = [ordered]@{
    schema = 'squidrun.build1b.main_e28_restoration_event.v1'
    kind = 'lock_acquisition_failure'
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    ok = $false
    restartState = 'degraded_unknown_do_not_restart_lock_acquisition_failed'
    error = $_.Exception.Message
    stack = $_.ScriptStackTrace
  }
  $payload.receiptPath = Write-RunReceipt -Kind 'lock-acquisition-failure' -Payload $payload -RunId $runId
  $payload | ConvertTo-Json -Depth 10
  exit 46
}
if (-not $ownership.ok) {
  $payload = [ordered]@{
    schema = 'squidrun.build1b.main_e28_restoration_event.v1'
    kind = 'single_flight_refusal'
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    ok = $false
    restartState = 'degraded_unknown_do_not_restart_restoration_already_running'
    ownership = $ownership
  }
  $payload.receiptPath = Write-RunReceipt -Kind 'single-flight-refusal' -Payload $payload -RunId $runId
  $payload | ConvertTo-Json -Depth 10
  exit 43
}

$finalPayload = $null
$finalExitCode = 1
$syncPlanSummary = $null
$syncPlanArtifactBinding = $null
$syncProgress = $null
$syncResult = $null
try {
  if (-not $preflight.ok) {
    $finalPayload = [ordered]@{
      schema = 'squidrun.build1b.main_e28_restoration_event.v1'
      kind = 'initial_preflight_refusal'
      capturedAtUtc = [DateTime]::UtcNow.ToString('o')
      ok = $false
      restartState = 'degraded_unknown_do_not_restart_pending_natural_quiet_window_restore'
      preflight = $preflight
    }
    $finalPayload.receiptPath = Write-RunReceipt -Kind 'initial-refusal' -Payload $finalPayload -RunId $runId
    $finalExitCode = if (-not $externalRunner.ok) {
      45
    } elseif (-not $sourceTreeBoundToHead) {
      47
    } else {
      42
    }
  } else {
    [void][IO.Directory]::CreateDirectory($ReceiptRoot)

    if (Test-Path -LiteralPath $ReferenceRoot) {
      $referenceHead = (& git -C $ReferenceRoot rev-parse HEAD).Trim()
      Assert-SquidRunCondition ($LASTEXITCODE -eq 0) "Existing reference is not a Git worktree: $ReferenceRoot"
      Assert-SquidRunCondition ($referenceHead -eq $head) "Existing reference HEAD $referenceHead does not match main $head."
    } else {
      $gitExecutable = (Get-Command git.exe).Source
      $worktreeResult = Invoke-Captured -FilePath $gitExecutable -Arguments @(
        '-C', $ProjectRoot, '-c', 'core.autocrlf=false', 'worktree', 'add', '--detach', $ReferenceRoot, $head
      ) -WorkingDirectory $ProjectRoot -TimeoutMinutes 10
      Assert-SquidRunCondition ($worktreeResult.exitCode -eq 0) "Failed to create E28 reference worktree: $($worktreeResult.stderr)"
      $referenceHead = $head
    }

    $referenceProvenancePreInstall = Get-ReferenceProvenance -Stage 'pre_reference_install'
    Assert-SquidRunCondition ($referenceProvenancePreInstall.head -eq $head) 'Reference HEAD changed before npm ci.'
    Assert-SquidRunCondition $referenceProvenancePreInstall.trackedClean 'Reference worktree is dirty before npm ci; refusing lifecycle execution.'
    Assert-SquidRunCondition $referenceProvenancePreInstall.lockMatchesMain 'Reference package-lock differs from main before npm ci.'
    Assert-SquidRunTreeHasNoReparsePoints -Root $ReferenceRoot

    $npm = (Get-Command npm.cmd).Source
    $referenceInstall = Invoke-Captured -FilePath $npm -Arguments @('ci', '--no-audit', '--no-fund') -WorkingDirectory $ReferenceUi -TimeoutMinutes $TestTimeoutMinutes
    Assert-SquidRunCondition ($referenceInstall.exitCode -eq 0) "Reference npm ci failed: $($referenceInstall.stderr)"

    $referencePackage = Get-Content -Raw -LiteralPath (Join-Path $ReferenceModules 'electron\package.json') | ConvertFrom-Json -AsHashtable
    Assert-SquidRunCondition ($referencePackage.version -eq $ExpectedElectronVersion) 'Reference electron package metadata is not 28.3.3.'
    $referenceElectronHash = Get-SquidRunSha256 -LiteralPath (Join-Path $ReferenceModules $ProtectedElectronRelativePath)
    Assert-SquidRunCondition ($referenceElectronHash -eq $ExpectedElectronExeSha256) 'Reference Electron executable hash differs from the protected live binary.'
    $sourceProvenancePostReference = Get-SourceProvenance -Stage 'post_reference_install'
    Assert-SourceProvenanceUnchanged -Expected $sourceProvenanceInitial -Actual $sourceProvenancePostReference -Stage 'post_reference_install'
    $referenceProvenancePostInstall = Get-ReferenceProvenance -Stage 'post_reference_install'
    Assert-SquidRunCondition ($referenceProvenancePostInstall.head -eq $head) 'Reference HEAD changed or does not match main after npm ci.'
    Assert-SquidRunCondition $referenceProvenancePostInstall.trackedClean 'Reference worktree has tracked changes after npm ci.'
    Assert-SquidRunCondition $referenceProvenancePostInstall.lockMatchesMain 'Reference package-lock differs from main after npm ci.'

    # Oracle MR audit change 1: close the minutes-long npm-ci TOCTOU gap before
    # planning or writing anything in the loaded main dependency tree.
    $postReferenceQuiet = New-QuietSnapshot -Stage 'post_reference_build'
    if (-not $postReferenceQuiet.ok) {
      $finalPayload = [ordered]@{
        schema = 'squidrun.build1b.main_e28_restoration_event.v1'
        kind = 'post_reference_quiet_refusal'
        capturedAtUtc = [DateTime]::UtcNow.ToString('o')
        ok = $false
        restartState = 'degraded_unknown_do_not_restart_pending_natural_quiet_window_restore'
        reference = [ordered]@{
          root = $ReferenceRoot
          head = $referenceHead
          npmCiExitCode = $referenceInstall.exitCode
          npmCiDurationSeconds = $referenceInstall.durationSeconds
        }
        quiet = $postReferenceQuiet
        mainTreeMutations = 0
      }
      $finalPayload.receiptPath = Write-RunReceipt -Kind 'post-reference-refusal' -Payload $finalPayload -RunId $runId
      $finalExitCode = 42
    } else {
      # All expensive all-file hashing happens before the first destination
      # mutation. The measured plan duration is therefore not exposure time.
      $script:lastPlanningGuardTickMs = $null
      $script:planningQuietWindowLoss = $null
      $planningQuietGuard = {
        param([string]$Stage, [string]$RelativePath)
        $nowTickMs = [Environment]::TickCount64
        if ($null -ne $script:lastPlanningGuardTickMs -and ($nowTickMs - $script:lastPlanningGuardTickMs) -lt [Math]::Max(100, $QuietRecheckIntervalMs)) {
          return
        }
        $script:lastPlanningGuardTickMs = $nowTickMs
        $active = @(Get-ProjectProcesses)
        if ($active.Count -gt 0 -and -not $script:planningQuietWindowLoss) {
          $script:planningQuietWindowLoss = [ordered]@{
            detectedAtUtc = [DateTime]::UtcNow.ToString('o')
            stage = $Stage
            relativePath = $RelativePath
            activeProjectProcessCount = $active.Count
            activeProjectProcesses = $active
          }
        }
      }
      $syncPlanArguments = @{
        ReferenceRoot = $ReferenceModules
        DestinationRoot = $MainModules
        ProtectedRelativePath = $ProtectedElectronRelativePath
        QuietGuard = $planningQuietGuard
      }
      $syncPlan = New-SquidRunDependencySyncPlan @syncPlanArguments
      $syncPlanSummary = Get-SyncPlanSummary -Plan $syncPlan
      $syncPlanArtifactPath = Join-Path $ReceiptRoot "$runId-sync-plan.json"
      $syncPlanArtifact = [ordered]@{
        schema = 'squidrun.build1b.main_e28_restoration_sync_plan.v1'
        runId = $runId
        head = $head
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
        protectedRelativePath = $ProtectedElectronRelativePath
        plan = $syncPlan
      }
      Write-JsonAtomic -LiteralPath $syncPlanArtifactPath -Value $syncPlanArtifact
      $syncPlanArtifactBinding = [ordered]@{
        schema = $syncPlanArtifact.schema
        path = $syncPlanArtifactPath
        sha256 = Get-SquidRunSha256 -LiteralPath $syncPlanArtifactPath
        mutationCount = [int]$syncPlan.mutationCount
      }
      $sourceProvenancePostPlan = Get-SourceProvenance -Stage 'post_sync_plan'
      Assert-SourceProvenanceUnchanged -Expected $sourceProvenanceInitial -Actual $sourceProvenancePostPlan -Stage 'post_sync_plan'
      $referenceProvenancePostPlan = Get-ReferenceProvenance -Stage 'post_sync_plan'
      Assert-SquidRunCondition ($referenceProvenancePostPlan.head -eq $head) 'Reference HEAD changed during sync planning.'
      Assert-SquidRunCondition $referenceProvenancePostPlan.trackedClean 'Reference worktree changed during sync planning.'
      Assert-SquidRunCondition $referenceProvenancePostPlan.lockMatchesMain 'Reference package-lock drifted during sync planning.'
      $postPlanQuiet = New-QuietSnapshot -Stage 'post_sync_plan_immediate_prelaunch'
      if ($script:planningQuietWindowLoss) {
        $postPlanQuiet['ok'] = $false
        $postPlanQuiet['reason'] = 'project_process_observed_during_sync_planning'
        $postPlanQuiet['planningQuietWindowLoss'] = $script:planningQuietWindowLoss
      }

      if (-not $postPlanQuiet.ok) {
        $finalPayload = [ordered]@{
          schema = 'squidrun.build1b.main_e28_restoration_event.v1'
          kind = 'post_plan_quiet_refusal'
          capturedAtUtc = [DateTime]::UtcNow.ToString('o')
          ok = $false
          restartState = 'degraded_unknown_do_not_restart_pending_natural_quiet_window_restore'
          syncPlan = $syncPlanSummary
          syncPlanArtifact = $syncPlanArtifactBinding
          quiet = $postPlanQuiet
          mainTreeMutations = 0
        }
        $finalPayload.receiptPath = Write-RunReceipt -Kind 'post-plan-refusal' -Payload $finalPayload -RunId $runId
        $finalExitCode = 42
      } else {
        $progressPath = Join-Path $ReceiptRoot "$runId-sync-progress.json"
        $syncProgress = [ordered]@{}
        $script:lastQuietGuardTickMs = $null
        $script:lastProgressReceiptAtMs = 0
        $script:quietWindowLoss = $null
        $quietGuard = {
          param(
            [string]$Stage,
            [string]$RelativePath,
            [int[]]$AdditionalExcludedRootProcessIds = @()
          )
          $nowTickMs = [Environment]::TickCount64
          $alwaysCheck = $Stage -in @('sync_start', 'before_directory_create', 'before_temp_copy', 'before_atomic_commit', 'after_missing_destination_commit_check', 'before_extra_file_delete', 'before_extra_directory_delete', 'sync_complete', 'before_test', 'after_test')
          if (-not $alwaysCheck -and $null -ne $script:lastQuietGuardTickMs -and ($nowTickMs - $script:lastQuietGuardTickMs) -lt [Math]::Max(100, $QuietRecheckIntervalMs)) {
            return
          }
          $script:lastQuietGuardTickMs = $nowTickMs
          $active = @(Get-ProjectProcesses -AdditionalExcludedRootProcessIds $AdditionalExcludedRootProcessIds)
          if ($active.Count -gt 0) {
            $script:quietWindowLoss = [ordered]@{
              detectedAtUtc = [DateTime]::UtcNow.ToString('o')
              stage = $Stage
              relativePath = $RelativePath
              activeProjectProcessCount = $active.Count
              activeProjectProcesses = $active
            }
            throw "quiet_window_lost:${Stage}:${RelativePath}"
          }
        }
        $progressCallback = {
          param([object]$Progress)
          $nowTickMs = [Environment]::TickCount64
          $operationCount = [int]$Progress.createDirectories + [int]$Progress.copyMissing + [int]$Progress.replaceDifferent + [int]$Progress.deleteExtraFiles + [int]$Progress.deleteExtraDirectories
          if ($Progress.stage -eq 'complete' -or $operationCount -eq 1 -or ($operationCount % 100) -eq 0 -or ($nowTickMs - $script:lastProgressReceiptAtMs) -ge 2000) {
            $script:lastProgressReceiptAtMs = $nowTickMs
            Write-JsonAtomic -LiteralPath $progressPath -Value ([ordered]@{
              schema = 'squidrun.build1b.main_e28_restoration_progress.v1'
              runId = $runId
              head = $head
              syncPlan = $syncPlanSummary
              syncPlanArtifact = $syncPlanArtifactBinding
              progress = $Progress
              restartState = 'do_not_restart_restoration_in_progress'
            })
          }
        }

        $syncResult = $null
        try {
          $syncResult = Invoke-SquidRunDependencySyncPlan -Plan $syncPlan -QuietGuard $quietGuard -ProgressState $syncProgress -ProgressCallback $progressCallback
        } catch {
          $abortKind = if ($script:quietWindowLoss) { 'mid_sync_relaunch_abort' } else { 'sync_error_abort' }
          $finalPayload = [ordered]@{
            schema = 'squidrun.build1b.main_e28_restoration_event.v1'
            kind = $abortKind
            capturedAtUtc = [DateTime]::UtcNow.ToString('o')
            ok = $false
            restartState = 'restart_blocked_repair_incomplete'
            error = $_.Exception.Message
            quietWindowLoss = $script:quietWindowLoss
            syncPlan = $syncPlanSummary
            syncPlanArtifact = $syncPlanArtifactBinding
            progress = $syncProgress
            progressPath = $progressPath
            protectedElectronSha256 = Get-SquidRunSha256 -LiteralPath $ElectronExe
          }
          $finalPayload.receiptPath = Write-RunReceipt -Kind $abortKind -Payload $finalPayload -RunId $runId
          $finalExitCode = if ($script:quietWindowLoss) { 44 } else { 1 }
        }

        if (-not $finalPayload) {
          $electronHashAfterSync = Get-SquidRunSha256 -LiteralPath $ElectronExe
          Assert-SquidRunCondition ($electronHashAfterSync -eq $electronHashBefore) 'Protected Electron executable hash changed during sync.'

          $mainFileMapAfter = Get-SquidRunFileMap -Root $MainModules
          $referenceFileMap = Get-SquidRunFileMap -Root $ReferenceModules
          $missingAfter = @($referenceFileMap.Keys | Where-Object { -not $mainFileMapAfter.ContainsKey($_) })
          $extraAfter = @($mainFileMapAfter.Keys | Where-Object { -not $referenceFileMap.ContainsKey($_) })
          $mainTopLevelCount = @(Get-ChildItem -LiteralPath $MainModules -Force).Count
          $referenceTopLevelCount = @(Get-ChildItem -LiteralPath $ReferenceModules -Force).Count
          $mainElectronPackage = Get-Content -Raw -LiteralPath (Join-Path $MainModules 'electron\package.json') | ConvertFrom-Json -AsHashtable

          $referenceNative = Get-NativeHashRows -Root $ReferenceModules
          $mainNative = Get-NativeHashRows -Root $MainModules
          $referenceNativePresence = Get-NativePresence -Rows $referenceNative
          $mainNativePresence = Get-NativePresence -Rows $mainNative
          $nativeHashesMatch = Compare-NativeRows -ReferenceRows $referenceNative -MainRows $mainNative

          $eligibleSamplePaths = @($referenceFileMap.Keys | Where-Object {
            $_.Contains('\') -and -not $_.Equals($ProtectedElectronRelativePath, [StringComparison]::OrdinalIgnoreCase)
          })
          $sampleSize = [Math]::Min([Math]::Max($RandomSampleSize, 1), $eligibleSamplePaths.Count)
          $sampleSeed = [Security.Cryptography.RandomNumberGenerator]::GetInt32(1, [int]::MaxValue)
          $samplePaths = @(Get-Random -InputObject $eligibleSamplePaths -Count $sampleSize -SetSeed $sampleSeed)
          $hashSample = @($samplePaths | Sort-Object | ForEach-Object {
            $referenceHash = Get-SquidRunSha256 -LiteralPath $referenceFileMap[$_]
            $mainHash = Get-SquidRunSha256 -LiteralPath $mainFileMapAfter[$_]
            [pscustomobject]@{ path = $_; referenceSha256 = $referenceHash; mainSha256 = $mainHash; match = ($referenceHash -eq $mainHash) }
          })

          $fileParity = ($missingAfter.Count -eq 0 -and $extraAfter.Count -eq 0)
          $sampleMatch = (@($hashSample | Where-Object { -not $_.match }).Count -eq 0)
          $treeCoherentBeforeTests = (
            $fileParity -and
            $mainTopLevelCount -eq $referenceTopLevelCount -and
            $mainElectronPackage.version -eq $ExpectedElectronVersion -and
            $referenceNativePresence.allPresent -and
            $mainNativePresence.allPresent -and
            $nativeHashesMatch -and
            $sampleMatch
          )
          $treeCoherent = $treeCoherentBeforeTests

          try {
            & $quietGuard 'before_test' 'full_suite_minus_characterized_eol_pair'
            $fullSuitePollGuard = {
              param([int]$OwnedProcessId)
              & $quietGuard 'during_test' 'full_suite_minus_characterized_eol_pair' @($OwnedProcessId)
            }
            $ignorePattern = '[/\\](system-protected-evals|the-tell-normalize-parity)\.test\.js$'
            $fullSuite = Invoke-Captured -FilePath $npm -Arguments @(
              'test', '--', '--runInBand', '--silent', '--forceExit', "--testPathIgnorePatterns=$ignorePattern"
            ) -WorkingDirectory $UiRoot -TimeoutMinutes $TestTimeoutMinutes -PollGuard $fullSuitePollGuard -PollIntervalMs $QuietRecheckIntervalMs
            $fullSuiteLog = Join-Path $ReceiptRoot "$runId-full-suite-minus-eol-pair.log"
            [IO.File]::WriteAllText($fullSuiteLog, $fullSuite.stdout + [Environment]::NewLine + $fullSuite.stderr)
            $fullSuiteLogSha256 = Get-SquidRunSha256 -LiteralPath $fullSuiteLog
            $fullSuiteLogBytes = (Get-Item -LiteralPath $fullSuiteLog).Length
            & $quietGuard 'after_test' 'full_suite_minus_characterized_eol_pair'

            & $quietGuard 'before_test' 'hm_send_and_comms'
            $commsPollGuard = {
              param([int]$OwnedProcessId)
              & $quietGuard 'during_test' 'hm_send_and_comms' @($OwnedProcessId)
            }
            $commsSuites = Invoke-Captured -FilePath $npm -Arguments @(
              'test', '--', '--runInBand', '--silent', '--forceExit', '__tests__/hm-send.test.js', '__tests__/hm-comms.test.js'
            ) -WorkingDirectory $UiRoot -TimeoutMinutes $TestTimeoutMinutes -PollGuard $commsPollGuard -PollIntervalMs $QuietRecheckIntervalMs
            $commsLog = Join-Path $ReceiptRoot "$runId-comms-suites.log"
            [IO.File]::WriteAllText($commsLog, $commsSuites.stdout + [Environment]::NewLine + $commsSuites.stderr)
            $commsLogSha256 = Get-SquidRunSha256 -LiteralPath $commsLog
            $commsLogBytes = (Get-Item -LiteralPath $commsLog).Length
            & $quietGuard 'after_test' 'hm_send_and_comms'

            # Oracle MR audit change 3: retain the checkout-sensitive EOL pair
            # as diagnostics, but never let it veto an otherwise coherent E28 tree.
            & $quietGuard 'before_test' 'characterized_eol_pair_diagnostic'
            $eolPollGuard = {
              param([int]$OwnedProcessId)
              & $quietGuard 'during_test' 'characterized_eol_pair_diagnostic' @($OwnedProcessId)
            }
            $eolSuites = Invoke-Captured -FilePath $npm -Arguments @(
              'test', '--', '--runInBand', '--silent', '--forceExit', '__tests__/system-protected-evals.test.js', '__tests__/the-tell-normalize-parity.test.js'
            ) -WorkingDirectory $UiRoot -TimeoutMinutes $TestTimeoutMinutes -PollGuard $eolPollGuard -PollIntervalMs $QuietRecheckIntervalMs
            $eolLog = Join-Path $ReceiptRoot "$runId-eol-suites.log"
            [IO.File]::WriteAllText($eolLog, $eolSuites.stdout + [Environment]::NewLine + $eolSuites.stderr)
            $eolLogSha256 = Get-SquidRunSha256 -LiteralPath $eolLog
            $eolLogBytes = (Get-Item -LiteralPath $eolLog).Length
            & $quietGuard 'after_test' 'characterized_eol_pair_diagnostic'
          } catch {
            $finalPayload = [ordered]@{
              schema = 'squidrun.build1b.main_e28_restoration_event.v1'
              kind = 'post_sync_relaunch_abort'
              capturedAtUtc = [DateTime]::UtcNow.ToString('o')
              ok = $false
              treeSyncCompleted = $true
              treeCoherentBeforeAbort = $treeCoherent
              restartState = 'restart_blocked_verification_incomplete'
              error = $_.Exception.Message
              quietWindowLoss = $script:quietWindowLoss
              syncPlan = $syncPlanSummary
              syncPlanArtifact = $syncPlanArtifactBinding
              progress = $syncResult
              protectedElectronSha256 = Get-SquidRunSha256 -LiteralPath $ElectronExe
            }
            $finalPayload.receiptPath = Write-RunReceipt -Kind 'post-sync-relaunch-abort' -Payload $finalPayload -RunId $runId
            $finalExitCode = 44
          }

          if (-not $finalPayload) {
            $finalCoherencePlan = New-SquidRunDependencySyncPlan -ReferenceRoot $ReferenceModules -DestinationRoot $MainModules -ProtectedRelativePath $ProtectedElectronRelativePath -QuietGuard $quietGuard
            $finalCoherencePlanSummary = Get-SyncPlanSummary -Plan $finalCoherencePlan
            $finalCoherencePass = (
              [int]$finalCoherencePlanSummary.mutationCount -eq 0 -and
              [int]$finalCoherencePlanSummary.protectedMutationCount -eq 0 -and
              [int]$finalCoherencePlanSummary.protectedDirectoryMutationCount -eq 0 -and
              [int]$finalCoherencePlanSummary.protectedPathStateConflictCount -eq 0 -and
              $finalCoherencePlanSummary.referenceManifestSha256 -eq $syncPlanSummary.referenceManifestSha256
            )
            $treeCoherent = ($treeCoherentBeforeTests -and $finalCoherencePass)
            $sourceProvenanceFinalValidation = Get-SourceProvenance -Stage 'final_validation'
            Assert-SourceProvenanceUnchanged -Expected $sourceProvenanceInitial -Actual $sourceProvenanceFinalValidation -Stage 'final_validation'
            $trackedUiSourceManifestFinalValidation = Get-TrackedUiSourceManifest -Stage 'final_validation'
            Assert-TrackedUiSourceManifestUnchanged -Expected $trackedUiSourceManifestInitial -Actual $trackedUiSourceManifestFinalValidation -Stage 'final_validation'
            $referenceProvenanceFinalValidation = Get-ReferenceProvenance -Stage 'final_validation'
            Assert-SquidRunCondition ($referenceProvenanceFinalValidation.head -eq $head) 'Reference HEAD changed before final validation.'
            Assert-SquidRunCondition $referenceProvenanceFinalValidation.trackedClean 'Reference worktree changed before final validation.'
            Assert-SquidRunCondition $referenceProvenanceFinalValidation.lockMatchesMain 'Reference package-lock changed before final validation.'
            $finalValidationQuiet = New-QuietSnapshot -Stage 'final_validation'
            $activeAfter = @($finalValidationQuiet.activeProjectProcesses)
            $initialProjectProcessStartTimes = @($initialQuiet.activeProjectProcesses | ForEach-Object {
              [pscustomobject]@{
                processId = [int]$_.ProcessId
                creationDate = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
              }
            })
            $finalProjectProcessStartTimes = @($activeAfter | ForEach-Object {
              [pscustomobject]@{
                processId = [int]$_.ProcessId
                creationDate = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
              }
            })
            $projectProcessStartTimesUnchanged = (
              (ConvertTo-Json -InputObject $initialProjectProcessStartTimes -Depth 4 -Compress) -ceq
              (ConvertTo-Json -InputObject $finalProjectProcessStartTimes -Depth 4 -Compress)
            )
            $electronHashAfter = Get-SquidRunSha256 -LiteralPath $ElectronExe
            $functionalPass = ($fullSuite.exitCode -eq 0 -and $commsSuites.exitCode -eq 0)
            $binaryUntouched = ($electronHashBefore -eq $electronHashAfter -and $electronHashAfter -eq $ExpectedElectronExeSha256)
            $atomicReplacementDerived = (
              [int]$syncResult.atomicCommits -eq ([int]$syncResult.copyMissing + [int]$syncResult.replaceDifferent) -and
              [int]$syncPlanSummary.protectedMutationCount -eq 0 -and
              [int]$syncPlanSummary.protectedDirectoryMutationCount -eq 0 -and
              [int]$syncPlanSummary.protectedPathStateConflictCount -eq 0
            )
            $noBlast = ($initialQuiet.ok -and $postReferenceQuiet.ok -and $postPlanQuiet.ok -and $finalValidationQuiet.ok)
            $h6ReceiptValidationFinal = Get-H6ReceiptValidation
            $h6EvidenceUnchanged = (
              $h6ReceiptValidationFinal.native.sha256 -eq $h6ReceiptValidation.native.sha256 -and
              $h6ReceiptValidationFinal.window.sha256 -eq $h6ReceiptValidation.window.sha256 -and
              $h6ReceiptValidationFinal.stage.sha256 -eq $h6ReceiptValidation.stage.sha256 -and
              $h6ReceiptValidationFinal.packagedArtifact.executableSha256 -eq $h6ReceiptValidation.packagedArtifact.executableSha256 -and
              $h6ReceiptValidationFinal.packagedArtifact.asarSha256 -eq $h6ReceiptValidation.packagedArtifact.asarSha256
            )
            $ok = ($treeCoherent -and $functionalPass -and $binaryUntouched -and $atomicReplacementDerived -and $noBlast -and $h6ReceiptValidation.ok -and $h6ReceiptValidationFinal.ok -and $h6EvidenceUnchanged)

            $hmTaskQueueText = Get-Content -Raw -LiteralPath (Join-Path $UiRoot 'scripts\hm-task-queue.js')
            $normalizerText = Get-Content -Raw -LiteralPath (Join-Path $UiRoot 'modules\the-tell\normalize-job-type.js')
            $eolState = [ordered]@{
              hmTaskQueue = [ordered]@{
                crlf = ([regex]::Matches($hmTaskQueueText, "`r`n")).Count
                bareLf = ([regex]::Matches($hmTaskQueueText, "(?<!`r)`n")).Count
              }
              normalizerPort = [ordered]@{
                crlf = ([regex]::Matches($normalizerText, "`r`n")).Count
                bareLf = ([regex]::Matches($normalizerText, "(?<!`r)`n")).Count
              }
              characterizedSuites = @('system-protected-evals', 'the-tell-normalize-parity')
            }

            $finalPayload = [ordered]@{
              schema = 'squidrun.build1b.main_e28_restoration.v1'
              runId = $runId
              capturedAt = [DateTime]::UtcNow.ToString('o')
              ok = $ok
              restartState = if ($ok) { 'restart_ready_electron_28_3_3' } else { 'restart_blocked_repair_incomplete' }
              MR1 = [ordered]@{
                branch = $branch
                head = $head
                packageElectron = $package.devDependencies.electron
                lockRootElectron = $lock.packages[''].devDependencies.electron
                lockElectron = $lock.packages['node_modules/electron'].version
                ladderBranch = 'build-1b-ladder'
                ladderStageCommit = '2db3e392ab6aaae16609eaf939058e6b35d97303'
                h6CoveredSourceThrough = '2db3e392ab6aaae16609eaf939058e6b35d97303'
                retainedCommitsAfterH6Coverage = $retainedCommitRows
                sourceProvenance = [ordered]@{
                  initial = $sourceProvenanceInitial
                  postReferenceInstall = $sourceProvenancePostReference
                  postPlan = $sourceProvenancePostPlan
                  finalValidation = $sourceProvenanceFinalValidation
                }
                trackedUiSourceManifest = [ordered]@{
                  initial = $trackedUiSourceManifestInitial
                  finalValidation = $trackedUiSourceManifestFinalValidation
                  unchanged = ($trackedUiSourceManifestFinalValidation.sha256 -eq $trackedUiSourceManifestInitial.sha256)
                }
              }
              MR2 = [ordered]@{
                referenceRoot = $ReferenceRoot
                referenceHead = $referenceHead
                referenceNpmCiExitCode = $referenceInstall.exitCode
                referenceNpmCiDurationSeconds = $referenceInstall.durationSeconds
                referenceTopLevelCount = $referenceTopLevelCount
                mainTopLevelCount = $mainTopLevelCount
                referenceFileCount = $referenceFileMap.Count
                mainFileCount = $mainFileMapAfter.Count
                missingFiles = $missingAfter
                extraFiles = $extraAfter
                electronPackageMetadata = $mainElectronPackage.version
                nativeHashesMatch = $nativeHashesMatch
                referenceNativePresence = $referenceNativePresence
                mainNativePresence = $mainNativePresence
                referenceNativeHashes = $referenceNative
                mainNativeHashes = $mainNative
                randomSampleSeed = $sampleSeed
                randomSampleSize = $sampleSize
                randomSample = $hashSample
                randomSampleAllMatch = $sampleMatch
                syncPlan = $syncPlanSummary
                syncPlanArtifact = $syncPlanArtifactBinding
                sync = $syncResult
                finalFullCoherencePlan = $finalCoherencePlanSummary
                finalFullCoherencePass = $finalCoherencePass
                referenceProvenance = [ordered]@{
                  preInstall = $referenceProvenancePreInstall
                  postInstall = $referenceProvenancePostInstall
                  postPlan = $referenceProvenancePostPlan
                  finalValidation = $referenceProvenanceFinalValidation
                }
              }
              MR3 = [ordered]@{
                protectedPath = $ElectronExe
                sha256Before = $electronHashBefore
                sha256AfterSync = $electronHashAfterSync
                sha256After = $electronHashAfter
                expectedSha256 = $ExpectedElectronExeSha256
                atomicReplacement = $atomicReplacementDerived
                atomicCommitCount = [int]$syncResult.atomicCommits
                expectedAtomicCommitCount = ([int]$syncResult.copyMissing + [int]$syncResult.replaceDifferent)
                protectedMutationCount = [int]$syncPlanSummary.protectedMutationCount
                protectedDirectoryMutationCount = [int]$syncPlanSummary.protectedDirectoryMutationCount
                protectedPathStateConflictCount = [int]$syncPlanSummary.protectedPathStateConflictCount
                untouched = $binaryUntouched
              }
              MR4 = [ordered]@{
                fullSuiteMinusCharacterizedEolPair = [ordered]@{
                  exitCode = $fullSuite.exitCode
                  timedOut = $fullSuite.timedOut
                  forceExit = $true
                  durationSeconds = $fullSuite.durationSeconds
                  log = $fullSuiteLog
                  logSha256 = $fullSuiteLogSha256
                  logBytes = [int64]$fullSuiteLogBytes
                }
                characterizedEolSuitesDiagnosticOnly = [ordered]@{
                  exitCode = $eolSuites.exitCode
                  timedOut = $eolSuites.timedOut
                  forceExit = $true
                  gatesRestart = $false
                  status = if ($eolSuites.exitCode -eq 0) {
                    'diagnostic_pass'
                  } elseif ($eolSuites.timedOut) {
                    'diagnostic_timeout_non_gating_requires_log_review'
                  } else {
                    'diagnostic_failure_non_gating_requires_log_review'
                  }
                  durationSeconds = $eolSuites.durationSeconds
                  log = $eolLog
                  logSha256 = $eolLogSha256
                  logBytes = [int64]$eolLogBytes
                  checkoutState = $eolState
                }
                hmSendAndCommsRoundTripTests = [ordered]@{
                  exitCode = $commsSuites.exitCode
                  timedOut = $commsSuites.timedOut
                  forceExit = $true
                  durationSeconds = $commsSuites.durationSeconds
                  log = $commsLog
                  logSha256 = $commsLogSha256
                  logBytes = [int64]$commsLogBytes
                }
              }
              MR5 = [ordered]@{
                statement = if ($ok) {
                  'On the next restart, main boots its unchanged Electron 28.3.3 executable with an E28-coherent dependency tree and the current main source. This combination is execution-covered by the H6 E28 rollback receipt through 2db3e392 and by the full main-checkout suite recorded here for later restoration commits.'
                } else {
                  'Restart is blocked because one or more restoration criteria failed.'
                }
                h6NativeReceipt = '.squidrun/coord/build1b-e29-s480/rollback-native-e28-2db3e392.json'
                h6WindowReceipt = '.squidrun/coord/build1b-e29-s480/rollback-windows-e28-2db3e392/window-capture-receipt.json'
                h6ReceiptValidation = $h6ReceiptValidation
                h6ReceiptValidationFinal = $h6ReceiptValidationFinal
                h6EvidenceUnchanged = $h6EvidenceUnchanged
                residualRisks = @(
                  'Known packaged discoverProjectRoot/profile-link defect remains.',
                  'Inherited sandbox/CSP and navigation-guard debt remains.',
                  'Credential-scrubbed startup previously stalled at 6 percent; normal inherited environment is still required.',
                  'Signing and Smart App Control policy are unchanged and deferred.'
                )
              }
              MR6 = [ordered]@{
                naturalQuietWindowRequired = $true
                projectProcessStopCommands = 0
                ownedChildTerminationPolicy = 'Invoke-Captured may terminate only the child process tree it created, either after its explicit timeout or when the ambient-project-process poll guard detects a relaunch. It never targets an ambient project process.'
                initialQuiet = $initialQuiet
                postReferenceQuiet = $postReferenceQuiet
                postPlanQuiet = $postPlanQuiet
                finalValidationQuiet = $finalValidationQuiet
                activeProjectProcessesAfter = $activeAfter
                initialProjectProcessStartTimes = $initialProjectProcessStartTimes
                finalProjectProcessStartTimes = $finalProjectProcessStartTimes
                projectProcessStartTimesUnchanged = $projectProcessStartTimesUnchanged
                zeroProjectProcessSnapshots = $noBlast
                midRunGuardIntervalMs = [Math]::Max(100, $QuietRecheckIntervalMs)
                atomicSameDirectoryReplacement = $atomicReplacementDerived
                protectedElectronPlannedMutations = [int]$syncPlanSummary.protectedMutationCount
                protectedParentDirectoryPlannedMutations = [int]$syncPlanSummary.protectedDirectoryMutationCount
                protectedPathStateConflicts = [int]$syncPlanSummary.protectedPathStateConflictCount
              }
              MR7 = [ordered]@{
                originalMissingTopLevelEntries = 454
                originalMissingNestedFiles = 9124
                supersededIntermediate = 'E29-sourced missing-only fill; closed holes but left mixed Electron metadata and was not accepted as coherence restoration.'
                damageCharacterization = '.squidrun/coord/build1b-e29-s480/main-node-modules-damage-characterization.json'
                damageCharacterizationSha256 = $damageCharacterizationSha256
                originalUndersell = 'Initial EBUSY wording failed to state that npm ci had already removed dependency content; corrected before this restoration.'
              }
              singleFlight = [ordered]@{
                mutexName = $RestorationMutexName
                lockPath = $LockPath
                lockToken = $ownership.token
                staleQuarantine = $ownership.staleQuarantine
                staleStory = 'The cross-session Global OS mutex is the concurrency authority and is automatically released on crash. Only its exclusive owner may quarantine metadata; a matching live PID plus creation identity is conservatively refused, while missing/corrupt metadata is quarantined under global-mutex exclusivity with an explicit reason.'
              }
            }
            $sourceProvenanceBeforeReceipt = Get-SourceProvenance -Stage 'before_success_receipt'
            Assert-SourceProvenanceUnchanged -Expected $sourceProvenanceInitial -Actual $sourceProvenanceBeforeReceipt -Stage 'before_success_receipt'
            $trackedUiSourceManifestBeforeReceipt = Get-TrackedUiSourceManifest -Stage 'before_success_receipt'
            Assert-TrackedUiSourceManifestUnchanged -Expected $trackedUiSourceManifestInitial -Actual $trackedUiSourceManifestBeforeReceipt -Stage 'before_success_receipt'
            $finalReceiptQuiet = New-QuietSnapshot -Stage 'immediately_before_receipt'
            $finalPayload['MR1']['sourceProvenance']['beforeReceipt'] = $sourceProvenanceBeforeReceipt
            $finalPayload['MR1']['trackedUiSourceManifest']['beforeReceipt'] = $trackedUiSourceManifestBeforeReceipt
            $finalPayload['MR6']['finalReceiptQuiet'] = $finalReceiptQuiet
            if ($ok -and -not $finalReceiptQuiet.ok) {
              $finalPayload = [ordered]@{
                schema = 'squidrun.build1b.main_e28_restoration_event.v1'
                kind = 'final_relaunch_abort'
                capturedAtUtc = [DateTime]::UtcNow.ToString('o')
                ok = $false
                treeSyncCompleted = $true
                treeCoherentBeforeAbort = $treeCoherent
                functionalPassBeforeAbort = $functionalPass
                restartState = 'restart_blocked_verification_incomplete'
                quiet = $finalReceiptQuiet
                syncPlan = $syncPlanSummary
                syncPlanArtifact = $syncPlanArtifactBinding
                progress = $syncResult
                protectedElectronSha256 = $electronHashAfter
              }
              $finalPayload.receiptPath = Write-RunReceipt -Kind 'final-relaunch-abort' -Payload $finalPayload -RunId $runId
              $finalExitCode = 44
            } elseif ($ok) {
              $provisionalReceiptPayload = [ordered]@{
                schema = 'squidrun.build1b.main_e28_restoration_pre_success_validation.v1'
                runId = $runId
                kind = 'pre_success_validation'
                capturedAtUtc = [DateTime]::UtcNow.ToString('o')
                ok = $false
                candidateWouldPass = $true
                restartState = 'restart_blocked_pending_post_receipt_quiet_check'
                head = $head
                protectedElectronSha256 = $electronHashAfter
                finalReceiptQuiet = $finalReceiptQuiet
              }
              $provisionalReceiptPath = Write-RunReceipt -Kind 'pre-success-validation' -Payload $provisionalReceiptPayload -RunId $runId
              $provisionalReceiptSha256 = Get-SquidRunSha256 -LiteralPath $provisionalReceiptPath
              $sourceProvenanceAfterProvisionalReceipt = Get-SourceProvenance -Stage 'after_provisional_receipt'
              Assert-SourceProvenanceUnchanged -Expected $sourceProvenanceInitial -Actual $sourceProvenanceAfterProvisionalReceipt -Stage 'after_provisional_receipt'
              $trackedUiSourceManifestAfterProvisionalReceipt = Get-TrackedUiSourceManifest -Stage 'after_provisional_receipt'
              Assert-TrackedUiSourceManifestUnchanged -Expected $trackedUiSourceManifestInitial -Actual $trackedUiSourceManifestAfterProvisionalReceipt -Stage 'after_provisional_receipt'
              $h6ReceiptValidationAfterProvisionalReceipt = Get-H6ReceiptValidation
              $postProvisionalReceiptQuiet = New-QuietSnapshot -Stage 'after_provisional_receipt_before_final_success'
              $finalPayload['MR1']['sourceProvenance']['afterProvisionalReceipt'] = $sourceProvenanceAfterProvisionalReceipt
              $finalPayload['MR1']['trackedUiSourceManifest']['afterProvisionalReceipt'] = $trackedUiSourceManifestAfterProvisionalReceipt
              $finalPayload['MR5']['h6ReceiptValidationAfterProvisionalReceipt'] = $h6ReceiptValidationAfterProvisionalReceipt
              $finalPayload['MR6']['provisionalReceiptPath'] = $provisionalReceiptPath
              $finalPayload['MR6']['provisionalReceiptSha256'] = $provisionalReceiptSha256
              $finalPayload['MR6']['postProvisionalReceiptQuiet'] = $postProvisionalReceiptQuiet
              if (-not $postProvisionalReceiptQuiet.ok) {
                $finalPayload = [ordered]@{
                  schema = 'squidrun.build1b.main_e28_restoration_event.v1'
                  kind = 'post_provisional_receipt_relaunch_abort'
                  capturedAtUtc = [DateTime]::UtcNow.ToString('o')
                  ok = $false
                  treeSyncCompleted = $true
                  treeCoherentBeforeAbort = $treeCoherent
                  functionalPassBeforeAbort = $functionalPass
                  restartState = 'restart_blocked_verification_incomplete'
                  provisionalReceiptPath = $provisionalReceiptPath
                  quiet = $postProvisionalReceiptQuiet
                  protectedElectronSha256 = $electronHashAfter
                }
                $finalPayload.receiptPath = Write-RunReceipt -Kind 'post-provisional-relaunch-abort' -Payload $finalPayload -RunId $runId
                $finalExitCode = 44
              } else {
                $finalPayload.receiptPath = Write-RunReceipt -Kind 'main-e28-restoration' -Payload $finalPayload -RunId $runId
                $finalExitCode = 0
              }
            } else {
              $finalPayload.receiptPath = Write-RunReceipt -Kind 'main-e28-restoration' -Payload $finalPayload -RunId $runId
              $finalExitCode = 1
            }
          }
        }
      }
    }
  }
} catch {
  $postSyncFailure = ($null -ne $syncResult -and [string]$syncResult.stage -eq 'complete')
  $finalPayload = [ordered]@{
    schema = 'squidrun.build1b.main_e28_restoration_event.v1'
    kind = if ($postSyncFailure) { 'post_sync_unhandled_refusal_or_failure' } else { 'unhandled_refusal_or_failure' }
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    ok = $false
    restartState = 'restart_blocked_repair_incomplete'
    error = $_.Exception.Message
    stack = $_.ScriptStackTrace
    protectedElectronSha256 = if (Test-Path -LiteralPath $ElectronExe -PathType Leaf) { Get-SquidRunSha256 -LiteralPath $ElectronExe } else { $null }
  }
  if ($syncPlanSummary) { $finalPayload['syncPlan'] = $syncPlanSummary }
  if ($syncPlanArtifactBinding) { $finalPayload['syncPlanArtifact'] = $syncPlanArtifactBinding }
  if ($syncProgress) { $finalPayload['progress'] = $syncProgress }
  if ($postSyncFailure) {
    $finalPayload['treeSyncCompleted'] = $true
    $finalPayload['restartState'] = 'restart_blocked_verification_incomplete'
  }
  $finalPayload.receiptPath = Write-RunReceipt -Kind $(if ($postSyncFailure) { 'post-sync-unhandled-failure' } else { 'unhandled-failure' }) -Payload $finalPayload -RunId $runId
  $finalExitCode = 1
} finally {
  Remove-RestorationMutexAndLock -Ownership $ownership
}

$finalPayload | ConvertTo-Json -Depth 14
exit $finalExitCode

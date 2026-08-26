[CmdletBinding()]
param(
  [string]$ReceiptPath,
  [string]$RealReferenceModules,
  [switch]$RequireRealProjection
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptsRoot = Split-Path -Parent $ScriptPath
$UiRoot = Split-Path -Parent $ScriptsRoot
$ProjectRoot = Split-Path -Parent $UiRoot
$ModulePath = Join-Path $ScriptsRoot 'hm-main-e28-tree-sync.psm1'
$ProtectedRelativePath = 'electron\dist\electron.exe'
$ExpectedElectronExeSha256 = '67dc2a7036860a68e5312c212c31b8772ac463ed0289fcc44897867f55075e89'
$ExpectedElectronVersion = '28.3.3'
$RehearsalBase = Join-Path $ProjectRoot '.squidrun\coord\build1b-e29-s480\main-e28-restoration-rehearsal'
$RunId = "$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))-$PID-$([guid]::NewGuid().ToString('n').Substring(0, 8))"
$RunRoot = Join-Path $RehearsalBase "work-$RunId"

if (-not $ReceiptPath) {
  $ReceiptPath = Join-Path $RehearsalBase "$RunId-tree-sync-rehearsal.json"
}

Import-Module $ModulePath -Force

function Assert-Rehearsal {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-RunPath {
  param([string]$Candidate)
  $fullCandidate = [IO.Path]::GetFullPath($Candidate)
  $fullBase = [IO.Path]::GetFullPath($RehearsalBase).TrimEnd('\') + '\'
  Assert-Rehearsal $fullCandidate.StartsWith($fullBase, [StringComparison]::OrdinalIgnoreCase) "Refusing rehearsal path outside base: $fullCandidate"
}

$ReceiptPath = [IO.Path]::GetFullPath($ReceiptPath)
Assert-RunPath -Candidate $ReceiptPath

function Write-JsonAtomic {
  param([string]$LiteralPath, [object]$Value)

  Assert-RunPath -Candidate $LiteralPath
  [void][IO.Directory]::CreateDirectory((Split-Path -Parent $LiteralPath))
  $temporaryPath = "$LiteralPath.$PID.$([guid]::NewGuid().ToString('n')).tmp"
  Assert-RunPath -Candidate $temporaryPath
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 14))
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

function Get-RehearsalProvenance {
  param([string]$Stage)

  $head = (& git -C $ProjectRoot rev-parse HEAD).Trim()
  Assert-Rehearsal ($LASTEXITCODE -eq 0) "Unable to read Git HEAD at $Stage."
  $paths = @(
    $ScriptPath,
    $ModulePath,
    (Join-Path $ScriptsRoot 'hm-restore-main-e28-coherence.ps1'),
    (Join-Path $ScriptsRoot 'hm-main-e28-restoration-watch.js')
  )
  $hashes = [ordered]@{}
  foreach ($candidate in $paths) {
    Assert-Rehearsal (Test-Path -LiteralPath $candidate -PathType Leaf) "Rehearsal provenance source missing at ${Stage}: $candidate"
    $relative = [IO.Path]::GetRelativePath($ProjectRoot, $candidate).Replace('/', '\')
    $hashes[$relative] = Get-SquidRunSha256 -LiteralPath $candidate
  }
  return [ordered]@{
    stage = $Stage
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    head = $head
    hashes = $hashes
  }
}

function Assert-RehearsalProvenanceUnchanged {
  param([object]$Expected, [object]$Actual)

  Assert-Rehearsal ($Expected.head -eq $Actual.head) "Git HEAD changed during rehearsal: $($Expected.head) -> $($Actual.head)"
  foreach ($relative in $Expected.hashes.Keys) {
    Assert-Rehearsal ($Expected.hashes[$relative] -eq $Actual.hashes[$relative]) "Rehearsal source changed during execution: $relative"
  }
}

function Write-TextFile {
  param([string]$Path, [string]$Text)
  [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
  [IO.File]::WriteAllText($Path, $Text)
}

function Get-NonProtectedParity {
  param([string]$ReferenceRoot, [string]$DestinationRoot)
  $referenceMap = Get-SquidRunFileMap -Root $ReferenceRoot
  $destinationMap = Get-SquidRunFileMap -Root $DestinationRoot
  $mismatches = @()
  foreach ($relativePath in $referenceMap.Keys) {
    if ($relativePath.Equals($ProtectedRelativePath, [StringComparison]::OrdinalIgnoreCase)) { continue }
    if (-not $destinationMap.ContainsKey($relativePath)) {
      $mismatches += [pscustomobject]@{ path = $relativePath; reason = 'missing' }
      continue
    }
    $referenceHash = Get-SquidRunSha256 -LiteralPath $referenceMap[$relativePath]
    $destinationHash = Get-SquidRunSha256 -LiteralPath $destinationMap[$relativePath]
    if ($referenceHash -ne $destinationHash) {
      $mismatches += [pscustomobject]@{ path = $relativePath; reason = 'hash_mismatch' }
    }
  }
  foreach ($relativePath in $destinationMap.Keys) {
    if ($relativePath.Equals($ProtectedRelativePath, [StringComparison]::OrdinalIgnoreCase)) { continue }
    if (-not $referenceMap.ContainsKey($relativePath)) {
      $mismatches += [pscustomobject]@{ path = $relativePath; reason = 'extra' }
    }
  }
  return @($mismatches)
}

function Get-PlanSummary {
  param([object]$Plan)
  return [ordered]@{
    planDurationSeconds = $Plan.planDurationSeconds
    referenceFileCount = $Plan.referenceFileCount
    destinationFileCount = $Plan.destinationFileCount
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

function Measure-RealMutationReplay {
  param([object]$Plan, [string]$MeasureRoot)

  Assert-RunPath -Candidate $MeasureRoot
  $replayDestination = Join-Path $MeasureRoot 'destination'
  [void][IO.Directory]::CreateDirectory($replayDestination)
  $createDirectories = [Collections.Generic.List[object]]::new()
  $copyMissing = [Collections.Generic.List[object]]::new()
  $replaceDifferent = [Collections.Generic.List[object]]::new()
  $deleteExtraFiles = [Collections.Generic.List[object]]::new()
  $deleteExtraDirectories = [Collections.Generic.List[object]]::new()

  for ($index = 0; $index -lt @($Plan.createDirectories).Count; $index++) {
    $relative = "created\$($index.ToString('d6'))"
    $createDirectories.Add([pscustomobject]@{ relativePath = $relative; destination = Join-Path $replayDestination $relative })
  }
  for ($index = 0; $index -lt @($Plan.copyMissing).Count; $index++) {
    $original = @($Plan.copyMissing)[$index]
    $relative = "missing\$($index.ToString('d6')).bin"
    $destination = Join-Path $replayDestination $relative
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
    $copyMissing.Add([pscustomobject]@{
      relativePath = $relative
      source = $original.source
      destination = $destination
      bytes = $original.bytes
      sourceSha256 = $original.sourceSha256
      destinationExpected = 'missing'
    })
  }
  for ($index = 0; $index -lt @($Plan.replaceDifferent).Count; $index++) {
    $original = @($Plan.replaceDifferent)[$index]
    $relative = "replace\$($index.ToString('d6')).bin"
    $destination = Join-Path $replayDestination $relative
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
    Copy-Item -LiteralPath $original.destination -Destination $destination -Force
    Assert-Rehearsal ((Get-SquidRunSha256 -LiteralPath $destination) -eq $original.destinationSha256Before) "Replay replacement precondition hash mismatch: $($original.relativePath)"
    $replaceDifferent.Add([pscustomobject]@{
      relativePath = $relative
      source = $original.source
      destination = $destination
      bytes = $original.bytes
      sourceSha256 = $original.sourceSha256
      destinationBytesBefore = $original.destinationBytesBefore
      destinationSha256Before = $original.destinationSha256Before
    })
  }
  for ($index = 0; $index -lt @($Plan.deleteExtraFiles).Count; $index++) {
    $original = @($Plan.deleteExtraFiles)[$index]
    $relative = "delete-file\$($index.ToString('d6')).bin"
    $destination = Join-Path $replayDestination $relative
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
    Copy-Item -LiteralPath $original.destination -Destination $destination -Force
    $deleteExtraFiles.Add([pscustomobject]@{
      relativePath = $relative
      destination = $destination
      bytes = $original.bytes
      destinationSha256Before = $original.destinationSha256Before
    })
  }
  for ($index = 0; $index -lt @($Plan.deleteExtraDirectories).Count; $index++) {
    $relative = "delete-directory\$($index.ToString('d6'))"
    $destination = Join-Path $replayDestination $relative
    [void][IO.Directory]::CreateDirectory($destination)
    $deleteExtraDirectories.Add([pscustomobject]@{ relativePath = $relative; destination = $destination })
  }

  $replayPlan = [pscustomobject]@{
    schema = 'squidrun.dependency_sync_plan.replay.v1'
    referenceRoot = $Plan.referenceRoot
    destinationRoot = $replayDestination
    protectedRelativePath = $ProtectedRelativePath
    protectedMutationCount = 0
    protectedDirectoryMutationCount = 0
    protectedPathStateConflictCount = 0
    createDirectories = @($createDirectories)
    copyMissing = @($copyMissing)
    replaceDifferent = @($replaceDifferent)
    deleteExtraFiles = @($deleteExtraFiles)
    deleteExtraDirectories = @($deleteExtraDirectories)
  }
  $progress = [ordered]@{}
  $progressPath = Join-Path $MeasureRoot 'actual-module-progress.json'
  $script:replayExposureStartedTickMs = $null
  $script:replayExposureCompletedTickMs = $null
  $script:replayLastGuardTickMs = $null
  $script:replayLastProgressTickMs = $null
  $guard = {
    param([string]$Stage, [string]$RelativePath)
    $nowTickMs = [Environment]::TickCount64
    if ($null -eq $script:replayExposureStartedTickMs -and $Stage -in @('before_directory_create', 'before_temp_copy', 'before_extra_file_delete', 'before_extra_directory_delete')) {
      $script:replayExposureStartedTickMs = $nowTickMs
    }
    if ($Stage -eq 'sync_complete') {
      $script:replayExposureCompletedTickMs = $nowTickMs
    }
    $alwaysCheck = $Stage -in @('sync_start', 'before_directory_create', 'before_temp_copy', 'before_atomic_commit', 'after_missing_destination_commit_check', 'before_extra_file_delete', 'before_extra_directory_delete', 'sync_complete')
    if ($alwaysCheck -or $null -eq $script:replayLastGuardTickMs -or ($nowTickMs - $script:replayLastGuardTickMs) -ge 500) {
      $script:replayLastGuardTickMs = $nowTickMs
      [void]@(Get-CimInstance Win32_Process)
    }
  }
  $progressCallback = {
    param([object]$Progress)
    $nowTickMs = [Environment]::TickCount64
    $operationCount = [int]$Progress.createDirectories + [int]$Progress.copyMissing + [int]$Progress.replaceDifferent + [int]$Progress.deleteExtraFiles + [int]$Progress.deleteExtraDirectories
    if ($Progress.stage -eq 'complete' -or $operationCount -eq 1 -or ($operationCount % 100) -eq 0 -or $null -eq $script:replayLastProgressTickMs -or ($nowTickMs - $script:replayLastProgressTickMs) -ge 2000) {
      $script:replayLastProgressTickMs = $nowTickMs
      Write-JsonAtomic -LiteralPath $progressPath -Value ([ordered]@{ progress = $Progress; updatedAtUtc = [DateTime]::UtcNow.ToString('o') })
    }
  }
  $sync = Invoke-SquidRunDependencySyncPlan -Plan $replayPlan -QuietGuard $guard -ProgressState $progress -ProgressCallback $progressCallback
  $exposureSeconds = if ($null -ne $script:replayExposureStartedTickMs -and $null -ne $script:replayExposureCompletedTickMs) {
    [Math]::Round(($script:replayExposureCompletedTickMs - $script:replayExposureStartedTickMs) / 1000.0, 3)
  } else { 0.0 }
  $tempFiles = @(Get-ChildItem -LiteralPath $replayDestination -Recurse -File -Force | Where-Object { $_.Name -like '.squidrun-restore-*.tmp' })
  Assert-Rehearsal ([int]$sync.atomicCommits -eq (@($Plan.copyMissing).Count + @($Plan.replaceDifferent).Count)) 'Actual-module replay atomic commit count mismatch.'
  Assert-Rehearsal ($tempFiles.Count -eq 0) 'Actual-module replay left temporary files.'
  return [ordered]@{
    measured = $true
    measurementUsesActualSyncModule = $true
    planningHashScanSeconds = $Plan.planDurationSeconds
    planningHashScanOccursBeforeFirstMutation = $true
    actualModuleSyncDurationSeconds = $sync.durationSeconds
    measuredLoadedTreeExposureSeconds = $exposureSeconds
    replayedMutationCount = [int]$Plan.mutationCount
    replayedCopyFileCount = @($Plan.copyMissing).Count + @($Plan.replaceDifferent).Count
    replayedCopyBytes = [int64]$Plan.mutationBytes
    processGuardUsesRealCimQuery = $true
    progressReceiptPath = $progressPath
    sync = $sync
    temporaryFileCountAfter = $tempFiles.Count
    exposureDefinition = 'Measured from the first mutation boundary through sync_complete while invoking the production Invoke-SquidRunDependencySyncPlan with every real plan source byte/action, production Copy-Item plus temp-hash plus same-directory atomic Move, real CIM guard cost, and atomic progress-receipt writes. Setup and full-tree validation occur before the exposure boundary.'
  }
}

$provenanceInitial = Get-RehearsalProvenance -Stage 'initial'
Assert-RunPath -Candidate $RunRoot
[void][IO.Directory]::CreateDirectory($RunRoot)
$referenceRoot = Join-Path $RunRoot 'reference'
$destinationRoot = Join-Path $RunRoot 'destination'
$abortRoot = Join-Path $RunRoot 'abort-destination'
$raceReferenceRoot = Join-Path $RunRoot 'race-reference'
$raceDestinationRoot = Join-Path $RunRoot 'race-destination'
$missingRaceReferenceRoot = Join-Path $RunRoot 'missing-race-reference'
$missingRaceDestinationRoot = Join-Path $RunRoot 'missing-race-destination'
$postCommitReferenceRoot = Join-Path $RunRoot 'post-commit-reference'
$postCommitDestinationRoot = Join-Path $RunRoot 'post-commit-destination'
$typeReferenceRoot = Join-Path $RunRoot 'type-reference'
$typeDestinationRoot = Join-Path $RunRoot 'type-destination'
$directoryGuardReferenceRoot = Join-Path $RunRoot 'directory-guard-reference'
$directoryGuardDestinationRoot = Join-Path $RunRoot 'directory-guard-destination'
$protectedTypeReferenceRoot = Join-Path $RunRoot 'protected-type-reference'
$protectedTypeDestinationRoot = Join-Path $RunRoot 'protected-type-destination'

try {
  $lfLockFixturePath = Join-Path $RunRoot 'lock-hash-lf.json'
  $crlfLockFixturePath = Join-Path $RunRoot 'lock-hash-crlf.json'
  $invalidUtf8LockFixturePath = Join-Path $RunRoot 'lock-hash-invalid-utf8.json'
  Write-TextFile -Path $lfLockFixturePath -Text "{`n  `"lockfileVersion`": 3`n}`n"
  Write-TextFile -Path $crlfLockFixturePath -Text "{`r`n  `"lockfileVersion`": 3`r`n}`r`n"
  [IO.File]::WriteAllBytes($invalidUtf8LockFixturePath, [byte[]]@(0x7b, 0x0a, 0xc3, 0x28, 0x0a, 0x7d))
  $lfLockRawSha256 = Get-SquidRunSha256 -LiteralPath $lfLockFixturePath
  $crlfLockRawSha256 = Get-SquidRunSha256 -LiteralPath $crlfLockFixturePath
  $lfLockNormalizedSha256 = Get-SquidRunNormalizedTextSha256 -LiteralPath $lfLockFixturePath
  $crlfLockNormalizedSha256 = Get-SquidRunNormalizedTextSha256 -LiteralPath $crlfLockFixturePath
  $invalidUtf8Rejected = $false
  try {
    Get-SquidRunNormalizedTextSha256 -LiteralPath $invalidUtf8LockFixturePath | Out-Null
  } catch [Text.DecoderFallbackException] {
    $invalidUtf8Rejected = $true
  }
  Assert-Rehearsal ($lfLockRawSha256 -ne $crlfLockRawSha256) 'Lock hash fixture did not prove raw line-ending drift.'
  Assert-Rehearsal ($lfLockNormalizedSha256 -eq $crlfLockNormalizedSha256) 'LF-normalized lock hashes differ across checkout line endings.'
  Assert-Rehearsal $invalidUtf8Rejected 'Lock hash normalization did not reject invalid UTF-8 bytes.'

  Write-TextFile -Path (Join-Path $referenceRoot $ProtectedRelativePath) -Text 'REFERENCE_PROTECTED_DO_NOT_COPY'
  Write-TextFile -Path (Join-Path $referenceRoot 'equal\same.txt') -Text 'same'
  Write-TextFile -Path (Join-Path $referenceRoot 'replace\replace-me.txt') -Text ('new-value-' * 4096)
  Write-TextFile -Path (Join-Path $referenceRoot 'missing\missing.txt') -Text 'newly-present'
  Write-TextFile -Path (Join-Path $referenceRoot 'nested\a\b\value.txt') -Text 'nested-reference'

  Write-TextFile -Path (Join-Path $destinationRoot $ProtectedRelativePath) -Text 'LIVE_PROTECTED_MUST_SURVIVE'
  Write-TextFile -Path (Join-Path $destinationRoot 'equal\same.txt') -Text 'same'
  Write-TextFile -Path (Join-Path $destinationRoot 'replace\replace-me.txt') -Text ('old-value-' * 4096)
  Write-TextFile -Path (Join-Path $destinationRoot 'extra\delete-me.txt') -Text 'extra'
  Write-TextFile -Path (Join-Path $destinationRoot 'extra-root.txt') -Text 'extra-root'

  Copy-Item -LiteralPath $destinationRoot -Destination $abortRoot -Recurse
  $protectedHashBefore = Get-SquidRunSha256 -LiteralPath (Join-Path $destinationRoot $ProtectedRelativePath)
  $referenceReplacementPath = Join-Path $referenceRoot 'replace\replace-me.txt'
  $destinationReplacementPath = Join-Path $destinationRoot 'replace\replace-me.txt'
  $referenceReplacementLength = (Get-Item -LiteralPath $referenceReplacementPath).Length
  $destinationReplacementLength = (Get-Item -LiteralPath $destinationReplacementPath).Length
  $referenceReplacementHash = Get-SquidRunSha256 -LiteralPath $referenceReplacementPath
  $destinationReplacementHash = Get-SquidRunSha256 -LiteralPath $destinationReplacementPath
  Assert-Rehearsal ($referenceReplacementLength -eq $destinationReplacementLength) 'Synthetic replacement inputs are not equal length.'
  Assert-Rehearsal ($referenceReplacementHash -ne $destinationReplacementHash) 'Synthetic replacement inputs do not exercise the equal-size hash-mismatch branch.'
  $oldReplacementHash = Get-SquidRunSha256 -LiteralPath (Join-Path $abortRoot 'replace\replace-me.txt')

  $abortPlan = New-SquidRunDependencySyncPlan -ReferenceRoot $referenceRoot -DestinationRoot $abortRoot -ProtectedRelativePath $ProtectedRelativePath
  $equalSizeMismatchActions = @($abortPlan.replaceDifferent | Where-Object { $_.relativePath -eq 'replace\replace-me.txt' })
  Assert-Rehearsal ($equalSizeMismatchActions.Count -eq 1) 'Equal-size hash mismatch was not classified as replaceDifferent.'
  $abortProgress = [ordered]@{}
  $abortObserved = $false
  $abortError = $null
  $abortGuard = {
    param([string]$Stage, [string]$RelativePath)
    if ($Stage -eq 'before_atomic_commit' -and $RelativePath -eq 'replace\replace-me.txt') {
      throw 'synthetic_relaunch_before_atomic_commit'
    }
  }
  try {
    Invoke-SquidRunDependencySyncPlan -Plan $abortPlan -QuietGuard $abortGuard -ProgressState $abortProgress | Out-Null
  } catch {
    $abortObserved = $true
    $abortError = $_.Exception.Message
  }
  $replacementHashAfterAbort = Get-SquidRunSha256 -LiteralPath (Join-Path $abortRoot 'replace\replace-me.txt')
  $abortTempFiles = @(Get-ChildItem -LiteralPath $abortRoot -Recurse -File -Force | Where-Object { $_.Name -like '.squidrun-restore-*.tmp' })
  Assert-Rehearsal $abortObserved 'Synthetic precommit relaunch did not abort.'
  Assert-Rehearsal ($replacementHashAfterAbort -eq $oldReplacementHash) 'Destination replacement was observably changed before atomic commit.'
  Assert-Rehearsal ($abortTempFiles.Count -eq 0) 'Temporary copy file survived abort cleanup.'
  $abortCompletedCount = @($abortProgress.completedActions).Count
  $abortCounterCount = [int]$abortProgress.createDirectories + [int]$abortProgress.copyMissing + [int]$abortProgress.replaceDifferent + [int]$abortProgress.deleteExtraFiles + [int]$abortProgress.deleteExtraDirectories
  Assert-Rehearsal ($abortCompletedCount -eq $abortCounterCount) 'Abort progress did not retain one exact completed-action row per committed mutation.'

  $plantedPartialPath = Join-Path (Split-Path -Parent (Join-Path $abortRoot 'replace\replace-me.txt')) '.squidrun-restore-replace-me.txt.planted.tmp'
  [IO.File]::WriteAllText($plantedPartialPath, 'partial-copy-from-hard-interruption')
  $replacementHashWithPlantedPartial = Get-SquidRunSha256 -LiteralPath (Join-Path $abortRoot 'replace\replace-me.txt')
  Assert-Rehearsal ($replacementHashWithPlantedPartial -eq $oldReplacementHash) 'Planted hard-interruption temp changed the destination.'
  $recoveryPlan = New-SquidRunDependencySyncPlan -ReferenceRoot $referenceRoot -DestinationRoot $abortRoot -ProtectedRelativePath $ProtectedRelativePath
  $plantedRelativePath = Get-SquidRunRelativePath -BasePath $abortRoot -LiteralPath $plantedPartialPath
  $plantedPlannedForDeletion = @($recoveryPlan.deleteExtraFiles | Where-Object { $_.relativePath -eq $plantedRelativePath }).Count -eq 1
  Assert-Rehearsal $plantedPlannedForDeletion 'Next-run plan did not classify the planted partial temp as an extra file.'
  $recoveryProgress = [ordered]@{}
  $recoveryResult = Invoke-SquidRunDependencySyncPlan -Plan $recoveryPlan -ProgressState $recoveryProgress
  $recoveryTempFiles = @(Get-ChildItem -LiteralPath $abortRoot -Recurse -File -Force | Where-Object { $_.Name -like '.squidrun-restore-*.tmp' })
  $recoveryMismatches = @(Get-NonProtectedParity -ReferenceRoot $referenceRoot -DestinationRoot $abortRoot)
  Assert-Rehearsal ($recoveryTempFiles.Count -eq 0) 'Next-run recovery left a planted or generated temp file.'
  Assert-Rehearsal ($recoveryMismatches.Count -eq 0) 'Next-run recovery did not restore non-protected parity.'

  Write-TextFile -Path (Join-Path $raceReferenceRoot $ProtectedRelativePath) -Text 'race-reference-protected'
  Write-TextFile -Path (Join-Path $raceDestinationRoot $ProtectedRelativePath) -Text 'race-destination-protected'
  Write-TextFile -Path (Join-Path $raceReferenceRoot 'race.txt') -Text 'planned-source-value'
  Write-TextFile -Path (Join-Path $raceDestinationRoot 'race.txt') -Text 'planned-destination-value'
  $racePlan = New-SquidRunDependencySyncPlan -ReferenceRoot $raceReferenceRoot -DestinationRoot $raceDestinationRoot -ProtectedRelativePath $ProtectedRelativePath
  $raceConcurrentValue = 'concurrent-destination-value'
  $raceGuard = {
    param([string]$Stage, [string]$RelativePath)
    if ($Stage -eq 'before_atomic_commit' -and $RelativePath -eq 'race.txt') {
      [IO.File]::WriteAllText((Join-Path $raceDestinationRoot 'race.txt'), $raceConcurrentValue)
    }
  }
  $commitRaceAborted = $false
  $commitRaceError = $null
  try {
    Invoke-SquidRunDependencySyncPlan -Plan $racePlan -QuietGuard $raceGuard | Out-Null
  } catch {
    $commitRaceAborted = $true
    $commitRaceError = $_.Exception.Message
  }
  $raceDestinationValueAfter = [IO.File]::ReadAllText((Join-Path $raceDestinationRoot 'race.txt'))
  $raceTempFiles = @(Get-ChildItem -LiteralPath $raceDestinationRoot -Recurse -File -Force | Where-Object { $_.Name -like '.squidrun-restore-*.tmp' })
  Assert-Rehearsal $commitRaceAborted 'Commit-time destination race did not abort.'
  Assert-Rehearsal ($raceDestinationValueAfter -eq $raceConcurrentValue) 'Commit-time destination race overwrote concurrent content.'
  Assert-Rehearsal ($raceTempFiles.Count -eq 0) 'Commit-time destination race left a temporary file.'

  Write-TextFile -Path (Join-Path $missingRaceReferenceRoot $ProtectedRelativePath) -Text 'missing-race-reference-protected'
  Write-TextFile -Path (Join-Path $missingRaceDestinationRoot $ProtectedRelativePath) -Text 'missing-race-destination-protected'
  Write-TextFile -Path (Join-Path $missingRaceReferenceRoot 'appearing.txt') -Text 'planned-reference-value'
  $missingRacePlan = New-SquidRunDependencySyncPlan -ReferenceRoot $missingRaceReferenceRoot -DestinationRoot $missingRaceDestinationRoot -ProtectedRelativePath $ProtectedRelativePath
  $missingRaceConcurrentValue = 'concurrent-create-must-survive'
  $missingRacePath = Join-Path $missingRaceDestinationRoot 'appearing.txt'
  $missingRaceGuard = {
    param([string]$Stage, [string]$RelativePath)
    if ($Stage -eq 'after_missing_destination_commit_check' -and $RelativePath -eq 'appearing.txt') {
      [IO.File]::WriteAllText($missingRacePath, $missingRaceConcurrentValue)
    }
  }
  $missingRaceAborted = $false
  $missingRaceError = $null
  try {
    Invoke-SquidRunDependencySyncPlan -Plan $missingRacePlan -QuietGuard $missingRaceGuard | Out-Null
  } catch {
    $missingRaceAborted = $true
    $missingRaceError = $_.Exception.Message
  }
  $missingRaceValueAfter = [IO.File]::ReadAllText($missingRacePath)
  $missingRaceTempFiles = @(Get-ChildItem -LiteralPath $missingRaceDestinationRoot -Recurse -File -Force | Where-Object { $_.Name -like '.squidrun-restore-*.tmp' })
  Assert-Rehearsal $missingRaceAborted 'Atomic create-only move did not refuse a destination that appeared after the final absence check.'
  Assert-Rehearsal ($missingRaceValueAfter -eq $missingRaceConcurrentValue) 'Atomic create-only move overwrote a concurrent destination.'
  Assert-Rehearsal ($missingRaceTempFiles.Count -eq 0) 'Atomic create-only race left a temporary file.'

  Write-TextFile -Path (Join-Path $postCommitReferenceRoot $ProtectedRelativePath) -Text 'post-commit-reference-protected'
  Write-TextFile -Path (Join-Path $postCommitDestinationRoot $ProtectedRelativePath) -Text 'post-commit-destination-protected'
  Write-TextFile -Path (Join-Path $postCommitReferenceRoot 'journal.txt') -Text 'planned-journal-value'
  $postCommitPlan = New-SquidRunDependencySyncPlan -ReferenceRoot $postCommitReferenceRoot -DestinationRoot $postCommitDestinationRoot -ProtectedRelativePath $ProtectedRelativePath
  $postCommitProgress = [ordered]@{}
  $postCommitPath = Join-Path $postCommitDestinationRoot 'journal.txt'
  $postCommitCallback = {
    param([object]$Progress)
    if ($Progress.stage -eq 'missing_file_committed') {
      [IO.File]::WriteAllText($postCommitPath, 'corrupted-after-commit-before-verification')
    }
  }
  $postCommitVerificationAborted = $false
  $postCommitVerificationError = $null
  try {
    Invoke-SquidRunDependencySyncPlan -Plan $postCommitPlan -ProgressState $postCommitProgress -ProgressCallback $postCommitCallback | Out-Null
  } catch {
    $postCommitVerificationAborted = $true
    $postCommitVerificationError = $_.Exception.Message
  }
  $postCommitJournalExact = (
    $postCommitVerificationAborted -and
    [int]$postCommitProgress.copyMissing -eq 1 -and
    @($postCommitProgress.completedActions).Count -eq 1 -and
    [string]$postCommitProgress.completedActions[0].stage -eq 'missing_file_committed' -and
    [string]$postCommitProgress.completedActions[0].relativePath -eq 'journal.txt'
  )
  Assert-Rehearsal $postCommitJournalExact 'Post-commit verification failure omitted the already committed action from the exact journal.'

  Write-TextFile -Path (Join-Path $typeReferenceRoot $ProtectedRelativePath) -Text 'type-reference-protected'
  Write-TextFile -Path (Join-Path $typeDestinationRoot $ProtectedRelativePath) -Text 'type-destination-protected'
  Write-TextFile -Path (Join-Path $typeReferenceRoot 'dir-from-file\child.txt') -Text 'reference-child'
  Write-TextFile -Path (Join-Path $typeReferenceRoot 'file-from-dir.txt') -Text 'reference-file'
  Write-TextFile -Path (Join-Path $typeDestinationRoot 'dir-from-file') -Text 'destination-file-conflict'
  Write-TextFile -Path (Join-Path $typeDestinationRoot 'file-from-dir.txt\old.txt') -Text 'destination-directory-conflict'
  $typePlan = New-SquidRunDependencySyncPlan -ReferenceRoot $typeReferenceRoot -DestinationRoot $typeDestinationRoot -ProtectedRelativePath $ProtectedRelativePath
  $typeSync = Invoke-SquidRunDependencySyncPlan -Plan $typePlan
  $typeMismatches = @(Get-NonProtectedParity -ReferenceRoot $typeReferenceRoot -DestinationRoot $typeDestinationRoot)
  $typeConflictsReconciled = (
    $typeMismatches.Count -eq 0 -and
    (Test-Path -LiteralPath (Join-Path $typeDestinationRoot 'dir-from-file') -PathType Container) -and
    (Test-Path -LiteralPath (Join-Path $typeDestinationRoot 'file-from-dir.txt') -PathType Leaf)
  )
  Assert-Rehearsal $typeConflictsReconciled 'File/directory type conflicts were not reconciled.'

  Write-TextFile -Path (Join-Path $directoryGuardReferenceRoot $ProtectedRelativePath) -Text 'directory-guard-reference-protected'
  Write-TextFile -Path (Join-Path $directoryGuardDestinationRoot $ProtectedRelativePath) -Text 'directory-guard-destination-protected'
  Write-TextFile -Path (Join-Path $directoryGuardDestinationRoot 'extra\planned.txt') -Text 'planned-extra'
  $directoryGuardPlan = New-SquidRunDependencySyncPlan -ReferenceRoot $directoryGuardReferenceRoot -DestinationRoot $directoryGuardDestinationRoot -ProtectedRelativePath $ProtectedRelativePath
  $plantedUnplannedPath = Join-Path $directoryGuardDestinationRoot 'extra\appeared-after-plan.txt'
  $directoryGuard = {
    param([string]$Stage, [string]$RelativePath)
    if ($Stage -eq 'before_extra_directory_delete' -and $RelativePath -eq 'extra') {
      [IO.File]::WriteAllText($plantedUnplannedPath, 'must-survive')
    }
  }
  $unplannedDirectoryContentAborted = $false
  $unplannedDirectoryContentError = $null
  try {
    Invoke-SquidRunDependencySyncPlan -Plan $directoryGuardPlan -QuietGuard $directoryGuard | Out-Null
  } catch {
    $unplannedDirectoryContentAborted = $true
    $unplannedDirectoryContentError = $_.Exception.Message
  }
  Assert-Rehearsal $unplannedDirectoryContentAborted 'Unplanned directory content did not abort deletion.'
  Assert-Rehearsal (Test-Path -LiteralPath $plantedUnplannedPath -PathType Leaf) 'Unplanned directory content was recursively removed.'

  Write-TextFile -Path (Join-Path $protectedTypeReferenceRoot $ProtectedRelativePath) -Text 'reference-protected-file'
  $protectedDirectoryChild = Join-Path $protectedTypeDestinationRoot "$ProtectedRelativePath\must-survive.txt"
  Write-TextFile -Path $protectedDirectoryChild -Text 'protected-directory-content'
  $protectedTypePlan = New-SquidRunDependencySyncPlan -ReferenceRoot $protectedTypeReferenceRoot -DestinationRoot $protectedTypeDestinationRoot -ProtectedRelativePath $ProtectedRelativePath
  $protectedDirectoryScheduledForDelete = @($protectedTypePlan.deleteExtraDirectories | Where-Object {
    $_.relativePath.Equals($ProtectedRelativePath, [StringComparison]::OrdinalIgnoreCase)
  }).Count -gt 0
  $protectedDescendantScheduledForDelete = @(
    @($protectedTypePlan.deleteExtraFiles) + @($protectedTypePlan.deleteExtraDirectories) | Where-Object {
      $_.relativePath.StartsWith("$ProtectedRelativePath\", [StringComparison]::OrdinalIgnoreCase)
    }
  ).Count -gt 0
  $protectedTypeRefused = $false
  $protectedTypeError = $null
  try {
    Invoke-SquidRunDependencySyncPlan -Plan $protectedTypePlan | Out-Null
  } catch {
    $protectedTypeRefused = $true
    $protectedTypeError = $_.Exception.Message
  }
  Assert-Rehearsal (-not $protectedDirectoryScheduledForDelete) 'Planner scheduled the exact protected-path directory for deletion.'
  Assert-Rehearsal (-not $protectedDescendantScheduledForDelete) 'Planner scheduled protected-path directory content for deletion.'
  Assert-Rehearsal ([int]$protectedTypePlan.protectedPathStateConflictCount -gt 0) 'Protected file/directory type conflict was not marked as a protected path-state conflict.'
  Assert-Rehearsal $protectedTypeRefused 'Protected file/directory type conflict plan was not refused.'
  Assert-Rehearsal (Test-Path -LiteralPath $protectedDirectoryChild -PathType Leaf) 'Protected directory content was removed by a refused plan.'

  $plan = New-SquidRunDependencySyncPlan -ReferenceRoot $referenceRoot -DestinationRoot $destinationRoot -ProtectedRelativePath $ProtectedRelativePath
  $progress = [ordered]@{}
  $guardCalls = [Collections.Generic.List[object]]::new()
  $quietGuard = {
    param([string]$Stage, [string]$RelativePath)
    $guardCalls.Add([pscustomobject]@{ stage = $Stage; relativePath = $RelativePath })
  }
  $syncResult = Invoke-SquidRunDependencySyncPlan -Plan $plan -QuietGuard $quietGuard -ProgressState $progress
  $syntheticDurationSeconds = [double]$syncResult.durationSeconds
  $syntheticSecondsPerMutation = if ([int]$plan.mutationCount -gt 0) {
    $syntheticDurationSeconds / [int]$plan.mutationCount
  } else { 0.0 }

  $protectedHashAfter = Get-SquidRunSha256 -LiteralPath (Join-Path $destinationRoot $ProtectedRelativePath)
  $mismatches = @(Get-NonProtectedParity -ReferenceRoot $referenceRoot -DestinationRoot $destinationRoot)
  $tempFilesAfter = @(Get-ChildItem -LiteralPath $destinationRoot -Recurse -File -Force | Where-Object { $_.Name -like '.squidrun-restore-*.tmp' })
  Assert-Rehearsal ($protectedHashAfter -eq $protectedHashBefore) 'Protected file changed during successful sync.'
  Assert-Rehearsal ($mismatches.Count -eq 0) 'Non-protected synthetic tree is not coherent after sync.'
  Assert-Rehearsal ($tempFilesAfter.Count -eq 0) 'Temporary files survived successful sync.'
  Assert-Rehearsal ([int]$syncResult.copyMissing -gt 0) 'Missing-file copy path did not execute.'
  Assert-Rehearsal ([int]$syncResult.replaceDifferent -gt 0) 'Replacement path did not execute.'
  Assert-Rehearsal ([int]$syncResult.deleteExtraFiles -gt 0) 'Extra-file deletion path did not execute.'
  Assert-Rehearsal ([int]$syncResult.deleteExtraDirectories -gt 0) 'Extra-directory deletion path did not execute.'
  Assert-Rehearsal ([int]$syncResult.atomicCommits -eq ([int]$syncResult.copyMissing + [int]$syncResult.replaceDifferent)) 'Not every file copy used the atomic commit path.'
  Assert-Rehearsal (@($syncResult.completedActions).Count -eq [int]$plan.mutationCount) 'Successful sync did not retain one exact completed-action row per planned mutation.'

  $realProjection = [ordered]@{
    measured = $false
    reason = 'RealReferenceModules not supplied.'
  }
  if ($RealReferenceModules) {
    $resolvedReference = [IO.Path]::GetFullPath($RealReferenceModules)
    $resolvedDestination = [IO.Path]::GetFullPath((Join-Path $UiRoot 'node_modules'))
    $expectedReference = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ProjectRoot) '_archive\squidrun-worktrees\squidrun-build1b-main-e28-reference\ui\node_modules'))
    Assert-Rehearsal (Test-Path -LiteralPath $resolvedReference -PathType Container) "Real reference modules missing: $resolvedReference"
    Assert-Rehearsal ($resolvedReference -eq $expectedReference) "Real reference must be the isolated E28 restoration worktree: $expectedReference"
    Assert-Rehearsal ($resolvedReference -ne $resolvedDestination) 'Real reference and live destination must be different trees.'
    $referenceUi = Split-Path -Parent $resolvedReference
    $referenceWorktreeRoot = Split-Path -Parent $referenceUi
    $referenceHead = (& git -C $referenceWorktreeRoot rev-parse HEAD).Trim()
    Assert-Rehearsal ($LASTEXITCODE -eq 0 -and $referenceHead -eq $provenanceInitial.head) 'Real reference HEAD does not match the rehearsal HEAD.'
    $referenceTrackedStatus = @(& git -C $referenceWorktreeRoot status --porcelain --untracked-files=no)
    Assert-Rehearsal ($LASTEXITCODE -eq 0 -and $referenceTrackedStatus.Count -eq 0) 'Real reference tracked worktree is not clean.'
    $mainLockPath = Join-Path $UiRoot 'package-lock.json'
    $referenceLockPath = Join-Path $referenceUi 'package-lock.json'
    Assert-Rehearsal (Test-Path -LiteralPath $referenceLockPath -PathType Leaf) 'Real reference package-lock.json is missing.'
    $mainLockSha256 = Get-SquidRunNormalizedTextSha256 -LiteralPath $mainLockPath
    $referenceLockSha256 = Get-SquidRunNormalizedTextSha256 -LiteralPath $referenceLockPath
    Assert-Rehearsal ($mainLockSha256 -eq $referenceLockSha256) 'Real reference package lock differs from main.'
    $referencePackage = Get-Content -Raw -LiteralPath (Join-Path $resolvedReference 'electron\package.json') | ConvertFrom-Json -AsHashtable
    Assert-Rehearsal ([string]$referencePackage.version -eq $ExpectedElectronVersion) 'Real reference Electron package is not 28.3.3.'
    $referenceProtectedPath = Join-Path $resolvedReference $ProtectedRelativePath
    $destinationProtectedPath = Join-Path $resolvedDestination $ProtectedRelativePath
    Assert-Rehearsal (Test-Path -LiteralPath $referenceProtectedPath -PathType Leaf) 'Real reference protected Electron binary is missing.'
    Assert-Rehearsal (Test-Path -LiteralPath $destinationProtectedPath -PathType Leaf) 'Live protected Electron binary is missing.'
    $referenceProtectedSha256 = Get-SquidRunSha256 -LiteralPath $referenceProtectedPath
    $destinationProtectedSha256 = Get-SquidRunSha256 -LiteralPath $destinationProtectedPath
    Assert-Rehearsal ($referenceProtectedSha256 -eq $ExpectedElectronExeSha256) 'Real reference protected Electron hash is unexpected.'
    Assert-Rehearsal ($destinationProtectedSha256 -eq $ExpectedElectronExeSha256) 'Live protected Electron hash is unexpected.'
    $realPlan = New-SquidRunDependencySyncPlan -ReferenceRoot $resolvedReference -DestinationRoot $resolvedDestination -ProtectedRelativePath $ProtectedRelativePath
    Assert-Rehearsal ([int]$realPlan.protectedMutationCount -eq 0) 'Real plan targets the protected Electron binary.'
    Assert-Rehearsal ([int]$realPlan.protectedDirectoryMutationCount -eq 0) 'Real plan targets a protected Electron parent directory.'
    Assert-Rehearsal ([int]$realPlan.protectedPathStateConflictCount -eq 0) 'Real plan protected Electron path is not a file in both trees.'
    $measureRoot = Join-Path $RunRoot 'real-copy-replay'
    $realProjection = Measure-RealMutationReplay -Plan $realPlan -MeasureRoot $measureRoot
    $realProjection.plan = Get-PlanSummary -Plan $realPlan
    $realProjection.binding = [ordered]@{
      referenceModules = $resolvedReference
      destinationModules = $resolvedDestination
      referenceWorktreeRoot = $referenceWorktreeRoot
      referenceHead = $referenceHead
      mainHead = $provenanceInitial.head
      referenceTrackedClean = $true
      lockHashMode = 'utf8_lf_normalized'
      mainPackageLockSha256 = $mainLockSha256
      referencePackageLockSha256 = $referenceLockSha256
      protectedRelativePath = $ProtectedRelativePath
      expectedProtectedSha256 = $ExpectedElectronExeSha256
      referenceProtectedSha256 = $referenceProtectedSha256
      destinationProtectedSha256 = $destinationProtectedSha256
    }
    $durableProgressPath = Join-Path $RehearsalBase "$RunId-real-projection-progress.json"
    Write-JsonAtomic -LiteralPath $durableProgressPath -Value ([ordered]@{
      schema = 'squidrun.build1b.main_e28_tree_sync_rehearsal_progress.v1'
      runId = $RunId
      binding = $realProjection.binding
      plan = $realProjection.plan
      sync = $realProjection.sync
    })
    $realProjection.progressReceiptPath = $durableProgressPath
  }

  $syntheticOk = $true
  $gateReady = ($syntheticOk -and $realProjection.measured -eq $true)
  $receiptOk = if ($RequireRealProjection) { $gateReady } else { $syntheticOk }

  $provenanceFinal = Get-RehearsalProvenance -Stage 'before_receipt'
  Assert-RehearsalProvenanceUnchanged -Expected $provenanceInitial -Actual $provenanceFinal

  $receipt = [ordered]@{
    schema = 'squidrun.build1b.main_e28_tree_sync_rehearsal.v2'
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    ok = $receiptOk
    syntheticOk = $syntheticOk
    gateReady = $gateReady
    realProjectionRequired = [bool]$RequireRealProjection
    receiptPath = $ReceiptPath
    source = $ScriptPath
    module = $ModulePath
    provenance = [ordered]@{
      initial = $provenanceInitial
      beforeReceipt = $provenanceFinal
    }
    protectedRelativePath = $ProtectedRelativePath
    lockHashNormalization = [ordered]@{
      mode = 'utf8_lf_normalized'
      rawHashesDiffer = ($lfLockRawSha256 -ne $crlfLockRawSha256)
      normalizedHashesMatch = ($lfLockNormalizedSha256 -eq $crlfLockNormalizedSha256)
      invalidUtf8Rejected = $invalidUtf8Rejected
      lfNormalizedSha256 = $lfLockNormalizedSha256
      crlfNormalizedSha256 = $crlfLockNormalizedSha256
    }
    synthetic = [ordered]@{
      plan = Get-PlanSummary -Plan $plan
      sync = $syncResult
      quietGuardCallCount = $guardCalls.Count
      protectedHashBefore = $protectedHashBefore
      protectedHashAfter = $protectedHashAfter
      protectedUntouched = ($protectedHashBefore -eq $protectedHashAfter)
      nonProtectedMismatchCount = $mismatches.Count
      temporaryFileCountAfter = $tempFilesAfter.Count
      secondsPerMutation = [Math]::Round($syntheticSecondsPerMutation, 6)
    }
    equalSizeHashMismatch = [ordered]@{
      relativePath = 'replace\replace-me.txt'
      referenceBytes = $referenceReplacementLength
      destinationBytes = $destinationReplacementLength
      referenceSha256 = $referenceReplacementHash
      destinationSha256 = $destinationReplacementHash
      classifiedAsReplaceDifferent = ($equalSizeMismatchActions.Count -eq 1)
    }
    commitTimeDestinationRace = [ordered]@{
      aborted = $commitRaceAborted
      error = $commitRaceError
      concurrentValuePreserved = ($raceDestinationValueAfter -eq $raceConcurrentValue)
      temporaryFileCountAfter = $raceTempFiles.Count
    }
    missingDestinationCreateRace = [ordered]@{
      aborted = $missingRaceAborted
      error = $missingRaceError
      concurrentValuePreserved = ($missingRaceValueAfter -eq $missingRaceConcurrentValue)
      temporaryFileCountAfter = $missingRaceTempFiles.Count
    }
    postCommitVerificationFailure = [ordered]@{
      aborted = $postCommitVerificationAborted
      error = $postCommitVerificationError
      committedActionJournalExact = $postCommitJournalExact
      progressAtAbort = $postCommitProgress
    }
    fileDirectoryTypeConflicts = [ordered]@{
      plan = Get-PlanSummary -Plan $typePlan
      sync = $typeSync
      nonProtectedMismatchCount = $typeMismatches.Count
      reconciled = $typeConflictsReconciled
    }
    unplannedDirectoryContent = [ordered]@{
      aborted = $unplannedDirectoryContentAborted
      error = $unplannedDirectoryContentError
      plantedPath = $plantedUnplannedPath
      plantedContentSurvived = (Test-Path -LiteralPath $plantedUnplannedPath -PathType Leaf)
    }
    protectedFileDirectoryConflict = [ordered]@{
      plan = Get-PlanSummary -Plan $protectedTypePlan
      exactProtectedDirectoryScheduledForDelete = $protectedDirectoryScheduledForDelete
      protectedDescendantScheduledForDelete = $protectedDescendantScheduledForDelete
      refused = $protectedTypeRefused
      error = $protectedTypeError
      protectedDirectoryContentSurvived = (Test-Path -LiteralPath $protectedDirectoryChild -PathType Leaf)
    }
    interruption = [ordered]@{
      precommitAbort = [ordered]@{
        observed = $abortObserved
        error = $abortError
        injectedBoundary = 'before_atomic_commit:replace\\replace-me.txt'
        destinationHashBefore = $oldReplacementHash
        destinationHashAfter = $replacementHashAfterAbort
        destinationUntornAndUnchanged = ($replacementHashAfterAbort -eq $oldReplacementHash)
        temporaryFileCountAfterAbort = $abortTempFiles.Count
        completedActionCount = $abortCompletedCount
        completedCounterCount = $abortCounterCount
        progressAtAbort = $abortProgress
      }
      plantedHardInterruptionRecovery = [ordered]@{
        plantedTempRelativePath = $plantedRelativePath
        destinationHashWithPartialPresent = $replacementHashWithPlantedPartial
        destinationUntornBeforeRecovery = ($replacementHashWithPlantedPartial -eq $oldReplacementHash)
        plantedTempPlannedForDeletion = $plantedPlannedForDeletion
        recoveryPlan = Get-PlanSummary -Plan $recoveryPlan
        recovery = $recoveryResult
        temporaryFileCountAfterRecovery = $recoveryTempFiles.Count
        nonProtectedMismatchCountAfterRecovery = $recoveryMismatches.Count
      }
    }
    realTreeProjection = $realProjection
    criteria = [ordered]@{
      copyMissingExecuted = ([int]$syncResult.copyMissing -gt 0)
      replaceDifferentExecuted = ([int]$syncResult.replaceDifferent -gt 0)
      deleteExtraFilesExecuted = ([int]$syncResult.deleteExtraFiles -gt 0)
      deleteExtraDirectoriesExecuted = ([int]$syncResult.deleteExtraDirectories -gt 0)
      equalSizeHashMismatchExercised = ($referenceReplacementLength -eq $destinationReplacementLength -and $referenceReplacementHash -ne $destinationReplacementHash -and $equalSizeMismatchActions.Count -eq 1)
      protectedFileUntouched = ($protectedHashBefore -eq $protectedHashAfter)
      atomicAbortLeavesOldDestination = ($replacementHashAfterAbort -eq $oldReplacementHash)
      hardInterruptionArtifactRecovered = ($plantedPlannedForDeletion -and $recoveryTempFiles.Count -eq 0 -and $recoveryMismatches.Count -eq 0)
      commitTimeDestinationRaceRefused = ($commitRaceAborted -and $raceDestinationValueAfter -eq $raceConcurrentValue -and $raceTempFiles.Count -eq 0)
      missingDestinationCreateRaceRefused = ($missingRaceAborted -and $missingRaceValueAfter -eq $missingRaceConcurrentValue -and $missingRaceTempFiles.Count -eq 0)
      postCommitFailureJournalExact = $postCommitJournalExact
      fileDirectoryTypeConflictsReconciled = $typeConflictsReconciled
      unplannedDirectoryContentPreserved = ($unplannedDirectoryContentAborted -and (Test-Path -LiteralPath $plantedUnplannedPath -PathType Leaf))
      protectedFileDirectoryConflictRefused = ($protectedTypeRefused -and -not $protectedDirectoryScheduledForDelete -and (Test-Path -LiteralPath $protectedDirectoryChild -PathType Leaf))
      noTemporaryFilesRemain = ($abortTempFiles.Count -eq 0 -and $recoveryTempFiles.Count -eq 0 -and $raceTempFiles.Count -eq 0 -and $missingRaceTempFiles.Count -eq 0 -and $tempFilesAfter.Count -eq 0)
      exactCompletedActionJournal = (@($syncResult.completedActions).Count -eq [int]$plan.mutationCount -and $abortCompletedCount -eq $abortCounterCount)
      realTreeProjectionMeasured = ($realProjection.measured -eq $true)
    }
  }

  Write-JsonAtomic -LiteralPath $ReceiptPath -Value $receipt
  $receipt | ConvertTo-Json -Depth 14
  if (-not $receipt.ok) { exit 1 }
} finally {
  if (Test-Path -LiteralPath $RunRoot -PathType Container) {
    Assert-RunPath -Candidate $RunRoot
    Remove-Item -LiteralPath $RunRoot -Recurse -Force
  }
}

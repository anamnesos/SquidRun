[CmdletBinding()]
param(
  [switch]$PreflightOnly,
  [int]$RandomSampleSize = 64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExpectedElectronVersion = '28.3.3'
$ExpectedElectronExeSha256 = '67dc2a7036860a68e5312c212c31b8772ac463ed0289fcc44897867f55075e89'
$ProtectedElectronRelativePath = 'electron\dist\electron.exe'

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

function Assert-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) {
    throw $Message
  }
}

function Get-Sha256 {
  param([string]$LiteralPath)
  return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-RelativePath {
  param([string]$BasePath, [string]$LiteralPath)
  return [IO.Path]::GetRelativePath($BasePath, $LiteralPath).Replace('/', '\')
}

function Assert-PathWithin {
  param([string]$Candidate, [string]$AllowedRoot)
  $fullCandidate = [IO.Path]::GetFullPath($Candidate)
  $fullRoot = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\') + '\'
  Assert-Condition ($fullCandidate.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) "Refusing path outside allowed root: $fullCandidate"
}

function Get-SelfAndAncestorProcessIds {
  $ids = [Collections.Generic.HashSet[int]]::new()
  $cursor = [int]$PID
  while ($cursor -gt 0 -and $ids.Add($cursor)) {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $cursor" -ErrorAction SilentlyContinue
    if (-not $row) { break }
    $cursor = [int]$row.ParentProcessId
  }
  return $ids
}

function Get-ProjectProcesses {
  $excluded = Get-SelfAndAncestorProcessIds
  $rows = @(Get-CimInstance Win32_Process | Where-Object {
    if ($excluded.Contains([int]$_.ProcessId)) { return $false }
    $exeMatch = $_.ExecutablePath -and (
      $_.ExecutablePath.Equals($ElectronExe, [StringComparison]::OrdinalIgnoreCase) -or
      $_.ExecutablePath.StartsWith($UiRoot, [StringComparison]::OrdinalIgnoreCase)
    )
    $commandMatch = $_.CommandLine -and $_.CommandLine.IndexOf($ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    return $exeMatch -or $commandMatch
  } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate, CommandLine)
  return $rows
}

function Get-FileMap {
  param([string]$Root)
  $map = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($file in (Get-ChildItem -LiteralPath $Root -Recurse -File -Force)) {
    $map[(Get-RelativePath -BasePath $Root -LiteralPath $file.FullName)] = $file.FullName
  }
  return ,$map
}

function Get-DirectorySet {
  param([string]$Root)
  $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($directory in (Get-ChildItem -LiteralPath $Root -Recurse -Directory -Force)) {
    [void]$set.Add((Get-RelativePath -BasePath $Root -LiteralPath $directory.FullName))
  }
  return $set
}

function Invoke-Captured {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory
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
  $process.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  return [pscustomobject]@{
    file = $FilePath
    arguments = $Arguments
    workingDirectory = $WorkingDirectory
    exitCode = $process.ExitCode
    startedAtUtc = $startedAt.ToString('o')
    durationSeconds = [Math]::Round(([DateTime]::UtcNow - $startedAt).TotalSeconds, 3)
    stdout = $stdout
    stderr = $stderr
  }
}

function Get-NativeHashRows {
  param([string]$Root)
  $rows = @()
  foreach ($file in (Get-ChildItem -LiteralPath $Root -Recurse -File -Force)) {
    $relative = Get-RelativePath -BasePath $Root -LiteralPath $file.FullName
    $module = $null
    if ($relative -match '^better-sqlite3\\.*\.node$') { $module = 'better-sqlite3' }
    elseif ($relative -match '^node-pty\\.*\.node$') { $module = 'node-pty' }
    elseif ($relative -match '^sharp\\.*\.node$') { $module = 'sharp' }
    elseif ($relative -match '^onnxruntime-node\\.*\.node$') { $module = 'onnxruntime-node' }
    elseif ($relative -match '^sqlite-vec[^\\]*\\.*\.(dll|node)$') { $module = 'sqlite-vec' }
    if ($module) {
      $rows += [pscustomobject]@{
        module = $module
        path = $relative
        bytes = $file.Length
        sha256 = Get-Sha256 -LiteralPath $file.FullName
      }
    }
  }
  return @($rows | Sort-Object module, path)
}

function Compare-NativeRows {
  param([object[]]$ReferenceRows, [object[]]$MainRows)
  $referenceJson = $ReferenceRows | ConvertTo-Json -Depth 5 -Compress
  $mainJson = $MainRows | ConvertTo-Json -Depth 5 -Compress
  return $referenceJson -ceq $mainJson
}

Assert-Condition (Test-Path -LiteralPath $ProjectRoot -PathType Container) "Project root missing: $ProjectRoot"
Assert-Condition (Test-Path -LiteralPath $ElectronExe -PathType Leaf) "Electron executable missing: $ElectronExe"

$branch = (& git -C $ProjectRoot branch --show-current).Trim()
$head = (& git -C $ProjectRoot rev-parse HEAD).Trim()
Assert-Condition ($LASTEXITCODE -eq 0) 'Unable to read Git HEAD.'
Assert-Condition ($branch -eq 'main') "Restoration must run on main, not $branch."

$package = Get-Content -Raw -LiteralPath (Join-Path $UiRoot 'package.json') | ConvertFrom-Json -AsHashtable
$lock = Get-Content -Raw -LiteralPath (Join-Path $UiRoot 'package-lock.json') | ConvertFrom-Json -AsHashtable
Assert-Condition ($package.devDependencies.electron -eq $ExpectedElectronVersion) 'package.json is not pinned to Electron 28.3.3.'
Assert-Condition ($lock.packages[''].devDependencies.electron -eq $ExpectedElectronVersion) 'package-lock root is not pinned to Electron 28.3.3.'
Assert-Condition ($lock.packages['node_modules/electron'].version -eq $ExpectedElectronVersion) 'package-lock Electron entry is not 28.3.3.'

$electronHashBefore = Get-Sha256 -LiteralPath $ElectronExe
Assert-Condition ($electronHashBefore -eq $ExpectedElectronExeSha256) "Protected Electron binary hash is unexpected: $electronHashBefore"

$activeBefore = @(Get-ProjectProcesses)
$preflight = [ordered]@{
  ok = ($activeBefore.Count -eq 0)
  mode = if ($PreflightOnly) { 'preflight_only' } else { 'restore' }
  checkedAtUtc = [DateTime]::UtcNow.ToString('o')
  branch = $branch
  head = $head
  expectedElectron = $ExpectedElectronVersion
  electronExeSha256 = $electronHashBefore
  activeProjectProcessCount = $activeBefore.Count
  activeProjectProcesses = $activeBefore
  reason = if ($activeBefore.Count -eq 0) { 'natural_quiet_window_present' } else { 'natural_quiet_window_absent_refusing_all_writes' }
}

if ($PreflightOnly) {
  $preflight | ConvertTo-Json -Depth 7
  exit 0
}

if ($activeBefore.Count -ne 0) {
  $preflight | ConvertTo-Json -Depth 7
  exit 42
}

# Nothing above this line writes to the loaded dependency tree or creates a quiet window.
# From here on, the strict zero-project-process guard has passed naturally.

if (Test-Path -LiteralPath $ReferenceRoot) {
  $referenceHead = (& git -C $ReferenceRoot rev-parse HEAD).Trim()
  Assert-Condition ($LASTEXITCODE -eq 0) "Existing reference is not a Git worktree: $ReferenceRoot"
  Assert-Condition ($referenceHead -eq $head) "Existing reference HEAD $referenceHead does not match main $head."
} else {
  $worktreeResult = Invoke-Captured -FilePath (Get-Command git.exe).Source -Arguments @('-C', $ProjectRoot, '-c', 'core.autocrlf=false', 'worktree', 'add', '--detach', $ReferenceRoot, $head) -WorkingDirectory $ProjectRoot
  Assert-Condition ($worktreeResult.exitCode -eq 0) "Failed to create E28 reference worktree: $($worktreeResult.stderr)"
}

$npm = (Get-Command npm.cmd).Source
$referenceInstall = Invoke-Captured -FilePath $npm -Arguments @('ci', '--no-audit', '--no-fund') -WorkingDirectory $ReferenceUi
Assert-Condition ($referenceInstall.exitCode -eq 0) "Reference npm ci failed: $($referenceInstall.stderr)"

$referencePackage = Get-Content -Raw -LiteralPath (Join-Path $ReferenceModules 'electron\package.json') | ConvertFrom-Json -AsHashtable
Assert-Condition ($referencePackage.version -eq $ExpectedElectronVersion) 'Reference electron package metadata is not 28.3.3.'
$referenceElectronHash = Get-Sha256 -LiteralPath (Join-Path $ReferenceModules $ProtectedElectronRelativePath)
Assert-Condition ($referenceElectronHash -eq $ExpectedElectronExeSha256) 'Reference Electron executable hash differs from the protected live binary.'

$referenceFileMap = Get-FileMap -Root $ReferenceModules
$mainFileMapBefore = Get-FileMap -Root $MainModules
$referenceDirectories = Get-DirectorySet -Root $ReferenceModules
$mainDirectoriesBefore = Get-DirectorySet -Root $MainModules

$copiedMissing = 0
$replacedDifferent = 0
$deletedExtraFiles = 0
$deletedExtraDirectories = 0
$protectedWriteAttempts = 0

foreach ($relativeDirectory in ($referenceDirectories | Sort-Object Length, { $_ })) {
  $destinationDirectory = Join-Path $MainModules $relativeDirectory
  Assert-PathWithin -Candidate $destinationDirectory -AllowedRoot $MainModules
  if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
    [void][IO.Directory]::CreateDirectory($destinationDirectory)
  }
}

foreach ($relativePath in ($referenceFileMap.Keys | Sort-Object)) {
  if ($relativePath.Equals($ProtectedElectronRelativePath, [StringComparison]::OrdinalIgnoreCase)) {
    continue
  }
  $source = $referenceFileMap[$relativePath]
  $destination = Join-Path $MainModules $relativePath
  Assert-PathWithin -Candidate $destination -AllowedRoot $MainModules
  if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $copiedMissing++
  } elseif ((Get-Sha256 -LiteralPath $source) -ne (Get-Sha256 -LiteralPath $destination)) {
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $replacedDifferent++
  }
}

foreach ($relativePath in ($mainFileMapBefore.Keys | Sort-Object)) {
  if ($referenceFileMap.ContainsKey($relativePath)) { continue }
  if ($relativePath.Equals($ProtectedElectronRelativePath, [StringComparison]::OrdinalIgnoreCase)) {
    $protectedWriteAttempts++
    continue
  }
  $candidate = $mainFileMapBefore[$relativePath]
  Assert-PathWithin -Candidate $candidate -AllowedRoot $MainModules
  Remove-Item -LiteralPath $candidate -Force
  $deletedExtraFiles++
}

foreach ($relativeDirectory in ($mainDirectoriesBefore | Sort-Object Length -Descending)) {
  if ($referenceDirectories.Contains($relativeDirectory)) { continue }
  $candidate = Join-Path $MainModules $relativeDirectory
  Assert-PathWithin -Candidate $candidate -AllowedRoot $MainModules
  if (Test-Path -LiteralPath $candidate -PathType Container) {
    Remove-Item -LiteralPath $candidate -Recurse -Force
    $deletedExtraDirectories++
  }
}

$electronHashAfterSync = Get-Sha256 -LiteralPath $ElectronExe
Assert-Condition ($electronHashAfterSync -eq $electronHashBefore) 'Protected Electron executable hash changed during sync.'
Assert-Condition ($protectedWriteAttempts -eq 0) 'A protected Electron executable write/delete path was attempted.'

$mainFileMapAfter = Get-FileMap -Root $MainModules
$missingAfter = @($referenceFileMap.Keys | Where-Object { -not $mainFileMapAfter.ContainsKey($_) })
$extraAfter = @($mainFileMapAfter.Keys | Where-Object { -not $referenceFileMap.ContainsKey($_) })
$mainTopLevelCount = @(Get-ChildItem -LiteralPath $MainModules -Force).Count
$referenceTopLevelCount = @(Get-ChildItem -LiteralPath $ReferenceModules -Force).Count
$mainElectronPackage = Get-Content -Raw -LiteralPath (Join-Path $MainModules 'electron\package.json') | ConvertFrom-Json -AsHashtable

$referenceNative = Get-NativeHashRows -Root $ReferenceModules
$mainNative = Get-NativeHashRows -Root $MainModules
$nativeHashesMatch = Compare-NativeRows -ReferenceRows $referenceNative -MainRows $mainNative

$eligibleSamplePaths = @($referenceFileMap.Keys | Where-Object {
  $_.Contains('\') -and -not $_.Equals($ProtectedElectronRelativePath, [StringComparison]::OrdinalIgnoreCase)
})
$sampleSize = [Math]::Min([Math]::Max($RandomSampleSize, 1), $eligibleSamplePaths.Count)
$sampleSeed = [Security.Cryptography.RandomNumberGenerator]::GetInt32(1, [int]::MaxValue)
$samplePaths = @(Get-Random -InputObject $eligibleSamplePaths -Count $sampleSize -SetSeed $sampleSeed)
$hashSample = @($samplePaths | Sort-Object | ForEach-Object {
  $referenceHash = Get-Sha256 -LiteralPath $referenceFileMap[$_]
  $mainHash = Get-Sha256 -LiteralPath $mainFileMapAfter[$_]
  [pscustomobject]@{ path = $_; referenceSha256 = $referenceHash; mainSha256 = $mainHash; match = ($referenceHash -eq $mainHash) }
})

[void][IO.Directory]::CreateDirectory($ReceiptRoot)
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$fullSuite = Invoke-Captured -FilePath $npm -Arguments @('test', '--', '--runInBand', '--silent') -WorkingDirectory $UiRoot
$fullSuiteLog = Join-Path $ReceiptRoot "$stamp-full-suite.log"
[IO.File]::WriteAllText($fullSuiteLog, $fullSuite.stdout + [Environment]::NewLine + $fullSuite.stderr)

$eolSuites = Invoke-Captured -FilePath $npm -Arguments @('test', '--', '--runInBand', '--silent', '__tests__/system-protected-evals.test.js', '__tests__/the-tell-normalize-parity.test.js') -WorkingDirectory $UiRoot
$eolLog = Join-Path $ReceiptRoot "$stamp-eol-suites.log"
[IO.File]::WriteAllText($eolLog, $eolSuites.stdout + [Environment]::NewLine + $eolSuites.stderr)

$commsSuites = Invoke-Captured -FilePath $npm -Arguments @('test', '--', '--runInBand', '--silent', '__tests__/hm-send.test.js', '__tests__/hm-comms.test.js') -WorkingDirectory $UiRoot
$commsLog = Join-Path $ReceiptRoot "$stamp-comms-suites.log"
[IO.File]::WriteAllText($commsLog, $commsSuites.stdout + [Environment]::NewLine + $commsSuites.stderr)

$activeAfter = @(Get-ProjectProcesses)
$electronHashAfter = Get-Sha256 -LiteralPath $ElectronExe
$fileParity = ($missingAfter.Count -eq 0 -and $extraAfter.Count -eq 0)
$sampleMatch = (@($hashSample | Where-Object { -not $_.match }).Count -eq 0)
$treeCoherent = (
  $fileParity -and
  $mainTopLevelCount -eq $referenceTopLevelCount -and
  $mainElectronPackage.version -eq $ExpectedElectronVersion -and
  $nativeHashesMatch -and
  $sampleMatch
)
$functionalPass = ($fullSuite.exitCode -eq 0 -and $eolSuites.exitCode -eq 0 -and $commsSuites.exitCode -eq 0)
$binaryUntouched = ($electronHashBefore -eq $electronHashAfter -and $electronHashAfter -eq $ExpectedElectronExeSha256 -and $protectedWriteAttempts -eq 0)
$noBlast = ($activeBefore.Count -eq 0 -and $activeAfter.Count -eq 0)
$ok = ($treeCoherent -and $functionalPass -and $binaryUntouched -and $noBlast)

$hmTaskQueueText = Get-Content -Raw -LiteralPath (Join-Path $UiRoot 'scripts\hm-task-queue.js')
$normalizerText = Get-Content -Raw -LiteralPath (Join-Path $UiRoot 'modules\the-tell\normalize-job-type.js')
$eolState = [ordered]@{
  hmTaskQueue = [ordered]@{ crlf = ([regex]::Matches($hmTaskQueueText, "`r`n")).Count; bareLf = ([regex]::Matches($hmTaskQueueText, "(?<!`r)`n")).Count }
  normalizerPort = [ordered]@{ crlf = ([regex]::Matches($normalizerText, "`r`n")).Count; bareLf = ([regex]::Matches($normalizerText, "(?<!`r)`n")).Count }
  characterizedSuites = @('system-protected-evals', 'the-tell-normalize-parity')
}

$receipt = [ordered]@{
  schema = 'squidrun.build1b.main_e28_restoration.v0'
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
    retainedCommitsAfterH6Coverage = @($head)
    retainedCommitJustification = 'Main-only restoration tooling and exact E28 metadata are covered by this receipt full-suite run, not by the earlier H6 receipt.'
  }
  MR2 = [ordered]@{
    referenceRoot = $ReferenceRoot
    referenceHead = $head
    referenceNpmCiExitCode = $referenceInstall.exitCode
    referenceTopLevelCount = $referenceTopLevelCount
    mainTopLevelCount = $mainTopLevelCount
    referenceFileCount = $referenceFileMap.Count
    mainFileCount = $mainFileMapAfter.Count
    missingFiles = $missingAfter
    extraFiles = $extraAfter
    electronPackageMetadata = $mainElectronPackage.version
    nativeHashesMatch = $nativeHashesMatch
    referenceNativeHashes = $referenceNative
    mainNativeHashes = $mainNative
    randomSampleSeed = $sampleSeed
    randomSampleSize = $sampleSize
    randomSample = $hashSample
    randomSampleAllMatch = $sampleMatch
    sync = [ordered]@{ copiedMissing = $copiedMissing; replacedDifferent = $replacedDifferent; deletedExtraFiles = $deletedExtraFiles; deletedExtraDirectories = $deletedExtraDirectories }
  }
  MR3 = [ordered]@{
    protectedPath = $ElectronExe
    sha256Before = $electronHashBefore
    sha256AfterSync = $electronHashAfterSync
    sha256After = $electronHashAfter
    expectedSha256 = $ExpectedElectronExeSha256
    protectedWriteAttempts = $protectedWriteAttempts
    untouched = $binaryUntouched
  }
  MR4 = [ordered]@{
    fullSuite = [ordered]@{ exitCode = $fullSuite.exitCode; durationSeconds = $fullSuite.durationSeconds; log = $fullSuiteLog }
    characterizedEolSuites = [ordered]@{ exitCode = $eolSuites.exitCode; durationSeconds = $eolSuites.durationSeconds; log = $eolLog; checkoutState = $eolState }
    hmSendAndCommsRoundTripTests = [ordered]@{ exitCode = $commsSuites.exitCode; durationSeconds = $commsSuites.durationSeconds; log = $commsLog }
  }
  MR5 = [ordered]@{
    statement = if ($ok) { 'On the next restart, main boots its unchanged Electron 28.3.3 executable with an E28-coherent dependency tree and the current main source. This combination is execution-covered by the H6 E28 rollback receipt through 2db3e392 and by the full main-checkout suite recorded here for later restoration commits.' } else { 'Restart is blocked because one or more restoration criteria failed.' }
    h6NativeReceipt = '.squidrun/coord/build1b-e29-s480/rollback-native-e28-2db3e392.json'
    h6WindowReceipt = '.squidrun/coord/build1b-e29-s480/rollback-windows-e28-2db3e392/window-capture-receipt.json'
    residualRisks = @(
      'Known packaged discoverProjectRoot/profile-link defect remains.',
      'Inherited sandbox/CSP and navigation-guard debt remains.',
      'Credential-scrubbed startup previously stalled at 6 percent; normal inherited environment is still required.',
      'Signing and Smart App Control policy are unchanged and deferred.'
    )
  }
  MR6 = [ordered]@{
    naturalQuietWindowRequired = $true
    processStopCommandsInScript = 0
    activeProjectProcessesBefore = $activeBefore
    activeProjectProcessesAfter = $activeAfter
    processStartTimesUnchanged = $noBlast
    protectedWriteAttempts = $protectedWriteAttempts
  }
  MR7 = [ordered]@{
    originalMissingTopLevelEntries = 454
    originalMissingNestedFiles = 9124
    supersededIntermediate = 'E29-sourced missing-only fill; closed holes but left mixed Electron metadata and was not accepted as coherence restoration.'
    damageCharacterization = '.squidrun/coord/build1b-e29-s480/main-node-modules-damage-characterization.json'
    originalUndersell = 'Initial EBUSY wording failed to state that npm ci had already removed dependency content; corrected before this restoration.'
  }
}

$receiptPath = Join-Path $ReceiptRoot "$stamp-main-e28-restoration.json"
[IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 12))
$receipt | ConvertTo-Json -Depth 12
if (-not $ok) { exit 1 }

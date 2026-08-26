Set-StrictMode -Version Latest

function Assert-SquidRunCondition {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Get-SquidRunSha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-SquidRunTextSha256 {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)

  $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Get-SquidRunNormalizedTextSha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  $bytes = [IO.File]::ReadAllBytes($LiteralPath)
  $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { 3 } else { 0 }
  $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
  $text = $strictUtf8.GetString($bytes, $offset, $bytes.Length - $offset)
  $normalized = $text.Replace("`r`n", "`n").Replace("`r", "`n")
  return Get-SquidRunTextSha256 -Text $normalized
}

function Get-SquidRunRelativePath {
  param(
    [Parameter(Mandatory = $true)][string]$BasePath,
    [Parameter(Mandatory = $true)][string]$LiteralPath
  )

  return [IO.Path]::GetRelativePath($BasePath, $LiteralPath).Replace('/', '\')
}

function Assert-SquidRunPathWithin {
  param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$AllowedRoot
  )

  $fullCandidate = [IO.Path]::GetFullPath($Candidate)
  $fullRoot = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\') + '\'
  Assert-SquidRunCondition (
    $fullCandidate.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)
  ) "Refusing path outside allowed root: $fullCandidate"

  $rootWithoutSeparator = $fullRoot.TrimEnd('\')
  $rootAttributes = [IO.File]::GetAttributes($rootWithoutSeparator)
  Assert-SquidRunCondition (
    ($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
  ) "Refusing reparse-point dependency root: $rootWithoutSeparator"

  $relative = [IO.Path]::GetRelativePath($rootWithoutSeparator, $fullCandidate)
  $cursor = $rootWithoutSeparator
  foreach ($segment in ($relative -split '[\\/]' | Where-Object { $_ -and $_ -ne '.' })) {
    $cursor = Join-Path $cursor $segment
    if (-not (Test-Path -LiteralPath $cursor)) { break }
    $attributes = [IO.File]::GetAttributes($cursor)
    Assert-SquidRunCondition (
      ($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
    ) "Refusing dependency path through reparse point: $cursor"
  }
}

function Assert-SquidRunTreeHasNoReparsePoints {
  param([Parameter(Mandatory = $true)][string]$Root)

  $rootAttributes = [IO.File]::GetAttributes([IO.Path]::GetFullPath($Root))
  Assert-SquidRunCondition (
    ($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
  ) "Refusing reparse-point dependency root: $Root"
  $reparsePoints = @(Get-ChildItem -LiteralPath $Root -Recurse -Force | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  } | Select-Object -First 10 FullName, Attributes, LinkType, Target)
  $reparsePointNames = @($reparsePoints | ForEach-Object { $_.FullName }) -join ', '
  Assert-SquidRunCondition (
    $reparsePoints.Count -eq 0
  ) "Refusing dependency tree containing reparse points: $reparsePointNames"
}

function Get-SquidRunFileMap {
  param([Parameter(Mandatory = $true)][string]$Root)

  $map = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($file in (Get-ChildItem -LiteralPath $Root -Recurse -File -Force)) {
    $map[(Get-SquidRunRelativePath -BasePath $Root -LiteralPath $file.FullName)] = $file.FullName
  }
  return ,$map
}

function Get-SquidRunDirectorySet {
  param([Parameter(Mandatory = $true)][string]$Root)

  $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($directory in (Get-ChildItem -LiteralPath $Root -Recurse -Directory -Force)) {
    [void]$set.Add((Get-SquidRunRelativePath -BasePath $Root -LiteralPath $directory.FullName))
  }
  return ,$set
}

function Invoke-SquidRunQuietGuard {
  param(
    [scriptblock]$QuietGuard,
    [string]$Stage,
    [string]$RelativePath = ''
  )

  if ($QuietGuard) {
    & $QuietGuard $Stage $RelativePath
  }
}

function New-SquidRunDependencySyncPlan {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$ReferenceRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [Parameter(Mandatory = $true)][string]$ProtectedRelativePath,
    [scriptblock]$QuietGuard
  )

  $startedAt = [DateTime]::UtcNow
  $durationWatch = [Diagnostics.Stopwatch]::StartNew()
  Assert-SquidRunCondition (Test-Path -LiteralPath $ReferenceRoot -PathType Container) "Reference root missing: $ReferenceRoot"
  Assert-SquidRunCondition (Test-Path -LiteralPath $DestinationRoot -PathType Container) "Destination root missing: $DestinationRoot"
  Assert-SquidRunTreeHasNoReparsePoints -Root $ReferenceRoot
  Assert-SquidRunTreeHasNoReparsePoints -Root $DestinationRoot
  Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'plan_start' -RelativePath ''

  $referenceFileMap = Get-SquidRunFileMap -Root $ReferenceRoot
  $destinationFileMap = Get-SquidRunFileMap -Root $DestinationRoot
  $referenceDirectories = Get-SquidRunDirectorySet -Root $ReferenceRoot
  $destinationDirectories = Get-SquidRunDirectorySet -Root $DestinationRoot
  $protectedPathStateConflictCount = if (
    $referenceFileMap.ContainsKey($ProtectedRelativePath) -and
    $destinationFileMap.ContainsKey($ProtectedRelativePath)
  ) { 0 } else { 1 }

  $createDirectories = [Collections.Generic.List[object]]::new()
  $copyMissing = [Collections.Generic.List[object]]::new()
  $replaceDifferent = [Collections.Generic.List[object]]::new()
  $deleteExtraFiles = [Collections.Generic.List[object]]::new()
  $deleteExtraDirectories = [Collections.Generic.List[object]]::new()
  $referenceManifest = [Text.StringBuilder]::new()
  $hashedEqualFiles = 0
  $hashedEqualBytes = [int64]0

  foreach ($relativeDirectory in ($referenceDirectories | Sort-Object Length, { $_ })) {
    Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'plan_reference_directory' -RelativePath $relativeDirectory
    if (-not $destinationDirectories.Contains($relativeDirectory)) {
      $destination = Join-Path $DestinationRoot $relativeDirectory
      Assert-SquidRunPathWithin -Candidate $destination -AllowedRoot $DestinationRoot
      $createDirectories.Add([pscustomobject]@{
        relativePath = $relativeDirectory
        destination = $destination
        destinationExpected = 'missing'
      })
    }
  }

  foreach ($relativePath in ($referenceFileMap.Keys | Sort-Object)) {
    Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'plan_reference_file' -RelativePath $relativePath
    $source = $referenceFileMap[$relativePath]
    Assert-SquidRunPathWithin -Candidate $source -AllowedRoot $ReferenceRoot
    $sourceInfo = Get-Item -LiteralPath $source -Force
    $sourceHash = Get-SquidRunSha256 -LiteralPath $source
    [void]$referenceManifest.Append($relativePath).Append("`t").Append([int64]$sourceInfo.Length).Append("`t").Append($sourceHash).Append("`n")
    if (
      $relativePath.Equals($ProtectedRelativePath, [StringComparison]::OrdinalIgnoreCase) -or
      $relativePath.StartsWith("$ProtectedRelativePath\", [StringComparison]::OrdinalIgnoreCase)
    ) {
      continue
    }

    $destination = Join-Path $DestinationRoot $relativePath
    Assert-SquidRunPathWithin -Candidate $destination -AllowedRoot $DestinationRoot

    if (-not $destinationFileMap.ContainsKey($relativePath)) {
      $copyMissing.Add([pscustomobject]@{
        relativePath = $relativePath
        source = $source
        destination = $destination
        bytes = [int64]$sourceInfo.Length
        sourceSha256 = $sourceHash
        destinationExpected = 'missing'
      })
      continue
    }

    $destinationPath = $destinationFileMap[$relativePath]
    $destinationInfo = Get-Item -LiteralPath $destinationPath -Force
    $destinationHash = Get-SquidRunSha256 -LiteralPath $destinationPath
    $different = ([int64]$sourceInfo.Length -ne [int64]$destinationInfo.Length)
    if (-not $different) {
      $different = ($sourceHash -ne $destinationHash)
      if (-not $different) {
        $hashedEqualFiles++
        $hashedEqualBytes += [int64]$sourceInfo.Length
      }
    }

    if ($different) {
      $replaceDifferent.Add([pscustomobject]@{
        relativePath = $relativePath
        source = $source
        destination = $destinationPath
        bytes = [int64]$sourceInfo.Length
        sourceSha256 = $sourceHash
        destinationBytesBefore = [int64]$destinationInfo.Length
        destinationSha256Before = $destinationHash
      })
    }
  }

  foreach ($relativePath in ($destinationFileMap.Keys | Sort-Object)) {
    Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'plan_destination_extra_file' -RelativePath $relativePath
    if ($referenceFileMap.ContainsKey($relativePath)) {
      continue
    }
    if (
      $relativePath.Equals($ProtectedRelativePath, [StringComparison]::OrdinalIgnoreCase) -or
      $relativePath.StartsWith("$ProtectedRelativePath\", [StringComparison]::OrdinalIgnoreCase)
    ) {
      continue
    }

    $candidate = $destinationFileMap[$relativePath]
    Assert-SquidRunPathWithin -Candidate $candidate -AllowedRoot $DestinationRoot
    $deleteExtraFiles.Add([pscustomobject]@{
      relativePath = $relativePath
      destination = $candidate
      bytes = [int64](Get-Item -LiteralPath $candidate -Force).Length
      destinationSha256Before = Get-SquidRunSha256 -LiteralPath $candidate
    })
  }

  foreach ($relativeDirectory in ($destinationDirectories | Sort-Object Length -Descending)) {
    Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'plan_destination_extra_directory' -RelativePath $relativeDirectory
    if ($referenceDirectories.Contains($relativeDirectory)) {
      continue
    }
    if (
      $relativeDirectory.Equals($ProtectedRelativePath, [StringComparison]::OrdinalIgnoreCase) -or
      $ProtectedRelativePath.StartsWith("$relativeDirectory\", [StringComparison]::OrdinalIgnoreCase) -or
      $relativeDirectory.StartsWith("$ProtectedRelativePath\", [StringComparison]::OrdinalIgnoreCase)
    ) {
      continue
    }

    $candidate = Join-Path $DestinationRoot $relativeDirectory
    Assert-SquidRunPathWithin -Candidate $candidate -AllowedRoot $DestinationRoot
    $deleteExtraDirectories.Add([pscustomobject]@{
      relativePath = $relativeDirectory
      destination = $candidate
      destinationExpected = 'empty_after_planned_file_deletes'
    })
  }

  $mutationBytes = [int64]0
  foreach ($action in @($copyMissing) + @($replaceDifferent)) {
    $mutationBytes += [int64]$action.bytes
  }
  $allFileMutations = @($copyMissing) + @($replaceDifferent) + @($deleteExtraFiles)
  $protectedMutationCount = @($allFileMutations | Where-Object {
    $_.relativePath.Equals($ProtectedRelativePath, [StringComparison]::OrdinalIgnoreCase) -or
    $_.relativePath.StartsWith("$ProtectedRelativePath\", [StringComparison]::OrdinalIgnoreCase)
  }).Count
  $protectedDirectoryMutationCount = @($deleteExtraDirectories | Where-Object {
    $_.relativePath.Equals($ProtectedRelativePath, [StringComparison]::OrdinalIgnoreCase) -or
    $ProtectedRelativePath.StartsWith("$($_.relativePath)\", [StringComparison]::OrdinalIgnoreCase)
  }).Count
  Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'plan_complete' -RelativePath ''

  return [pscustomobject]@{
    schema = 'squidrun.dependency_sync_plan.v1'
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    referenceRoot = [IO.Path]::GetFullPath($ReferenceRoot)
    destinationRoot = [IO.Path]::GetFullPath($DestinationRoot)
    protectedRelativePath = $ProtectedRelativePath
    referenceFileCount = $referenceFileMap.Count
    destinationFileCount = $destinationFileMap.Count
    referenceDirectoryCount = $referenceDirectories.Count
    destinationDirectoryCount = $destinationDirectories.Count
    hashedEqualFiles = $hashedEqualFiles
    hashedEqualBytes = $hashedEqualBytes
    planDurationSeconds = [Math]::Round($durationWatch.Elapsed.TotalSeconds, 3)
    mutationBytes = $mutationBytes
    mutationCount = ($createDirectories.Count + $copyMissing.Count + $replaceDifferent.Count + $deleteExtraFiles.Count + $deleteExtraDirectories.Count)
    protectedMutationCount = $protectedMutationCount
    protectedDirectoryMutationCount = $protectedDirectoryMutationCount
    protectedPathStateConflictCount = $protectedPathStateConflictCount
    referenceManifestSha256 = Get-SquidRunTextSha256 -Text $referenceManifest.ToString()
    createDirectories = @($createDirectories)
    copyMissing = @($copyMissing)
    replaceDifferent = @($replaceDifferent)
    deleteExtraFiles = @($deleteExtraFiles)
    deleteExtraDirectories = @($deleteExtraDirectories)
  }
}

function Copy-SquidRunFileAtomically {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$SourceAllowedRoot,
    [Parameter(Mandatory = $true)][string]$AllowedRoot,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$ExpectedSourceSha256,
    [string]$ExpectedDestinationSha256,
    [switch]$DestinationMustBeMissing,
    [scriptblock]$QuietGuard
  )

  Assert-SquidRunPathWithin -Candidate $Source -AllowedRoot $SourceAllowedRoot
  Assert-SquidRunCondition (Test-Path -LiteralPath $Source -PathType Leaf) "Source file missing before atomic copy: $Source"
  Assert-SquidRunCondition ((Get-SquidRunSha256 -LiteralPath $Source) -eq $ExpectedSourceSha256) "Source file changed after planning: $RelativePath"
  Assert-SquidRunPathWithin -Candidate $Destination -AllowedRoot $AllowedRoot
  if ($DestinationMustBeMissing) {
    Assert-SquidRunCondition (-not (Test-Path -LiteralPath $Destination)) "Missing-file destination appeared after planning: $RelativePath"
  } else {
    Assert-SquidRunCondition (Test-Path -LiteralPath $Destination -PathType Leaf) "Replacement destination disappeared after planning: $RelativePath"
    Assert-SquidRunCondition ((Get-SquidRunSha256 -LiteralPath $Destination) -eq $ExpectedDestinationSha256) "Replacement destination changed after planning: $RelativePath"
  }
  $destinationDirectory = Split-Path -Parent $Destination
  Assert-SquidRunCondition (Test-Path -LiteralPath $destinationDirectory -PathType Container) "Destination directory missing: $destinationDirectory"
  $temporaryName = ".squidrun-restore-$([IO.Path]::GetFileName($Destination)).$([guid]::NewGuid().ToString('n')).tmp"
  $temporaryPath = Join-Path $destinationDirectory $temporaryName
  Assert-SquidRunPathWithin -Candidate $temporaryPath -AllowedRoot $AllowedRoot

  try {
    Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'before_temp_copy' -RelativePath $RelativePath
    Copy-Item -LiteralPath $Source -Destination $temporaryPath -Force
    Assert-SquidRunCondition ((Get-SquidRunSha256 -LiteralPath $temporaryPath) -eq $ExpectedSourceSha256) "Temporary copy hash differs from the planned source: $RelativePath"
    Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'before_atomic_commit' -RelativePath $RelativePath
    if ($DestinationMustBeMissing) {
      Assert-SquidRunCondition (-not (Test-Path -LiteralPath $Destination)) "Missing-file destination appeared at commit time: $RelativePath"
      Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'after_missing_destination_commit_check' -RelativePath $RelativePath
    } else {
      Assert-SquidRunCondition (Test-Path -LiteralPath $Destination -PathType Leaf) "Replacement destination disappeared at commit time: $RelativePath"
      Assert-SquidRunCondition ((Get-SquidRunSha256 -LiteralPath $Destination) -eq $ExpectedDestinationSha256) "Replacement destination changed at commit time: $RelativePath"
    }
    if ($DestinationMustBeMissing) {
      # The two-argument overload is create-only. It closes the check-to-move
      # race without ever overwriting a destination that appeared after the
      # last explicit absence check.
      [IO.File]::Move($temporaryPath, $Destination)
    } else {
      [IO.File]::Move($temporaryPath, $Destination, $true)
    }
  } finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-SquidRunDependencySyncPlan {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][object]$Plan,
    [scriptblock]$QuietGuard,
    [System.Collections.IDictionary]$ProgressState,
    [scriptblock]$ProgressCallback
  )

  $startedAt = [DateTime]::UtcNow
  $durationWatch = [Diagnostics.Stopwatch]::StartNew()
  $referenceRoot = [IO.Path]::GetFullPath([string]$Plan.referenceRoot)
  $destinationRoot = [IO.Path]::GetFullPath([string]$Plan.destinationRoot)
  Assert-SquidRunCondition ([int]$Plan.protectedMutationCount -eq 0) "Refusing sync plan that targets the protected path: $($Plan.protectedRelativePath)"
  Assert-SquidRunCondition ([int]$Plan.protectedDirectoryMutationCount -eq 0) "Refusing sync plan that targets a protected parent directory: $($Plan.protectedRelativePath)"
  Assert-SquidRunCondition ([int]$Plan.protectedPathStateConflictCount -eq 0) "Refusing sync plan whose protected path is not a file in both trees: $($Plan.protectedRelativePath)"
  Assert-SquidRunTreeHasNoReparsePoints -Root $referenceRoot
  Assert-SquidRunTreeHasNoReparsePoints -Root $destinationRoot
  if ($null -eq $ProgressState) {
    $ProgressState = [ordered]@{}
  }
  $ProgressState.stage = 'starting'
  $ProgressState.startedAtUtc = $startedAt.ToString('o')
  $ProgressState.createDirectories = 0
  $ProgressState.copyMissing = 0
  $ProgressState.replaceDifferent = 0
  $ProgressState.deleteExtraFiles = 0
  $ProgressState.deleteExtraDirectories = 0
  $ProgressState.atomicCommits = 0
  $ProgressState.lastRelativePath = $null
  $ProgressState.completedActions = [Collections.Generic.List[object]]::new()

  $reportProgress = {
    param([string]$Stage, [string]$RelativePath)
    $ProgressState.stage = $Stage
    $ProgressState.lastRelativePath = $RelativePath
    $ProgressState.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
    [void]$ProgressState.completedActions.Add([pscustomobject]@{
      stage = $Stage
      relativePath = $RelativePath
      completedAtUtc = $ProgressState.updatedAtUtc
    })
    if ($ProgressCallback) {
      & $ProgressCallback $ProgressState
    }
  }

  Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'sync_start' -RelativePath ''

  # Remove planned extras first so reference file/directory type changes can be
  # reconciled. Every file is hash-bound and every directory must be empty;
  # unexpected post-plan content aborts rather than being recursively removed.
  foreach ($action in @($Plan.deleteExtraFiles)) {
    Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'before_extra_file_delete' -RelativePath $action.relativePath
    Assert-SquidRunPathWithin -Candidate $action.destination -AllowedRoot $destinationRoot
    Assert-SquidRunCondition (Test-Path -LiteralPath $action.destination -PathType Leaf) "Extra file disappeared after planning: $($action.relativePath)"
    Assert-SquidRunCondition ((Get-SquidRunSha256 -LiteralPath $action.destination) -eq $action.destinationSha256Before) "Extra file changed after planning: $($action.relativePath)"
    Remove-Item -LiteralPath $action.destination -Force
    $ProgressState.deleteExtraFiles++
    & $reportProgress 'extra_file_deleted' $action.relativePath
  }

  foreach ($action in @($Plan.deleteExtraDirectories)) {
    Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'before_extra_directory_delete' -RelativePath $action.relativePath
    Assert-SquidRunPathWithin -Candidate $action.destination -AllowedRoot $destinationRoot
    Assert-SquidRunCondition (Test-Path -LiteralPath $action.destination -PathType Container) "Extra directory disappeared after planning: $($action.relativePath)"
    $unexpectedChildren = @(Get-ChildItem -LiteralPath $action.destination -Force | Select-Object -First 1)
    Assert-SquidRunCondition ($unexpectedChildren.Count -eq 0) "Extra directory contains unplanned content after planned file deletions: $($action.relativePath)"
    [IO.Directory]::Delete([string]$action.destination, $false)
    $ProgressState.deleteExtraDirectories++
    & $reportProgress 'extra_directory_deleted' $action.relativePath
  }

  foreach ($action in @($Plan.createDirectories)) {
    Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'before_directory_create' -RelativePath $action.relativePath
    Assert-SquidRunPathWithin -Candidate $action.destination -AllowedRoot $destinationRoot
    Assert-SquidRunCondition (-not (Test-Path -LiteralPath $action.destination)) "Missing directory appeared after planning: $($action.relativePath)"
    [void][IO.Directory]::CreateDirectory($action.destination)
    $ProgressState.createDirectories++
    & $reportProgress 'directory_created' $action.relativePath
  }

  foreach ($action in @($Plan.copyMissing)) {
    $copyArguments = @{
      Source = $action.source
      Destination = $action.destination
      SourceAllowedRoot = $referenceRoot
      AllowedRoot = $destinationRoot
      RelativePath = $action.relativePath
      ExpectedSourceSha256 = $action.sourceSha256
      DestinationMustBeMissing = $true
      QuietGuard = $QuietGuard
    }
    Copy-SquidRunFileAtomically @copyArguments
    $ProgressState.copyMissing++
    $ProgressState.atomicCommits++
    & $reportProgress 'missing_file_committed' $action.relativePath
    Assert-SquidRunCondition ((Get-SquidRunSha256 -LiteralPath $action.destination) -eq $action.sourceSha256) "Atomic copy verification failed: $($action.relativePath)"
  }

  foreach ($action in @($Plan.replaceDifferent)) {
    $copyArguments = @{
      Source = $action.source
      Destination = $action.destination
      SourceAllowedRoot = $referenceRoot
      AllowedRoot = $destinationRoot
      RelativePath = $action.relativePath
      ExpectedSourceSha256 = $action.sourceSha256
      ExpectedDestinationSha256 = $action.destinationSha256Before
      QuietGuard = $QuietGuard
    }
    Copy-SquidRunFileAtomically @copyArguments
    $ProgressState.replaceDifferent++
    $ProgressState.atomicCommits++
    & $reportProgress 'replacement_committed' $action.relativePath
    Assert-SquidRunCondition ((Get-SquidRunSha256 -LiteralPath $action.destination) -eq $action.sourceSha256) "Atomic copy verification failed: $($action.relativePath)"
  }

  Invoke-SquidRunQuietGuard -QuietGuard $QuietGuard -Stage 'sync_complete' -RelativePath ''
  $ProgressState.stage = 'complete'
  $ProgressState.completedAtUtc = [DateTime]::UtcNow.ToString('o')
  $ProgressState.durationSeconds = [Math]::Round($durationWatch.Elapsed.TotalSeconds, 3)
  if ($ProgressCallback) {
    & $ProgressCallback $ProgressState
  }
  return [pscustomobject]$ProgressState
}

Export-ModuleMember -Function @(
  'Assert-SquidRunCondition',
  'Get-SquidRunSha256',
  'Get-SquidRunTextSha256',
  'Get-SquidRunNormalizedTextSha256',
  'Get-SquidRunRelativePath',
  'Assert-SquidRunPathWithin',
  'Assert-SquidRunTreeHasNoReparsePoints',
  'Get-SquidRunFileMap',
  'Get-SquidRunDirectorySet',
  'New-SquidRunDependencySyncPlan',
  'Invoke-SquidRunDependencySyncPlan'
)

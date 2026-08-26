$ErrorActionPreference = "Stop"

function Get-LogRoot {
    if ($env:SQUIDRUN_CODEX_HOOK_TEST_LOG_ROOT) {
        return $env:SQUIDRUN_CODEX_HOOK_TEST_LOG_ROOT
    }
    return Join-Path $HOME ".codex\log"
}

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-StateFile([string]$Cwd) {
    $profile = [string]$env:SQUIDRUN_PROFILE
    $role = [string]$env:SQUIDRUN_ROLE
    $paneId = [string]$env:SQUIDRUN_PANE_ID
    $presentCount = @($profile, $role, $paneId).Where({ -not [string]::IsNullOrWhiteSpace($_) }).Count
    if ($presentCount -ne 0 -and $presentCount -ne 3) {
        return $null
    }

    $keyMaterial = $Cwd
    if ($presentCount -eq 3) {
        $profile = $profile.Trim().ToLowerInvariant()
        $role = $role.Trim().ToLowerInvariant()
        $paneId = $paneId.Trim().ToLowerInvariant()
        if ($profile -notmatch '^[a-z0-9_-]+$' -or
            $role -notmatch '^[a-z0-9_-]+$' -or
            $paneId -notmatch '^[a-z0-9_-]+$') {
            return $null
        }
        try {
            $normalizedCwd = [System.IO.Path]::GetFullPath($Cwd).TrimEnd('\', '/').ToLowerInvariant()
        } catch {
            return $null
        }
        $keyMaterial = "squidrun-seat-v1`n$normalizedCwd`nprofile=$profile`nrole=$role`npane=$paneId"
    }

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($keyMaterial)
        $hash = $sha.ComputeHash($bytes)
        $name = ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
        return Join-Path (Join-Path (Get-LogRoot) "hook-state") "$name.json"
    } finally {
        $sha.Dispose()
    }
}

Ensure-Directory (Get-LogRoot)
Ensure-Directory (Join-Path (Get-LogRoot) "hook-state")

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) {
    exit 0
}

$inputObject = $raw | ConvertFrom-Json
$timestamp = [DateTimeOffset]::UtcNow.ToString("o")
$auditPath = Join-Path (Get-LogRoot) "codex-hooks-audit.jsonl"

$auditEntry = [ordered]@{
    ts = $timestamp
    event = "SessionStart"
    session_id = $inputObject.session_id
    cwd = $inputObject.cwd
    transcript_path = $inputObject.transcript_path
    model = $inputObject.model
    permission_mode = $inputObject.permission_mode
    source = $inputObject.source
} | ConvertTo-Json -Compress

Add-Content -Path $auditPath -Value $auditEntry

# SQUIDRUN_CODEX_PANE_SESSION_BINDER_BEGIN
# The existing trusted SessionStart command stays unchanged. Only SquidRun
# panes with a complete runtime identity may call the repo-owned binder.
try {
    $squidRunRoot = $env:SQUIDRUN_PROJECT_ROOT
    if ($env:SQUIDRUN_CODEX_HOOK_TEST_DISABLE_BINDER -ne '1' -and
        $squidRunRoot -and $env:SQUIDRUN_PANE_ID -and $env:SQUIDRUN_ROLE) {
        $binder = Join-Path $squidRunRoot "ui\scripts\hm-codex-pane-session.js"
        if (Test-Path -LiteralPath $binder -PathType Leaf) {
            $binderInput = $inputObject | ConvertTo-Json -Compress -Depth 8
            $binderInput | & node $binder capture | Out-Null
        }
    }
} catch {
    $binderFailure = [ordered]@{
        ts = [DateTimeOffset]::UtcNow.ToString("o")
        event = "SquidRunCodexPaneBindingFailure"
        pane_id = $env:SQUIDRUN_PANE_ID
        reason = $_.Exception.Message
    } | ConvertTo-Json -Compress
    Add-Content -Path $auditPath -Value $binderFailure
}
# SQUIDRUN_CODEX_PANE_SESSION_BINDER_END

$stateFile = Get-StateFile -Cwd $inputObject.cwd
if ([string]::IsNullOrWhiteSpace($stateFile) -or -not (Test-Path $stateFile)) {
    exit 0
}

try {
    $state = Get-Content -Raw $stateFile | ConvertFrom-Json
} catch {
    exit 0
}

if (-not $state) {
    exit 0
}

$parts = @()
if ($state.last_seen_at) {
    $parts += "Previous Codex turn in this workspace ended at $($state.last_seen_at)."
}
if ($state.last_assistant_message) {
    $parts += "Last assistant summary: $($state.last_assistant_message)"
}
if ($state.last_transcript_path) {
    $parts += "Transcript: $($state.last_transcript_path)"
}

if ($parts.Count -gt 0) {
    [Console]::Out.WriteLine(($parts -join " "))
}

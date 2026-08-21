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
    event = "Stop"
    session_id = $inputObject.session_id
    cwd = $inputObject.cwd
    transcript_path = $inputObject.transcript_path
    model = $inputObject.model
    permission_mode = $inputObject.permission_mode
    stop_hook_active = $inputObject.stop_hook_active
    last_assistant_message = $inputObject.last_assistant_message
} | ConvertTo-Json -Compress

Add-Content -Path $auditPath -Value $auditEntry

$stateFile = Get-StateFile -Cwd $inputObject.cwd
if ([string]::IsNullOrWhiteSpace($stateFile)) {
    [Console]::Out.WriteLine('{"continue":true}')
    exit 0
}

$state = [ordered]@{
    last_seen_at = $timestamp
    cwd = $inputObject.cwd
    last_transcript_path = $inputObject.transcript_path
    last_assistant_message = $inputObject.last_assistant_message
    model = $inputObject.model
    permission_mode = $inputObject.permission_mode
    squidrun_profile = $env:SQUIDRUN_PROFILE
    squidrun_role = $env:SQUIDRUN_ROLE
    squidrun_pane_id = $env:SQUIDRUN_PANE_ID
}

$state | ConvertTo-Json | Set-Content -Path $stateFile

[Console]::Out.WriteLine('{"continue":true}')

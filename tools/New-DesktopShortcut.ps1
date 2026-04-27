param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string]$TargetPath,

    [string]$Arguments = "",
    [string]$WorkingDirectory = "",
    [string]$IconLocation = ""
)

$desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop)) {
    throw "Could not resolve the real Windows Desktop path."
}

if (-not $Name.EndsWith('.lnk', [StringComparison]::OrdinalIgnoreCase)) {
    $Name = "$Name.lnk"
}

if (-not (Test-Path -LiteralPath $TargetPath) -and $TargetPath -ne "$env:WINDIR\explorer.exe") {
    throw "Shortcut target does not exist: $TargetPath"
}

$shortcutPath = Join-Path $desktop $Name
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $TargetPath
$shortcut.Arguments = $Arguments

if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $WorkingDirectory = Split-Path -Parent $TargetPath
}
$shortcut.WorkingDirectory = $WorkingDirectory

if (-not [string]::IsNullOrWhiteSpace($IconLocation)) {
    $shortcut.IconLocation = $IconLocation
}

$shortcut.Save()
Write-Output $shortcutPath

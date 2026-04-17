param(
    [string]$DesktopPath = [Environment]::GetFolderPath('Desktop')
)

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
$launcherPath = Join-Path $scriptRoot 'launch-eunbyeol.ps1'
$iconPath = Join-Path $repoRoot 'ui\assets\squidrun-favicon.ico'
$shortcutPath = Join-Path $DesktopPath 'SquidRun - 은별.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherPath`""
$shortcut.WorkingDirectory = Join-Path $repoRoot 'ui'
$shortcut.IconLocation = $iconPath
$shortcut.Description = 'Launch the Eunbyeol SquidRun profile.'
$shortcut.Save()

Write-Output $shortcutPath

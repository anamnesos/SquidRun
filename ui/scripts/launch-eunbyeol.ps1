param(
    [switch]$Wait
)

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
$uiRoot = Join-Path $repoRoot 'ui'

$packagedCandidates = @(
    (Join-Path $uiRoot 'dist\win-unpacked\SquidRun.exe'),
    (Join-Path $uiRoot 'dist\SquidRun.exe')
)

$launchFilePath = $null
$launchArgs = @()
$workingDirectory = $uiRoot

foreach ($candidate in $packagedCandidates) {
    if (Test-Path $candidate) {
        $launchFilePath = $candidate
        $launchArgs = @('--profile=eunbyeol')
        $workingDirectory = Split-Path -Parent $candidate
        break
    }
}

if (-not $launchFilePath) {
    $npmCommand = Get-Command npm.cmd -ErrorAction Stop
    $launchFilePath = $npmCommand.Source
    $launchArgs = @('start', '--', '--profile=eunbyeol')
}

$process = Start-Process -FilePath $launchFilePath `
    -ArgumentList $launchArgs `
    -WorkingDirectory $workingDirectory `
    -PassThru

if ($Wait) {
    $process.WaitForExit()
    exit $process.ExitCode
}

# hm-screenshot-window.ps1
# Captures just the SquidRun window using DPI-aware DWM extended frame bounds.
# Usage: powershell -File hm-screenshot-window.ps1 [-OutPath path\to\output.png]

param(
    [string]$OutPath = ""
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class ScreenCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    // DPI awareness — MUST call before any window measurements
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    // DWMWA_EXTENDED_FRAME_BOUNDS = 9
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, uint dwRop);
}
"@

# Set DPI awareness FIRST — before any coordinate queries
[ScreenCapture]::SetProcessDPIAware() | Out-Null
Write-Host "DPI awareness set"

# Find SquidRun window
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*SquidRun*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1

if (-not $proc) {
    Write-Error "No SquidRun window found"
    exit 1
}

$hwnd = $proc.MainWindowHandle
Write-Host "Found: $($proc.MainWindowTitle) (PID $($proc.Id), HWND $hwnd)"

# Try DWM extended frame bounds first
$rect = New-Object ScreenCapture+RECT
$hr = [ScreenCapture]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf($rect))

if ($hr -ne 0) {
    Write-Host "DWM failed (hr=$hr), falling back to GetWindowRect"
    [ScreenCapture]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
}

$width  = $rect.Right  - $rect.Left
$height = $rect.Bottom - $rect.Top

Write-Host "Window bounds: L=$($rect.Left) T=$($rect.Top) R=$($rect.Right) B=$($rect.Bottom) => ${width}x${height}"

if ($width -le 0 -or $height -le 0) {
    Write-Error "Invalid window dimensions: ${width}x${height}"
    exit 1
}

# Method 1: Try PrintWindow (captures the window's own rendering, even if occluded)
$bmp = New-Object System.Drawing.Bitmap($width, $height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)

# PW_RENDERFULLCONTENT = 2 — forces full render including child windows
$success = [ScreenCapture]::PrintWindow($hwnd, $gfx.GetHdc(), 2)
$gfx.ReleaseHdc()

if (-not $success) {
    Write-Host "PrintWindow failed, falling back to CopyFromScreen"
    $gfx.Dispose()
    $bmp.Dispose()
    $bmp = New-Object System.Drawing.Bitmap($width, $height)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
}

$gfx.Dispose()

# Output path
if (-not $OutPath) {
    $OutPath = Join-Path $PSScriptRoot "..\..\workspace\screenshots\latest.png"
}
$OutPath = [System.IO.Path]::GetFullPath($OutPath)

$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "Saved: $OutPath (${width}x${height})"

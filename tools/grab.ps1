# ============================================================================
#  桌面实拍：直接抓屏（本机 GDI 能拍到分层窗口，所以不需要自拍+合成的两步走）。
#  用法： pwsh -File tools/grab.ps1 -X 2400 -Y 700 -W 480 -H 320 -Out docs/preview.png
# ============================================================================
param(
    [int]$X, [int]$Y, [int]$W, [int]$H,
    [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
Add-Type -Namespace Grab -Name Dpi -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
'@
[void][Grab.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-2))
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$sw = [Grab.Dpi]::GetSystemMetrics(0)
$sh = [Grab.Dpi]::GetSystemMetrics(1)

if ($W -le 0) { $W = $sw - $X }
if ($H -le 0) { $H = $sh - $Y }
$X = [Math]::Max(0, [Math]::Min($X, $sw - 1))
$Y = [Math]::Max(0, [Math]::Min($Y, $sh - 1))
$W = [Math]::Min($W, $sw - $X)
$H = [Math]::Min($H, $sh - $Y)

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))
$g.Dispose()

$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }
$dir = Split-Path -Parent $outPath
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "grabbed ($X,$Y) ${W}x${H} -> $outPath"

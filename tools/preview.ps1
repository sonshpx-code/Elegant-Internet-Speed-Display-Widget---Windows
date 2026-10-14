# ============================================================================
#  把窗口自拍合成到真实桌面上，得到“用户实际看到的样子”。
#
#  为什么需要它：组件是逐像素透明的分层窗口，GDI 的 BitBlt（CopyFromScreen）
#  **不会**合成它 —— 抓屏只能拍到它背后的东西。所以窗口自己拍（--net-snapshot），
#  再由这个脚本按窗口真实位置贴回桌面截图里。
#
#  用法： pwsh -File tools/preview.ps1 -Shot docs/shot-01.png -Out docs/preview.png
# ============================================================================
param(
    [Parameter(Mandatory = $true)][string]$Shot,
    [string]$Out = '',
    [int]$PadX = 260,
    [int]$PadTop = 150,
    [int]$PadBottom = 130,
    [int]$PrefsScale = 0,          # 0 = 自动按 2 倍（本机 200% 缩放）
    [int]$X = -1,                  # 覆盖粘贴位置（物理像素）；-1 = 读 prefs
    [int]$Y = -1,
    [switch]$Checkerboard
)

$ErrorActionPreference = 'Stop'
Add-Type -Namespace Preview -Name Dpi -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
'@
[void][Preview.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-2))

Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$shotPath = if ([System.IO.Path]::IsPathRooted($Shot)) { $Shot } else { Join-Path $root $Shot }
if (-not (Test-Path $shotPath)) { throw "找不到自拍文件 $shotPath" }

$prefsFile = Join-Path $root 'hud-app\.state\prefs.json'
$prefs = if (Test-Path $prefsFile) { Get-Content $prefsFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }

$scale = if ($PrefsScale -gt 0) { $PrefsScale } else { 2 }
$screenW = [Preview.Dpi]::GetSystemMetrics(0)
$screenH = [Preview.Dpi]::GetSystemMetrics(1)

$img = [System.Drawing.Image]::FromFile($shotPath)
$winW = $img.Width
$winH = $img.Height
# 窗口默认贴右边缘、靠下（与 main.js 的 defaultAnchor 一致）
$x = if ($X -ge 0) { $X } elseif ($prefs -and $null -ne $prefs.x) { [int]$prefs.x * $scale } else { $screenW - $winW }
$y = if ($Y -ge 0) { $Y } elseif ($prefs -and $null -ne $prefs.y) { [int]$prefs.y * $scale } else { $screenH - 96 - $winH - 56 }

$x0 = [Math]::Max(0, $x - $PadX)
$y0 = [Math]::Max(0, $y - $PadTop)
$x1 = [Math]::Min($screenW, $x + $winW + (2 * $PadX))
$y1 = [Math]::Min($screenH, $y + $winH + $PadBottom)
$w = $x1 - $x0
$h = $y1 - $y0

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

if ($Checkerboard) {
    # 透明区域用棋盘格显示（检查卡片之外确实什么都没画）
    $cell = 8
    $light = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 58, 58, 58))
    $dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 40, 40, 40))
    for ($cy = 0; $cy -lt $h; $cy += $cell) {
        for ($cx = 0; $cx -lt $w; $cx += $cell) {
            $brush = if ((($cx / $cell) + ($cy / $cell)) % 2 -eq 0) { $light } else { $dark }
            $g.FillRectangle($brush, $cx, $cy, $cell, $cell)
        }
    }
    $light.Dispose(); $dark.Dispose()
} else {
    $g.CopyFromScreen($x0, $y0, 0, 0, (New-Object System.Drawing.Size($w, $h)))
}

$g.DrawImage($img, ($x - $x0), ($y - $y0), $winW, $winH)
$g.Dispose()

$outPath = if ($Out -ne '') { if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out } } else { [System.IO.Path]::ChangeExtension($shotPath, '.preview.png') }
$dir = Split-Path -Parent $outPath
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$img.Dispose()

Write-Host "window  : ${winW}x${winH} at (${x},${y})"
Write-Host "region  : (${x0},${y0})-(${x1},${y1})"
Write-Host "preview : $outPath"

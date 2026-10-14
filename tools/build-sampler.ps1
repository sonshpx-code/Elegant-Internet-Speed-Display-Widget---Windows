# ============================================================================
#  编译网速采样器 —— 只用 Windows 自带的 .NET Framework 编译器（无需 VS / SDK）
#  用法： pwsh -File tools/build-sampler.ps1        （或 powershell -File ...）
#  产物： hud-app/bin/netspeed-sampler.exe
# ============================================================================
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$src = Join-Path $root 'hud-app\src\netspeed-sampler.cs'
$bin = Join-Path $root 'hud-app\bin'
$out = Join-Path $bin 'netspeed-sampler.exe'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw '找不到 csc.exe（需要 .NET Framework 4.x，Win10/11 自带）' }
if (-not (Test-Path $src)) { throw "找不到源码 $src" }

New-Item -ItemType Directory -Force -Path $bin | Out-Null

Write-Host "编译器: $csc"
& $csc /nologo /target:exe /optimize+ /platform:anycpu /codepage:65001 `
    /r:System.dll "/out:$out" $src

if ($LASTEXITCODE -ne 0) { throw "编译失败 (exit $LASTEXITCODE)" }

# 负向对照用的假采样器（输出恒定值，用来断言“数值没变就不写 DOM”）
$fakeSrc = Join-Path $root 'tools\fake-sampler.cs'
$fakeOut = Join-Path $bin 'fake-sampler.exe'
if (Test-Path $fakeSrc) {
    & $csc /nologo /target:exe /optimize+ /platform:anycpu /codepage:65001 `
        /r:System.dll "/out:$fakeOut" $fakeSrc
    if ($LASTEXITCODE -ne 0) { throw "假采样器编译失败 (exit $LASTEXITCODE)" }
}

# 常驻看门狗：编成 winexe（没有控制台窗口），它负责启动并监管窗口进程
$wdSrc = Join-Path $root 'hud-app\src\net-hud-watchdog.cs'
$wdOut = Join-Path $bin 'net-hud-watchdog.exe'
if (Test-Path $wdSrc) {
    & $csc /nologo /target:winexe /optimize+ /platform:anycpu /codepage:65001 `
        /r:System.dll "/out:$wdOut" $wdSrc
    if ($LASTEXITCODE -ne 0) { throw "看门狗编译失败 (exit $LASTEXITCODE)" }
}

# 自检：跑一次 --once，确认能吐出合法 JSON
$probe = & $out --once 2>&1
Write-Host "自检输出: $probe"
if ($probe -notmatch '^\s*\{"ts":') { throw '采样器自检失败：输出不是预期 JSON' }

Get-Item $out | Select-Object FullName, Length, LastWriteTime | Format-List

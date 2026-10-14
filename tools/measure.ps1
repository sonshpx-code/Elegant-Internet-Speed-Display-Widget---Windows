# ============================================================================
#  占用实测：网速悬浮组件到底吃多少 CPU 和内存
#
#  用法： pwsh -File tools/measure.ps1 [-Seconds 60]
#
#  口径说明（这两条比数字本身重要）：
#   · CPU 用 **CPU 秒 / 每分钟**：把一行里所有相关进程的 TotalProcessorTime 加起来，
#     除以实测的墙钟时间。它和 CPU 核心数无关，也不会因为机器忙就被“摊薄”，
#     比任务管理器里那个百分比诚实。
#   · 内存用 **私有工作集**（PrivateWorkingSet），不是 WorkingSet：后者把共享的
#     Chromium 代码页也算进每个进程，四个进程加起来会重复计算同一份。
# ============================================================================
param(
    [int]$Seconds = 60,
    [string]$AppDir = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
if ($AppDir -eq '') { $AppDir = Join-Path $root 'hud-app' }

function Get-HudProcesses {
    $picked = @()
    # 窗口：按命令行匹配（electron.exe 可能是别的程序的）
    $picked += Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$AppDir*" }
    $picked += Get-CimInstance Win32_Process -Filter "Name='netspeed-sampler.exe'" -ErrorAction SilentlyContinue
    $picked += Get-CimInstance Win32_Process -Filter "Name='net-hud-watchdog.exe'" -ErrorAction SilentlyContinue
    return $picked
}

function Snapshot {
    $rows = @()
    foreach ($item in Get-HudProcesses) {
        $proc = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $proc) { continue }
        $rows += [pscustomobject]@{
            Pid      = $proc.Id
            Name     = $proc.ProcessName
            CpuMs    = [math]::Round($proc.TotalProcessorTime.TotalMilliseconds)
            PrivateMB = [math]::Round($proc.PrivateMemorySize64 / 1MB, 1)
            WorkingMB = [math]::Round($proc.WorkingSet64 / 1MB, 1)
        }
    }
    return $rows
}

$before = Snapshot
if ($before.Count -eq 0) { throw "没找到任何组件进程（$AppDir）——先把它启动起来再测" }
$t0 = Get-Date
Write-Host "采样 $Seconds 秒…（进程 $($before.Count) 个）"
Start-Sleep -Seconds $Seconds
$elapsed = ((Get-Date) - $t0).TotalSeconds
$after = Snapshot

$cpuBefore = ($before | Measure-Object -Property CpuMs -Sum).Sum
$cpuAfter = ($after | Measure-Object -Property CpuMs -Sum).Sum
$cpuDelta = ($cpuAfter - $cpuBefore) / 1000
$pct = if ($elapsed -gt 0) { [math]::Round(100 * $cpuDelta / $elapsed, 2) } else { 0 }

Write-Host ''
Write-Host ("CPU  ：{0:N2} CPU 秒 / {1:N0} 秒  =  单核 {2}%" -f $cpuDelta, $elapsed, $pct)
Write-Host ("内存 ：私有 {0:N1} MB   工作集 {1:N1} MB   进程 {2} 个" -f `
    (($after | Measure-Object -Property PrivateMB -Sum).Sum), `
    (($after | Measure-Object -Property WorkingMB -Sum).Sum), `
    $after.Count)
Write-Host ''
$after | Sort-Object -Property PrivateMB -Descending |
    Format-Table Name, Pid, @{ n = 'CPU秒/分'; e = { [math]::Round($_.CpuMs / 1000 / $elapsed * 60, 2) } }, PrivateMB, WorkingMB -AutoSize

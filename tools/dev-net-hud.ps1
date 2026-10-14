# ============================================================================
#  开发/验证用启动器：直接用 Electron 跑窗口，不经过 DSH。
#
#  用法：
#    pwsh -File tools/dev-net-hud.ps1                     # 起一个窗口（前台日志到控制台）
#    pwsh -File tools/dev-net-hud.ps1 -Shot out.png       # 自拍一张后退出
#    pwsh -File tools/dev-net-hud.ps1 -Shot out.png -Delay 7000
#    pwsh -File tools/dev-net-hud.ps1 -Kill               # 杀掉所有窗口进程
#    pwsh -File tools/dev-net-hud.ps1 -StateDir .state-alt
#
#  两条平台约束（都是踩出来的）：
#   · ELECTRON_RUN_AS_NODE 必须从子进程环境里删掉 —— DSH 宿主自己就是 Electron 的
#     Node 模式，环境里带着它，继承下去窗口会以纯 Node 启动并立刻死在 require('electron')。
#   · 不能用管道继承 stdio 启动（& $electron 那种），渲染进程的 fetch/加载会失败；
#     一律走 Start-Process 并把输出重定向到文件。
# ============================================================================
param(
    [string]$StateDir = '',
    [string]$Shot = '',
    [int]$Delay = 1500,
    [string]$EvalFile = '',
    [int]$EvalDelay = 3000,
    [string]$Sampler = '',
    [string]$Theme = '',
    [string]$Unit = '',
    [double]$Scale = 0,
    [switch]$Kill
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$appDir = Join-Path $root 'hud-app'

function Get-ElectronPath {
    $candidates = @(
        (Join-Path $appDir 'node_modules\electron\dist\electron.exe'),
        (Join-Path $root '..\dsh-status-hud\hud-app\node_modules\electron\dist\electron.exe'),
        (Join-Path $env:USERPROFILE '.dsh\status-hud\hud-app\node_modules\electron\dist\electron.exe')
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
    throw '找不到 electron.exe：先在 hud-app 里 pnpm install，或用 -Electron 指定路径'
}

if ($Kill) {
    # 先停常驻看门狗，否则它会在开发实例被杀的瞬间把窗口又拉起来
    Get-Process net-hud-watchdog -ErrorAction SilentlyContinue |
        ForEach-Object { "kill watchdog pid=$($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    # 按命令行匹配：electron.exe 可能来自兄弟项目，只看 Path 会误杀状态组件
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$appDir*" } |
        ForEach-Object { "kill pid=$($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-Process netspeed-sampler -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    return
}

$state = if ($StateDir -ne '') { Join-Path $root $StateDir } else { Join-Path $appDir '.state' }
$electron = Get-ElectronPath
New-Item -ItemType Directory -Force -Path $state | Out-Null

# 需要临时改偏好（主题/单位/缩放）时，先写进 state 里的 prefs.json
if ($Theme -ne '' -or $Unit -ne '' -or $Scale -gt 0) {
    $prefsFile = Join-Path $state 'prefs.json'
    $prefs = if (Test-Path $prefsFile) { Get-Content $prefsFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
    if ($Theme -ne '') { $prefs | Add-Member -NotePropertyName theme -NotePropertyValue $Theme -Force }
    if ($Unit -ne '') { $prefs | Add-Member -NotePropertyName unit -NotePropertyValue $Unit -Force }
    if ($Scale -gt 0) { $prefs | Add-Member -NotePropertyName scale -NotePropertyValue $Scale -Force }
    $json = $prefs | ConvertTo-Json
    [System.IO.File]::WriteAllText($prefsFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "prefs    : theme=$Theme unit=$Unit scale=$Scale"
}

$samplerPath = if ($Sampler -ne '') { Join-Path $appDir $Sampler } else { Join-Path $appDir 'bin\netspeed-sampler.exe' }

$stdout = Join-Path $state 'dev-stdout.log'
$stderr = Join-Path $state 'dev-stderr.log'

# 关键：删掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会以纯 Node 模式启动
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$args = @(
    '--no-sandbox',
    "--user-data-dir=$(Join-Path $state 'chromium')",
    "--disk-cache-dir=$(Join-Path $state 'cache')",
    "--crash-dumps-dir=$(Join-Path $state 'crash')",
    "--net-state-dir=$state",
    "--net-sampler=$samplerPath"
)
if ($Shot -ne '') {
    $shotPath = if ([System.IO.Path]::IsPathRooted($Shot)) { $Shot } else { Join-Path $root $Shot }
    $args += "--net-snapshot=$shotPath"
    $args += "--net-snapshot-delay=$Delay"
}
if ($EvalFile -ne '') {
    $evalPath = if ([System.IO.Path]::IsPathRooted($EvalFile)) { $EvalFile } else { Join-Path $root $EvalFile }
    $args += "--net-eval-file=$evalPath"
    $args += "--net-eval-delay=$EvalDelay"
    $args += '--net-eval-keep'
}
# 常驻实例通常正握着单实例锁；开发实例是“另一个 state 目录的第二份”，要显式放行
$args += '--net-allow-multi=1'
$args += $appDir

Write-Host "electron : $electron"
Write-Host "app      : $appDir"
Write-Host "state    : $state"
if ($Shot -ne '') { Write-Host "snapshot : $Shot (delay ${Delay}ms)" }

$proc = Start-Process -FilePath $electron -ArgumentList $args -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr

if ($Shot -ne '') {
    # 自拍模式：窗口拍完会自己退出；卡住就杀掉，别让脚本悬在那里
    $deadline = (Get-Date).AddSeconds(45)
    while (-not $proc.HasExited -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        $proc.Refresh()
    }
    if (-not $proc.HasExited) {
        Write-Host 'snapshot did not finish in 45s; killing'
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "running in background: pid=$($proc.Id)  (用 -Kill 结束)"
}

if (Test-Path $stderr) {
    $err = Get-Content $stderr -Raw -Encoding UTF8
    if ($err -and $err.Trim() -ne '') { Write-Host "--- stderr ---"; Write-Host $err }
}
$log = Join-Path $state 'net-hud-app.log'
if (Test-Path $log) {
    Write-Host '--- net-hud-app.log (tail 25) ---'
    Get-Content $log -Encoding UTF8 -Tail 25
}
if ($Shot -ne '') {
    $shotPath = if ([System.IO.Path]::IsPathRooted($Shot)) { $Shot } else { Join-Path $root $Shot }
    if (Test-Path $shotPath) {
        $item = Get-Item $shotPath
        Write-Host "snapshot ok: $($item.FullName)  $([math]::Round($item.Length/1KB,1)) KB"
    } else {
        Write-Host 'snapshot MISSING'
    }
}

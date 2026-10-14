# ============================================================================
#  dsh-net-hud 安装脚本
#
#    pwsh -File tools/setup.ps1                  # 只写插件配置（~/.dsh/net-hud/plugin.json）
#    pwsh -File tools/setup.ps1 -RegisterBundle  # 同时把 bundle 挂进 desktop profile（改 2 处 + 一个 Junction）
#    pwsh -File tools/setup.ps1 -Status          # 看看现在装到哪一步了
#    pwsh -File tools/setup.ps1 -Unregister      # 从 desktop profile 摘掉（有备份就还原）
#
#  为什么可以直接改文件：desktop 是 **live 配置**，改完即时生效、不需要重启 DSH。
#  改动前一定先备份 package.json —— 装错了要能一条命令退回来。
# ============================================================================
param(
    [switch]$RegisterBundle,
    [switch]$Unregister,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$appDir = Join-Path $root 'hud-app'
$configDir = Join-Path $env:USERPROFILE '.dsh\net-hud'
$configFile = Join-Path $configDir 'plugin.json'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$profilePkg = Join-Path $profileDir 'package.json'
$junction = Join-Path $profileDir 'node_modules\dsh-net-hud'
$bundleName = 'dsh-net-hud'

function Get-ElectronPath {
    $candidates = @(
        (Join-Path $appDir 'node_modules\electron\dist\electron.exe'),
        (Join-Path $root '..\dsh-status-hud\hud-app\node_modules\electron\dist\electron.exe'),
        (Join-Path $env:USERPROFILE '.dsh\status-hud\hud-app\node_modules\electron\dist\electron.exe')
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
    return $null
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    # 必须无 BOM：宿主用 JSON.parse 读它，BOM 会让整份配置静默退回默认值
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Show-Status {
    Write-Host "仓库        : $root"
    Write-Host "窗口应用    : $appDir  (main.js: $(Test-Path (Join-Path $appDir 'main.js')))"
    $el = Get-ElectronPath
    Write-Host "electron    : $(if ($el) { $el } else { '未找到（先在 hud-app 里 pnpm install）' })"
    Write-Host "采样器      : $(Test-Path (Join-Path $appDir 'bin\netspeed-sampler.exe'))"
    Write-Host "插件配置    : $configFile  ($(Test-Path $configFile))"
    if (Test-Path $profilePkg) {
        $pkg = Get-Content $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
        $inBundles = @($pkg.dsh.profile.bundles) -contains $bundleName
        $dep = $pkg.dependencies.PSObject.Properties.Name -contains $bundleName
        Write-Host "profile     : bundles 包含=$inBundles  dependencies 包含=$dep"
    }
    $j = Get-Item $junction -ErrorAction SilentlyContinue
    Write-Host "Junction    : $(if ($j) { "$($j.LinkType) -> $($j.Target)" } else { '无' })"
}

if ($Status) { Show-Status; return }

if ($Unregister) {
    if (Test-Path $profilePkg) {
        $backup = Get-ChildItem "$profilePkg.bak-*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        $pkg = Get-Content $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
        $pkg.dependencies.PSObject.Properties.Remove($bundleName)
        $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $bundleName })
        Write-Utf8NoBom $profilePkg ($pkg | ConvertTo-Json -Depth 8)
        $backupNote = if ($backup) { $backup.Name } else { '无' }
        Write-Host "已从 profile 移除 $bundleName （备份保留：$backupNote）"
    }
    if (Test-Path $junction) { (Get-Item $junction).Delete(); Write-Host 'Junction 已删除' }
    return
}

# --- 1. 写插件配置 ---------------------------------------------------------
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$electron = Get-ElectronPath
if (-not (Test-Path (Join-Path $appDir 'main.js'))) { throw "找不到 $appDir\main.js" }
if (-not $electron) { throw '找不到 electron.exe：先在 hud-app 里 pnpm install（约 190MB），或用已装的兄弟项目那份' }
if (-not (Test-Path (Join-Path $appDir 'bin\netspeed-sampler.exe'))) {
    Write-Host '采样器还没编译，正在编译…'
    & (Join-Path $here 'build-sampler.ps1') | Out-Null
}

$config = [ordered]@{
    hudAppDir     = $appDir
    electronPath  = $electron
    stateDir      = (Join-Path $appDir '.state')
    autoLaunch    = $true
    relaunchLimit = 5
    noSandbox     = $true
    stableResetMs = 60000
    debug         = $false
}
Write-Utf8NoBom $configFile ($config | ConvertTo-Json -Depth 4)
Write-Host "已写插件配置: $configFile"

# --- 2. 挂进 desktop profile ----------------------------------------------
if ($RegisterBundle) {
    if (-not (Test-Path $profilePkg)) { throw "找不到 $profilePkg" }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item $profilePkg "$profilePkg.bak-$stamp" -Force
    Write-Host "已备份 profile: package.json.bak-$stamp"

    $pkg = Get-Content $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not ($pkg.dependencies.PSObject.Properties.Name -contains $bundleName)) {
        $pkg.dependencies | Add-Member -NotePropertyName $bundleName -NotePropertyValue "link:$($root -replace '\\', '/')" -Force
    }
    if (-not (@($pkg.dsh.profile.bundles) -contains $bundleName)) {
        $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + $bundleName
    }
    $json = $pkg | ConvertTo-Json -Depth 8
    Write-Utf8NoBom $profilePkg $json

    # 写完立刻回读校验：坏掉的 profile 会让 DSH 起不来，这一步不能省
    $check = Get-Content $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not (@($check.dsh.profile.bundles) -contains $bundleName)) { throw '回读校验失败：bundles 里没有 dsh-net-hud' }
    Write-Host '已注册 bundle 并回读校验通过'

    $nm = Join-Path $profileDir 'node_modules'
    if (-not (Test-Path $nm)) { New-Item -ItemType Directory -Force -Path $nm | Out-Null }
    if (-not (Test-Path $junction)) {
        New-Item -ItemType Junction -Path $junction -Target $root | Out-Null
        Write-Host "已建 Junction: $junction -> $root"
    } else {
        Write-Host 'Junction 已存在'
    }
}

Show-Status

# ============================================================================
#  网速悬浮组件 —— 常驻安装
#
#    pwsh -File tools/install.ps1              # 登录自启 + 现在就起来
#    pwsh -File tools/install.ps1 -Status      # 看装到哪一步、任务什么状态
#    pwsh -File tools/install.ps1 -Stop        # 停下（但不卸载，登录还会起来）
#    pwsh -File tools/install.ps1 -Start
#    pwsh -File tools/install.ps1 -Restart
#    pwsh -File tools/install.ps1 -Uninstall   # 停掉 + 删任务 + 删快捷方式
#
#  为什么用计划任务而不是注册表 Run 键：
#   · 它自带「失败后重启」（失败 1 分钟后重试，最多 3 次）——窗口崩了会自己回来；
#     而用户主动「退出」是退出码 0，任务算成功完成，不会把它拉起来，这才是对语义。
#   · 只在用户登录时运行（交互式），不是会话 0 的服务，窗口能正常显示。
#   · 卸载是一条命令：Unregister-ScheduledTask。
#
#  这一步之后它**不依赖 DSH**：DSH 开不开、装不装，组件都在。
# ============================================================================
param(
    [switch]$Uninstall,
    [switch]$Status,
    [switch]$Start,
    [switch]$Stop,
    [switch]$Restart,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$appDir = Join-Path $root 'hud-app'
$stateDir = Join-Path $appDir '.state'
$taskName = 'NetSpeedHud'
$shortcutName = '网速悬浮组件.lnk'
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$shortcutName"

function Get-ElectronPath {
    $candidates = @(
        (Join-Path $appDir 'node_modules\electron\dist\electron.exe'),                 # 自有（安装时 pnpm install 得到）
        (Join-Path $root '..\dsh-status-hud\hud-app\node_modules\electron\dist\electron.exe'),
        (Join-Path $env:USERPROFILE '.dsh\status-hud\hud-app\node_modules\electron\dist\electron.exe')
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
    return $null
}

function Get-WatchdogPath { Join-Path $appDir 'bin\net-hud-watchdog.exe' }

function Get-WatchdogArgs {
    param([string]$Electron)
    return @(
        "--electron=`"$Electron`"",
        "--app=`"$appDir`"",
        "--state=`"$stateDir`"",
        "--sampler=`"$(Join-Path $appDir 'bin\netspeed-sampler.exe')`""
    ) -join ' '
}

function Get-Args {
    param([string]$Electron)
    $sampler = Join-Path $appDir 'bin\netspeed-sampler.exe'
    return @(
        '--no-sandbox',
        "--user-data-dir=`"$(Join-Path $stateDir 'chromium')`"",
        "--disk-cache-dir=`"$(Join-Path $stateDir 'cache')`"",
        "--crash-dumps-dir=`"$(Join-Path $stateDir 'crash')`"",
        "--net-state-dir=`"$stateDir`"",
        "--net-sampler=`"$sampler`"",
        "`"$appDir`""
    ) -join ' '
}

function Get-HudProcesses {
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$appDir*" }
}

# 启动计划任务前必须先确认它不在 Running 状态。
# 任务是 MultipleInstances=IgnoreNew：进程被外部杀掉后，任务实例有时仍被算作
# “正在运行”，此时 Start-ScheduledTask 会被**静默忽略**——表现就是“命令跑完了，
# 但什么都没起来”。所以先 Stop 再 Start。
function Start-OrRestartTask {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -eq $task) { return }
    if ($task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
    }
    Start-ScheduledTask -TaskName $taskName
    Write-Host '已通过计划任务启动'
}

function Get-WatchdogProcesses {
    Get-CimInstance Win32_Process -Filter "Name='net-hud-watchdog.exe'" -ErrorAction SilentlyContinue
}

function Ensure-Prereqs {
    $sampler = Join-Path $appDir 'bin\netspeed-sampler.exe'
    $watchdog = Get-WatchdogPath
    if (-not (Test-Path $sampler) -or -not (Test-Path $watchdog)) {
        Write-Host '采样器/看门狗还没编译，正在编译…'
        & (Join-Path $here 'build-sampler.ps1') | Out-Null
    }
    if (-not (Test-Path (Join-Path $appDir 'assets\icon.ico'))) {
        Write-Host '图标还没生成，正在生成…'
        & node (Join-Path $here 'make-assets.mjs') | Out-Null
    }
}

function Show-Status {
    $electron = Get-ElectronPath
    Write-Host "仓库        : $root"
    Write-Host "窗口应用    : $appDir"
    Write-Host "electron    : $(if ($electron) { $electron } else { '未找到（在 hud-app 里 pnpm install，再 node node_modules/electron/install.js）' })"
    Write-Host "采样器      : $(Test-Path (Join-Path $appDir 'bin\netspeed-sampler.exe'))"
    Write-Host "看门狗      : $(Test-Path (Get-WatchdogPath))"
    Write-Host "状态目录    : $stateDir"
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $taskName
        $exec = $task.Actions[0].Execute
        Write-Host "计划任务    : 已注册  状态=$($task.State)  上次结果=$($info.LastTaskResult)"
        Write-Host "  动作      : $exec"
    } else {
        Write-Host '计划任务    : 未注册（跑 install.ps1 不带参数即可）'
    }
    Write-Host "开始菜单    : $(Test-Path $startMenu)"
    $wd = @(Get-WatchdogProcesses)
    Write-Host "看门狗      : $($wd.Count) 个$(if ($wd.Count -gt 0) { "（pid=$($wd[0].ProcessId)）" })"
    $procs = @(Get-HudProcesses)
    Write-Host "窗口进程    : $($procs.Count) 个 electron$(if ($procs.Count -gt 0) { "（主进程 pid=$($procs[0].ProcessId)）" })"
    Write-Host "采样器进程  : $(@(Get-Process netspeed-sampler -ErrorAction SilentlyContinue).Count)"
}

if ($Status) { Show-Status; return }

if ($Stop -or $Uninstall -or $Restart) {
    # 先停看门狗，否则它会把窗口又拉起来
    $wd = @(Get-WatchdogProcesses)
    foreach ($p in $wd) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($wd.Count -gt 0) { Write-Host "已停止看门狗 $($wd.Count) 个" }
    $procs = @(Get-HudProcesses)
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($procs.Count -gt 0) { Write-Host "已停止 $($procs.Count) 个窗口进程" }
    # 采样器是窗口主进程的子进程；主进程被强杀时它可能被留下
    Get-Process netspeed-sampler -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "已删除计划任务 $taskName"
    }
    if (Test-Path $startMenu) { Remove-Item $startMenu -Force; Write-Host '已删除开始菜单快捷方式' }
    Write-Host '已卸载。状态目录仍保留（偏好与日志）：' $stateDir
    return
}

if ($Start -or $Restart -or (-not $Uninstall -and -not $Status -and -not $Stop)) {
    if ($Restart -and (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        Start-OrRestartTask
        Show-Status
        return
    }
    if ($Start) {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Start-OrRestartTask
        } else {
            $watchdog = Get-WatchdogPath
            $electron = Get-ElectronPath
            if (-not $electron) { throw '找不到 electron.exe' }
            Start-Process -FilePath $watchdog -ArgumentList (Get-WatchdogArgs -Electron $electron) -WorkingDirectory $appDir
            Write-Host '已直接启动看门狗（没有计划任务）'
        }
        Show-Status
        return
    }

    # --- 安装 ---
    Ensure-Prereqs
    $electron = Get-ElectronPath
    if (-not $electron) { throw '找不到 electron.exe：先在 hud-app 里跑 pnpm install 与 node node_modules/electron/install.js' }
    $watchdog = Get-WatchdogPath

    # 计划任务的动作是**看门狗**，不是 electron：任务计划自己的「失败后重启」对
    # “进程被强杀”并不可靠（实测不会重拉），真正的监管由看门狗负责（实测 2 秒恢复）。
    $action = New-ScheduledTaskAction -Execute $watchdog -Argument (Get-WatchdogArgs -Electron $electron) -WorkingDirectory $appDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Force `
        -Description '常驻桌面网速悬浮组件（登录自启，看门狗监管，异常退出 2 秒内自动恢复）' | Out-Null
    Write-Host "已注册计划任务 $taskName（登录自启 → 看门狗 → 窗口）"

    # 开始菜单快捷方式：指向看门狗，重复启动会被单实例判断挡掉
    try {
        $shellCom = New-Object -ComObject WScript.Shell
        $lnk = $shellCom.CreateShortcut($startMenu)
        $lnk.TargetPath = $watchdog
        $lnk.Arguments = Get-WatchdogArgs -Electron $electron
        $lnk.WorkingDirectory = $appDir
        $lnk.IconLocation = (Join-Path $appDir 'assets\icon.ico')
        $lnk.Description = '网速悬浮组件'
        $lnk.Save()
        Write-Host "已创建开始菜单快捷方式：$shortcutName"
    } catch {
        Write-Host "快捷方式创建失败（不影响常驻）：$($_.Exception.Message)"
    }

    if (-not $NoStart) {
        Start-ScheduledTask -TaskName $taskName
        Start-Sleep -Seconds 3
    }
    Show-Status
}

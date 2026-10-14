# ============================================================================
#  窗口行为探针：读回真实矩形 + 断言“点击不抢焦点”。
#
#  为什么必须从窗口外面测：不抢焦点这条性质在代码里看是看不出来的
#  （focusable:false → WS_EX_NOACTIVATE 只是声明），只有真点一下、
#  再看 GetForegroundWindow() 有没有变，才算数。
#
#  用法：
#    pwsh -File tools/probe-window.ps1            # 真实光标 + 真实点击
#    pwsh -File tools/probe-window.ps1 -Measure   # 不动光标，只报当前矩形与样式
#    pwsh -File tools/probe-window.ps1 -Click     # 只跑点击断言
# ============================================================================
param(
    [switch]$Measure,
    [switch]$Click
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Probe -Name Win -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder sb, int m);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder sb, int m);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
'@

# 不声明 DPI 感知的话，GetWindowRect 会被静默缩放进虚拟坐标空间，
# 而 SetCursorPos 不会 —— 于是探针在一个空间里量矩形、在另一个空间里放光标。
[void][Probe.Win]::SetProcessDpiAwarenessContext([IntPtr](-2))

function Get-HudWindow {
    $NULLS = [NullString]::Value
    $h = [IntPtr]::Zero
    while (($h = [Probe.Win]::FindWindowEx([IntPtr]::Zero, $h, $NULLS, $NULLS)) -ne [IntPtr]::Zero) {
        $sb = New-Object System.Text.StringBuilder 200
        [void][Probe.Win]::GetWindowTextW($h, $sb, 200)
        if ($sb.ToString() -eq '网速悬浮组件') { return $h }   # 按标题精确匹配：其它窗口比卡片大，不能取“最大的那个”
    }
    return [IntPtr]::Zero
}

$hwnd = Get-HudWindow
if ($hwnd -eq [IntPtr]::Zero) { Write-Host 'FAIL 没找到组件窗口（窗口标题 网速悬浮组件）'; exit 1 }

$r = New-Object Probe.Win+RECT
[void][Probe.Win]::GetWindowRect($hwnd, [ref]$r)
$ex = [Probe.Win]::GetWindowLong($hwnd, -20)
$style = [Probe.Win]::GetWindowLong($hwnd, -16)
Write-Host "窗口 : hwnd=$hwnd rect=($($r.L),$($r.T))-($($r.R),$($r.B))  $($r.R-$r.L)x$($r.B-$r.T)  visible=$([Probe.Win]::IsWindowVisible($hwnd))"
Write-Host ("ExStyle: 0x{0:X}  TOPMOST={1} TOOLWINDOW={2} NOACTIVATE={3}" -f $ex,
    [bool]($ex -band 0x8), [bool]($ex -band 0x80), [bool]($ex -band 0x8000000))
Write-Host ("Style  : 0x{0:X}  POPUP={1} VISIBLE={2}" -f $style, [bool]($style -band 0x80000000), [bool]($style -band 0x10000000))

if ($Measure) { return }

$cursor = New-Object Probe.Win+POINT
[void][Probe.Win]::GetCursorPos([ref]$cursor)
$cx = [int](($r.L + $r.R) / 2)
$cy = [int](($r.T + $r.B) / 2)

#  第一部分：光标命中测试必须翻转鼠标策略。
#  透明像素不是死区，靠的是主进程 80ms 一次的光标轮询把 setIgnoreMouseEvents 翻对；
#  这一条不先成立，后面的点击断言就是假的（点在穿透窗口上当然不会抢焦点）。
[void][Probe.Win]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 400
$exOver = [Probe.Win]::GetWindowLong($hwnd, -20)
$transparentOver = [bool]($exOver -band 0x20)          # WS_EX_TRANSPARENT = 穿透中

[void][Probe.Win]::SetCursorPos([Math]::Max(2, $r.L - 220), $cy)
Start-Sleep -Milliseconds 400
$exAway = [Probe.Win]::GetWindowLong($hwnd, -20)
$transparentAway = [bool]($exAway -band 0x20)

Write-Host ("光标在卡片上 : ExStyle=0x{0:X}  穿透={1}" -f $exOver, $transparentOver)
Write-Host ("光标离开卡片 : ExStyle=0x{0:X}  穿透={1}" -f $exAway, $transparentAway)
if (-not $transparentOver -and $transparentAway) {
    Write-Host 'PASS 命中测试翻转正确（卡上可交互、卡外穿透）'
} else {
    Write-Host 'FAIL 鼠标策略没有按命中测试翻转'
}

# --- 第二部分：真实点击不抢焦点 -------------------------------------------
$before = [Probe.Win]::GetForegroundWindow()
[void][Probe.Win]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 400
# 真实点击（mouse_event 走输入队列，也就是真正会触发 WM_MOUSEACTIVATE 的那条路）
[Probe.Win]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 90
[Probe.Win]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 350
$after = [Probe.Win]::GetForegroundWindow()
[void][Probe.Win]::SetCursorPos($cursor.X, $cursor.Y)

$nameBefore = New-Object System.Text.StringBuilder 200
$nameAfter = New-Object System.Text.StringBuilder 200
[void][Probe.Win]::GetWindowTextW($before, $nameBefore, 200)
[void][Probe.Win]::GetWindowTextW($after, $nameAfter, 200)

Write-Host "点击前前台: $before [$($nameBefore.ToString())]"
Write-Host "点击后前台: $after [$($nameAfter.ToString())]"
if ($after -eq $before -and $after -ne $hwnd) {
    Write-Host 'PASS 点击组件没有改变前台窗口（没有抢焦点）'
} elseif ($after -eq $hwnd) {
    Write-Host 'FAIL 组件被点成了前台窗口'
} else {
    Write-Host 'CHECK 前台窗口变了，但不是组件（可能是别的窗口抢走了）'
}

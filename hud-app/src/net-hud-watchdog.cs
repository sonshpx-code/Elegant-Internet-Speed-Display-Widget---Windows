// ============================================================================
//  net-hud-watchdog —— 常驻看门狗
//
//  计划任务的「失败后重启」对“进程被强杀”这种情形并不可靠（实测：任务只是结束，
//  没有重拉）。所以监管交给这个几 KB 的小程序：它启动窗口、等它退出、按语义决定
//  要不要拉起来，自己则一直活着。计划任务/启动项只需要拉起看门狗。
//
//  语义（与 lib/host.js 那套保持一致）：
//   · 退出码 0 且存活 < 5 秒  → 视为“已经有一份在跑了”，自己退出，不跟它抢。
//   · <stateDir>\quit 标记存在 → 用户显式退出：删掉标记、自己退出，不再拉起。
//   · 稳定运行超过 60 秒后退出 → 重启计数归零（偶发一次不该吃掉配额）。
//   · 其余一律按崩溃处理：退避重启，最多 5 次，间隔 2/4/8/16/30 秒。
//
//  两个必须做对的细节：
//   · **删掉 ELECTRON_RUN_AS_NODE 与 NODE_OPTIONS**：DSH 宿主自己就是 Electron 的
//     Node 模式，环境里带着它；继承下去窗口会以纯 Node 启动并立刻死在 require('electron')。
//     这里在**本进程内**删掉，再用 UseShellExecute 起子进程，子进程自然不会带。
//   · **自己编成 winexe**（无控制台），子进程用 UseShellExecute=true 起 —— 这样它不会
//     继承我们可能并不存在的 stdio 句柄（有宿主上，带管道 stdio 会让渲染进程加载失败）。
//
//  编译：tools/build-sampler.ps1
// ============================================================================
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

internal static class NetHudWatchdog
{
    private static string _electron;
    private static string _appDir;
    private static string _stateDir;
    private static string _sampler;
    private static string _logFile;
    private static bool _noSandbox = true;
    private static bool _packaged = false;

    private const int StableResetMs = 60000;
    private const int MaxRelaunch = 5;
    private const int SpawnRetryMs = 5 * 60 * 1000;   // spawn 失败后的重试间隔
    private const int MaxSpawnRetry = 12;             // 约 1 小时
    private const string TaskName = "NetSpeedHud";    // 开机自启的计划任务名（与 tools/install.ps1 一致）
    private const string RunValue = "NetHUD";         // 兜底的 Run 键值名
    private static int spawnFailures = 0;

    private static int Main(string[] args)
    {
        /*
         * 安装程序用的两条一次性命令。放在最前面，做完就退出，不起窗口。
         *
         * 为什么由**看门狗**注册任务，而不是让安装程序去跑 `Net HUD.exe --register-autostart`：
         * 实测踩到过 —— 如果进程环境里有 ELECTRON_RUN_AS_NODE（Electron 的 Node 模式开关），
         * 那个 exe 会以纯 Node 启动、参数一律报 bad option，任务根本没注册上。
         * 看门狗是原生程序，环境变量怎么设都影响不到它。
         */
        if (HasFlag(args, "register-task") || HasFlag(args, "unregister-task"))
        {
            // 这两条命令还没解析过路径，日志先落到 %TEMP%，否则排查时什么都看不到
            _logFile = Path.Combine(Path.GetTempPath(), "net-hud-watchdog.log");
            Log("---- " + (HasFlag(args, "register-task") ? "register-task" : "unregister-task") + " ----");
        }
        if (HasFlag(args, "register-task")) return RegisterTask() ? 0 : 1;
        if (HasFlag(args, "unregister-task")) return UnregisterTask() ? 0 : 1;
        foreach (string raw in args)
        {
            string a = raw.Trim().Trim('"');
            int eq = a.IndexOf('=');
            if (eq <= 0) continue;
            string key = a.Substring(0, eq).TrimStart('-').ToLowerInvariant();
            string value = a.Substring(eq + 1).Trim('"');
            switch (key)
            {
                case "electron": _electron = value; break;
                case "app": _appDir = value; break;
                case "state": _stateDir = value; break;
                case "sampler": _sampler = value; break;
                case "nosandbox": _noSandbox = value != "0"; break;
                case "packaged": _packaged = value != "0"; break;
            }
        }

        /*
         * 安装版：只给一个 --packaged=1，其余路径从**看门狗自己的位置**推导。
         *
         * 安装后的布局是 NSIS 定的：
         *   <install>\Net HUD.exe                     ← electron 外壳（应用本体在 resources\app.asar）
         *   <install>\resources\bin\net-hud-watchdog.exe   ← 我
         *   <install>\resources\bin\netspeed-sampler.exe
         * 状态目录必须在用户目录下（安装目录不该被写），和 main.js 里的
         * app.getPath('userData') 是同一个地方：%APPDATA%\Net HUD。
         *
         * 之所以要推导而不是全部用参数传：计划任务的 /TR 有 261 字符上限，
         * 三个绝对路径塞进去，用户名一长就爆。
         */
        string selfDir = Path.GetDirectoryName(Path.GetFullPath(Environment.GetEnvironmentVariable("_") ?? System.Reflection.Assembly.GetExecutingAssembly().Location));
        if (_packaged)
        {
            string binDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            string installDir = Path.GetDirectoryName(Path.GetDirectoryName(binDir));
            if (string.IsNullOrEmpty(_electron)) _electron = Path.Combine(installDir, "Net HUD.exe");
            if (string.IsNullOrEmpty(_appDir)) _appDir = installDir;
            if (string.IsNullOrEmpty(_sampler)) _sampler = Path.Combine(binDir, "netspeed-sampler.exe");
            if (string.IsNullOrEmpty(_stateDir))
                _stateDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Net HUD");
        }

        if (string.IsNullOrEmpty(_electron) || !File.Exists(_electron)) return Fail("electron 不存在: " + _electron);
        if (!_packaged)
        {
            // 打包版的代码在 resources\app.asar 里，没有 main.js 这个文件可查；
            // 源码版才检查它。（踩过：安装版因为这条校验失败，退出码 2 且没有任何日志。）
            if (string.IsNullOrEmpty(_appDir) || !File.Exists(Path.Combine(_appDir, "main.js"))) return Fail("app 目录不对: " + _appDir);
        }
        if (string.IsNullOrEmpty(_stateDir)) _stateDir = Path.Combine(_appDir, ".state");

        try { Directory.CreateDirectory(_stateDir); } catch { }
        _logFile = Path.Combine(_stateDir, "watchdog.log");

        // 这两个变量必须在起子进程之前从**本进程**环境里删掉，子进程才不会继承
        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", null);
        Environment.SetEnvironmentVariable("NODE_OPTIONS", null);

        Log("watchdog start pid=" + Process.GetCurrentProcess().Id + " electron=" + _electron);
        WritePid();

        /*
         * 已经有实例在跑就什么都不做。
         *
         * 这一条不能省：两份窗口共用同一个 --user-data-dir，Chromium 的 ProcessSingleton
         * 会在第二份里直接把它干掉（实测退出码 9，不是 0），于是看门狗会把它当成崩溃、
         * 退避重试 5 次——重复点一下开始菜单快捷方式就要白白折腾半分钟。
         * 探测走窗口自己开的回环端口：进程一死端口立刻释放，不存在过期状态。
         */
        if (AnotherInstanceRunning())
        {
            Log("检测到已有实例在运行（回环锁端口有应答），看门狗结束");
            return 0;
        }

        int relaunches = 0;
        while (true)
        {
            int exitCode;
            long uptimeMs = RunChild(out exitCode);

            /*
             * spawn 失败（uptime < 0）和“窗口崩了”是两回事，不能共用一套退避。
             * 实测踩到过：`pnpm add` 重装依赖时 electron 的 postinstall 被跳过，
             * dist\electron.exe 直接没了 —— 窗口进程根本起不来。按崩溃处理的话
             * 退避 5 次就永久放弃，组件从此静默死亡，直到有人发现。
             * 所以这种情况改成**每 5 分钟重试**，撑够 1 小时再放弃：
             * 用户重装依赖 / 修好路径之后它自己就回来了。
             */
            if (uptimeMs < 0)
            {
                spawnFailures++;
                if (spawnFailures > MaxSpawnRetry)
                {
                    Log("spawn 连续失败 " + spawnFailures + " 次（约 1 小时），放弃；看门狗结束");
                    return 1;
                }
                Log("spawn 失败（electron 不在？）第 " + spawnFailures + " 次，" + (SpawnRetryMs / 60000) + " 分钟后重试");
                Thread.Sleep(SpawnRetryMs);
                continue;
            }
            spawnFailures = 0;

            if (ConsumeQuitMarker())
            {
                Log("用户显式退出（发现 quit 标记），看门狗结束");
                return 0;
            }
            if (exitCode == 0 && uptimeMs < 5000)
            {
                Log("窗口秒退且退出码 0（多半已有一份在运行），看门狗结束  uptime=" + uptimeMs + "ms");
                return 0;
            }
            if (uptimeMs >= StableResetMs && relaunches > 0)
            {
                Log("窗口稳定运行 " + (uptimeMs / 1000) + "s，重启计数归零");
                relaunches = 0;
            }
            if (relaunches >= MaxRelaunch)
            {
                Log("已重启 " + relaunches + " 次，放弃；看门狗结束");
                return 1;
            }
            relaunches++;
            int delay = (int)Math.Min(30000, 1000 * Math.Pow(2, relaunches));
            Log("窗口退出 code=" + exitCode + " uptime=" + uptimeMs + "ms，" + delay + "ms 后第 " + relaunches + " 次拉起");
            Thread.Sleep(delay);
        }
    }

    private static int Fail(string message)
    {
        /*
         * 早期失败的日志不能丢。
         * 踩过两次：一次是安装版因为 app 目录校验失败直接退出（退出码 2），
         * 一次是 --register-task 失败，两次都因为 _logFile 还没赋值而什么都不写，
         * 排查时只能靠猜。所以这里兜底写到 %TEMP%。
         */
        try
        {
            if (string.IsNullOrEmpty(_logFile))
                _logFile = Path.Combine(Path.GetTempPath(), "net-hud-watchdog.log");
            Log("FATAL " + message);
        }
        catch { }
        return 2;
    }

    private static bool HasFlag(string[] args, string name)
    {
        foreach (string raw in args)
        {
            if (raw.Trim().Trim('"').TrimStart('-').Equals(name, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    /// <summary>注册登录自启的计划任务：动作就是"我自己 --packaged=1"。</summary>
    private static bool RegisterTask()
    {
        string self = System.Reflection.Assembly.GetExecutingAssembly().Location;

        // 路 1：schtasks（最常见的路径，毫秒级）
        // /TR 里带空格必须整体加引号；这里只有两个 token，离 261 字符上限很远
        if (RunSchtasks(new[] { "/Create", "/TN", TaskName, "/TR", "\"" + self + "\" --packaged=1",
                                "/SC", "ONLOGON", "/RL", "LIMITED", "/F" }, "register (schtasks)"))
        {
            return true;
        }

        /*
         * 路 2：PowerShell 的 Register-ScheduledTask（走 COM API）。
         * 不是多余的：实测在受限令牌（沙箱/受限作业对象）里，schtasks /Create 会直接
         * 返回 Access is denied，而降级成 -Change/-Delete 却都正常 —— 同一个上下文里
         * 用 COM API 注册是成功的。两条路都留，装到哪台机器上都能成。
         * 脚本写成临时 .ps1 文件再 -File 执行：省得把长命令塞进 -Command 里跟
         * CreateProcess 的引号规则打架。
         */
        /*
         * 路 3：注册表 Run 键（HKCU\...\Run）。
         * 实测在受限令牌下计划任务的两条路都会 Access is denied，而 Run 键一次就成。
         * 普通用户（非管理员）装这个组件时，不该因为建不了计划任务就没有开机自启。
         */
        bool runKeyOk = WriteRunKey(true);
        try { Log("register: schtasks+powershell failed, run key = " + runKeyOk); } catch { }
        return runKeyOk;
    }

    /// <summary>Run 键值：打包版只带 --packaged=1（路径由看门狗自己推导）。</summary>
    private static string RunKeyCommand()
    {
        string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
        return "\"" + self + "\" --packaged=1";
    }

    private static bool WriteRunKey(bool on)
    {
        try
        {
            string key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
            string[] args = on
                ? new[] { "add", key, "/v", RunValue, "/t", "REG_SZ", "/d", RunKeyCommand(), "/f" }
                : new[] { "delete", key, "/v", RunValue, "/f" };
            StringBuilder line = new StringBuilder();
            foreach (string argument in args)
            {
                if (line.Length > 0) line.Append(' ');
                line.Append('"').Append(argument.Replace("\"", "\\\"")).Append('"');
            }
            ProcessStartInfo psi = new ProcessStartInfo("reg.exe", line.ToString());
            psi.UseShellExecute = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process child = Process.Start(psi))
            {
                if (child == null) return false;
                child.WaitForExit(15000);
                int code = child.HasExited ? child.ExitCode : -1;
                try { Log("reg " + (on ? "add" : "delete") + " exit=" + code); } catch { }
                return on ? code == 0 : true;      // 删不掉不算失败
            }
        }
        catch (Exception ex)
        {
            try { Log("reg failed: " + ex.Message); } catch { }
            return false;
        }
    }

    private static bool UnregisterTask()
    {
        // 删不掉不算失败（本来就没有这个任务）
        RunSchtasks(new[] { "/Delete", "/TN", TaskName, "/F" }, "unregister (schtasks)");
        if (!TaskExists()) RunPowerShellScript(
            "Unregister-ScheduledTask -TaskName '" + TaskName + "' -Confirm:$false -ErrorAction SilentlyContinue\n",
            "unregister (powershell)");
        WriteRunKey(false);
        return true;
    }

    private static bool TaskExists()
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("schtasks.exe", "/Query /TN \"" + TaskName + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            using (Process child = Process.Start(psi))
            {
                if (child == null) return false;
                child.StandardOutput.ReadToEnd();
                child.StandardError.ReadToEnd();
                child.WaitForExit(10000);
                return child.HasExited && child.ExitCode == 0;
            }
        }
        catch { return false; }
    }

    /// <summary>把脚本写成临时 .ps1（带 BOM）再用 powershell -File 跑，避开引号地狱。</summary>
    private static bool RunPowerShellScript(string script, string what)
    {
        string file = Path.Combine(Path.GetTempPath(), "net-hud-task-" + Process.GetCurrentProcess().Id + ".ps1");
        try
        {
            File.WriteAllText(file, script, new UTF8Encoding(true));   // 必须带 BOM：否则中文/特殊字符会被当 ANSI
            ProcessStartInfo psi = new ProcessStartInfo(
                "powershell.exe",
                "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + file + "\"");
            psi.UseShellExecute = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process child = Process.Start(psi))
            {
                if (child == null) return false;
                child.WaitForExit(60000);
                int code = child.HasExited ? child.ExitCode : -1;
                try { Log("schtasks " + what + " exit=" + code); } catch { }
                return code == 0;
            }
        }
        catch (Exception ex)
        {
            try { Log("schtasks " + what + " failed: " + ex.Message); } catch { }
            return false;
        }
        finally
        {
            try { File.Delete(file); } catch { }
        }
    }

    private static bool RunSchtasks(string[] arguments, string what)
    {
        try
        {
            // 手工拼引号：这个 exe 用 .NET Framework 4.0 的 csc 编译（C# 5），
            // 没有 ArgumentList（那是 .NET Core 的 API）。
            StringBuilder line = new StringBuilder();
            foreach (string argument in arguments)
            {
                if (line.Length > 0) line.Append(' ');
                line.Append('"').Append(argument.Replace("\"", "\\\"")).Append('"');
            }

            ProcessStartInfo psi = new ProcessStartInfo("schtasks.exe", line.ToString());
            psi.UseShellExecute = true;              // 不继承 stdio，也不会弹控制台
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process child = Process.Start(psi))
            {
                if (child == null) return false;
                child.WaitForExit(15000);
                int code = child.HasExited ? child.ExitCode : -1;
                try { Log("schtasks " + what + " exit=" + code); } catch { }
                return code == 0;
            }
        }
        catch (Exception ex)
        {
            try { Log("schtasks " + what + " failed: " + ex.Message); } catch { }
            return false;
        }
    }

    /// <summary>问一句回环锁端口：对面回 net-hud 就说明窗口已经在跑。</summary>
    private static bool AnotherInstanceRunning()
    {
        const int LockPort = 48711;
        try
        {
            using (System.Net.Sockets.TcpClient client = new System.Net.Sockets.TcpClient())
            {
                IAsyncResult connecting = client.BeginConnect("127.0.0.1", LockPort, null, null);
                if (!connecting.AsyncWaitHandle.WaitOne(400)) return false;
                client.EndConnect(connecting);
                if (!client.Connected) return false;

                System.Net.Sockets.NetworkStream stream = client.GetStream();
                stream.ReadTimeout = 400;
                stream.WriteTimeout = 400;
                byte[] request = Encoding.ASCII.GetBytes("net-hud?\n");
                stream.Write(request, 0, request.Length);
                byte[] buffer = new byte[32];
                int read = stream.Read(buffer, 0, buffer.Length);
                if (read <= 0) return false;
                return Encoding.ASCII.GetString(buffer, 0, read).IndexOf("net-hud", StringComparison.Ordinal) >= 0;
            }
        }
        catch
        {
            return false;   // 没人应答 / 端口被别的程序占着，都当作没有实例
        }
    }

    /// <summary>起窗口并等它退出；返回存活时长（负数 = spawn 失败，见调用处的处理）。</summary>
    private static long RunChild(out int exitCode)
    {
        string arguments = BuildArguments();
        ProcessStartInfo psi = new ProcessStartInfo(_electron, arguments);
        psi.UseShellExecute = true;                 // 不继承我们的 stdio 句柄
        psi.WorkingDirectory = _appDir;
        psi.WindowStyle = ProcessWindowStyle.Normal;

        Stopwatch clock = Stopwatch.StartNew();
        Process child;
        try
        {
            child = Process.Start(psi);
        }
        catch (Exception ex)
        {
            Log("spawn failed: " + ex.Message);
            exitCode = -1;
            return -1;                              // 起不来：走“每 5 分钟重试”，不当崩溃
        }
        if (child == null)
        {
            exitCode = -1;
            return -1;
        }

        Log("window pid=" + child.Id);
        try { child.WaitForExit(); }
        catch { /* 句柄失效就当作已退出 */ }
        clock.Stop();

        try { exitCode = child.ExitCode; }
        catch { exitCode = -1; }
        return (long)clock.Elapsed.TotalMilliseconds;
    }

    private static string BuildArguments()
    {
        StringBuilder sb = new StringBuilder();
        if (_noSandbox) sb.Append("--no-sandbox ");
        sb.Append("--user-data-dir=\"").Append(Path.Combine(_stateDir, "chromium")).Append("\" ");
        sb.Append("--disk-cache-dir=\"").Append(Path.Combine(_stateDir, "cache")).Append("\" ");
        sb.Append("--crash-dumps-dir=\"").Append(Path.Combine(_stateDir, "crash")).Append("\" ");
        sb.Append("--net-state-dir=\"").Append(_stateDir).Append("\" ");
        if (!string.IsNullOrEmpty(_sampler)) sb.Append("--net-sampler=\"").Append(_sampler).Append("\" ");
        sb.Append('"').Append(_appDir).Append('"');
        return sb.ToString();
    }

    private static bool ConsumeQuitMarker()
    {
        try
        {
            string marker = Path.Combine(_stateDir, "quit");
            if (!File.Exists(marker)) return false;
            File.Delete(marker);
            return true;
        }
        catch { return false; }
    }

    private static void WritePid()
    {
        try
        {
            File.WriteAllText(Path.Combine(_stateDir, "watchdog.pid"),
                Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch { /* 只是给排查用的便利文件 */ }
    }

    private static void Log(string message)
    {
        try
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine;
            if (File.Exists(_logFile) && new FileInfo(_logFile).Length > 64 * 1024)
                File.Delete(_logFile);
            File.AppendAllText(_logFile, line, new UTF8Encoding(false));
        }
        catch { /* 记日志绝不能成为失败原因 */ }
    }
}

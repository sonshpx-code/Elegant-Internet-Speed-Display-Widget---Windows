// ============================================================================
//  netspeed-sampler —— 给 dsh-net-hud 用的网卡速率采样器
//
//  为什么需要它：Electron/Node 没有读取网卡字节计数的 API（os.networkInterfaces
//  只有地址和状态，没有流量）。所以这里用系统自带的 .NET Framework 编译器编一个
//  几 KB 的控制台程序，按固定间隔把每个网卡的累计字节数与速率打成 JSON 行写到
//  stdout，由 Electron 主进程 spawn 并逐行解析。
//
//  输出（每行一个 JSON 对象，UTF-8 无 BOM，行尾 \n）：
//  {"ts":1699999999999,"intervalMs":1000,"rx":123456.7,"tx":7890.1,
//   "rxTotal":123456789,"txTotal":9876543,
//   "ifaces":[{"name":"WLAN","desc":"Intel(R) Wi-Fi 6E AX210 160MHz",
//              "type":"Wireless80211","up":true,
//              "rx":123456.7,"tx":7890.1,"rxTotal":123456789,"txTotal":9876543}]}
//
//  参数：--interval=<ms>   采样间隔，默认 1000，最小 200
//        --once           只输出一次（用于自检）
//        --all            连回环与隧道网卡也输出（默认排除）
//
//  编译：见 tools/build-sampler.ps1（csc.exe /target:exe，无需 VS/SDK）
// ============================================================================
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Net.NetworkInformation;
using System.Text;
using System.Threading;

internal static class NetSpeedSampler
{
    private sealed class Nic
    {
        public string Name;
        public string Desc;
        public string Type;
        public bool Up;
        public long LastRecv = -1;
        public long LastSent = -1;
    }

    private static int _intervalMs = 1000;
    private static bool _once;
    private static bool _includeAll;

    private static int Main(string[] args)
    {
        foreach (string raw in args)
        {
            string a = raw.Trim();
            if (a.StartsWith("--interval=", StringComparison.OrdinalIgnoreCase))
            {
                int v;
                if (int.TryParse(a.Substring(11), NumberStyles.Integer, CultureInfo.InvariantCulture, out v))
                    _intervalMs = v;
            }
            else if (a.Equals("--once", StringComparison.OrdinalIgnoreCase)) _once = true;
            else if (a.Equals("--all", StringComparison.OrdinalIgnoreCase)) _includeAll = true;
        }
        if (_intervalMs < 200) _intervalMs = 200;
        if (_intervalMs > 10000) _intervalMs = 10000;

        try { Console.OutputEncoding = new UTF8Encoding(false); }
        catch { /* 老控制台可能不支持，忽略 */ }
        Console.Out.Flush();

        Dictionary<string, Nic> known = new Dictionary<string, Nic>(StringComparer.Ordinal);
        Stopwatch clock = Stopwatch.StartNew();
        double lastMs = 0;

        while (true)
        {
            double nowMs = clock.Elapsed.TotalMilliseconds;
            double elapsed = (nowMs - lastMs) / 1000.0;
            if (elapsed <= 0.0001) elapsed = _intervalMs / 1000.0;
            lastMs = nowMs;

            string line = Sample(known, elapsed, (long)nowMs);
            Console.Out.Write(line);
            Console.Out.Write('\n');
            Console.Out.Flush();

            if (_once) return 0;
            Thread.Sleep(_intervalMs);
        }
    }

    private static string Sample(Dictionary<string, Nic> known, double elapsed, long ts)
    {
        StringBuilder sb = new StringBuilder(1024);
        sb.Append("{\"ts\":").Append(ts.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"intervalMs\":").Append(_intervalMs.ToString(CultureInfo.InvariantCulture));

        StringBuilder ifaces = new StringBuilder(1024);
        int count = 0;
        double sumRx = 0, sumTx = 0;
        long sumRxTotal = 0, sumTxTotal = 0;
        var seen = new HashSet<string>(StringComparer.Ordinal);

        NetworkInterface[] nics;
        try { nics = NetworkInterface.GetAllNetworkInterfaces(); }
        catch { nics = new NetworkInterface[0]; }

        foreach (NetworkInterface ni in nics)
        {
            if (!_includeAll)
            {
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;
            }

            long recv = -1, sent = -1;
            try
            {
                IPInterfaceStatistics st = ni.GetIPStatistics();   // 该网卡 IPv4+IPv6 总字节
                recv = st.BytesReceived;
                sent = st.BytesSent;
            }
            catch { continue; }                                     // 取不到就跳过这张卡

            string name = ni.Name ?? "";
            string desc = ni.Description ?? "";
            bool up = ni.OperationalStatus == OperationalStatus.Up;
            seen.Add(name);

            Nic prev;
            if (!known.TryGetValue(name, out prev))
            {
                prev = new Nic { Name = name, Desc = desc, Type = ni.NetworkInterfaceType.ToString(), Up = up };
                known[name] = prev;
            }
            prev.Desc = desc;
            prev.Type = ni.NetworkInterfaceType.ToString();
            prev.Up = up;

            double rx = 0, tx = 0;
            if (prev.LastRecv >= 0)
            {
                long dr = recv - prev.LastRecv;
                long ds = sent - prev.LastSent;
                if (dr > 0) rx = dr / elapsed;                       // 计数器回绕/重置时不取负值
                if (ds > 0) tx = ds / elapsed;
            }
            prev.LastRecv = recv;
            prev.LastSent = sent;

            if (count > 0) ifaces.Append(',');
            ifaces.Append("{\"name\":").Append(Json(name));
            ifaces.Append(",\"desc\":").Append(Json(desc));
            ifaces.Append(",\"type\":").Append(Json(prev.Type));
            ifaces.Append(",\"up\":").Append(up ? "true" : "false");
            ifaces.Append(",\"rx\":").Append(Num(rx));
            ifaces.Append(",\"tx\":").Append(Num(tx));
            ifaces.Append(",\"rxTotal\":").Append(recv.ToString(CultureInfo.InvariantCulture));
            ifaces.Append(",\"txTotal\":").Append(sent.ToString(CultureInfo.InvariantCulture));
            ifaces.Append('}');
            count++;

            sumRx += rx; sumTx += tx; sumRxTotal += recv; sumTxTotal += sent;
        }

        // 网卡消失后清掉旧状态，避免它以后重新出现时算出一个巨大的假速率
        var stale = new List<string>();
        foreach (var kv in known) if (!seen.Contains(kv.Key)) stale.Add(kv.Key);
        foreach (string k in stale) known.Remove(k);

        sb.Append(",\"rx\":").Append(Num(sumRx));
        sb.Append(",\"tx\":").Append(Num(sumTx));
        sb.Append(",\"rxTotal\":").Append(sumRxTotal.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"txTotal\":").Append(sumTxTotal.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"ifaces\":[").Append(ifaces.ToString()).Append("]}");
        return sb.ToString();
    }

    private static string Num(double v)
    {
        if (v < 0) v = 0;
        return Math.Round(v, 1).ToString("0.0", CultureInfo.InvariantCulture);
    }

    private static string Json(string s)
    {
        StringBuilder sb = new StringBuilder(s.Length + 8);
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}

// ============================================================================
//  fake-sampler —— 负向对照用的假采样器（只给验证脚本用，不是运行时的一部分）
//
//  每秒吐出一模一样的样本。渲染端如果在“数值没变”时还去写 DOM，就会在这里露馅：
//  正确的表现是 frames 一直涨、writes 一动不动（只在第一帧写一次）。
//  一个不会失败的检查等于没有检查，所以这条对照必须存在。
//
//  编译： tools/build-sampler.ps1 一并产出 bin/fake-sampler.exe
// ============================================================================
using System;
using System.Globalization;
using System.Text;
using System.Threading;

internal static class FakeSampler
{
    private static int Main(string[] args)
    {
        int interval = 1000;
        foreach (string raw in args)
        {
            string a = raw.Trim();
            if (a.StartsWith("--interval=", StringComparison.OrdinalIgnoreCase))
            {
                int v;
                if (int.TryParse(a.Substring(11), NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) interval = v;
            }
        }
        if (interval < 200) interval = 200;

        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        long total = 12345678;
        string line = "{\"ts\":0,\"intervalMs\":" + interval.ToString(CultureInfo.InvariantCulture)
            + ",\"rx\":12345.6,\"tx\":789.0,\"rxTotal\":" + total.ToString(CultureInfo.InvariantCulture)
            + ",\"txTotal\":987654,\"ifaces\":[{\"name\":\"FAKE\",\"desc\":\"constant fixture\",\"type\":\"Ethernet\",\"up\":true,"
            + "\"rx\":12345.6,\"tx\":789.0,\"rxTotal\":" + total.ToString(CultureInfo.InvariantCulture) + ",\"txTotal\":987654}]}";

        while (true)
        {
            Console.Out.Write(line);
            Console.Out.Write('\n');
            Console.Out.Flush();
            Thread.Sleep(interval);
        }
    }
}

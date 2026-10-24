// Windows 主機輸入 / 截圖 / 音量 helper(PowerShell Add-Type 編譯,C# 5 語法;不需要 .NET SDK)。
// 由 winHost.ps1 載入,windowsClient.mjs 透過 stdin/stdout 的 JSON 行呼叫。
// 座標一律是「主螢幕實體像素」(程序設為 DPI aware;截圖與 SendInput 同一個空間)。
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// ── WASAPI(音量讀取)的 COM 介面 ────────────────────────────────────────────
//
// 為什麼不是用 ffmpeg 錄音:ffmpeg 在 Windows 的音訊輸入走 dshow,而 dshow 不暴露
// WASAPI loopback —— 要錄系統「播放出去」的聲音得先裝虛擬音訊驅動
// (virtual-audio-capturer / VB-CABLE 之類),那是核心模式驅動,在用完就消失的
// stream session 裡裝不了(見 agent/windowsCapture.mjs 的註解)。
//
// IAudioMeterInformation 不必裝任何東西、也不必開音訊串流:它直接問系統
// 「這個輸出端點現在的峰值是多少」。要判斷「遊戲有沒有在出聲」這就夠了。
//
// 介面方法**必須按 vtable 原順序宣告**(用不到的也要佔位),少一個後面全部錯位。

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int access, out IntPtr store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
}

[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation
{
    int GetPeakValue(out float peak);
}

public static class WinHelper
{
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy, mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public int dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public int type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);

    const int MOUSEEVENTF_MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
    const int KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    public static void Init()
    {
        // PER_MONITOR_AWARE_V2 = -4;失敗退回系統 DPI aware。
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) SetProcessDPIAware(); } catch { SetProcessDPIAware(); }
    }

    public static int Width { get { return GetSystemMetrics(0); } }
    public static int Height { get { return GetSystemMetrics(1); } }

    /// 主螢幕截圖 → PNG base64。
    public static string Shot()
    {
        int w = Width, h = Height;
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(bmp))
        using (var ms = new MemoryStream())
        {
            g.CopyFromScreen(0, 0, 0, 0, new Size(w, h));
            bmp.Save(ms, ImageFormat.Png);
            return Convert.ToBase64String(ms.ToArray());
        }
    }

    static INPUT Mouse(int x, int y, int flags)
    {
        // 絕對座標 0..65535 對應主螢幕。
        var i = new INPUT { type = 0 };
        i.u.mi.dx = (int)Math.Round(x * 65535.0 / Math.Max(1, Width - 1));
        i.u.mi.dy = (int)Math.Round(y * 65535.0 / Math.Max(1, Height - 1));
        i.u.mi.dwFlags = flags | ABSOLUTE | MOUSEEVENTF_MOVE;
        return i;
    }
    static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

    public static void Click(int x, int y)
    {
        SetCursorPos(x, y);
        Send(Mouse(x, y, 0));
        Send(Mouse(x, y, LEFTDOWN));
        Thread.Sleep(60);
        Send(Mouse(x, y, LEFTUP));
    }

    /// 按住拖曳(滑動 / 搖桿 / 長按):從 (x,y) 到 (x2,y2),總時長 ms,中間持續送移動事件。
    public static void Drag(int x, int y, int x2, int y2, int ms)
    {
        SetCursorPos(x, y);
        Send(Mouse(x, y, 0));
        Send(Mouse(x, y, LEFTDOWN));
        int steps = Math.Max(1, ms / 16);
        for (int k = 1; k <= steps; k++)
        {
            int px = x + (x2 - x) * k / steps, py = y + (y2 - y) * k / steps;
            Send(Mouse(px, py, 0));
            Thread.Sleep(Math.Max(1, ms / steps));
        }
        Send(Mouse(x2, y2, LEFTUP));
    }

    /// 輸入文字(Unicode,中文也可以)。
    public static void TypeText(string text)
    {
        foreach (char c in text)
        {
            var down = new INPUT { type = 1 }; down.u.ki.wScan = c; down.u.ki.dwFlags = KEYEVENTF_UNICODE;
            var up = new INPUT { type = 1 }; up.u.ki.wScan = c; up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            Send(down, up);
            Thread.Sleep(15);
        }
    }

    /// 按一個虛擬鍵(VK code,例:0x1B = Esc、0x0D = Enter)。
    public static void Key(int vk)
    {
        var down = new INPUT { type = 1 }; down.u.ki.wVk = (ushort)vk;
        var up = new INPUT { type = 1 }; up.u.ki.wVk = (ushort)vk; up.u.ki.dwFlags = KEYEVENTF_KEYUP;
        Send(down, up);
    }

    /// 某個程序(含子程序同名)最大的可見視窗;找不到回 Zero。
    public static IntPtr MainWindowOf(string processName)
    {
        IntPtr best = IntPtr.Zero; long bestArea = 0;
        var ids = new System.Collections.Generic.HashSet<int>();
        foreach (var p in Process.GetProcessesByName(processName)) ids.Add(p.Id);
        EnumWindows(delegate (IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            int pid; GetWindowThreadProcessId(h, out pid);
            if (!ids.Contains(pid)) return true;
            RECT r; GetWindowRect(h, out r);
            long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
            if (a > bestArea) { bestArea = a; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    /// 遊戲是否在前景(前景視窗屬於這個程序)。
    public static bool IsForeground(string processName)
    {
        var fg = GetForegroundWindow(); int pid; GetWindowThreadProcessId(fg, out pid);
        foreach (var p in Process.GetProcessesByName(processName)) if (p.Id == pid) return true;
        return false;
    }

    /// 目前前景視窗所屬的程序名稱(不含 .exe);取不到回空字串。
    ///
    /// 用途:啟動器型的遊戲(例如 Gamania Games Manager → 新楓之谷)真正的遊戲是**另一個程序**,
    /// 我們啟動的那個 exe 交棒後可能就結束了。只盯著啟動的 exe 會得到兩個錯誤結論:
    /// 「程序不在了 = 當掉了,重開」以及「前景不是它 = 失焦了,搶回來」——
    /// 前者會在遊戲上面一直重開啟動器,後者會把焦點從遊戲搶走。
    /// 所以要能問「現在前景到底是誰」,把它學進追蹤名單。
    public static string ForegroundName()
    {
        var fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return "";
        int pid; GetWindowThreadProcessId(fg, out pid);
        if (pid == 0) return "";
        try { return Process.GetProcessById(pid).ProcessName; }
        catch { return ""; }
    }

    public static bool Focus(string processName)
    {
        var h = MainWindowOf(processName);
        if (h == IntPtr.Zero) return false;
        ShowWindow(h, 9); // SW_RESTORE
        return SetForegroundWindow(h);
    }

    public static string WindowRect(string processName)
    {
        var h = MainWindowOf(processName);
        if (h == IntPtr.Zero) return "";
        RECT r; GetWindowRect(h, out r);
        return string.Format("{0},{1},{2},{3}", r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
    }

    // ── 音量 ────────────────────────────────────────────────────────────────

    static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    const int eRender = 0, eConsole = 0, CLSCTX_INPROC_SERVER = 1;

    static string JsonStr(string s)
    {
        if (s == null) return "\"\"";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < ' ') sb.Append(' ');
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    /// 產生一段正弦波的 WAV(記憶體內,不碰檔案系統)。
    ///
    /// 為什麼不播 C:\Windows\Media 裡的 wav:Windows Server 的精簡安裝不保證有那些檔案,
    /// 而「找不到檔案」會被誤讀成「這台機器沒有聲音」。自己生一段就沒有這個變數。
    static byte[] SineWav(int ms, int freq)
    {
        int rate = 44100, bits = 16, ch = 1;
        int samples = rate * ms / 1000;
        int dataLen = samples * ch * bits / 8;
        var m = new MemoryStream();
        var w = new BinaryWriter(m);
        w.Write(Encoding.ASCII.GetBytes("RIFF")); w.Write(36 + dataLen);
        w.Write(Encoding.ASCII.GetBytes("WAVE"));
        w.Write(Encoding.ASCII.GetBytes("fmt ")); w.Write(16);
        w.Write((short)1); w.Write((short)ch); w.Write(rate);
        w.Write(rate * ch * bits / 8); w.Write((short)(ch * bits / 8)); w.Write((short)bits);
        w.Write(Encoding.ASCII.GetBytes("data")); w.Write(dataLen);
        for (int i = 0; i < samples; i++)
        {
            double t = (double)i / rate;
            w.Write((short)(Math.Sin(2 * Math.PI * freq * t) * 12000));
        }
        w.Flush();
        return m.ToArray();
    }

    /// <summary>
    /// 音訊鏈自我檢查:自己播一段已知的聲音,看音量表有沒有跟著動。
    ///
    /// 為什麼需要這個:讀到「有輸出端點」不等於「遊戲的聲音會進到那個端點」。
    /// 沒有這個檢查的話,一整場 peak=0 有兩種完全不同的解釋 ——
    /// 遊戲真的沒出聲(是個發現),或者音訊鏈根本不通(我們的量測沒有意義)。
    /// 分不出來的量測不該拿去寫報告。
    ///
    /// 只在 runner 啟動時跑一次(遊戲還沒開),不然這段測試音會疊在遊戲聲音上。
    /// </summary>
    public static string AudioSelfTest()
    {
        try
        {
            var wav = SineWav(700, 440);
            using (var ms = new MemoryStream(wav))
            using (var player = new System.Media.SoundPlayer(ms))
            {
                player.Load();
                player.Play(); // 非同步,接著就可以量
                Thread.Sleep(120);
                string during = AudioSample(350);
                player.Stop();
                Thread.Sleep(250);
                string after = AudioSample(200);
                return "{\"during\":" + during + ",\"after\":" + after + "}";
            }
        }
        catch (Exception e)
        {
            return "{\"error\":" + JsonStr(e.Message) + "}";
        }
    }

    /// <summary>
    /// 取樣預設輸出端點的音量峰值。回傳 JSON 字串。
    ///
    /// peak 是「這一瞬間」的值,所以單次讀取判斷不了「有沒有聲音」—— 音效的波形會經過
    /// 零點,剛好讀在那裡就會誤判成靜音。所以在 ms 毫秒內以 10ms 間隔連續取樣,
    /// 看這段時間的最大值。
    ///
    /// ok=false 的兩種情形都要能分辨(查問題時差很多):
    ///   no-endpoint → 這台機器沒有預設輸出裝置(沒有音效卡也沒有虛擬裝置)
    ///   其他 hr     → 有裝置但 Activate/GetPeakValue 失敗
    /// </summary>
    public static string AudioSample(int ms)
    {
        try
        {
            var t = Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator);
            if (t == null) return "{\"ok\":false,\"why\":\"no-mmdeviceenumerator\"}";
            var en = (IMMDeviceEnumerator)Activator.CreateInstance(t);
            IMMDevice dev = null;
            int hr = en.GetDefaultAudioEndpoint(eRender, eConsole, out dev);
            if (hr != 0 || dev == null)
                return "{\"ok\":false,\"why\":\"no-endpoint\",\"hr\":" + hr + "}";
            string id = ""; dev.GetId(out id);
            int state = 0; dev.GetState(out state);
            var iid = typeof(IAudioMeterInformation).GUID;
            object o = null;
            hr = dev.Activate(ref iid, CLSCTX_INPROC_SERVER, IntPtr.Zero, out o);
            if (hr != 0 || o == null)
                return "{\"ok\":false,\"why\":\"activate-failed\",\"hr\":" + hr + ",\"device\":" + JsonStr(id) + "}";
            var meter = (IAudioMeterInformation)o;

            int n = Math.Max(1, Math.Min(400, ms / 10));
            float max = 0f, sum = 0f;
            int got = 0;
            for (int k = 0; k < n; k++)
            {
                float p;
                if (meter.GetPeakValue(out p) == 0)
                {
                    if (p > max) max = p;
                    sum += p;
                    got++;
                }
                if (k + 1 < n) Thread.Sleep(10);
            }
            float avg = got > 0 ? sum / got : 0f;
            return "{\"ok\":true,\"peak\":" + max.ToString("0.00000", System.Globalization.CultureInfo.InvariantCulture)
                + ",\"avg\":" + avg.ToString("0.00000", System.Globalization.CultureInfo.InvariantCulture)
                + ",\"samples\":" + got + ",\"state\":" + state + ",\"device\":" + JsonStr(id) + "}";
        }
        catch (Exception e)
        {
            return "{\"ok\":false,\"why\":" + JsonStr(e.Message) + "}";
        }
    }
}

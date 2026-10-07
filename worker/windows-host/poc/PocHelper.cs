// Windows PoC helper(PowerShell 5.1 Add-Type 編譯,C# 5 語法)。
// 正式版會改成 .NET 8 的 WindowsHostAgent(SendInput / DXGI Desktop Duplication / NVENC)。
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class PocHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra; public int dmFields;
        public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
        public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
        public int dmDisplayFlags; public int dmDisplayFrequency;
        public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
        public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DISPLAY_DEVICE
    {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string lpDevice, int iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, int dwFlags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string lpszDeviceName, ref DEVMODE lpDevMode, IntPtr hwnd, int dwflags, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(int flags, int dx, int dy, int data, IntPtr extra);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);

    const int ENUM_CURRENT_SETTINGS = -1;
    const int DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000, DM_DISPLAYORIENTATION = 0x80;
    const int CDS_UPDATEREGISTRY = 0x1, CDS_TEST = 0x2;

    public static void Init() { SetProcessDPIAware(); }

    /// 所有顯示卡 / 螢幕與目前模式(一行一個,給報告看)。
    public static string Displays()
    {
        var sb = new StringBuilder();
        for (int i = 0; i < 16; i++)
        {
            var d = new DISPLAY_DEVICE(); d.cb = Marshal.SizeOf(d);
            if (!EnumDisplayDevices(null, i, ref d, 0)) break;
            var m = NewMode();
            bool cur = EnumDisplaySettings(d.DeviceName, ENUM_CURRENT_SETTINGS, ref m);
            sb.AppendFormat("{0} | {1} | flags=0x{2:X} | {3}\n", d.DeviceName, d.DeviceString, d.StateFlags,
                cur ? string.Format("{0}x{1}@{2} orient={3}", m.dmPelsWidth, m.dmPelsHeight, m.dmDisplayFrequency, m.dmDisplayOrientation) : "inactive");
        }
        sb.AppendFormat("virtual screen {0}x{1}\n", GetSystemMetrics(78), GetSystemMetrics(79));
        return sb.ToString();
    }

    /// 某個螢幕支援的模式(去重)。
    public static string Modes(string device)
    {
        var seen = new HashSet<string>();
        var sb = new StringBuilder();
        var m = NewMode();
        for (int i = 0; EnumDisplaySettings(device, i, ref m); i++)
        {
            string k = string.Format("{0}x{1}@{2}", m.dmPelsWidth, m.dmPelsHeight, m.dmDisplayFrequency);
            if (seen.Add(k)) sb.Append(k).Append(' ');
        }
        return sb.ToString();
    }

    /// 設定模式;portrait=true 時以「旋轉 90°」方式呈現(width/height 是旋轉後的尺寸)。
    /// 回傳 ChangeDisplaySettingsEx 結果碼(0 = 成功,-2 = 不支援此模式)。
    public static int SetMode(string device, int width, int height, int hz, bool rotate)
    {
        var m = NewMode();
        EnumDisplaySettings(device, ENUM_CURRENT_SETTINGS, ref m);
        m.dmPelsWidth = width; m.dmPelsHeight = height; m.dmDisplayFrequency = hz;
        m.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
        if (rotate) { m.dmDisplayOrientation = 1; m.dmFields |= DM_DISPLAYORIENTATION; }
        int test = ChangeDisplaySettingsEx(device, ref m, IntPtr.Zero, CDS_TEST, IntPtr.Zero);
        if (test != 0) return test;
        return ChangeDisplaySettingsEx(device, ref m, IntPtr.Zero, CDS_UPDATEREGISTRY, IntPtr.Zero);
    }

    /// 旋轉測試:目前模式分別試 90°/270°,寬高對調與不對調,回傳各自結果碼(只 CDS_TEST,不真的套用)。
    public static string TryRotate(string device)
    {
        var sb = new StringBuilder();
        foreach (int o in new[] { 1, 3 })
            foreach (bool swap in new[] { true, false })
            {
                var m = NewMode();
                EnumDisplaySettings(device, ENUM_CURRENT_SETTINGS, ref m);
                if (swap) { int t = m.dmPelsWidth; m.dmPelsWidth = m.dmPelsHeight; m.dmPelsHeight = t; }
                m.dmDisplayOrientation = o;
                m.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYORIENTATION;
                sb.AppendFormat("orient={0} swap={1} -> {2}; ", o, swap, ChangeDisplaySettingsEx(device, ref m, IntPtr.Zero, CDS_TEST, IntPtr.Zero));
            }
        return sb.ToString();
    }

    public static string Screenshot(string path)
    {
        int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = GetSystemMetrics(78), h = GetSystemMetrics(79);
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
            bmp.Save(path, ImageFormat.Png);
            // 粗略判斷黑畫面(抽樣平均亮度)。
            long sum = 0; int n = 0;
            for (int yy = 0; yy < h; yy += Math.Max(1, h / 40))
                for (int xx = 0; xx < w; xx += Math.Max(1, w / 40)) { var c = bmp.GetPixel(xx, yy); sum += c.R + c.G + c.B; n++; }
            return string.Format("{0}x{1} meanLuma={2}", w, h, n > 0 ? sum / (3 * n) : 0);
        }
    }

    public static void Click(int x, int y)
    {
        SetCursorPos(x, y);
        mouse_event(0x0002, 0, 0, 0, IntPtr.Zero); // LEFTDOWN
        System.Threading.Thread.Sleep(60);
        mouse_event(0x0004, 0, 0, 0, IntPtr.Zero); // LEFTUP
    }

    /// 可見的頂層視窗:標題、位置大小、pid。
    public static string Windows()
    {
        var sb = new StringBuilder();
        EnumWindows(delegate (IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            var t = new StringBuilder(256); GetWindowText(h, t, 256);
            if (t.Length == 0) return true;
            RECT r; GetWindowRect(h, out r); int pid; GetWindowThreadProcessId(h, out pid);
            sb.AppendFormat("0x{0:X} pid={1} [{2},{3} {4}x{5}] {6}\n", h.ToInt64(), pid, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, t);
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    public static string Foreground()
    {
        var h = GetForegroundWindow(); var t = new StringBuilder(256); GetWindowText(h, t, 256);
        RECT r; GetWindowRect(h, out r);
        return string.Format("0x{0:X} [{1},{2} {3}x{4}] {5}", h.ToInt64(), r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, t);
    }

    public static bool Focus(long hwnd) { return SetForegroundWindow(new IntPtr(hwnd)); }

    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, int flags);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    /// 把視窗的「客戶區」(遊戲實際繪製的區域)調成剛好 w×h,放在 (x,y)。回傳調整後的客戶區位置與大小。
    public static string SetClientSize(long hwnd, int x, int y, int w, int h)
    {
        var hw = new IntPtr(hwnd);
        RECT wr, cr;
        GetWindowRect(hw, out wr); GetClientRect(hw, out cr);
        int borderW = (wr.Right - wr.Left) - (cr.Right - cr.Left);
        int borderH = (wr.Bottom - wr.Top) - (cr.Bottom - cr.Top);
        SetWindowPos(hw, IntPtr.Zero, x, y, w + borderW, h + borderH, 0x0004 /*NOZORDER*/);
        System.Threading.Thread.Sleep(500);
        GetClientRect(hw, out cr);
        var p = new POINT(); ClientToScreen(hw, ref p);
        return string.Format("client at ({0},{1}) {2}x{3}", p.X, p.Y, cr.Right, cr.Bottom);
    }

    /// 只截某個矩形(遊戲客戶區)。
    public static string ScreenshotRect(string path, int x, int y, int w, int h)
    {
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
            bmp.Save(path, ImageFormat.Png);
            return string.Format("{0}x{1}", w, h);
        }
    }

    static DEVMODE NewMode() { var m = new DEVMODE(); m.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); return m; }
}

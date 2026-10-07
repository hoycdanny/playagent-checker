// Windows 主機輸入 / 截圖 helper(PowerShell Add-Type 編譯,C# 5 語法;不需要 .NET SDK)。
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
}

using System.ComponentModel;
using System.Runtime.InteropServices;

namespace HappierCodexBridge;

internal sealed class CodexRightClickHook : IDisposable
{
    private readonly NativeMethods.HookProc _callback;
    private IntPtr _hook;

    public event Action<System.Drawing.Point>? RightClicked;

    public CodexRightClickHook()
    {
        _callback = OnHook;
        _hook = NativeMethods.SetWindowsHookEx(NativeMethods.WhMouseLl, _callback, IntPtr.Zero, 0);
        if (_hook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法安装鼠标右键监听");
    }

    private IntPtr OnHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0 && wParam.ToInt32() == NativeMethods.WmRButtonUp && CodexSidebarAutomation.IsCodexForegroundWindow())
        {
            var data = Marshal.PtrToStructure<NativeMethods.MouseHookStruct>(lParam);
            RightClicked?.Invoke(new System.Drawing.Point(data.Point.X, data.Point.Y));
        }
        return NativeMethods.CallNextHookEx(_hook, code, wParam, lParam);
    }

    public void Dispose()
    {
        if (_hook == IntPtr.Zero) return;
        NativeMethods.UnhookWindowsHookEx(_hook);
        _hook = IntPtr.Zero;
    }
}

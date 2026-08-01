using System.ComponentModel;
using System.Runtime.InteropServices;

namespace HappierCodexBridge;

internal sealed class CodexRightClickHook : IDisposable
{
    private readonly NativeMethods.HookProc _callback;
    private IntPtr _hook;
    private bool _suppressLeftButtonUp;

    public Func<System.Drawing.Point, bool>? LeftClickIntercepted { get; set; }
    public event Action<System.Drawing.Point>? RightButtonPressed;

    public CodexRightClickHook()
    {
        _callback = OnHook;
        _hook = NativeMethods.SetWindowsHookEx(NativeMethods.WhMouseLl, _callback, IntPtr.Zero, 0);
        if (_hook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法安装鼠标右键监听");
    }

    private IntPtr OnHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0) return NativeMethods.CallNextHookEx(_hook, code, wParam, lParam);

        var message = wParam.ToInt32();
        var leftClickInterceptor = LeftClickIntercepted;
        if (message == NativeMethods.WmLButtonDown && leftClickInterceptor is not null)
        {
            var data = Marshal.PtrToStructure<NativeMethods.MouseHookStruct>(lParam);
            var point = new System.Drawing.Point(data.Point.X, data.Point.Y);
            _suppressLeftButtonUp = leftClickInterceptor(point);
            if (_suppressLeftButtonUp) return new IntPtr(1);
        }

        if (message == NativeMethods.WmLButtonUp && _suppressLeftButtonUp)
        {
            _suppressLeftButtonUp = false;
            return new IntPtr(1);
        }

        if (message == NativeMethods.WmRButtonDown)
        {
            var data = Marshal.PtrToStructure<NativeMethods.MouseHookStruct>(lParam);
            BridgeDiagnostics.Write("hook_right_down_passthrough");
            RightButtonPressed?.Invoke(new System.Drawing.Point(data.Point.X, data.Point.Y));
        }

        // Codex must always receive the complete native right-click gesture. The
        // bridge only consumes a later left click inside its separate sidecar row.
        return NativeMethods.CallNextHookEx(_hook, code, wParam, lParam);
    }

    public void Dispose()
    {
        if (_hook == IntPtr.Zero) return;
        NativeMethods.UnhookWindowsHookEx(_hook);
        _hook = IntPtr.Zero;
    }
}

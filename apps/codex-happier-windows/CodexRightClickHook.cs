using System.ComponentModel;
using System.Runtime.InteropServices;

namespace HappierCodexBridge;

internal sealed class CodexRightClickHook : IDisposable
{
    private readonly NativeMethods.HookProc _callback;
    private readonly MouseHookGestureRouter _router = new();
    private IntPtr _hook;

    public Func<System.Drawing.Point, bool>? LeftClickIntercepted
    {
        get => _router.LeftClickIntercepted;
        set => _router.LeftClickIntercepted = value;
    }

    public event Action<System.Drawing.Point>? RightButtonPressed
    {
        add => _router.RightButtonPressed += value;
        remove => _router.RightButtonPressed -= value;
    }

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
        var data = Marshal.PtrToStructure<NativeMethods.MouseHookStruct>(lParam);
        var point = new System.Drawing.Point(data.Point.X, data.Point.Y);
        if (message == NativeMethods.WmRButtonDown)
        {
            BridgeDiagnostics.Write("hook_right_down_passthrough");
        }
        if (_router.ShouldSuppress(message, point)) return new IntPtr(1);

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

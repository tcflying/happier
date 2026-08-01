using System.ComponentModel;
using System.Runtime.InteropServices;

namespace HappierCodexBridge;

internal sealed class CodexRightClickHook : IDisposable
{
    private readonly NativeMethods.HookProc _callback;
    private IntPtr _hook;
    private bool _suppressRightButtonUp;

    public Func<System.Drawing.Point, bool>? RightClickIntercepted { get; set; }
    public event Action<System.Drawing.Point>? PointerPressed;

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
        if (message == NativeMethods.WmLButtonDown || message == NativeMethods.WmRButtonDown)
        {
            var pressed = Marshal.PtrToStructure<NativeMethods.MouseHookStruct>(lParam);
            PointerPressed?.Invoke(new System.Drawing.Point(pressed.Point.X, pressed.Point.Y));
        }

        // Chromium can dispatch its contextmenu event on right-button down. Waiting
        // until button-up lets the native Codex menu appear underneath our menu.
        // Decide on button-down and suppress the matching button-up as one gesture.
        if (message == NativeMethods.WmRButtonDown)
        {
            var data = Marshal.PtrToStructure<NativeMethods.MouseHookStruct>(lParam);
            var point = new System.Drawing.Point(data.Point.X, data.Point.Y);
            BridgeDiagnostics.Write("hook_right_down");
            _suppressRightButtonUp = RightClickIntercepted?.Invoke(point) == true;
            if (_suppressRightButtonUp) return new IntPtr(1);
        }

        if (message == NativeMethods.WmRButtonUp && _suppressRightButtonUp)
        {
            _suppressRightButtonUp = false;
            return new IntPtr(1);
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

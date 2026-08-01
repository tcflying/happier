using System.Drawing;
using System.Windows.Forms;

namespace HappierCodexBridge;

internal static class RightClickPassThroughTest
{
    public static int Run()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        using var context = new ApplicationContext();
        using var form = new Form
        {
            StartPosition = FormStartPosition.Manual,
            Bounds = new Rectangle(240, 180, 320, 180),
            ShowInTaskbar = false,
            TopMost = true,
        };
        using var nativeMenu = new ContextMenuStrip();
        using var hook = new CodexRightClickHook();
        nativeMenu.Items.Add("原生菜单");

        var observed = 0;
        var targetReceivedRightDown = 0;
        var expectedWindow = IntPtr.Zero;
        var windowAtPoint = IntPtr.Zero;
        hook.RightButtonPressed += _ => Interlocked.Increment(ref observed);
        form.MouseDown += (_, eventArgs) =>
        {
            if (eventArgs.Button != MouseButtons.Right) return;
            Interlocked.Increment(ref targetReceivedRightDown);
            nativeMenu.Show(form, eventArgs.Location);
        };

        NativeMethods.GetCursorPos(out var originalCursor);
        form.Shown += (_, _) =>
        {
            form.Activate();
            form.BringToFront();
            expectedWindow = form.Handle;
            var point = form.PointToScreen(new Point(form.ClientSize.Width / 2, form.ClientSize.Height / 2));
            _ = Task.Run(async () =>
            {
                await Task.Delay(100);
                NativeMethods.SetCursorPos(point.X, point.Y);
                var targetWindow = NativeMethods.WindowFromPoint(new NativeMethods.Point { X = point.X, Y = point.Y });
                windowAtPoint = NativeMethods.GetAncestor(targetWindow, NativeMethods.GaRoot);
                NativeMethods.mouse_event(NativeMethods.MouseEventRightDown, 0, 0, 0, UIntPtr.Zero);
                NativeMethods.mouse_event(NativeMethods.MouseEventRightUp, 0, 0, 0, UIntPtr.Zero);
                await Task.Delay(250);
                form.BeginInvoke(context.ExitThread);
            });
        };

        context.MainForm = form;
        Application.Run(context);
        NativeMethods.SetCursorPos(originalCursor.X, originalCursor.Y);

        if (observed != 1) throw new InvalidOperationException($"右键观察次数不正确: {observed}");
        if (targetReceivedRightDown != 1)
        {
            throw new InvalidOperationException(
                $"Codex 原生右键没有收到完整的右键按下事件: observed={observed};received={targetReceivedRightDown};expected=0x{expectedWindow.ToInt64():X};actual=0x{windowAtPoint.ToInt64():X}");
        }
        Console.WriteLine("RIGHT_CLICK_PASSTHROUGH_TEST=PASS");
        return 0;
    }
}

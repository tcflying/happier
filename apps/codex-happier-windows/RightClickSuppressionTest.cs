using System.Drawing;
using System.Windows.Forms;

namespace HappierCodexBridge;

internal static class RightClickSuppressionTest
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
        };
        using var nativeMenu = new ContextMenuStrip();
        using var hook = new CodexRightClickHook();
        nativeMenu.Items.Add("原生菜单");

        var intercepted = 0;
        var targetReceivedRightDown = 0;
        hook.RightClickIntercepted = _ =>
        {
            Interlocked.Increment(ref intercepted);
            return true;
        };
        form.MouseDown += (_, eventArgs) =>
        {
            if (eventArgs.Button != MouseButtons.Right) return;
            Interlocked.Increment(ref targetReceivedRightDown);
            nativeMenu.Show(form, eventArgs.Location);
        };

        NativeMethods.GetCursorPos(out var originalCursor);
        form.Shown += (_, _) =>
        {
            var point = form.PointToScreen(new Point(form.ClientSize.Width / 2, form.ClientSize.Height / 2));
            _ = Task.Run(async () =>
            {
                await Task.Delay(100);
                NativeMethods.SetCursorPos(point.X, point.Y);
                NativeMethods.mouse_event(NativeMethods.MouseEventRightDown, 0, 0, 0, UIntPtr.Zero);
                NativeMethods.mouse_event(NativeMethods.MouseEventRightUp, 0, 0, 0, UIntPtr.Zero);
                await Task.Delay(250);
                form.BeginInvoke(context.ExitThread);
            });
        };

        context.MainForm = form;
        Application.Run(context);
        NativeMethods.SetCursorPos(originalCursor.X, originalCursor.Y);

        if (intercepted != 1) throw new InvalidOperationException($"右键拦截次数不正确: {intercepted}");
        if (targetReceivedRightDown != 0 || nativeMenu.Visible)
        {
            throw new InvalidOperationException("被拦截的右键仍然触发了目标应用原生菜单");
        }
        Console.WriteLine("RIGHT_CLICK_SUPPRESSION_TEST=PASS");
        return 0;
    }
}

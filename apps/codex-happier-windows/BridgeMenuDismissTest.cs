using System.Drawing;
using System.Windows.Forms;

namespace HappierCodexBridge;

internal static class BridgeMenuDismissTest
{
    public static int Run()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        using var context = new ApplicationContext();
        using var menu = new ContextMenuStrip();
        using var hook = new CodexRightClickHook();
        menu.Items.Add("导入到 Happier 直连");
        var opened = false;
        var closed = false;
        NativeMethods.GetCursorPos(out var originalCursor);

        hook.PointerPressed += point =>
        {
            if (menu.Visible && !menu.Bounds.Contains(point)) menu.Close();
        };
        menu.Opened += (_, _) =>
        {
            opened = true;
            var outside = new Point(menu.Right + 60, menu.Bottom + 60);
            _ = Task.Run(async () =>
            {
                await Task.Delay(100);
                NativeMethods.SetCursorPos(outside.X, outside.Y);
                NativeMethods.mouse_event(NativeMethods.MouseEventLeftDown, 0, 0, 0, UIntPtr.Zero);
                NativeMethods.mouse_event(NativeMethods.MouseEventLeftUp, 0, 0, 0, UIntPtr.Zero);
            });
        };
        menu.Closed += (_, _) =>
        {
            closed = true;
            context.ExitThread();
        };

        using var openTimer = new System.Windows.Forms.Timer { Interval = 50 };
        openTimer.Tick += (_, _) =>
        {
            openTimer.Stop();
            menu.Show(new Point(100, 100));
        };
        using var watchdog = new System.Windows.Forms.Timer { Interval = 2_000 };
        watchdog.Tick += (_, _) =>
        {
            watchdog.Stop();
            context.ExitThread();
        };
        openTimer.Start();
        watchdog.Start();
        Application.Run(context);
        NativeMethods.SetCursorPos(originalCursor.X, originalCursor.Y);

        if (!opened || !closed) throw new InvalidOperationException("点击菜单外部后菜单没有自动收起");
        Console.WriteLine("MENU_DISMISS_TEST=PASS");
        return 0;
    }
}

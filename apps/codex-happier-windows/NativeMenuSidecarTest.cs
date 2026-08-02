using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace HappierCodexBridge;

internal static class NativeMenuSidecarTest
{
    public static int Run()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var processPath = Environment.ProcessPath ?? throw new InvalidOperationException("无法确定测试进程路径");
        var runningViaDotnet = string.Equals(Path.GetFileNameWithoutExtension(processPath), "dotnet", StringComparison.OrdinalIgnoreCase);
        var startInfo = new ProcessStartInfo(processPath)
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        };
        if (runningViaDotnet) startInfo.ArgumentList.Add(Environment.GetCommandLineArgs()[0]);
        startInfo.ArgumentList.Add("--native-menu-sidecar-test-host");
        using var host = Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动原生菜单测试宿主");
        try
        {
            var nativeMenu = NativePopupMenuLocator.WaitForAsync(new Point(102, 102), host.Id, TimeSpan.FromSeconds(4)).GetAwaiter().GetResult();
            if (nativeMenu is null) throw new InvalidOperationException("找不到跨进程测试用原生弹出菜单窗口");
            using var sidecar = new HappierMenuSidecar(nativeMenu.Bounds);
            using var hook = new CodexRightClickHook();
            sidecar.ShowAttachedTo(nativeMenu.Handle);
            Application.DoEvents();
            if (sidecar.Bounds.IntersectsWith(nativeMenu.Bounds)) throw new InvalidOperationException("Happier 追加行遮挡了原生菜单");
            if (!NativeMethods.IsWindowVisible(nativeMenu.Handle)) throw new InvalidOperationException("显示 Happier 追加行时关闭了原生菜单");
            if (!NativeMethods.IsWindowVisible(sidecar.Handle)) throw new InvalidOperationException("跨进程绑定后 Happier 追加行不可见");

            var sidecarClicked = false;
            hook.LeftClickIntercepted = point =>
            {
                if (!sidecar.Bounds.Contains(point)) return false;
                sidecarClicked = true;
                NativePopupMenuLocator.Dismiss(nativeMenu);
                return true;
            };
            NativeMethods.GetCursorPos(out var originalCursor);
            var sidecarCenter = new Point(sidecar.Left + sidecar.Width / 2, sidecar.Top + sidecar.Height / 2);
            _ = Task.Run(async () =>
            {
                await Task.Delay(50);
                NativeMethods.SetCursorPos(sidecarCenter.X, sidecarCenter.Y);
                NativeMethods.mouse_event(NativeMethods.MouseEventLeftDown, 0, 0, 0, UIntPtr.Zero);
                NativeMethods.mouse_event(NativeMethods.MouseEventLeftUp, 0, 0, 0, UIntPtr.Zero);
            });
            for (var attempt = 0; attempt < 100 && !sidecarClicked; attempt++)
            {
                Application.DoEvents();
                Thread.Sleep(10);
            }
            NativeMethods.SetCursorPos(originalCursor.X, originalCursor.Y);
            if (!sidecarClicked) throw new InvalidOperationException("Happier 追加行没有截获自己的点击");
            sidecar.Hide();
            if (!host.WaitForExit(3_000)) throw new InvalidOperationException("关闭原生菜单后测试宿主没有退出");
            Console.WriteLine("NATIVE_MENU_SIDECAR_TEST=PASS");
            return 0;
        }
        finally
        {
            if (!host.HasExited) host.Kill(entireProcessTree: true);
        }
    }

    public static int RunHost(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using var context = new ApplicationContext();
        using var menu = new ContextMenuStrip();
        menu.Items.Add("Codex 原生菜单项");
        menu.Closed += (_, _) => context.ExitThread();
        using var openTimer = new System.Windows.Forms.Timer { Interval = 50 };
        openTimer.Tick += (_, _) =>
        {
            openTimer.Stop();
            menu.Show(new Point(100, 100));
        };
        using var watchdog = new System.Windows.Forms.Timer { Interval = 6_000 };
        watchdog.Tick += (_, _) =>
        {
            watchdog.Stop();
            context.ExitThread();
        };
        openTimer.Start();
        watchdog.Start();
        Application.Run(context);
        return 0;
    }
}

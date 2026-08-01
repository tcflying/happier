using System.Drawing;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace HappierCodexBridge;

internal static class NativeMenuThreadIdTest
{
    public static int Run()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        const string expectedThreadId = "019fb8c7-3c74-71b0-8198-8c357f82c6e1";
        const string clipboardSentinel = "HAPPIER_CLIPBOARD_RESTORE_TEST";
        Clipboard.SetText(clipboardSentinel);
        var processPath = Environment.ProcessPath ?? throw new InvalidOperationException("无法确定测试进程路径");
        var runningViaDotnet = string.Equals(Path.GetFileNameWithoutExtension(processPath), "dotnet", StringComparison.OrdinalIgnoreCase);
        var startInfo = new ProcessStartInfo(processPath)
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        };
        if (runningViaDotnet) startInfo.ArgumentList.Add(Environment.GetCommandLineArgs()[0]);
        startInfo.ArgumentList.Add("--native-menu-id-test-host");
        startInfo.ArgumentList.Add(expectedThreadId);
        using var host = Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动原生菜单测试宿主");
        try
        {
            var nativeMenu = NativePopupMenuLocator.WaitForAsync(new Point(102, 102), host.Id, TimeSpan.FromSeconds(4)).GetAwaiter().GetResult();
            if (nativeMenu is null) throw new InvalidOperationException("找不到跨进程测试用原生弹出菜单窗口");
            using var sidecar = new HappierMenuSidecar(nativeMenu.Bounds);
            using var hook = new CodexRightClickHook();
            sidecar.Show();
            Application.DoEvents();
            if (sidecar.Bounds.IntersectsWith(nativeMenu.Bounds))
            {
                throw new InvalidOperationException("Happier 追加行遮挡了原生菜单");
            }
            if (!NativeMethods.IsWindowVisible(nativeMenu.Handle))
            {
                throw new InvalidOperationException("显示 Happier 追加行时关闭了原生菜单");
            }

            var sidecarClicked = false;
            hook.LeftClickIntercepted = point =>
            {
                if (!sidecar.Bounds.Contains(point)) return false;
                sidecarClicked = true;
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
            if (!NativeMethods.IsWindowVisible(nativeMenu.Handle))
            {
                throw new InvalidOperationException("点击 Happier 追加行时原生菜单被提前关闭");
            }
            sidecar.Hide();
            var capturedThreadId = CodexNativeMenuThreadIdReader.Read(nativeMenu.Handle);
            if (!string.Equals(capturedThreadId, expectedThreadId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("没有从跨进程原生菜单取得正确的会话 ID");
            }
            if (!string.Equals(Clipboard.GetText(), clipboardSentinel, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("读取会话 ID 后没有恢复原剪贴板文本");
            }
            if (!host.WaitForExit(3_000)) throw new InvalidOperationException("原生菜单测试宿主没有在点击后退出");
            Console.WriteLine("NATIVE_MENU_ID_TEST=PASS");
            return 0;
        }
        finally
        {
            if (!host.HasExited) host.Kill(entireProcessTree: true);
        }
    }

    public static int RunHost(string[] args)
    {
        var idIndex = Array.FindIndex(args, value => string.Equals(value, "--native-menu-id-test-host", StringComparison.OrdinalIgnoreCase));
        if (idIndex < 0 || idIndex + 1 >= args.Length) return 2;
        var threadId = args[idIndex + 1];
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using var context = new ApplicationContext();
        using var menu = new ContextMenuStrip();
        menu.Items.Add("复制会话 ID", null, (_, _) => Clipboard.SetText(threadId));
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

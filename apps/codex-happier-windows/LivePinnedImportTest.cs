using System.Drawing;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text;
using System.Windows.Forms;

namespace HappierCodexBridge;

internal static class LivePinnedImportTest
{
    public static int Run(string title)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        EnsureDesktopUnlocked();
        using var codexWindow = ActivateCodexWindow();
        var target = CodexSidebarAutomation.FindTargetByTitle(title)
            ?? throw new InvalidOperationException($"当前 Codex 侧栏找不到任务：{title}");
        var expected = new CodexPinnedThreadResolver(new CodexThreadStore()).Resolve(target);
        var statusPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Happier",
            "CodexBridge",
            "status.json");
        var startedAt = DateTimeOffset.Now.AddMilliseconds(-100);
        NativeMethods.GetCursorPos(out var originalCursor);
        var targetPoint = new Point(
            target.Bounds.Left + target.Bounds.Width / 2,
            target.Bounds.Top + target.Bounds.Height / 2);
        var targetExposed = WaitUntil(() => IsCodexAtPoint(targetPoint), TimeSpan.FromSeconds(3));
        if (!targetExposed)
        {
            throw new InvalidOperationException($"Codex 任务行仍被其他窗口遮挡：{DescribeWindowAtPoint(targetPoint)}");
        }

        try
        {
            NativeMethods.SetCursorPos(targetPoint.X, targetPoint.Y);
            NativeMethods.mouse_event(NativeMethods.MouseEventRightDown, 0, 0, 0, UIntPtr.Zero);
            NativeMethods.mouse_event(NativeMethods.MouseEventRightUp, 0, 0, 0, UIntPtr.Zero);

            var shown = WaitForStatus(
                statusPath,
                status => status.UpdatedAt >= startedAt
                    && string.Equals(status.Stage, "native_menu_sidecar_shown", StringComparison.Ordinal)
                    && status.Details?.Contains($"title={title}", StringComparison.Ordinal) == true,
                TimeSpan.FromSeconds(6));
            var nativeBounds = ParseBounds(shown.Details!, "native");
            var sidecarBounds = ParseBounds(shown.Details!, "sidecar");
            if (nativeBounds.IntersectsWith(sidecarBounds))
            {
                throw new InvalidOperationException("真实 Codex 菜单被 Happier 追加项遮挡");
            }
            var nativeMenu = NativePopupMenuLocator.Find(targetPoint, target.ProcessId);
            if (nativeMenu is null || !NativeMethods.IsWindowVisible(nativeMenu.Handle))
            {
                throw new InvalidOperationException("Happier 追加项显示时 Codex 原生菜单已经消失");
            }

            var sidecarPoint = new Point(
                sidecarBounds.Left + sidecarBounds.Width / 2,
                sidecarBounds.Top + sidecarBounds.Height / 2);
            NativeMethods.SetCursorPos(sidecarPoint.X, sidecarPoint.Y);
            NativeMethods.mouse_event(NativeMethods.MouseEventLeftDown, 0, 0, 0, UIntPtr.Zero);
            NativeMethods.mouse_event(NativeMethods.MouseEventLeftUp, 0, 0, 0, UIntPtr.Zero);

            var imported = WaitForStatus(
                statusPath,
                status => status.UpdatedAt >= shown.UpdatedAt
                    && string.Equals(status.Stage, "import_succeeded", StringComparison.Ordinal)
                    && status.Details?.Contains($"threadId={expected.Id}", StringComparison.OrdinalIgnoreCase) == true,
                TimeSpan.FromSeconds(30));
            var menuClosed = WaitUntil(
                () => NativePopupMenuLocator.Find(targetPoint, target.ProcessId) is null,
                TimeSpan.FromSeconds(3));
            if (!menuClosed) throw new InvalidOperationException("导入后 Codex 原生菜单没有收起");

            var sessionId = Regex.Match(imported.Details ?? string.Empty, @"(?:^|;)sessionId=([^;]+)").Groups[1].Value;
            if (string.IsNullOrWhiteSpace(sessionId)) throw new InvalidOperationException("导入成功状态缺少 Happier session ID");
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                status = "LIVE_PINNED_IMPORT_TEST=PASS",
                expected.Id,
                expected.Name,
                SessionId = sessionId,
                NativeMenuPreserved = true,
                NonOverlapping = true,
                NativeMenuClosed = true,
            }));
            return 0;
        }
        finally
        {
            NativeMethods.SetCursorPos(originalCursor.X, originalCursor.Y);
        }
    }

    private static void EnsureDesktopUnlocked()
    {
        var screen = SystemInformation.VirtualScreen;
        var sample = new NativeMethods.Point
        {
            X = screen.Left + screen.Width / 2,
            Y = screen.Top + screen.Height / 2,
        };
        var window = NativeMethods.WindowFromPoint(sample);
        if (window == IntPtr.Zero) return;
        var root = NativeMethods.GetAncestor(window, NativeMethods.GaRoot);
        var className = new StringBuilder(128);
        NativeMethods.GetClassName(root, className, className.Capacity);
        if (string.Equals(className.ToString(), "LockScreenBackstopFrame", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Windows 桌面已锁定；请解锁后再运行真实 Codex 导入测试");
        }
    }

    private static CodexWindowLease ActivateCodexWindow()
    {
        var previousWindow = NativeMethods.GetForegroundWindow();
        using var process = Process.GetProcessesByName("ChatGPT")
            .FirstOrDefault(candidate => candidate.MainWindowHandle != IntPtr.Zero)
            ?? throw new InvalidOperationException("找不到 Codex Desktop 主窗口");
        var handle = process.MainWindowHandle;
        NativeMethods.ShowWindow(handle, NativeMethods.SwRestore);
        NativeMethods.SwitchToThisWindow(handle, altTab: true);
        Thread.Sleep(500);
        return new CodexWindowLease(previousWindow);
    }

    private static bool IsCodexAtPoint(Point point)
    {
        var nativePoint = new NativeMethods.Point { X = point.X, Y = point.Y };
        var window = NativeMethods.WindowFromPoint(nativePoint);
        if (window == IntPtr.Zero) return false;
        var root = NativeMethods.GetAncestor(window, NativeMethods.GaRoot);
        NativeMethods.GetWindowThreadProcessId(root, out var processId);
        try
        {
            using var process = Process.GetProcessById((int)processId);
            return string.Equals(process.ProcessName, "ChatGPT", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static string DescribeWindowAtPoint(Point point)
    {
        var nativePoint = new NativeMethods.Point { X = point.X, Y = point.Y };
        var window = NativeMethods.WindowFromPoint(nativePoint);
        if (window == IntPtr.Zero) return "no-window";
        var root = NativeMethods.GetAncestor(window, NativeMethods.GaRoot);
        NativeMethods.GetWindowThreadProcessId(root, out var processId);
        try
        {
            using var process = Process.GetProcessById((int)processId);
            return $"{process.ProcessName} pid={processId} hwnd=0x{root.ToInt64():X}";
        }
        catch
        {
            return $"pid={processId} hwnd=0x{root.ToInt64():X}";
        }
    }

    private static BridgeStatus WaitForStatus(
        string path,
        Func<BridgeStatus, bool> predicate,
        TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        BridgeStatus? latest = null;
        while (DateTime.UtcNow < deadline)
        {
            latest = TryReadStatus(path) ?? latest;
            if (latest is not null)
            {
                if (predicate(latest)) return latest;
                if (latest.Stage is "native_menu_attach_failed" or "native_menu_sidecar_failed" or "import_failed")
                {
                    throw new InvalidOperationException($"桥接失败：{latest.Stage}：{latest.Details}");
                }
            }
            Thread.Sleep(20);
        }
        throw new TimeoutException($"等待桥接状态超时；最后状态：{latest?.Stage}：{latest?.Details}");
    }

    private static BridgeStatus? TryReadStatus(string path)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;
            return new BridgeStatus(
                root.GetProperty("stage").GetString() ?? string.Empty,
                root.GetProperty("updatedAt").GetDateTimeOffset(),
                root.TryGetProperty("error", out var details) && details.ValueKind == JsonValueKind.String
                    ? details.GetString()
                    : null);
        }
        catch (IOException)
        {
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static Rectangle ParseBounds(string details, string label)
    {
        var match = Regex.Match(
            details,
            $@"{Regex.Escape(label)}=\{{X=(?<x>-?\d+),Y=(?<y>-?\d+),Width=(?<w>\d+),Height=(?<h>\d+)\}}");
        if (!match.Success) throw new InvalidOperationException($"桥接状态缺少 {label} 边界：{details}");
        return new Rectangle(
            int.Parse(match.Groups["x"].Value),
            int.Parse(match.Groups["y"].Value),
            int.Parse(match.Groups["w"].Value),
            int.Parse(match.Groups["h"].Value));
    }

    private static bool WaitUntil(Func<bool> predicate, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (predicate()) return true;
            Thread.Sleep(20);
        }
        return false;
    }

    private sealed record BridgeStatus(string Stage, DateTimeOffset UpdatedAt, string? Details);

    private sealed class CodexWindowLease : IDisposable
    {
        private readonly IntPtr _previousWindow;

        public CodexWindowLease(IntPtr previousWindow)
        {
            _previousWindow = previousWindow;
        }

        public void Dispose()
        {
            if (_previousWindow != IntPtr.Zero && NativeMethods.IsWindow(_previousWindow))
            {
                NativeMethods.SwitchToThisWindow(_previousWindow, altTab: true);
            }
        }
    }
}

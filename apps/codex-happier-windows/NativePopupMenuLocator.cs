using System.Diagnostics;
using System.Drawing;
using System.Text;

namespace HappierCodexBridge;

internal static class NativePopupMenuLocator
{
    public static async Task<NativePopupMenu?> WaitForAsync(
        Point origin,
        int ownerProcessId,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < timeout)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var menu = Find(origin, ownerProcessId);
            if (menu is not null) return menu;
            await Task.Delay(15, cancellationToken);
        }
        return null;
    }

    internal static NativePopupMenu? Find(Point origin, int ownerProcessId)
    {
        NativePopupMenu? best = null;
        var bestScore = int.MaxValue;
        NativeMethods.EnumWindows((window, _) =>
        {
            if (!NativeMethods.IsWindowVisible(window)) return true;
            NativeMethods.GetWindowThreadProcessId(window, out var processId);
            if (!IsSameProcessFamily((int)processId, ownerProcessId)) return true;

            var classNameBuffer = new StringBuilder(128);
            NativeMethods.GetClassName(window, classNameBuffer, classNameBuffer.Capacity);
            var className = classNameBuffer.ToString();
            var isNativeMenu = string.Equals(className, "#32768", StringComparison.Ordinal);
            var isChromiumPopup = className.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal);
            var isWinFormsPopup = className.StartsWith("WindowsForms10.", StringComparison.Ordinal);
            if (!isNativeMenu && !isChromiumPopup && !isWinFormsPopup) return true;
            if (!NativeMethods.GetWindowRect(window, out var nativeRectangle)) return true;
            var bounds = nativeRectangle.ToRectangle();
            if (bounds.Width < 80 || bounds.Height < 20 || bounds.Width > 700 || bounds.Height > 1_000) return true;

            var distance = DistanceTo(bounds, origin);
            if (distance > 96) return true;
            var score = distance + (isNativeMenu ? 0 : 1_000);
            if (score >= bestScore) return true;
            bestScore = score;
            best = new NativePopupMenu(window, bounds);
            return true;
        }, IntPtr.Zero);
        return best;
    }

    private static int DistanceTo(Rectangle bounds, Point point)
    {
        var horizontal = point.X < bounds.Left ? bounds.Left - point.X : point.X > bounds.Right ? point.X - bounds.Right : 0;
        var vertical = point.Y < bounds.Top ? bounds.Top - point.Y : point.Y > bounds.Bottom ? point.Y - bounds.Bottom : 0;
        return horizontal + vertical;
    }

    private static bool IsSameProcessFamily(int candidateProcessId, int ownerProcessId)
    {
        if (candidateProcessId == ownerProcessId) return true;
        try
        {
            using var candidate = Process.GetProcessById(candidateProcessId);
            using var owner = Process.GetProcessById(ownerProcessId);
            return string.Equals(candidate.ProcessName, owner.ProcessName, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }
}

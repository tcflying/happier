using System.Diagnostics;
using System.Windows.Automation;
using DrawingPoint = System.Drawing.Point;

namespace HappierCodexBridge;

internal static class CodexSidebarAutomation
{
    public static string? FindTitleAtPoint(DrawingPoint point)
    {
        try
        {
            var current = AutomationElement.FromPoint(new System.Windows.Point(point.X, point.Y));
            if (!IsCodexProcess(current.Current.ProcessId)) return null;
            for (var depth = 0; current is not null && depth < 12; depth++)
            {
                var name = current.Current.Name?.Trim();
                if (!string.IsNullOrWhiteSpace(name) && name.Length <= 512) return name;
                current = TreeWalker.ControlViewWalker.GetParent(current);
            }
        }
        catch (ElementNotAvailableException)
        {
            return null;
        }
        return null;
    }

    public static IReadOnlyList<string> FindSidebarTitleCandidates()
    {
        var root = FindCodexRoot();
        if (root is null) return [];
        var values = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var elements = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        for (var index = 0; index < elements.Count; index++)
        {
            try
            {
                var element = elements[index];
                var bounds = element.Current.BoundingRectangle;
                var name = element.Current.Name?.Trim();
                if (element.Current.IsOffscreen || string.IsNullOrWhiteSpace(name)) continue;
                if (bounds.X < 0 || bounds.X > 420 || bounds.Width < 40 || bounds.Width > 420 || bounds.Height < 16 || bounds.Height > 42) continue;
                if (name.Length > 160 || name.Contains('\n') || name.Contains('\r')) continue;
                values.Add(name);
            }
            catch (ElementNotAvailableException)
            {
                // Ignore rows replaced during a React render.
            }
        }
        return values.ToArray();
    }

    public static IReadOnlyList<VisibleThreadRow> FindVisibleRows(IReadOnlyList<CodexThread> threads)
    {
        var root = FindCodexRoot();
        if (root is null) return [];
        var byTitle = threads
            .GroupBy(thread => thread.Name.Trim(), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.OrderByDescending(item => item.UpdatedAt).First(), StringComparer.OrdinalIgnoreCase);
        var rows = new List<VisibleThreadRow>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var elements = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        for (var index = 0; index < elements.Count; index++)
        {
            try
            {
                var element = elements[index];
                var name = element.Current.Name?.Trim();
                if (string.IsNullOrWhiteSpace(name) || !byTitle.TryGetValue(name, out var thread)) continue;
                var bounds = element.Current.BoundingRectangle;
                if (element.Current.IsOffscreen || bounds.IsEmpty || bounds.Width <= 1 || bounds.Height <= 1) continue;
                var key = $"{thread.Id}:{bounds.X:F0}:{bounds.Y:F0}:{bounds.Width:F0}:{bounds.Height:F0}";
                if (seen.Add(key)) rows.Add(new VisibleThreadRow(thread, bounds));
            }
            catch (ElementNotAvailableException)
            {
                // The sidebar can rerender while it is being enumerated.
            }
        }
        return rows;
    }

    public static CodexThread? FindThreadAtPoint(IReadOnlyList<CodexThread> threads, DrawingPoint point)
    {
        var automationPoint = new System.Windows.Point(point.X, point.Y);
        try
        {
            var current = AutomationElement.FromPoint(automationPoint);
            if (!IsCodexProcess(current.Current.ProcessId)) return null;
            for (var depth = 0; current is not null && depth < 12; depth++)
            {
                var name = current.Current.Name?.Trim();
                if (!string.IsNullOrWhiteSpace(name))
                {
                    var exact = ThreadMatcher.FindByTitle(threads, name);
                    if (exact is not null) return exact;
                }
                current = TreeWalker.ControlViewWalker.GetParent(current);
            }
        }
        catch (ElementNotAvailableException)
        {
            // Fall through to rectangle matching.
        }
        return FindVisibleRows(threads)
            .Where(row => row.Bounds.Contains(automationPoint))
            .OrderBy(row => row.Bounds.Width * row.Bounds.Height)
            .Select(row => row.Thread)
            .FirstOrDefault();
    }

    private static bool IsCodexProcess(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return string.Equals(process.ProcessName, "ChatGPT", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    public static bool IsCodexForegroundWindow()
    {
        var window = NativeMethods.GetForegroundWindow();
        if (window == IntPtr.Zero) return false;
        NativeMethods.GetWindowThreadProcessId(window, out var pid);
        try
        {
            using var process = Process.GetProcessById((int)pid);
            return string.Equals(process.ProcessName, "ChatGPT", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static AutomationElement? FindCodexRoot()
    {
        foreach (var process in Process.GetProcessesByName("ChatGPT"))
        {
            using (process)
            {
                if (process.MainWindowHandle == IntPtr.Zero) continue;
                try
                {
                    return AutomationElement.FromHandle(process.MainWindowHandle);
                }
                catch (ElementNotAvailableException)
                {
                    // Try another Codex process.
                }
            }
        }
        return null;
    }
}

using System.Diagnostics;
using System.Windows.Automation;
using DrawingPoint = System.Drawing.Point;

namespace HappierCodexBridge;

internal static class CodexSidebarAutomation
{
    public static string? FindTitleAtPoint(DrawingPoint point)
        => FindTargetAtPoint(point)?.Title;

    public static CodexSidebarTarget? FindTargetAtPoint(DrawingPoint point)
    {
        try
        {
            var automationPoint = new System.Windows.Point(point.X, point.Y);
            var current = AutomationElement.FromPoint(automationPoint);
            var processId = current.Current.ProcessId;
            if (!IsCodexProcess(processId)) return null;
            for (var depth = 0; current is not null && depth < 12; depth++)
            {
                if (IsThreadListItem(current, automationPoint))
                {
                    return CreateTarget(current, processId);
                }
                current = TreeWalker.ControlViewWalker.GetParent(current);
            }
        }
        catch (ElementNotAvailableException)
        {
            return null;
        }
        return null;
    }

    public static CodexSidebarTarget? FindTargetByTitle(string title)
    {
        var root = FindCodexRoot();
        if (root is null) return null;
        var elements = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        for (var index = 0; index < elements.Count; index++)
        {
            try
            {
                var element = elements[index];
                var current = element.Current;
                if (current.ControlType != ControlType.ListItem
                    || !IsThreadListItemRow(current))
                {
                    continue;
                }
                var stableTitle = ReadStableTitle(element);
                if (!string.Equals(stableTitle, title.Trim(), StringComparison.Ordinal)) continue;
                return CreateTarget(element, current.ProcessId);
            }
            catch (ElementNotAvailableException)
            {
                // Keep looking in the current render tree.
            }
        }
        return null;
    }

    private static CodexSidebarTarget? CreateTarget(AutomationElement element, int processId)
    {
        var name = ReadStableTitle(element);
        if (string.IsNullOrWhiteSpace(name) || name.Length > 512) return null;
        var parent = TreeWalker.ControlViewWalker.GetParent(element);
        if (parent is null || parent.Current.ControlType != ControlType.List) return null;

        var targetRuntimeId = element.GetRuntimeId();
        var siblings = parent.FindAll(TreeScope.Children, Condition.TrueCondition);
        var rows = new List<(AutomationElement Element, System.Windows.Rect Bounds)>();
        for (var index = 0; index < siblings.Count; index++)
        {
            try
            {
                var sibling = siblings[index];
                var current = sibling.Current;
                if (IsThreadListItemRow(current)) rows.Add((sibling, current.BoundingRectangle));
            }
            catch (ElementNotAvailableException)
            {
                return null;
            }
        }
        rows.Sort((left, right) => left.Bounds.Top.CompareTo(right.Bounds.Top));
        var rowIndex = rows.FindIndex(row => row.Element.GetRuntimeId().SequenceEqual(targetRuntimeId));
        if (rowIndex < 0) return null;
        var bounds = element.Current.BoundingRectangle;
        var drawingBounds = System.Drawing.Rectangle.FromLTRB(
            checked((int)Math.Floor(bounds.Left)),
            checked((int)Math.Floor(bounds.Top)),
            checked((int)Math.Ceiling(bounds.Right)),
            checked((int)Math.Ceiling(bounds.Bottom)));
        return new CodexSidebarTarget(name, processId, rowIndex, rows.Count, drawingBounds);
    }

    private static string? ReadStableTitle(AutomationElement row)
    {
        try
        {
            var descendants = row.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            var candidates = new List<(string Name, System.Windows.Rect Bounds)>();
            for (var index = 0; index < descendants.Count; index++)
            {
                var current = descendants[index].Current;
                var name = current.Name?.Trim();
                if (current.ControlType != ControlType.Button
                    || !current.ClassName.Contains("sidebar-item", StringComparison.Ordinal)
                    || current.IsOffscreen
                    || string.IsNullOrWhiteSpace(name)
                    || name.Length > 512)
                {
                    continue;
                }
                candidates.Add((name, current.BoundingRectangle));
            }
            var stable = candidates
                .OrderBy(candidate => candidate.Bounds.Left)
                .ThenByDescending(candidate => candidate.Bounds.Width)
                .FirstOrDefault();
            if (!string.IsNullOrWhiteSpace(stable.Name)) return stable.Name;
            return row.Current.Name?.Trim();
        }
        catch (ElementNotAvailableException)
        {
            return null;
        }
    }

    private static bool IsThreadListItem(AutomationElement element, System.Windows.Point point)
    {
        var current = element.Current;
        return IsThreadListItemCandidate(
            current.ControlType == ControlType.ListItem,
            current.ClassName ?? string.Empty,
            current.IsOffscreen,
            current.BoundingRectangle,
            point);
    }

    private static bool IsThreadListItemRow(AutomationElement.AutomationElementInformation current)
        => current.ControlType == ControlType.ListItem
            && current.ClassName.Contains("touch-none", StringComparison.Ordinal)
            && !current.IsOffscreen
            && current.BoundingRectangle.Width is >= 100 and <= 500
            && current.BoundingRectangle.Height is >= 20 and <= 60;

    internal static bool IsThreadListItemCandidate(
        bool isListItem,
        string className,
        bool isOffscreen,
        System.Windows.Rect bounds,
        System.Windows.Point point)
        => isListItem
            && className.Contains("touch-none", StringComparison.Ordinal)
            && !isOffscreen
            && bounds.Contains(point)
            && bounds.Width is >= 100 and <= 500
            && bounds.Height is >= 20 and <= 60;

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

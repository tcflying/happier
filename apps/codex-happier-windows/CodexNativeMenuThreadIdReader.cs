using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Windows.Forms;
using DrawingPoint = System.Drawing.Point;
using DrawingRectangle = System.Drawing.Rectangle;

namespace HappierCodexBridge;

internal static partial class CodexNativeMenuThreadIdReader
{
    internal readonly record struct MenuClickCandidate(
        DrawingRectangle Bounds,
        bool IsOffscreen,
        bool IsActionable,
        DrawingPoint? ClickablePoint);

    public static string Read(IntPtr nativeMenuHandle)
    {
        if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
        {
            throw new InvalidOperationException("读取 Codex 原生菜单必须在 STA 线程执行");
        }
        if (!NativeMethods.IsWindow(nativeMenuHandle)) throw new InvalidOperationException("Codex 原生菜单已经关闭");

        var menuItemPoint = FindCopyThreadIdPoint(nativeMenuHandle)
            ?? throw new InvalidOperationException("Codex 原生菜单里找不到“复制会话 ID”");

        var snapshot = CaptureClipboard();
        try
        {
            RetryClipboard(Clipboard.Clear);
            ClickMenuItem(nativeMenuHandle, menuItemPoint);
            for (var attempt = 0; attempt < 100; attempt++)
            {
                Application.DoEvents();
                var value = TryReadClipboardText();
                var threadId = ParseThreadId(value);
                if (threadId is not null) return threadId;
                Thread.Sleep(10);
            }
            throw new InvalidOperationException("Codex 没有把会话 ID 写入剪贴板");
        }
        finally
        {
            RestoreClipboard(snapshot);
        }
    }

    internal static string? ParseThreadId(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var match = ThreadIdPattern().Match(value.Trim());
        return match.Success ? match.Groups[1].Value.ToLowerInvariant() : null;
    }

    private static DrawingPoint? FindCopyThreadIdPoint(IntPtr nativeMenuHandle)
    {
        if (!NativeMethods.GetWindowRect(nativeMenuHandle, out var nativeRectangle))
        {
            throw new InvalidOperationException("无法读取 Codex 原生菜单位置");
        }
        var menuBounds = nativeRectangle.ToRectangle();
        var root = AutomationElement.FromHandle(nativeMenuHandle);
        var elements = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        var candidates = new List<MenuClickCandidate>();
        var matchingElements = 0;
        for (var index = 0; index < elements.Count; index++)
        {
            var element = elements[index];
            try
            {
                var name = element.Current.Name?.Trim() ?? string.Empty;
                if (name.Contains("复制会话 ID", StringComparison.OrdinalIgnoreCase)
                    || name.Contains("复制任务 ID", StringComparison.OrdinalIgnoreCase)
                    || CopyIdLabelPattern().IsMatch(name))
                {
                    matchingElements++;
                    AddClickCandidates(element, root, candidates);
                }
            }
            catch (ElementNotAvailableException)
            {
                // The menu can close while its accessibility tree is enumerated.
            }
        }
        var selected = SelectClickPoint(menuBounds, candidates);
        if (selected is not null) return selected;
        if (matchingElements > 0)
        {
            throw new InvalidOperationException(
                $"Codex 原生菜单匹配到 {matchingElements} 个“复制会话 ID”节点，但都没有位于菜单内的有效点击点");
        }
        return null;
    }

    private static void AddClickCandidates(
        AutomationElement matchedElement,
        AutomationElement root,
        ICollection<MenuClickCandidate> candidates)
    {
        AddClickCandidate(matchedElement, isActionable: true, candidates);

        var current = matchedElement;
        for (var depth = 0; depth < 4; depth++)
        {
            AutomationElement? parent;
            try
            {
                parent = TreeWalker.ControlViewWalker.GetParent(current);
            }
            catch (ElementNotAvailableException)
            {
                break;
            }
            if (parent is null || parent.Equals(root)) break;
            AddClickCandidate(parent, IsActionableControl(parent), candidates);
            current = parent;
        }

        try
        {
            var descendants = matchedElement.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            for (var index = 0; index < Math.Min(descendants.Count, 12); index++)
            {
                AddClickCandidate(descendants[index], isActionable: true, candidates);
            }
        }
        catch (ElementNotAvailableException)
        {
            // The next matching node may still provide a usable click point.
        }
    }

    private static void AddClickCandidate(
        AutomationElement element,
        bool isActionable,
        ICollection<MenuClickCandidate> candidates)
    {
        try
        {
            var current = element.Current;
            var bounds = current.BoundingRectangle;
            var drawingBounds = bounds.IsEmpty
                ? DrawingRectangle.Empty
                : DrawingRectangle.FromLTRB(
                    checked((int)Math.Floor(bounds.Left)),
                    checked((int)Math.Floor(bounds.Top)),
                    checked((int)Math.Ceiling(bounds.Right)),
                    checked((int)Math.Ceiling(bounds.Bottom)));
            DrawingPoint? clickablePoint = null;
            if (element.TryGetClickablePoint(out var point))
            {
                clickablePoint = new DrawingPoint(
                    checked((int)Math.Round(point.X)),
                    checked((int)Math.Round(point.Y)));
            }
            candidates.Add(new MenuClickCandidate(drawingBounds, current.IsOffscreen, isActionable, clickablePoint));
        }
        catch (ElementNotAvailableException)
        {
            // Ignore nodes removed while the Chromium popup is rendering.
        }
        catch (NoClickablePointException)
        {
            // Bounding rectangle may still be usable.
        }
    }

    private static bool IsActionableControl(AutomationElement element)
    {
        try
        {
            var controlType = element.Current.ControlType;
            return controlType == ControlType.MenuItem
                || controlType == ControlType.Button
                || controlType == ControlType.ListItem;
        }
        catch (ElementNotAvailableException)
        {
            return false;
        }
    }

    internal static DrawingPoint? SelectClickPoint(
        DrawingRectangle menuBounds,
        IEnumerable<MenuClickCandidate> candidates)
    {
        foreach (var candidate in candidates)
        {
            if (candidate.IsOffscreen || !candidate.IsActionable) continue;
            if (candidate.ClickablePoint is { } clickablePoint && menuBounds.Contains(clickablePoint))
            {
                return clickablePoint;
            }
            if (candidate.Bounds.Width <= 1 || candidate.Bounds.Height <= 1) continue;
            var center = new DrawingPoint(
                candidate.Bounds.Left + candidate.Bounds.Width / 2,
                candidate.Bounds.Top + candidate.Bounds.Height / 2);
            if (menuBounds.Contains(center)) return center;
        }
        return null;
    }

    private static void ClickMenuItem(IntPtr nativeMenuHandle, DrawingPoint screenPoint)
    {
        var clientPoint = new NativeMethods.Point
        {
            X = screenPoint.X,
            Y = screenPoint.Y,
        };
        if (!NativeMethods.ScreenToClient(nativeMenuHandle, ref clientPoint))
        {
            throw new InvalidOperationException("无法换算“复制会话 ID”菜单项坐标");
        }
        var packedPoint = new IntPtr((clientPoint.Y << 16) | (clientPoint.X & 0xFFFF));
        if (!NativeMethods.PostMessage(nativeMenuHandle, NativeMethods.WmMouseMove, IntPtr.Zero, packedPoint)
            || !NativeMethods.PostMessage(nativeMenuHandle, NativeMethods.WmLButtonDown, new IntPtr(1), packedPoint)
            || !NativeMethods.PostMessage(nativeMenuHandle, NativeMethods.WmLButtonUp, IntPtr.Zero, packedPoint))
        {
            throw new InvalidOperationException("无法点击 Codex 的“复制会话 ID”菜单项");
        }
    }

    private static DataObject? CaptureClipboard()
    {
        try
        {
            var source = RetryClipboard(Clipboard.GetDataObject);
            if (source is null) return null;
            var snapshot = new DataObject();
            foreach (var format in source.GetFormats(autoConvert: false))
            {
                try
                {
                    var data = source.GetData(format, autoConvert: false);
                    if (data is not null) snapshot.SetData(format, autoConvert: false, data);
                }
                catch
                {
                    // Skip formats that only support delayed rendering.
                }
            }
            return snapshot;
        }
        catch
        {
            return null;
        }
    }

    private static void RestoreClipboard(DataObject? snapshot)
    {
        try
        {
            if (snapshot is null) RetryClipboard(Clipboard.Clear);
            else RetryClipboard(() => Clipboard.SetDataObject(snapshot, copy: true));
        }
        catch
        {
            // Import must not fail after the ID was already captured.
        }
    }

    private static string? TryReadClipboardText()
    {
        try
        {
            return RetryClipboard(() => Clipboard.ContainsText() ? Clipboard.GetText() : null);
        }
        catch
        {
            return null;
        }
    }

    private static void RetryClipboard(Action action)
        => RetryClipboard(() =>
        {
            action();
            return true;
        });

    private static T RetryClipboard<T>(Func<T> action)
    {
        Exception? lastError = null;
        for (var attempt = 0; attempt < 10; attempt++)
        {
            try
            {
                return action();
            }
            catch (ExternalException error)
            {
                lastError = error;
                Thread.Sleep(10);
            }
        }
        throw lastError ?? new InvalidOperationException("剪贴板不可用");
    }

    [GeneratedRegex(@"(?i)(?:codex://threads/)?\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b")]
    private static partial Regex ThreadIdPattern();

    [GeneratedRegex(@"(?i)copy\s+(?:conversation|task|thread)\s+id")]
    private static partial Regex CopyIdLabelPattern();
}

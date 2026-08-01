using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Windows.Forms;

namespace HappierCodexBridge;

internal static partial class CodexNativeMenuThreadIdReader
{
    public static string Read(IntPtr nativeMenuHandle)
    {
        if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
        {
            throw new InvalidOperationException("读取 Codex 原生菜单必须在 STA 线程执行");
        }
        if (!NativeMethods.IsWindow(nativeMenuHandle)) throw new InvalidOperationException("Codex 原生菜单已经关闭");

        var menuItem = FindCopyThreadIdItem(nativeMenuHandle)
            ?? throw new InvalidOperationException("Codex 原生菜单里找不到“复制会话 ID”");

        var snapshot = CaptureClipboard();
        try
        {
            RetryClipboard(Clipboard.Clear);
            ClickMenuItem(nativeMenuHandle, menuItem);
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

    private static AutomationElement? FindCopyThreadIdItem(IntPtr nativeMenuHandle)
    {
        var root = AutomationElement.FromHandle(nativeMenuHandle);
        var elements = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
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
                    return element;
                }
            }
            catch (ElementNotAvailableException)
            {
                // The menu can close while its accessibility tree is enumerated.
            }
        }
        return null;
    }

    private static void ClickMenuItem(IntPtr nativeMenuHandle, AutomationElement menuItem)
    {
        var bounds = menuItem.Current.BoundingRectangle;
        if (bounds.IsEmpty || bounds.Width <= 1 || bounds.Height <= 1)
        {
            throw new InvalidOperationException("Codex 的“复制会话 ID”菜单项没有有效坐标");
        }
        var clientPoint = new NativeMethods.Point
        {
            X = checked((int)Math.Round(bounds.Left + bounds.Width / 2)),
            Y = checked((int)Math.Round(bounds.Top + bounds.Height / 2)),
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

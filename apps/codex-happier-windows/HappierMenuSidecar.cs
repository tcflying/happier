using System.Drawing;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace HappierCodexBridge;

internal sealed class HappierMenuSidecar : Form
{
    private const int WsExToolWindow = 0x00000080;
    private const int WsExNoActivate = 0x08000000;
    private const int Gap = 1;
    private const int RowHeight = 38;

    public HappierMenuSidecar(Rectangle nativeMenuBounds)
    {
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = SystemColors.Menu;
        Cursor = Cursors.Hand;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);

        var workingArea = Screen.FromRectangle(nativeMenuBounds).WorkingArea;
        Bounds = CalculateBounds(nativeMenuBounds, workingArea, RowHeight);
    }

    protected override bool ShowWithoutActivation => true;

    public void ShowAttachedTo(IntPtr nativeMenuHandle)
    {
        var handle = Handle;
        Marshal.SetLastPInvokeError(0);
        var previousOwner = NativeMethods.SetWindowLongPtr(handle, NativeMethods.GwlpHwndParent, nativeMenuHandle);
        var ownerError = Marshal.GetLastPInvokeError();
        if (previousOwner == IntPtr.Zero && ownerError != 0)
        {
            throw new Win32Exception(ownerError, "无法把 Happier 追加行绑定到 Codex 原生菜单");
        }

        Show();
        if (!NativeMethods.SetWindowPos(
                handle,
                NativeMethods.HwndTopmost,
                Left,
                Top,
                Width,
                Height,
                NativeMethods.SwpNoActivate | NativeMethods.SwpShowWindow))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "无法显示 Happier 菜单追加行");
        }
        Update();
        if (!NativeMethods.IsWindowVisible(handle))
        {
            throw new InvalidOperationException("Happier 菜单追加行创建后仍不可见");
        }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.ExStyle |= WsExToolWindow | WsExNoActivate;
            return parameters;
        }
    }

    protected override void OnPaint(PaintEventArgs eventArgs)
    {
        base.OnPaint(eventArgs);
        eventArgs.Graphics.Clear(SystemColors.Menu);
        ControlPaint.DrawBorder(eventArgs.Graphics, ClientRectangle, SystemColors.ControlDark, ButtonBorderStyle.Solid);
        var textBounds = Rectangle.Inflate(ClientRectangle, -14, -1);
        TextRenderer.DrawText(
            eventArgs.Graphics,
            "导入到 Happier 直连",
            SystemFonts.MenuFont,
            textBounds,
            SystemColors.MenuText,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
    }

    internal static Rectangle CalculateBounds(Rectangle nativeMenuBounds, Rectangle workingArea, int height = RowHeight)
    {
        var width = Math.Min(Math.Max(nativeMenuBounds.Width, 180), workingArea.Width);
        var x = Math.Clamp(nativeMenuBounds.Left, workingArea.Left, Math.Max(workingArea.Left, workingArea.Right - width));

        var y = Math.Clamp(nativeMenuBounds.Top, workingArea.Top, Math.Max(workingArea.Top, workingArea.Bottom - height));
        if (nativeMenuBounds.Right + Gap + width <= workingArea.Right)
        {
            return new Rectangle(nativeMenuBounds.Right + Gap, y, width, height);
        }
        if (nativeMenuBounds.Left - Gap - width >= workingArea.Left)
        {
            return new Rectangle(nativeMenuBounds.Left - Gap - width, y, width, height);
        }
        if (nativeMenuBounds.Bottom + Gap + height <= workingArea.Bottom)
        {
            return new Rectangle(x, nativeMenuBounds.Bottom + Gap, width, height);
        }
        if (nativeMenuBounds.Top - Gap - height >= workingArea.Top)
        {
            return new Rectangle(x, nativeMenuBounds.Top - Gap - height, width, height);
        }

        throw new InvalidOperationException("屏幕上没有不遮挡 Codex 原生菜单的 Happier 菜单位置");
    }
}

using System.Drawing;

namespace HappierCodexBridge;

internal sealed class MouseHookGestureRouter
{
    private bool _suppressLeftButtonUp;

    public Func<Point, bool>? LeftClickIntercepted { get; set; }
    public event Action<Point>? RightButtonPressed;

    public bool ShouldSuppress(int message, Point point)
    {
        if (message == NativeMethods.WmLButtonDown)
        {
            var interceptor = LeftClickIntercepted;
            _suppressLeftButtonUp = interceptor is not null && interceptor(point);
            return _suppressLeftButtonUp;
        }

        if (message == NativeMethods.WmLButtonUp && _suppressLeftButtonUp)
        {
            _suppressLeftButtonUp = false;
            return true;
        }

        if (message == NativeMethods.WmRButtonDown)
        {
            RightButtonPressed?.Invoke(point);
        }
        return false;
    }
}

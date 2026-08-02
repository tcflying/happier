namespace HappierCodexBridge;

internal static class LeftDragPassThroughTest
{
    public static int Run()
    {
        var router = new MouseHookGestureRouter();
        var interceptorCalls = 0;
        router.LeftClickIntercepted = _ =>
        {
            interceptorCalls++;
            router.LeftClickIntercepted = null;
            return false;
        };
        var point = new System.Drawing.Point(100, 100);
        var dragDecisions = new[]
        {
            router.ShouldSuppress(NativeMethods.WmLButtonDown, point),
            router.ShouldSuppress(NativeMethods.WmMouseMove, new System.Drawing.Point(120, 110)),
            router.ShouldSuppress(NativeMethods.WmLButtonUp, new System.Drawing.Point(140, 120)),
        };
        if (interceptorCalls != 1) throw new InvalidOperationException($"菜单外拖拽应只检查一次临时拦截器，实际 {interceptorCalls}");
        if (dragDecisions.Any(value => value))
        {
            throw new InvalidOperationException("菜单外左键拖拽 down/move/up 必须全部放行");
        }

        var sidecarRouter = new MouseHookGestureRouter { LeftClickIntercepted = _ => true };
        var sidecarDecisions = new[]
        {
            sidecarRouter.ShouldSuppress(NativeMethods.WmLButtonDown, point),
            sidecarRouter.ShouldSuppress(NativeMethods.WmMouseMove, point),
            sidecarRouter.ShouldSuppress(NativeMethods.WmLButtonUp, point),
            sidecarRouter.ShouldSuppress(NativeMethods.WmLButtonUp, point),
        };
        if (!sidecarDecisions.SequenceEqual(new[] { true, false, true, false }))
        {
            throw new InvalidOperationException("只有 Happier 追加行点击的 down/up 可以被成对拦截");
        }
        Console.WriteLine("LEFT_DRAG_PASSTHROUGH_TEST=PASS");
        return 0;
    }
}

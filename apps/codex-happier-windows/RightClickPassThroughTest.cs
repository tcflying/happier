namespace HappierCodexBridge;

internal static class RightClickPassThroughTest
{
    public static int Run()
    {
        var router = new MouseHookGestureRouter();
        var observed = 0;
        router.RightButtonPressed += _ => observed++;
        var point = new System.Drawing.Point(100, 100);
        var decisions = new[]
        {
            router.ShouldSuppress(NativeMethods.WmRButtonDown, point),
            router.ShouldSuppress(NativeMethods.WmRButtonUp, point),
        };
        if (observed != 1) throw new InvalidOperationException($"右键观察次数不正确: {observed}");
        if (decisions.Any(value => value))
        {
            throw new InvalidOperationException("原生右键 down/up 必须完整放行");
        }
        Console.WriteLine("RIGHT_CLICK_PASSTHROUGH_TEST=PASS");
        return 0;
    }
}

namespace HappierCodexBridge;

internal static class SelfTests
{
    public static int Run()
    {
        var recent = new CodexThread("recent", "同名会话", "", "D:\\recent", 20);
        var older = new CodexThread("older", "同名会话", "", "D:\\older", 10);
        var unique = new CodexThread("unique", "唯一会话", "", null, 5);

        Require(ThreadMatcher.FindByTitle([older, unique, recent], "同名会话")?.Id == "recent", "同名标题应选择最近线程");
        Require(ThreadMatcher.FindByTitle([older, unique, recent], " 唯一会话 ")?.Id == "unique", "标题匹配应忽略首尾空白");
        Require(ThreadMatcher.FindByTitle([older, unique], "不存在") is null, "不存在的标题不得误匹配");
        Require(ThreadMatcher.FindById([older, unique], "unique")?.Name == "唯一会话", "线程 ID 应精确匹配");
        Require(DaemonStateLocator.TryParse("C:\\daemon.state.json", """
          {"pid":123,"httpPort":4567,"controlToken":"secret","lastHeartbeatAt":99}
          """) is { HttpPort: 4567, ControlToken: "secret", LastHeartbeatAt: 99 }, "daemon state 应正确解析");
        Require(DaemonStateLocator.TryParse("C:\\daemon.state.json", "{}") is null, "缺少认证字段的 state 必须拒绝");
        Require(CodexThreadStore.SelectDisplayName(null, " 用户标题 ", "预览", "id") == "用户标题", "线程标题应作为 UI 显示名回退");
        Require(
            CodexNativeMenuThreadIdReader.ParseThreadId("019fb8c7-3c74-71b0-8198-8c357f82c6e1") == "019fb8c7-3c74-71b0-8198-8c357f82c6e1",
            "应解析纯 Codex 会话 ID");
        Require(
            CodexNativeMenuThreadIdReader.ParseThreadId("codex://threads/019FB8C7-3C74-71B0-8198-8C357F82C6E1") == "019fb8c7-3c74-71b0-8198-8c357f82c6e1",
            "应解析 Codex 深度链接并规范化大小写");
        var workingArea = new System.Drawing.Rectangle(0, 0, 1_920, 1_080);
        var middleMenu = new System.Drawing.Rectangle(100, 100, 280, 300);
        var middleSidecar = HappierMenuSidecar.CalculateBounds(middleMenu, workingArea);
        Require(middleSidecar.Left > middleMenu.Right && workingArea.Contains(middleSidecar), "有空间时追加行应优先放在原生菜单右侧");
        var bottomMenu = new System.Drawing.Rectangle(560, 850, 800, 200);
        var bottomSidecar = HappierMenuSidecar.CalculateBounds(bottomMenu, workingArea);
        Require(!bottomSidecar.IntersectsWith(bottomMenu) && workingArea.Contains(bottomSidecar), "屏幕底部应改在原生菜单上方追加");
        var tallMenu = new System.Drawing.Rectangle(500, 0, 300, 1_080);
        var tallSidecar = HappierMenuSidecar.CalculateBounds(tallMenu, workingArea);
        Require(!tallSidecar.IntersectsWith(tallMenu) && workingArea.Contains(tallSidecar), "垂直空间不足时应放在原生菜单侧面");
        var threadBounds = new System.Windows.Rect(7, 374, 244, 31);
        Require(
            CodexSidebarAutomation.IsThreadListItemCandidate(true, "after:block touch-none", false, threadBounds, new System.Windows.Point(100, 385)),
            "真实任务 ListItem 应被识别");
        Require(
            !CodexSidebarAutomation.IsThreadListItemCandidate(false, "sidebar-item", false, threadBounds, new System.Windows.Point(100, 385)),
            "普通按钮不得被误识别为任务行");
        Require(
            !CodexSidebarAutomation.IsThreadListItemCandidate(true, "browser-content", false, threadBounds, new System.Windows.Point(100, 385)),
            "浏览器区域 ListItem 不得触发 Codex 任务导入");
        var nativeMenuBounds = new System.Drawing.Rectangle(100, 100, 220, 300);
        var menuPoint = CodexNativeMenuThreadIdReader.SelectClickPoint(nativeMenuBounds, [
            new CodexNativeMenuThreadIdReader.MenuClickCandidate(System.Drawing.Rectangle.Empty, false, true, null),
            new CodexNativeMenuThreadIdReader.MenuClickCandidate(new System.Drawing.Rectangle(120, 240, 180, 32), false, true, null),
        ]);
        Require(menuPoint == new System.Drawing.Point(210, 256), "首个同名节点无坐标时应继续选择后续有效菜单行");
        Require(
            CodexNativeMenuThreadIdReader.SelectClickPoint(nativeMenuBounds, [
                new CodexNativeMenuThreadIdReader.MenuClickCandidate(new System.Drawing.Rectangle(500, 500, 100, 30), false, true, null),
            ]) is null,
            "原生菜单矩形外的候选不得被点击");

        Console.WriteLine("SELF_TESTS=17/17");
        return 0;
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}

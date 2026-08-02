using System.Text.Json;

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
        using var sidebarState = JsonDocument.Parse("""
          {"electron-persisted-atom-state":{
            "thread-client-id-v1:local%3A019fad17-0293-7da2-afdf-8a37c6dd99ee":"client-new-thread:alias-a",
            "thread-client-id-v1:local%3A019fbc40-daa3-7471-a04f-69a65228390a":"client-new-thread:alias-b",
            "unified-sidebar-pinned-order-v1":[
              "codex:thread:local:client-new-thread:alias-a",
              "codex:thread:local:019fad17-0293-7da2-afdf-8a37c6dd99ee",
              "codex:thread:local:client-new-thread:alias-b",
              "codex:thread:local:019f8bc5-d747-7250-aedc-b3a2ddd3cffe",
              "codex:thread:remote:019fb882-64ec-75f2-a222-9c12c88aa85f"
            ]
          }}
          """);
        var pinnedIds = CodexPinnedThreadResolver.ParsePinnedThreadIds(sidebarState.RootElement);
        Require(pinnedIds.SequenceEqual([
            "019fad17-0293-7da2-afdf-8a37c6dd99ee",
            "019fbc40-daa3-7471-a04f-69a65228390a",
            "019f8bc5-d747-7250-aedc-b3a2ddd3cffe",
        ]), "侧栏状态应去掉重复 client 别名并恢复唯一真实线程 ID");
        Require(
            CodexPinnedThreadResolver.SelectThreadId(pinnedIds, 1, 3) == "019fbc40-daa3-7471-a04f-69a65228390a",
            "侧栏可见行号应精确选择同位置线程 ID");
        RequireThrows(
            () => CodexPinnedThreadResolver.SelectThreadId(pinnedIds, 1, 2),
            "界面行数和状态不一致时必须拒绝猜测");
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
        Console.WriteLine("SELF_TESTS=16/16");
        return 0;
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void RequireThrows(Action action, string message)
    {
        try
        {
            action();
        }
        catch (InvalidOperationException)
        {
            return;
        }
        throw new InvalidOperationException(message);
    }
}

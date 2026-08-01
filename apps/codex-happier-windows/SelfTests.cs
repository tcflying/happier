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

        Console.WriteLine("SELF_TESTS=9/9");
        return 0;
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}

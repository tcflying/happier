namespace HappierCodexBridge;

internal static class ThreadMatcher
{
    public static CodexThread? FindById(IEnumerable<CodexThread> threads, string id)
    {
        var expected = id.Trim();
        return threads.FirstOrDefault(thread => string.Equals(thread.Id, expected, StringComparison.Ordinal));
    }

    public static CodexThread? FindByTitle(IEnumerable<CodexThread> threads, string title)
    {
        var expected = title.Trim();
        return threads
            .Where(thread => string.Equals(thread.Name.Trim(), expected, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(thread => thread.UpdatedAt)
            .FirstOrDefault();
    }
}

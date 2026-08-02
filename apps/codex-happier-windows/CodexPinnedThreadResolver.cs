using System.IO;
using System.Text.Json;

namespace HappierCodexBridge;

internal sealed class CodexPinnedThreadResolver
{
    private const string LocalThreadPrefix = "codex:thread:local:";
    private const string ClientThreadPrefix = "client-new-thread:";
    private const string ClientAliasKeyPrefix = "thread-client-id-v1:local%3A";
    private readonly CodexThreadStore _store;

    public CodexPinnedThreadResolver(CodexThreadStore store)
    {
        _store = store;
    }

    public CodexThread Resolve(CodexSidebarTarget target)
    {
        var statePath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".codex",
            ".codex-global-state.json");
        if (!File.Exists(statePath)) throw new FileNotFoundException("找不到 Codex 侧栏状态", statePath);

        using var document = JsonDocument.Parse(File.ReadAllText(statePath));
        var candidates = ParsePinnedThreadIds(document.RootElement);
        var activeThreads = _store.FindUnarchivedByIds(candidates);
        var byId = activeThreads.ToDictionary(thread => thread.Id, StringComparer.OrdinalIgnoreCase);
        var activeIds = candidates.Where(byId.ContainsKey).ToArray();
        var selectedId = SelectThreadId(activeIds, target.RowIndex, target.ListSize);
        return byId[selectedId] with { Name = target.Title };
    }

    internal static IReadOnlyList<string> ParsePinnedThreadIds(JsonElement root)
    {
        if (!root.TryGetProperty("electron-persisted-atom-state", out var atoms)
            || atoms.ValueKind != JsonValueKind.Object
            || !atoms.TryGetProperty("unified-sidebar-pinned-order-v1", out var order)
            || order.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException("Codex 侧栏顺序格式不正确");
        }

        var clientAliases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in atoms.EnumerateObject())
        {
            if (!property.Name.StartsWith(ClientAliasKeyPrefix, StringComparison.OrdinalIgnoreCase)
                || property.Value.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var clientId = property.Value.GetString();
            var threadId = property.Name[ClientAliasKeyPrefix.Length..];
            if (!string.IsNullOrWhiteSpace(clientId) && Guid.TryParse(threadId, out _))
            {
                clientAliases[clientId] = threadId;
            }
        }

        var tokens = order.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String)
            .Select(item => item.GetString())
            .Where(value => value is not null && value.StartsWith(LocalThreadPrefix, StringComparison.OrdinalIgnoreCase))
            .Select(value => value![LocalThreadPrefix.Length..])
            .ToArray();
        var explicitThreadIds = tokens
            .Where(token => !token.StartsWith(ClientThreadPrefix, StringComparison.OrdinalIgnoreCase))
            .Where(token => Guid.TryParse(token, out _))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var token in tokens)
        {
            string threadId;
            if (token.StartsWith(ClientThreadPrefix, StringComparison.OrdinalIgnoreCase))
            {
                if (!clientAliases.TryGetValue(token, out threadId!)) continue;
                if (explicitThreadIds.Contains(threadId)) continue;
            }
            else
            {
                threadId = token;
            }

            if (Guid.TryParse(threadId, out _) && seen.Add(threadId)) result.Add(threadId);
        }
        return result;
    }

    internal static string SelectThreadId(IReadOnlyList<string> activeIds, int rowIndex, int listSize)
    {
        if (listSize != activeIds.Count)
        {
            throw new InvalidOperationException(
                $"Codex 侧栏行数与状态不一致：界面 {listSize}，状态 {activeIds.Count}");
        }
        if (rowIndex < 0 || rowIndex >= activeIds.Count)
        {
            throw new InvalidOperationException($"Codex 侧栏行号越界：{rowIndex + 1}/{activeIds.Count}");
        }
        return activeIds[rowIndex];
    }
}

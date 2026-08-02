using System.Runtime.InteropServices;
using System.IO;

namespace HappierCodexBridge;

internal sealed class CodexThreadStore
{
    private const int SqliteOk = 0;
    private const int SqliteRow = 100;
    private const int SqliteDone = 101;
    private const int SqliteOpenReadOnly = 0x00000001;
    private const int SqliteOpenUri = 0x00000040;

    public IReadOnlyList<CodexThread> ListRecent(int limit = 500)
    {
        var safeLimit = Math.Clamp(limit, 1, 2_000);
        return Query($"""
            SELECT id,
                   CASE
                     WHEN name IS NOT NULL AND trim(name) <> '' THEN name
                     WHEN length(title) BETWEEN 1 AND 512 THEN title
                     ELSE ''
                   END AS display_name,
                   preview,
                   cwd,
                   coalesce(updated_at_ms, updated_at * 1000, 0)
             FROM threads
             WHERE archived = 0
             ORDER BY recency_at_ms DESC
             LIMIT {safeLimit}
            """);
    }

    public CodexThread? FindById(string id)
    {
        var escaped = EscapeSqlLiteral(id.Trim());
        return Query($"""
            SELECT id,
                   CASE
                     WHEN name IS NOT NULL AND trim(name) <> '' THEN name
                     WHEN length(title) BETWEEN 1 AND 512 THEN title
                     ELSE ''
                   END AS display_name,
                   preview,
                   cwd,
                   coalesce(updated_at_ms, updated_at * 1000, 0)
              FROM threads
             WHERE id = '{escaped}'
             LIMIT 1
            """).FirstOrDefault();
    }

    public IReadOnlyList<CodexThread> FindUnarchivedByIds(IReadOnlyList<string> ids)
    {
        var distinctIds = ids
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(2_000)
            .ToArray();
        if (distinctIds.Length == 0) return [];
        var literals = string.Join(", ", distinctIds.Select(id => $"'{EscapeSqlLiteral(id.Trim())}'"));
        return Query($"""
            SELECT id,
                   CASE
                     WHEN name IS NOT NULL AND trim(name) <> '' THEN name
                     WHEN length(title) BETWEEN 1 AND 512 THEN title
                     ELSE ''
                   END AS display_name,
                   preview,
                   cwd,
                   coalesce(updated_at_ms, updated_at * 1000, 0)
              FROM threads
             WHERE archived = 0
               AND id IN ({literals})
            """);
    }

    internal static string SelectDisplayName(string? name, string? title, string preview, string id)
    {
        if (!string.IsNullOrWhiteSpace(name)) return name.Trim();
        if (!string.IsNullOrWhiteSpace(title) && title.Trim().Length <= 512) return title.Trim();
        var firstLine = preview.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();
        return string.IsNullOrWhiteSpace(firstLine) ? id : firstLine;
    }

    private static IReadOnlyList<CodexThread> Query(string sql)
    {
        var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex", "state_5.sqlite");
        if (!File.Exists(path)) throw new FileNotFoundException("找不到 Codex 本地线程数据库", path);
        var openCode = sqlite3_open_v2(path, out var database, SqliteOpenReadOnly | SqliteOpenUri, IntPtr.Zero);
        if (openCode != SqliteOk) throw new InvalidOperationException($"无法以只读方式打开 Codex 线程数据库: SQLite {openCode}");
        try
        {
            var prepareCode = sqlite3_prepare_v2(database, sql, -1, out var statement, IntPtr.Zero);
            if (prepareCode != SqliteOk) throw new InvalidOperationException($"无法查询 Codex 线程数据库: {ReadError(database)}");
            try
            {
                var result = new List<CodexThread>();
                while (true)
                {
                    var stepCode = sqlite3_step(statement);
                    if (stepCode == SqliteDone) break;
                    if (stepCode != SqliteRow) throw new InvalidOperationException($"读取 Codex 线程数据库失败: {ReadError(database)}");
                    var id = ReadText(statement, 0);
                    var displayName = ReadText(statement, 1);
                    var preview = ReadText(statement, 2);
                    var cwd = ReadNullableText(statement, 3);
                    var updatedAt = sqlite3_column_int64(statement, 4);
                    if (string.IsNullOrWhiteSpace(id)) continue;
                    result.Add(new CodexThread(id, SelectDisplayName(displayName, displayName, preview, id), preview, cwd, updatedAt));
                }
                return result;
            }
            finally
            {
                sqlite3_finalize(statement);
            }
        }
        finally
        {
            sqlite3_close(database);
        }
    }

    private static string EscapeSqlLiteral(string value) => value.Replace("'", "''", StringComparison.Ordinal);

    private static string ReadText(IntPtr statement, int column) => ReadNullableText(statement, column) ?? string.Empty;

    private static string? ReadNullableText(IntPtr statement, int column)
    {
        var pointer = sqlite3_column_text(statement, column);
        return pointer == IntPtr.Zero ? null : Marshal.PtrToStringUTF8(pointer);
    }

    private static string ReadError(IntPtr database)
    {
        var pointer = sqlite3_errmsg(database);
        return pointer == IntPtr.Zero ? "unknown error" : Marshal.PtrToStringUTF8(pointer) ?? "unknown error";
    }

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_open_v2([MarshalAs(UnmanagedType.LPUTF8Str)] string filename, out IntPtr database, int flags, IntPtr vfs);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_prepare_v2(IntPtr database, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql, int bytes, out IntPtr statement, IntPtr tail);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_step(IntPtr statement);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_text(IntPtr statement, int column);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern long sqlite3_column_int64(IntPtr statement, int column);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_finalize(IntPtr statement);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_close(IntPtr database);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_errmsg(IntPtr database);
}

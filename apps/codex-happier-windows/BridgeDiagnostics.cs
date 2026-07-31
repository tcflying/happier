using System.IO;
using System.Text.Json;

namespace HappierCodexBridge;

internal static class BridgeDiagnostics
{
    private static readonly object Gate = new();

    public static void Write(string stage, string? error = null)
    {
        try
        {
            var directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Happier",
                "CodexBridge");
            Directory.CreateDirectory(directory);
            var payload = JsonSerializer.Serialize(new
            {
                stage,
                updatedAt = DateTimeOffset.Now,
                processId = Environment.ProcessId,
                error,
            });
            lock (Gate)
            {
                File.WriteAllText(Path.Combine(directory, "status.json"), payload);
            }
        }
        catch
        {
            // Diagnostics must never break the hook or import flow.
        }
    }
}

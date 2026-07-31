using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;

namespace HappierCodexBridge;

internal sealed class DaemonStateLocator
{
    private readonly HttpClient _httpClient;

    public DaemonStateLocator(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task<DaemonState> FindActiveAsync(CancellationToken cancellationToken)
    {
        var candidates = EnumerateCandidateFiles()
            .Select(path => TryRead(path))
            .OfType<DaemonState>()
            .Where(IsProcessAlive)
            .OrderByDescending(state => state.LastHeartbeatAt)
            .ToArray();

        foreach (var state in candidates)
        {
            if (await PingAsync(state, cancellationToken).ConfigureAwait(false)) return state;
        }

        throw new InvalidOperationException("没有找到可用的 Happier daemon。请先启动 Happier。");
    }

    internal static DaemonState? TryParse(string path, string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (!root.TryGetProperty("pid", out var pidValue) || !pidValue.TryGetInt32(out var pid) || pid <= 0) return null;
            if (!root.TryGetProperty("httpPort", out var portValue) || !portValue.TryGetInt32(out var port) || port <= 0) return null;
            if (!root.TryGetProperty("controlToken", out var tokenValue)) return null;
            var token = tokenValue.GetString()?.Trim();
            if (string.IsNullOrWhiteSpace(token)) return null;
            var heartbeat = root.TryGetProperty("lastHeartbeatAt", out var heartbeatValue) && heartbeatValue.TryGetInt64(out var parsedHeartbeat)
                ? parsedHeartbeat
                : 0;
            return new DaemonState(path, pid, port, token, heartbeat);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static IEnumerable<string> EnumerateCandidateFiles()
    {
        var explicitPath = Environment.GetEnvironmentVariable("HAPPIER_DAEMON_STATE_FILE")?.Trim();
        if (!string.IsNullOrWhiteSpace(explicitPath) && File.Exists(explicitPath)) yield return explicitPath;

        var home = Environment.GetEnvironmentVariable("HAPPIER_HOME_DIR")?.Trim();
        if (string.IsNullOrWhiteSpace(home))
        {
            home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".happier");
        }
        if (!Directory.Exists(home)) yield break;

        IEnumerable<string> files;
        try
        {
            files = Directory.EnumerateFiles(home, "daemon*.state.json", SearchOption.AllDirectories).ToArray();
        }
        catch (UnauthorizedAccessException)
        {
            yield break;
        }
        foreach (var file in files)
        {
            if (!string.Equals(file, explicitPath, StringComparison.OrdinalIgnoreCase)) yield return file;
        }
    }

    private static DaemonState? TryRead(string path)
    {
        try
        {
            return TryParse(path, File.ReadAllText(path));
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static bool IsProcessAlive(DaemonState state)
    {
        try
        {
            using var process = Process.GetProcessById(state.Pid);
            return !process.HasExited;
        }
        catch
        {
            return false;
        }
    }

    private async Task<bool> PingAsync(DaemonState state, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{state.HttpPort}/ping");
        request.Headers.TryAddWithoutValidation("x-happier-daemon-token", state.ControlToken);
        try
        {
            using var response = await _httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }
}

using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;

namespace HappierCodexBridge;

internal sealed class HappierDaemonClient
{
    private readonly HttpClient _httpClient;
    private readonly DaemonStateLocator _stateLocator;

    public HappierDaemonClient(HttpClient httpClient)
    {
        _httpClient = httpClient;
        _stateLocator = new DaemonStateLocator(httpClient);
    }

    public async Task<DirectSessionLinkResult> LinkAsync(CodexThread thread, CancellationToken cancellationToken)
    {
        var state = await _stateLocator.FindActiveAsync(cancellationToken).ConfigureAwait(false);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{state.HttpPort}/codex/direct-session-link");
        request.Headers.TryAddWithoutValidation("x-happier-daemon-token", state.ControlToken);
        request.Content = JsonContent.Create(new
        {
            remoteSessionId = thread.Id,
            title = thread.Name,
            directory = string.IsNullOrWhiteSpace(thread.Cwd) ? null : thread.Cwd,
        });

        using var response = await _httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var payload = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"Happier daemon 返回 HTTP {(int)response.StatusCode}: {payload}");
        }

        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;
        var ok = root.TryGetProperty("ok", out var okValue) && okValue.ValueKind == JsonValueKind.True;
        var sessionId = ReadString(root, "sessionId");
        var created = root.TryGetProperty("created", out var createdValue) && createdValue.ValueKind == JsonValueKind.True;
        var result = new DirectSessionLinkResult(ok, sessionId, created, ReadString(root, "errorCode"), ReadString(root, "errorMessage"));
        if (!result.Ok)
        {
            throw new InvalidOperationException(result.ErrorMessage ?? result.ErrorCode ?? "Happier 直连导入失败");
        }
        if (string.IsNullOrWhiteSpace(result.SessionId)) throw new InvalidOperationException("Happier 未返回 sessionId");
        return result;
    }

    public static void OpenSession(string sessionId)
    {
        var baseUrl = Environment.GetEnvironmentVariable("HAPPIER_CODEX_BRIDGE_WEBAPP_URL")?.Trim();
        if (string.IsNullOrWhiteSpace(baseUrl)) baseUrl = "http://localhost:19087";
        var url = $"{baseUrl.TrimEnd('/')}/?id={Uri.EscapeDataString(sessionId)}";
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}

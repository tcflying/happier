namespace HappierCodexBridge;

internal sealed record CodexThread(
    string Id,
    string Name,
    string Preview,
    string? Cwd,
    long UpdatedAt);

internal sealed record VisibleThreadRow(
    CodexThread Thread,
    System.Windows.Rect Bounds);

internal sealed record DaemonState(
    string FilePath,
    int Pid,
    int HttpPort,
    string ControlToken,
    long LastHeartbeatAt);

internal sealed record DirectSessionLinkResult(
    bool Ok,
    string? SessionId,
    bool Created,
    string? ErrorCode,
    string? ErrorMessage);

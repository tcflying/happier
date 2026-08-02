namespace HappierCodexBridge;

internal sealed record CodexThread(
    string Id,
    string Name,
    string Preview,
    string? Cwd,
    long UpdatedAt);

internal sealed record CodexSidebarTarget(
    string Title,
    int ProcessId,
    int RowIndex,
    int ListSize,
    System.Drawing.Rectangle Bounds);

internal sealed record NativePopupMenu(
    IntPtr Handle,
    System.Drawing.Rectangle Bounds);

internal sealed record PendingCodexImport(
    CodexThread Thread,
    int ProcessId,
    System.Drawing.Point Point)
{
    public string Title => Thread.Name;
}

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

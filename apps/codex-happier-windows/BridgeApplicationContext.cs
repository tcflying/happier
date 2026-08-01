using System.Net.Http;
using System.Windows.Forms;

namespace HappierCodexBridge;

internal sealed class BridgeApplicationContext : ApplicationContext
{
    private readonly CodexThreadStore _codex = new();
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(8) };
    private readonly HappierDaemonClient _happier;
    private readonly NotifyIcon _tray;
    private readonly CodexRightClickHook _hook;
    private readonly Control _dispatcher = new();
    private readonly System.Windows.Forms.Timer _menuMonitor;
    private HappierMenuSidecar? _sidecar;
    private NativePopupMenu? _nativeMenu;
    private PendingCodexImport? _pendingImport;
    private CancellationTokenSource? _attachCancellation;
    private int _attachGeneration;

    public BridgeApplicationContext()
    {
        _happier = new HappierDaemonClient(_http);
        _dispatcher.CreateControl();
        var trayMenu = new ContextMenuStrip();
        trayMenu.Items.Add("检测 Codex 侧栏", null, (_, _) => ShowProbe());
        trayMenu.Items.Add("退出", null, (_, _) => ExitThread());
        _tray = new NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Application,
            Text = "Happier Codex Bridge",
            Visible = true,
            ContextMenuStrip = trayMenu,
        };
        _menuMonitor = new System.Windows.Forms.Timer { Interval = 50 };
        _menuMonitor.Tick += (_, _) =>
        {
            var nativeMenu = _nativeMenu;
            if (nativeMenu is null
                || !NativeMethods.IsWindow(nativeMenu.Handle)
                || !NativeMethods.IsWindowVisible(nativeMenu.Handle))
            {
                CloseSidecar();
            }
        };
        _hook = new CodexRightClickHook();
        _hook.RightButtonPressed += point =>
        {
            try
            {
                var target = CodexSidebarAutomation.FindTargetAtPoint(point);
                if (target is null)
                {
                    Interlocked.Increment(ref _attachGeneration);
                    _attachCancellation?.Cancel();
                    BridgeDiagnostics.Write("right_click_ignored");
                    _dispatcher.BeginInvoke(CloseSidecar);
                    return;
                }
                var pending = new PendingCodexImport(target.Title, target.ProcessId, point);
                _dispatcher.BeginInvoke(() => _ = AttachToNativeMenuAsync(pending));
                BridgeDiagnostics.Write("native_menu_attach_scheduled");
            }
            catch (Exception error)
            {
                BridgeDiagnostics.Write("right_click_failed", error.Message);
            }
        };
        BridgeDiagnostics.Write("started");
        ShowBalloon("Happier Codex Bridge 已启动", "在 Codex 左侧会话上点鼠标右键，即可导入到 Happier 直连。");
    }

    private async Task AttachToNativeMenuAsync(PendingCodexImport target)
    {
        var generation = Interlocked.Increment(ref _attachGeneration);
        _attachCancellation?.Cancel();
        _attachCancellation?.Dispose();
        var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        _attachCancellation = cancellation;
        CloseSidecar();

        try
        {
            var nativeMenu = await NativePopupMenuLocator.WaitForAsync(
                target.Point,
                target.ProcessId,
                TimeSpan.FromSeconds(2),
                cancellation.Token);
            if (nativeMenu is null)
            {
                BridgeDiagnostics.Write("native_menu_not_found");
                return;
            }
            if (generation != Volatile.Read(ref _attachGeneration) || cancellation.IsCancellationRequested) return;
            ShowSidecar(target, nativeMenu);
        }
        catch (OperationCanceledException)
        {
            // A newer right-click superseded this popup.
        }
        catch (Exception error)
        {
            BridgeDiagnostics.Write("native_menu_attach_failed", error.Message);
        }
    }

    private void ShowSidecar(PendingCodexImport target, NativePopupMenu nativeMenu)
    {
        CloseSidecar();
        try
        {
            var sidecar = new HappierMenuSidecar(nativeMenu.Bounds);
            _sidecar = sidecar;
            _nativeMenu = nativeMenu;
            _pendingImport = target;
            sidecar.Show();
            ArmSidecarClickInterceptor();
            _menuMonitor.Start();
            BridgeDiagnostics.Write(
                "native_menu_sidecar_shown",
                $"native={nativeMenu.Bounds};sidecar={sidecar.Bounds};title={target.Title}");
        }
        catch (Exception error)
        {
            BridgeDiagnostics.Write("native_menu_sidecar_failed", error.Message);
            CloseSidecar();
        }
    }

    private void ArmSidecarClickInterceptor()
    {
        _hook.LeftClickIntercepted = point =>
        {
            var sidecar = _sidecar;
            var nativeMenu = _nativeMenu;
            var target = _pendingImport;
            if (sidecar is null || nativeMenu is null || target is null || !sidecar.Visible)
            {
                _hook.LeftClickIntercepted = null;
                return false;
            }
            if (!sidecar.Bounds.Contains(point))
            {
                _hook.LeftClickIntercepted = null;
                _dispatcher.BeginInvoke(CloseSidecar);
                return false;
            }

            _hook.LeftClickIntercepted = null;
            _dispatcher.BeginInvoke(() => CaptureAndImportFromNativeMenu(target, nativeMenu));
            return true;
        };
    }

    private void CaptureAndImportFromNativeMenu(PendingCodexImport target, NativePopupMenu nativeMenu)
    {
        CloseSidecar();
        try
        {
            var threadId = CodexNativeMenuThreadIdReader.Read(nativeMenu.Handle);
            BridgeDiagnostics.Write("thread_id_captured", $"threadId={threadId};title={target.Title}");
            _ = Task.Run(() => ImportByIdAsync(threadId, target.Title));
        }
        catch (Exception error)
        {
            BridgeDiagnostics.Write("thread_id_capture_failed", error.Message);
            ShowBalloon("无法读取 Codex 会话 ID", error.Message, ToolTipIcon.Error);
        }
    }

    private void CloseSidecar()
    {
        _hook.LeftClickIntercepted = null;
        _menuMonitor.Stop();
        var sidecar = _sidecar;
        _sidecar = null;
        _nativeMenu = null;
        _pendingImport = null;
        if (sidecar is null) return;
        sidecar.Hide();
        sidecar.Dispose();
    }

    private async Task ImportByIdAsync(string threadId, string displayTitle)
    {
        try
        {
            var source = _codex.FindById(threadId)
                ?? throw new InvalidOperationException($"Codex 数据库里找不到会话 {threadId}");
            await ImportAsync(source with { Name = displayTitle });
        }
        catch (Exception error)
        {
            BridgeDiagnostics.Write("import_by_id_failed", error.Message);
            ShowBalloon("导入失败", error.Message, ToolTipIcon.Error);
        }
    }

    private async Task ImportAsync(CodexThread thread)
    {
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            var result = await _happier.LinkAsync(thread, timeout.Token);
            BridgeDiagnostics.Write(
                "import_succeeded",
                $"threadId={thread.Id};sessionId={result.SessionId};created={result.Created};title={thread.Name}");
            ShowBalloon(result.Created ? "已导入到 Happier" : "Happier 已有该会话", thread.Name);
            HappierDaemonClient.OpenSession(result.SessionId!);
        }
        catch (Exception error)
        {
            BridgeDiagnostics.Write("import_failed", error.Message);
            ShowBalloon("导入失败", error.Message, ToolTipIcon.Error);
        }
    }

    private void ShowProbe()
    {
        try
        {
            var candidates = CodexSidebarAutomation.FindSidebarTitleCandidates();
            var threads = _codex.ListRecent();
            var matched = candidates.Count(title => ThreadMatcher.FindByTitle(threads, title) is not null);
            ShowBalloon("Codex 侧栏检测完成", $"本地线程 {threads.Count} 条，UIA 候选 {candidates.Count} 条，匹配 {matched} 条。");
        }
        catch (Exception error)
        {
            ShowBalloon("Codex 侧栏检测失败", error.Message, ToolTipIcon.Error);
        }
    }

    private void ShowBalloon(string title, string message, ToolTipIcon icon = ToolTipIcon.Info)
    {
        _dispatcher.BeginInvoke(() =>
        {
            _tray.BalloonTipTitle = title;
            _tray.BalloonTipText = message.Length > 240 ? message[..240] : message;
            _tray.BalloonTipIcon = icon;
            _tray.ShowBalloonTip(5000);
        });
    }

    protected override void ExitThreadCore()
    {
        _attachCancellation?.Cancel();
        _attachCancellation?.Dispose();
        _hook.Dispose();
        CloseSidecar();
        _menuMonitor.Dispose();
        _tray.Visible = false;
        _tray.Dispose();
        _dispatcher.Dispose();
        _http.Dispose();
        base.ExitThreadCore();
    }
}

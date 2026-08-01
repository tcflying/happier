using System.Text.Json;
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
    private ContextMenuStrip? _bridgeMenu;
    private int _allowNextNativeRightClick;

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
        _hook = new CodexRightClickHook();
        _hook.PointerPressed += point =>
        {
            var menu = _bridgeMenu;
            if (menu is null || !menu.Visible || menu.Bounds.Contains(point)) return;
            _dispatcher.BeginInvoke(() =>
            {
                if (ReferenceEquals(_bridgeMenu, menu)) menu.Close();
            });
        };
        _hook.RightClickIntercepted = point =>
        {
            if (Interlocked.Exchange(ref _allowNextNativeRightClick, 0) == 1)
            {
                BridgeDiagnostics.Write("native_menu_replayed");
                return false;
            }
            try
            {
                var target = CodexSidebarAutomation.FindTargetAtPoint(point);
                if (target is null)
                {
                    BridgeDiagnostics.Write("right_click_ignored");
                    return false;
                }
                var pending = new PendingCodexImport(target.Title, target.ProcessId, point);
                _dispatcher.BeginInvoke(() => ShowBridgeMenu(pending));
                BridgeDiagnostics.Write("bridge_menu_scheduled");
                return true;
            }
            catch (Exception error)
            {
                BridgeDiagnostics.Write("right_click_failed", error.Message);
                return false;
            }
        };
        BridgeDiagnostics.Write("started");
        ShowBalloon("Happier Codex Bridge 已启动", "在 Codex 左侧会话上点鼠标右键，即可导入到 Happier 直连。");
    }

    private void ShowBridgeMenu(PendingCodexImport target)
    {
        _bridgeMenu?.Close();
        var menu = new ContextMenuStrip();
        _bridgeMenu = menu;
        menu.Items.Add("导入到 Happier 直连", null, (_, _) =>
        {
            menu.Close();
            _ = CaptureAndImportAsync(target);
        });
        menu.Closed += (_, _) => _dispatcher.BeginInvoke(() =>
        {
            if (ReferenceEquals(_bridgeMenu, menu)) _bridgeMenu = null;
            menu.Dispose();
        });
        menu.Show(target.Point);
        BridgeDiagnostics.Write("bridge_menu_shown");
    }

    private async Task CaptureAndImportAsync(PendingCodexImport target)
    {
        try
        {
            await Task.Delay(125);
            ReplayNativeRightClick(target.Point);
            var nativeMenu = await NativePopupMenuLocator.WaitForAsync(target.Point, target.ProcessId, TimeSpan.FromSeconds(2));
            if (nativeMenu is null)
            {
                BridgeDiagnostics.Write("native_menu_not_found");
                ShowBalloon("无法读取 Codex 会话 ID", "没有找到 Codex 原生右键菜单。", ToolTipIcon.Error);
                return;
            }
            var threadId = CodexNativeMenuThreadIdReader.Read(nativeMenu.Handle);
            BridgeDiagnostics.Write("thread_id_captured");
            _ = Task.Run(() => ImportByIdAsync(threadId, target.Title));
        }
        catch (Exception error)
        {
            BridgeDiagnostics.Write("thread_id_capture_failed", error.Message);
            ShowBalloon("无法读取 Codex 会话 ID", error.Message, ToolTipIcon.Error);
        }
    }

    private void ReplayNativeRightClick(System.Drawing.Point point)
    {
        Interlocked.Exchange(ref _allowNextNativeRightClick, 1);
        NativeMethods.SetCursorPos(point.X, point.Y);
        NativeMethods.mouse_event(NativeMethods.MouseEventRightDown, 0, 0, 0, UIntPtr.Zero);
        NativeMethods.mouse_event(NativeMethods.MouseEventRightUp, 0, 0, 0, UIntPtr.Zero);
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
        _hook.Dispose();
        _bridgeMenu?.Dispose();
        _tray.Visible = false;
        _tray.Dispose();
        _dispatcher.Dispose();
        _http.Dispose();
        base.ExitThreadCore();
    }
}

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
    private bool _handlingClick;

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
        _hook.RightClicked += point => _ = HandleRightClickAsync(point);
        ShowBalloon("Happier Codex Bridge 已启动", "在 Codex 左侧会话上点鼠标右键，即可导入到 Happier 直连。");
    }

    private async Task HandleRightClickAsync(System.Drawing.Point point)
    {
        if (_handlingClick) return;
        _handlingClick = true;
        try
        {
            var threads = _codex.ListRecent();
            var thread = CodexSidebarAutomation.FindThreadAtPoint(threads, point);
            if (thread is null) return;
            await Task.Delay(120);
            _dispatcher.BeginInvoke(() => ShowImportMenu(point, thread));
        }
        catch (Exception error)
        {
            ShowBalloon("无法读取 Codex 会话", error.Message, ToolTipIcon.Error);
        }
        finally
        {
            _handlingClick = false;
        }
    }

    private void ShowImportMenu(System.Drawing.Point point, CodexThread thread)
    {
        var menu = new ContextMenuStrip();
        var item = menu.Items.Add("导入到 Happier 直连");
        item.ToolTipText = thread.Name;
        item.Click += async (_, _) => await ImportAsync(thread);
        menu.Closed += (_, _) => menu.Dispose();
        menu.Show(point);
    }

    private async Task ImportAsync(CodexThread thread)
    {
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            var result = await _happier.LinkAsync(thread, timeout.Token);
            ShowBalloon(result.Created ? "已导入到 Happier" : "Happier 已有该会话", thread.Name);
            HappierDaemonClient.OpenSession(result.SessionId!);
        }
        catch (Exception error)
        {
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
        _tray.Visible = false;
        _tray.Dispose();
        _dispatcher.Dispose();
        _http.Dispose();
        base.ExitThreadCore();
    }
}

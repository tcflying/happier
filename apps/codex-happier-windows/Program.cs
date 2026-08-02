using Microsoft.Win32;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;

namespace HappierCodexBridge;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            return RunAsync(args).GetAwaiter().GetResult();
        }
        catch (Exception error)
        {
            if (!IsTestInvocation(args)) BridgeDiagnostics.Write("fatal", error.ToString());
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static bool IsTestInvocation(string[] args)
        => args.Any(argument => argument is
            "--self-test"
            or "--native-menu-sidecar-test"
            or "--native-menu-sidecar-test-host"
            or "--menu-dismiss-test"
            or "--right-click-passthrough-test"
            or "--left-drag-passthrough-test"
            or "--pinned-thread-test"
            or "--live-pinned-import-test");

    private static async Task<int> RunAsync(string[] args)
    {
        if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
        {
            return SelfTests.Run();
        }

        if (args.Contains("--native-menu-sidecar-test", StringComparer.OrdinalIgnoreCase))
        {
            return NativeMenuSidecarTest.Run();
        }

        if (args.Contains("--native-menu-sidecar-test-host", StringComparer.OrdinalIgnoreCase))
        {
            return NativeMenuSidecarTest.RunHost(args);
        }

        if (args.Contains("--menu-dismiss-test", StringComparer.OrdinalIgnoreCase))
        {
            return BridgeMenuDismissTest.Run();
        }

        if (args.Contains("--right-click-passthrough-test", StringComparer.OrdinalIgnoreCase))
        {
            return RightClickPassThroughTest.Run();
        }

        if (args.Contains("--left-drag-passthrough-test", StringComparer.OrdinalIgnoreCase))
        {
            return LeftDragPassThroughTest.Run();
        }

        var pinnedThreadTestIndex = Array.FindIndex(
            args,
            value => string.Equals(value, "--pinned-thread-test", StringComparison.OrdinalIgnoreCase));
        if (pinnedThreadTestIndex >= 0)
        {
            if (pinnedThreadTestIndex + 1 >= args.Length)
            {
                Console.Error.WriteLine("PINNED_THREAD_TEST_TITLE_REQUIRED");
                return 2;
            }

            var title = args[pinnedThreadTestIndex + 1];
            var target = CodexSidebarAutomation.FindTargetByTitle(title);
            if (target is null)
            {
                Console.Error.WriteLine("PINNED_THREAD_TEST_TARGET_NOT_FOUND");
                return 3;
            }
            var thread = new CodexPinnedThreadResolver(new CodexThreadStore()).Resolve(target);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                status = "PINNED_THREAD_TEST=PASS",
                thread.Id,
                thread.Name,
                thread.Cwd,
                target.RowIndex,
                target.ListSize,
            }));
            return 0;
        }

        var livePinnedImportIndex = Array.FindIndex(
            args,
            value => string.Equals(value, "--live-pinned-import-test", StringComparison.OrdinalIgnoreCase));
        if (livePinnedImportIndex >= 0)
        {
            if (livePinnedImportIndex + 1 >= args.Length)
            {
                Console.Error.WriteLine("LIVE_PINNED_IMPORT_TEST_TITLE_REQUIRED");
                return 2;
            }
            return LivePinnedImportTest.Run(args[livePinnedImportIndex + 1]);
        }

        if (args.Contains("--install", StringComparer.OrdinalIgnoreCase))
        {
            return Install();
        }

        if (args.Contains("--probe", StringComparer.OrdinalIgnoreCase))
        {
            var codex = new CodexThreadStore();
            var threads = codex.ListRecent();
            var candidates = CodexSidebarAutomation.FindSidebarTitleCandidates();
            var requestedTitleIndex = Array.FindIndex(args, value => string.Equals(value, "--probe-title", StringComparison.OrdinalIgnoreCase));
            var titles = requestedTitleIndex >= 0 && requestedTitleIndex + 1 < args.Length
                ? new[] { args[requestedTitleIndex + 1] }
                : candidates.Take(20).ToArray();
            var matches = new List<CodexThread>();
            foreach (var title in titles)
            {
                var found = ThreadMatcher.FindByTitle(threads, title);
                if (found is not null && matches.All(item => item.Id != found.Id)) matches.Add(found);
            }
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                uiaCandidates = candidates.Count,
                localThreads = threads.Count,
                searchedTitles = titles.Length,
                matchedThreads = matches.Count,
                matches = matches.Select(thread => new { thread.Id, thread.Name, thread.Cwd }),
            }));
            return matches.Count > 0 ? 0 : 2;
        }

        var idIndex = Array.FindIndex(args, value => string.Equals(value, "--import-thread", StringComparison.OrdinalIgnoreCase));
        var titleIndex = Array.FindIndex(args, value => string.Equals(value, "--import-title", StringComparison.OrdinalIgnoreCase));
        var displayTitleIndex = Array.FindIndex(args, value => string.Equals(value, "--import-display-title", StringComparison.OrdinalIgnoreCase));
        if ((idIndex >= 0 && idIndex + 1 < args.Length) || (titleIndex >= 0 && titleIndex + 1 < args.Length))
        {
            var codex = new CodexThreadStore();
            var thread = idIndex >= 0 ? codex.FindById(args[idIndex + 1]) : ThreadMatcher.FindByTitle(codex.ListRecent(), args[titleIndex + 1]);
            if (thread is null)
            {
                Console.Error.WriteLine("THREAD_NOT_FOUND");
                return 3;
            }
            if (displayTitleIndex >= 0 && displayTitleIndex + 1 < args.Length)
            {
                thread = thread with { Name = args[displayTitleIndex + 1].Trim() };
            }
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            var result = await new HappierDaemonClient(http).LinkAsync(thread, CancellationToken.None);
            Console.WriteLine(JsonSerializer.Serialize(new { thread.Id, thread.Name, result.SessionId, result.Created }));
            if (!args.Contains("--no-open", StringComparer.OrdinalIgnoreCase)) HappierDaemonClient.OpenSession(result.SessionId!);
            return 0;
        }

        using var mutex = new Mutex(initiallyOwned: true, "Local\\HappierCodexBridge", out var ownsMutex);
        if (!ownsMutex) return 0;

        System.Windows.Forms.Application.SetHighDpiMode(System.Windows.Forms.HighDpiMode.PerMonitorV2);
        System.Windows.Forms.Application.EnableVisualStyles();
        System.Windows.Forms.Application.SetCompatibleTextRenderingDefault(false);
        using var context = new BridgeApplicationContext();
        System.Windows.Forms.Application.Run(context);

        return 0;
    }

    private static int Install()
    {
        var source = Environment.ProcessPath ?? throw new InvalidOperationException("无法确定当前程序路径");
        var installDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Happier", "CodexBridge");
        Directory.CreateDirectory(installDirectory);
        var destination = Path.Combine(installDirectory, "HappierCodexBridge.exe");
        if (!string.Equals(Path.GetFullPath(source), Path.GetFullPath(destination), StringComparison.OrdinalIgnoreCase))
        {
            File.Copy(source, destination, overwrite: true);
        }
        using var runKey = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
        runKey.SetValue("HappierCodexBridge", $"\"{destination}\"");
        Process.Start(new ProcessStartInfo(destination) { UseShellExecute = true });
        Console.WriteLine(destination);
        return 0;
    }
}

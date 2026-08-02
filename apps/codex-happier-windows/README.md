# Happier Codex Bridge for Windows

一个独立、单文件的 Windows 托盘程序。它不修改 Codex Desktop 安装目录：

1. 用 Windows UI Automation 识别 Codex 左侧会话行和右键位置，完整放行 Codex 原生右键。
2. 在原生菜单边缘追加唯一一行“导入到 Happier 直连”，不覆盖原生菜单；原生菜单关闭时追加行同步收起。
3. 将 UIA 行号与 Codex Desktop 自己的 pinned 顺序、client 别名和归档状态对齐，得到精确 thread ID；不读取或修改系统剪贴板，也不启动额外 app-server。
4. 只读查询 `%USERPROFILE%\.codex\state_5.sqlite` 取得 cwd 等会话元数据。
5. 通过 Happier daemon 已有的随机控制令牌调用本机直连导入接口。
6. 导入成功后打开 `http://localhost:19087/?id=<sessionId>`。

## 构建与安装

```powershell
dotnet publish .\HappierCodexBridge.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
.\bin\Release\net8.0-windows\win-x64\publish\HappierCodexBridge.exe --self-test
.\bin\Release\net8.0-windows\win-x64\publish\HappierCodexBridge.exe --install
```

安装位置是 `%LOCALAPPDATA%\Happier\CodexBridge\HappierCodexBridge.exe`，并写入当前用户的登录启动项。

## 诊断

```powershell
HappierCodexBridge.exe --probe
HappierCodexBridge.exe --probe --probe-title "会话标题"
HappierCodexBridge.exe --import-thread <thread-id> --no-open
HappierCodexBridge.exe --import-title "会话标题" --no-open
HappierCodexBridge.exe --import-thread <thread-id> --import-display-title "界面标题" --no-open
```

正常运行时，在 Codex 左侧会话行上点鼠标右键，Codex 原生菜单保持完整，并在边缘追加一行“导入到 Happier 直连”。

原生菜单、鼠标透传与 pinned 顺序精确解析回归测试：

```powershell
HappierCodexBridge.exe --native-menu-sidecar-test
HappierCodexBridge.exe --menu-dismiss-test
HappierCodexBridge.exe --right-click-passthrough-test
HappierCodexBridge.exe --left-drag-passthrough-test
HappierCodexBridge.exe --pinned-thread-test "fushion happier (2)"
HappierCodexBridge.exe --live-pinned-import-test "fushion happier (2)"
```

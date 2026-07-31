# Happier Codex Bridge for Windows

一个独立、单文件的 Windows 托盘程序。它不修改 Codex Desktop 安装目录：

1. 用 Windows UI Automation 识别 Codex 左侧会话行和右键位置。
2. 只读查询 `%USERPROFILE%\.codex\state_5.sqlite`，把会话标题映射为 Codex thread ID。
3. 通过 Happier daemon 已有的随机控制令牌调用本机直连导入接口。
4. 导入成功后打开 `http://localhost:19087/?id=<sessionId>`。

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
```

正常运行时，在 Codex 左侧会话行上点鼠标右键，会出现“导入到 Happier 直连”。

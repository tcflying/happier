# Happier Codex Bridge for Windows

一个独立、单文件的 Windows 托盘程序。它不修改 Codex Desktop 安装目录：

1. 用 Windows UI Automation 识别 Codex 左侧会话行和右键位置。
2. 弹出唯一一项“导入到 Happier 直连”，点击菜单外任意位置会自动收起。
3. 导入时调用 Codex 原生“复制会话 ID”，读取精确 thread ID，并恢复用户原剪贴板。
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

正常运行时，在 Codex 左侧会话行上点鼠标右键，只会出现“导入到 Happier 直连”。

原生会话 ID 读取与剪贴板恢复回归测试：

```powershell
HappierCodexBridge.exe --native-menu-id-test
HappierCodexBridge.exe --menu-dismiss-test
HappierCodexBridge.exe --right-click-suppression-test
```

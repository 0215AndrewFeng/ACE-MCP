# ace-mcp Windows 安装说明

适用包名：`ace-mcp-v4.7.0-win-x64.zip`。

## 环境要求

- Windows 10/11 x64
- Node.js 18.18.0 或更高版本，推荐 Node.js 20/22 LTS
- npm 9+

`better-sqlite3` 是原生依赖。优先使用 Node.js LTS 版本可直接复用预编译包；如果 npm 触发源码编译，需要安装 Visual Studio Build Tools，并勾选 `Desktop development with C++`。

## Zip 安装

1. 解压 `ace-mcp-v4.7.0-win-x64.zip`。
2. 在解压目录打开 PowerShell。
3. 执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

cmd 也可以执行：

```cmd
install.cmd
```

安装脚本会在依赖安装后自动运行 `node dist\index.js --doctor`，检查 Node/npm、`better-sqlite3`、SQLite FTS5、目录写权限和端口占用。

## 启动 Web 面板

默认端口：

```cmd
start-web.cmd
```

指定端口：

```cmd
start-web.cmd 9000
```

PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-web.ps1 9000
```

启动后访问 `http://127.0.0.1:8787/`。

## npm/tgz 全局安装

如果使用 npm 或 tgz 全局安装：

```powershell
npm install -g ace-mcp
ace-mcp --version
ace-mcp-web
```

本地 tgz：

```powershell
npm install -g .\ace-mcp-4.7.0.tgz
ace-mcp-web
```

## MCP 客户端配置

全局安装后可直接配置：

```json
{
  "mcpServers": {
    "ace-mcp": {
      "command": "ace-mcp"
    }
  }
}
```

如果 MCP 宿主无法读取 PATH，使用 npm shim 绝对路径：

```json
{
  "mcpServers": {
    "ace-mcp": {
      "command": "C:\\Users\\<用户名>\\AppData\\Roaming\\npm\\ace-mcp.cmd"
    }
  }
}
```

Zip 解压运行时：

```json
{
  "mcpServers": {
    "ace-mcp": {
      "command": "node",
      "args": [
        "C:\\path\\to\\ace-mcp-v4.7.0-win-x64\\dist\\index.js"
      ]
    }
  }
}
```

## 常见问题

- 先运行 `ace-mcp --doctor` 或在 zip 解压目录运行 `node dist\index.js --doctor`，按输出的 `Next steps` 处理。
- PowerShell 拒绝执行脚本：使用 `powershell -ExecutionPolicy Bypass -File .\install.ps1`。
- `better-sqlite3` 安装失败：先切换到 Node.js 20/22 LTS；仍失败时安装 Visual Studio Build Tools 的 C++ 工作负载。
- Web 面板打不开：检查 doctor 的 `Web port` 项，或改用 `start-web.cmd 9000`。
- `ace-mcp` 命令找不到：在 MCP 客户端里改用 `C:\Users\<用户名>\AppData\Roaming\npm\ace-mcp.cmd`。

# ace-mcp Windows 使用说明

适用包名：`ace-mcp-v4.10.9-win-x64.zip`。

发布状态：v4.10.9 自包含 ZIP 尚待回到 Windows 主机补充构建与验证；该产物必须在 Windows x64 + Node.js 22 环境生成并通过原生依赖、CLI、doctor 和 Web smoke，不能用 macOS 构建结果替代。

## 系统要求

- Windows 10/11 x64
- 不需要预装 Node.js、npm 或 Visual Studio Build Tools
- 首次运行和日常使用均不需要从 npm 或 GitHub 下载依赖

通过上述 Windows 门禁的发布包应包含同一台构建主机上验证过的 Node.js 22 运行时、生产依赖和 `better-sqlite3` Windows 原生二进制。

## v4.10.9 摘要辅助项目路由

- 自动项目路由可复用现有项目摘要中的架构、模块描述、模块路径和关键符号，补充代码关键词之外的业务语义。
- 摘要按文件修改时间缓存，缺失或损坏时继续使用原有代码和符号证据，不会在查询时调用 LLM。

## v4.10.8 运行时稳定性与搜索并发

- SQLite 搜索使用有限 reader pool、请求队列上限和总 deadline；8/16/32 及 during-index 场景纳入发布 benchmark。
- 自动维护默认最多启用 8 个 root-only watcher，其余项目降级为 `periodic-only`，仍由 startup/periodic reconciliation 保证最终一致性。
- maintenance lease 在长持久化阶段之间主动续租并执行 fencing，避免错误提示其他进程持有自动维护 ownership。

## v4.10.7 Codex 沙箱配置

- npm/tgz 全局安装后可运行 `ace-mcp-configure-codex`，将用户目录下的 `.ace-mcp` 数据目录加入 Codex `sandbox_workspace_write.writable_roots`。
- 自包含 ZIP 用户可在 `%USERPROFILE%\.codex\config.toml` 的 `[sandbox_workspace_write]` 下合并 `writable_roots = ['C:\Users\<用户名>\.ace-mcp']`，然后重启 Codex。

## v4.10.6 跨进程索引行为

- Web startup/periodic catch-up 与 watcher 自动索引持有可续租 maintenance lease，stdio MCP freshness 不再启动竞争 writer。
- 有效 lease 期间查询复用最后成功索引；owner 崩溃或 lease 过期后恢复按需索引。

## v4.10.5 增量索引行为

- Git 持续报告 dirty/untracked 的文件仍经过文件指纹校验；内容未再变化时，周期校准不会重复重建索引。
- 新增文件和文件指纹真实变化时仍会正常进入增量索引。

## v4.10.4 路由与日志行为

- 自动维护跳过拥有两个及以上已登记后代项目的聚合父目录，由具体子项目各自 watcher 和周期校准；显式父目录索引仍可执行。
- 可靠 clean Git 项目的周期校准可在 HEAD 未变化且没有 dirty/失败/in-flight 状态时走 fast path；其他情况保守执行正常索引。
- SQLite 索引写入使用独立 index worker，source parse batch 会主动 yield；`/health` 可查看 active/queued phase、origin、进度和 queue/phase elapsed 诊断。
- 项目路由保留 ASCII/CJK 混合业务词，并以仓库名 ownership 锚点召回同族项目，降低复制代码误选。
- NDJSON 日志遵循配置等级，默认按 20 MiB 轮转并保留 3 个归档；EPIPE、磁盘和 metadata 序列化失败不会打崩进程。

## 启动 Web 面板

1. 解压 `ace-mcp-v4.10.9-win-x64.zip`。
2. 双击 `start-web.cmd`。
3. 访问 <http://127.0.0.1:8787/>。

指定端口：

```cmd
start-web.cmd 9000
```

PowerShell 也可以运行：

```powershell
.\start-web.ps1 9000
```

关闭启动窗口会停止服务。运行 `doctor.cmd` 可以检查 SQLite、数据目录、配置和端口状态。旧版本的自动化流程仍可调用 `install.cmd`，该入口现在只执行本地自检，不会联网安装依赖。

## MCP 客户端配置

将 `command` 设置为解压目录中 `ace-mcp.cmd` 的绝对路径：

```json
{
  "mcpServers": {
    "ace-mcp": {
      "command": "C:\\Tools\\ace-mcp-v4.10.9-win-x64\\ace-mcp.cmd"
    }
  }
}
```

不需要再配置 `node` 命令或 `dist/index.js` 参数。移动解压目录后，需要同步更新 MCP 客户端中的绝对路径。

## 命令行入口

```cmd
ace-mcp.cmd --version
ace-mcp.cmd --doctor
ace-mcp-web.cmd
ace-mcp-web.cmd 9000
```

## 全库维护重索引

启动 Web 服务后，可以预览维护计划：

```cmd
runtime\node.exe scripts\reindex-projects.mjs --dry-run
```

确认后逐项目执行 full index，并可附带生成摘要：

```cmd
runtime\node.exe scripts\reindex-projects.mjs --summary
```

## 包内结构

- `runtime\node.exe`：与原生依赖 ABI 匹配的 Node.js 22 运行时
- `node_modules\`：构建阶段裁剪过的生产依赖
- `dist\`：ace-mcp 服务和 Web 静态资源
- `ace-mcp.cmd`：MCP/CLI 入口
- `start-web.cmd`：Web 面板入口
- `doctor.cmd`：离线安装自检

## npm/tgz 安装

需要参与开发或自行管理 Node.js 环境时，仍可使用 npm/tgz：

```powershell
npm install -g ace-mcp
ace-mcp --version
ace-mcp-web
```

Windows 普通用户优先使用自包含 ZIP，避免 Node 版本和原生依赖下载问题。

## 常见问题

- Web 面板打不开：运行 `doctor.cmd` 检查默认端口，或执行 `start-web.cmd 9000`。
- MCP 客户端启动失败：确认 `command` 指向当前解压目录中的 `ace-mcp.cmd` 绝对路径。
- 安全软件提示未知脚本：入口脚本只调用同目录的 `runtime\node.exe` 和 `dist\index.js`，不会下载或安装系统组件。
- `ask_codebase` 或摘要功能不可用：在环境变量或 `~/.ace-mcp/settings.toml` 中配置 LLM API；本地索引和搜索不依赖 LLM。

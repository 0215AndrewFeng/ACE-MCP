# ace-mcp

本地代码搜索 `MCP Server`，面向 `Java`、`JavaScript/TypeScript`、`.NET/C#`、`Python` 项目，支持本地扫描、增量索引、全文/符号/路径搜索，并通过标准 `MCP` 协议把结果提供给 AI 客户端。

当前版本：`v3.0.1`

更新日志见 [`CHANGELOG.md`](./CHANGELOG.md)。

当前版本已具备：

- 本地项目扫描与 `.gitignore` 过滤
- 增量索引
- `SQLite + FTS5` 全文检索
- 语义召回 `MVP`（本地语义词扩展 + 混合检索）
- JavaScript/TypeScript AST 级定义抽取，Java / Python / .NET 增强轻量符号抽取
- `search_context` / `index_project` / `get_file_snippet` / `project_stats`
- 可选 Web 调试面板

## 使用示例

- Copilot 提示词模板：[`example/copilot-prompts.md`](./example/copilot-prompts.md)
- Claude Code 提示词模板：[`example/claude-code-prompts.md`](./example/claude-code-prompts.md)

## 环境要求

- Node.js `>= 18.18.0`
- npm `>= 9`

## 安装

```bash
npm install
```

## 构建

```bash
npm run build
```

查看当前版本：

```bash
node dist/index.js --version
```

## 本地运行

### 作为 MCP Server 启动

```bash
npm start
```

### 启动 MCP Server 并开启 Web 调试面板

```bash
npm start -- --web-port 8787
```

启动后可访问：

- `http://127.0.0.1:8787/`
- `http://127.0.0.1:8787/health`
- `http://127.0.0.1:8787/api/runtime`

## MCP 客户端配置示例

以 Claude Desktop 或其他支持 MCP 的客户端为例：

```json
{
  "mcpServers": {
    "ace-mcp": {
      "command": "node",
      "args": [
        "/Users/fengandrew/code/ace-mcp/dist/index.js"
      ]
    }
  }
}
```

若需要同时开启 Web 调试面板：

```json
{
  "mcpServers": {
    "ace-mcp": {
      "command": "node",
      "args": [
        "/Users/fengandrew/code/ace-mcp/dist/index.js",
        "--web-port",
        "8787"
      ]
    }
  }
}
```

### 宿主升级与重连建议

- 升级 `dist/` 或切换到新版本包后，需在 MCP 宿主侧执行一次 **reload / reconnect**，让宿主拉起新的 `ace-mcp` 进程。
- 若怀疑宿主仍连着旧进程，可先执行 `node dist/index.js --version` 确认版本，再访问 `/health` 或 `/api/runtime` 检查当前进程的 `version`、`pid` 与 `uptimeMs`。
- 若宿主需要并行调试，可在配置中加上 `--web-port 8787`，通过 HTTP 接口独立验证 `index_project` / `search_context`。

## 可用工具

### `index_project`

扫描并建立项目索引。

索引过程现在对单文件失败具备容错能力：若某些文件读取或处理失败，其余文件仍会继续索引，并在结果中返回 `failedFileCount` 与 `failedFiles` 诊断信息。

输入示例：

```json
{
  "projectRootPath": "/path/to/project",
  "mode": "incremental"
}
```

### `search_context`

自动执行增量索引后返回相关代码片段。

若增量索引过程中出现文件级失败，返回结果还会包含 `indexing` 摘要，便于排查“为什么这次搜索没有覆盖到某些新改动”。

也支持可选过滤条件：

- `languages`: 仅在指定语言范围内搜索，例如 `["java", "javascript"]`
- `pathPrefix`: 仅在指定相对路径前缀下搜索，例如 `src/web`
- `pathContains`: 仅在路径包含指定片段时搜索，例如 `search`
- `excludePathPrefix`: 排除指定相对路径前缀，例如 `dist`
- `resultMode`: 返回模式，`full` 返回 snippet，`metadata` 仅返回元数据与解释摘要
- `mode`: 搜索模式，支持 `auto` / `lexical` / `symbol` / `semantic` / `hybrid`

输入示例：

```json
{
  "projectRootPath": "/path/to/project",
  "query": "find refund service implementation",
  "mode": "auto",
  "topK": 8,
  "includeContextLines": 8,
  "languages": ["javascript"],
  "pathPrefix": "src/web",
  "pathContains": "search",
  "excludePathPrefix": "dist",
  "resultMode": "metadata"
}
```

其中 `includeContextLines` 为可选参数，默认 `0`，表示在命中片段前后额外展开的上下文行数，最大 `50`。`languages`、`pathPrefix`、`pathContains`、`excludePathPrefix`、`resultMode` 与 `mode` 均为可选；未传时保持当前全局搜索行为。`resultMode = "metadata"` 时结果仍保留位置、分数和 `explanation`，但 `snippet` 会被省略为空字符串，且 `snippetIncluded = false`。

当前 `auto` 与 `hybrid` 模式会额外启用语义召回 `MVP`：基于本地索引内容生成语义词，并结合常见代码概念同义词（如 `login/signin/auth`、`repository/dao/store`、`handler/controller/endpoint`）进行混合检索；若只想看语义候选，也可直接使用 `mode = "semantic"`。

当查询中已经包含明显的复合代码标识符（如 `MyWorkOrderController`、`GetMyWorkOrders`）时，`auto` 模式会优先走 lexical / symbol / path 分支，避免在大仓库上被高开销的 semantic 扩展拖慢。

搜索结果中的每个条目现在还会附带紧凑的 `explanation` 摘要，用于解释该结果为何靠前，例如：

- 命中的来源类型 `matchedSources`（`lexical` / `symbol` / `path` / `semantic`）
- 命中的查询 token 与覆盖率 `matchedTokens` / `tokenCoverage`
- 是否存在精确路径、文件名、符号或 snippet 查询命中

### `get_file_snippet`

读取指定文件的行区间。

### `project_stats`

返回项目索引统计信息。

当项目已有索引记录时，结果会包含最近一次索引事件摘要 `latestIndexEvent`，其中包括失败文件数量和部分失败明细。

## 配置文件

首次运行会自动创建：

```text
~/.ace-mcp/
  settings.toml
  data/index.db
  log/ace-mcp.log
```

配置示例：

```toml
batchSize = 32
defaultTopK = 8
maxFileSizeKb = 1024
maxLinesPerChunk = 220
logLevel = "info"
textExtensions = [".java", ".js", ".jsx", ".ts", ".tsx", ".cs", ".py"]
excludePatterns = [".git", "node_modules", "dist", "build", "target", "bin", "obj", "__pycache__", ".venv"]
```

也支持环境变量覆盖：

- `ACE_MCP_BATCH_SIZE`
- `ACE_MCP_DEFAULT_TOP_K`
- `ACE_MCP_MAX_FILE_SIZE_KB`
- `ACE_MCP_MAX_LINES_PER_CHUNK`
- `ACE_MCP_LOG_LEVEL`
- `ACE_MCP_TEXT_EXTENSIONS`
- `ACE_MCP_EXCLUDE_PATTERNS`

## Web 调试面板

当前提供最小能力：

- 健康检查
- 运行态信息查看（版本、PID、启动时间、运行时长）
- 当前配置查看
- 工具列表查看
- 已索引项目列表
- 项目统计查看
- 交互式调试表单页面
- 直接通过 HTTP 调试 `index_project` 与 `search_context`（含上下文行、语言与路径前缀过滤）
- 直接通过 HTTP 调试 `get_file_snippet`

主要接口：

- `GET /health`
- `GET /api/runtime`
- `GET /api/config`
- `GET /api/tools`
- `GET /api/projects`
- `GET /api/project-stats?projectRootPath=/path/to/project`
- `POST /api/file-snippet`
- `POST /api/index-project`
- `POST /api/search-context`

## 开发建议

当前版本优先实现“稳定可用的本地搜索骨架”。如果继续增强，建议按以下顺序推进：

1. 更细的语言适配器拆分
2. 语义向量检索
3. 更丰富的 Web UI
4. 结果重排与质量评估

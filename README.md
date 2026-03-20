# ace-mcp

本地代码搜索 `MCP Server`，面向 `Java`、`JavaScript/TypeScript`、`.NET/C#`、`Python` 项目，支持本地扫描、增量索引、全文/符号/路径搜索，并通过标准 `MCP` 协议把结果提供给 AI 客户端。

当前版本已具备：

- 本地项目扫描与 `.gitignore` 过滤
- 增量索引
- `SQLite + FTS5` 全文检索
- 轻量符号抽取
- `search_context` / `index_project` / `get_file_snippet` / `project_stats`
- 可选 Web 调试面板

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

## 可用工具

### `index_project`

扫描并建立项目索引。

输入示例：

```json
{
  "projectRootPath": "/path/to/project",
  "mode": "incremental"
}
```

### `search_context`

自动执行增量索引后返回相关代码片段。

输入示例：

```json
{
  "projectRootPath": "/path/to/project",
  "query": "find refund service implementation",
  "mode": "auto",
  "topK": 8
}
```

### `get_file_snippet`

读取指定文件的行区间。

### `project_stats`

返回项目索引统计信息。

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
- 当前配置查看
- 工具列表查看
- 已索引项目列表
- 项目统计查看
- 交互式调试表单页面
- 直接通过 HTTP 调试 `index_project` 与 `search_context`
- 直接通过 HTTP 调试 `get_file_snippet`

主要接口：

- `GET /health`
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

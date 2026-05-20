# ace-mcp

本地代码搜索 `MCP Server`，面向 `Java`、`JavaScript/TypeScript`、`.NET/C#`、`Python` 项目，支持本地扫描、增量索引、全文/符号/路径搜索，并通过标准 `MCP` 协议把结果提供给 AI 客户端。

当前版本：`v3.7.0`

更新日志见 [`CHANGELOG.md`](./CHANGELOG.md)。

当前版本已具备：

- 本地项目扫描与 `.gitignore` 过滤
- 增量索引
- `SQLite + FTS5` 全文检索
- 语义召回（本地语义词扩展 + 远程 Embedding API 支持）
- 懒加载向量索引与项目级向量缓存
- 文件监听自动重新索引（2500ms 防抖）
- JavaScript/TypeScript AST 级分析，Java / Python / .NET 增强轻量符号、import、usage 抽取
- 结构化查询语言：`AND` / `OR` / `NOT` + `symbol:` / `path:` / `content:`
- 语言级 definition/reference 解析、跨文件引用精度提升与多跳调用关系图
- `search_context` / `find_definition` / `find_references` / `find_callers` / `find_callees` / `evaluate_search_quality` / `index_project` / `get_file_snippet` / `project_stats`
- 搜索质量指标：`passRate` / `top1Recall` / `top5Recall` / `meanReciprocalRank`
- 统一的 `meta / request / data / stats / notes` 返回结构
- 搜索诊断信息（query analysis / phase timings / source breakdown / vector status）
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

自动执行增量索引后返回相关代码片段与结构化诊断信息。

工具层现在统一返回 `meta / request / data / stats / notes` 五段结构，并同时通过 MCP `content.text` 与 `structuredContent` 暴露同一份 JSON。

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

也支持结构化查询，例如：

```json
{
  "projectRootPath": "/path/to/project",
  "query": "symbol:RefundService AND path:src/refund NOT path:test",
  "mode": "auto",
  "topK": 8
}
```

其中 `includeContextLines` 为可选参数，默认 `0`，表示在命中片段前后额外展开的上下文行数，最大 `50`。`languages`、`pathPrefix`、`pathContains`、`excludePathPrefix`、`resultMode` 与 `mode` 均为可选；未传时保持当前全局搜索行为。`resultMode = "metadata"` 时结果仍保留位置、分数和 `explanation`，但 `snippet` 会被省略为空字符串，且 `snippetIncluded = false`。

当前 `auto` 与 `hybrid` 模式会额外启用语义召回 `MVP`：基于本地索引内容生成语义词，并结合常见代码概念同义词（如 `login/signin/auth`、`repository/dao/store`、`handler/controller/endpoint`）进行混合检索；若只想看语义候选，也可直接使用 `mode = "semantic"`。向量检索默认采用 `lazy` 模式，仅在首次 `semantic / hybrid` 查询时按需补齐对应项目的 chunk 向量，以降低大仓库索引时延。

当查询中已经包含明显的复合代码标识符（如 `MyWorkOrderController`、`GetMyWorkOrders`）时，`auto` 模式会优先走 lexical / symbol / path 分支，避免在大仓库上被高开销的 semantic 扩展拖慢。

搜索结果中的每个条目现在还会附带紧凑的 `explanation` 摘要，用于解释该结果为何靠前，例如：

- 命中的来源类型 `matchedSources`（`lexical` / `symbol` / `path` / `semantic`）
- 命中的查询 token 与覆盖率 `matchedTokens` / `tokenCoverage`
- 是否存在精确路径、文件名、符号或 snippet 查询命中

返回中的关键统计含义如下：

- `stats.project.indexedFileCount`：项目当前持久化索引里的总文件数
- `stats.indexSync.indexedFiles`：本次搜索前增量同步实际重新写入的文件数
- `stats.indexSync.scannedFiles`：本次增量同步扫描过的文件数
- `stats.search.candidateCount`：本次重排前汇总到的候选结果数
- `data.diagnostics.executedStrategies`：各搜索阶段是否执行、耗时和候选量
- `notes`：当本次增量同步未发现变更、或存在失败文件时，给出解释性提示，避免把 `0` 误读为“项目未建索引”

### `find_definition`

自动执行增量索引后定位符号定义，返回文件路径、行号、签名和代码片段。

输入示例：

```json
{
  "projectRootPath": "/path/to/project",
  "query": "RefundService.processRefund",
  "topK": 5,
  "resultMode": "metadata"
}
```

### `find_references`

自动执行增量索引，先解析最可能的定义，再优先基于语言级 symbol graph 返回 reference 命中；对 namespace import、模块别名和同名跨文件符号会优先按导入上下文收敛；若图中无结果，再回退到词法匹配。

输入示例：

```json
{
  "projectRootPath": "/path/to/project",
  "query": "RefundService.processRefund",
  "topK": 8
}
```

### `find_callers`

自动执行增量索引，解析目标定义后返回已解析调用图中的 caller 结果，支持按 `depth` 做多跳展开，并返回每条命中的 `hopCount` / `symbolPath`。

输入示例：

```json
{
  "projectRootPath": "/path/to/project",
  "query": "RefundService.processRefund",
  "depth": 2,
  "topK": 8,
  "resultMode": "metadata"
}
```

其中 `depth` 为可选参数，默认 `1`，最大 `5`。

### `find_callees`

自动执行增量索引，解析目标定义后返回该符号内部已解析调用到的 callee 结果，支持按 `depth` 做多跳展开，并返回每条命中的 `hopCount` / `symbolPath`。

输入示例：

```json
{
  "projectRootPath": "/path/to/project",
  "query": "handleRefund",
  "depth": 2,
  "topK": 8,
  "resultMode": "metadata"
}
```

### `evaluate_search_quality`

自动执行增量索引，并批量运行预期文件断言，输出通过率、Top1/Top5 Recall、MRR 与逐 case 结果。

输入示例：

```json
{
  "projectRootPath": "/path/to/project",
  "cases": [
    {
      "name": "semantic login",
      "query": "login handler",
      "mode": "semantic",
      "expectedFiles": ["src/auth/signInHandler.ts"],
      "topK": 5
    }
  ]
}
```

### `get_file_snippet`

读取指定文件的行区间，结果放在 `data.snippet`，实际返回的行号范围放在 `stats.snippet`。

### `project_stats`

返回项目索引统计信息。

项目总量放在 `stats.project`，最近一次索引事件放在 `stats.latestIndexing`。若项目尚未索引，`data.indexed = false`，并在 `notes` 中给出说明。

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
autoWatch = true
batchSize = 32
defaultTopK = 8
enableVectorSearch = true
maxFileSizeKb = 1024
maxLinesPerChunk = 220
logLevel = "info"
textExtensions = [".java", ".js", ".jsx", ".ts", ".tsx", ".cs", ".py"]
excludePatterns = [".git", "node_modules", "dist", "build", "target", "bin", "obj", "__pycache__", ".venv"]
vectorIndexingMode = "lazy"
```

也支持环境变量覆盖：

- `ACE_MCP_BATCH_SIZE`
- `ACE_MCP_DEFAULT_TOP_K`
- `ACE_MCP_ENABLE_VECTOR_SEARCH`
- `ACE_MCP_MAX_FILE_SIZE_KB`
- `ACE_MCP_MAX_LINES_PER_CHUNK`
- `ACE_MCP_LOG_LEVEL`
- `ACE_MCP_TEXT_EXTENSIONS`
- `ACE_MCP_EXCLUDE_PATTERNS`
- `ACE_MCP_VECTOR_INDEXING_MODE`
- `ACE_MCP_AUTO_WATCH`

### 远程 Embedding API

通过环境变量配置远程 Embedding API，用于语义搜索的向量生成：

```bash
ACE_MCP_EMBEDDING_PROVIDER=remote \
ACE_MCP_EMBEDDING_API_URL=https://api.openai.com/v1/embeddings \
ACE_MCP_EMBEDDING_API_KEY=sk-xxx \
ACE_MCP_EMBEDDING_MODEL=text-embedding-3-small \
ace-mcp --web-port 8787
```

- `ACE_MCP_EMBEDDING_PROVIDER`：设为 `remote` 启用远程 API（默认 `memory`，使用本地哈希向量）
- `ACE_MCP_EMBEDDING_API_URL`：OpenAI 兼容的 Embedding API 端点
- `ACE_MCP_EMBEDDING_API_KEY`：API 密钥（仅从环境变量读取，不落盘）
- `ACE_MCP_EMBEDDING_MODEL`：模型名，默认 `text-embedding-3-small`

远程 API 请求失败时自动回退到本地内存哈希向量，保证搜索可用性。

## Web 调试面板

当前提供最小能力：

- 健康检查
- 运行态信息查看（版本、PID、启动时间、运行时长）
- 当前配置查看
- 工具列表查看
- 已索引项目列表
- 项目统计查看
- 交互式调试表单页面
- 直接通过 HTTP 调试 `index_project`、`search_context`、`find_definition`、`find_references`、`find_callers`、`find_callees` 与 `evaluate_search_quality`
- 直接通过 HTTP 调试 `get_file_snippet`
- 文件监听控制：`POST /api/watch/start` / `POST /api/watch/stop`
- 搜索与索引结果摘要（候选数、耗时、向量模式）

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
- `POST /api/find-definition`
- `POST /api/find-references`
- `POST /api/find-callers`
- `POST /api/find-callees`
- `POST /api/evaluate-search-quality`
- `POST /api/watch/start`
- `POST /api/watch/stop`

## 路线图

### v3.8.0（已发布）

- **索引新鲜度策略**（`indexFreshness: always/stale/manual`），搜索前按策略跳过全量扫描
- **向量搜索优化**：Top-K 堆 + Float32Array 预转换，替代暴力全排序
- **符号图增量解析**：仅处理变更文件 + suffix 索引替代 O(n) filter
- **搜索缓存全模式覆盖**：semantic/hybrid 启用缓存 + 嵌套 Map 结构
- **新增工具**：`cache_stats`、`clear_project_index`、`list_symbols`
- **配置灵活性**：暴露缓存 TTL、fanout limit 等硬编码参数
- **错误处理统一**：`AppError` 扩展、Web API 状态码映射

### v3.9.0（规划中）

- 更深的多跳调用关系图与路径压缩/去噪
- `sqlite-vss` / ANN 等更高效的向量后端
- 更丰富的 Web 结果分析、质量回放与对比界面

## 开发建议

当前版本已经补齐性能、诊断、结构化查询、语言级基础导航、多跳调用关系和质量评估指标。如果继续增强，建议按以下顺序推进：

1. 更深的调用关系与引用精度
2. 更细的语言适配器拆分
3. `sqlite-vss` / ANN 等更高效的向量后端
4. 更丰富的 Web UI

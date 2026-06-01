# ace-mcp

本地代码搜索 `MCP Server`，面向 `Java`、`JavaScript/TypeScript`、`.NET/C#`、`Python` 项目，支持本地扫描、增量索引、全文/符号/路径搜索，并通过标准 `MCP` 协议把结果提供给 AI 客户端。

当前版本：`v4.4.5`

更新日志见 [`CHANGELOG.md`](./CHANGELOG.md)。

仓库地址：[GitHub](https://github.com/0215AndrewFeng/ACE-MCP) | [Gitee](https://gitee.com/AndrewFengCode/ace-mcp)

## 核心功能

### 代码搜索

- 本地项目扫描与 `.gitignore` 过滤
- 增量索引，文件监听自动重新索引（2500ms 防抖）
- `SQLite + FTS5` 全文检索
- 语义召回（本地语义词扩展 + 远程 Embedding API 支持）
- 懒加载向量索引与项目级向量缓存
- 结构化查询语言：`AND` / `OR` / `NOT` + `symbol:` / `path:` / `content:`
- JavaScript/TypeScript AST 级分析，Java / Python / .NET 增强轻量符号、import、usage 抽取
- 语言级 definition/reference 解析、跨文件引用精度提升与多跳调用关系图
- 搜索质量指标：`passRate` / `top1Recall` / `top5Recall` / `meanReciprocalRank`

### 智能问答 (RAG)

- **LLM 流式问答**：SSE 逐 token 显示，支持多轮对话追问
- **调用链分析**：自动提取搜索结果中符号的上下游调用关系，作为额外上下文传递给 LLM
- **调用链可视化**：Mermaid 流程图展示函数调用关系
- **可配置参考代码数量**：用户可自行选择检索源数量（1~50），前端选择直接生效
- **LLM Reranker（可选）**：使用 LLM 对搜索结果二次排序，提升搜索精度
- **LLM 响应缓存**：相同问题 5 分钟内直接返回缓存结果，节省 token
- **代码引用高亮**：`[N]` 引用可点击跳转到对应源码卡片
- **思考过程展示**：DeepSeek 模型的 reasoning_content 实时显示
- **代码摘要生成**：自动生成项目架构概览和模块摘要

### MCP 工具

- `search_context` / `find_definition` / `find_references` / `find_callers` / `find_callees`
- `evaluate_search_quality` / `index_project` / `get_file_snippet` / `project_stats`
- `generate_summary` / `get_summary` / `ask_codebase` / `warm_index`
- `cache_stats` / `clear_project_index` / `list_symbols`

## 使用示例

- Copilot 提示词模板：[`example/copilot-prompts.md`](./example/copilot-prompts.md)
- Claude Code 提示词模板：[`example/claude-code-prompts.md`](./example/claude-code-prompts.md)

## 环境要求

- Node.js `>= 18.18.0`
- npm `>= 9`

## 一键下载与启动

### GitHub

```bash
git clone https://github.com/0215AndrewFeng/ACE-MCP.git && cd ACE-MCP && npm install && npm run build && npm start -- --web-port 8787
```

### Gitee

```bash
git clone https://gitee.com/AndrewFengCode/ace-mcp.git && cd ace-mcp && npm install && npm run build && npm start -- --web-port 8787
```

> 执行完毕后访问 http://127.0.0.1:8787/ 即可使用 Web 调试面板。

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

### CLI 参数

| 参数 | 说明 |
|------|------|
| `--web-port <port>` | 启动 HTTP 调试面板，如 `--web-port 8787` |
| `-v, --version` | 查看当前版本 |
| `-h, --help` | 查看帮助信息 |
| `--autostart enable` | 启用开机自启（macOS launchd / Linux systemd） |
| `--autostart disable` | 禁用开机自启 |
| `--autostart status` | 查看开机自启状态 |

### 开机自启管理

```bash
# 启用开机自启（同时开启 Web 面板）
node dist/index.js --autostart enable --web-port 8787

# 查看自启状态
node dist/index.js --autostart status

# 禁用开机自启
node dist/index.js --autostart disable
```

### 启动流程

ace-mcp 启动时按以下顺序初始化：

1. **解析 CLI 参数** — `--version`/`--help`/`--autostart` 处理后直接退出
2. **加载配置** — 从 `~/.ace-mcp/settings.toml` 读取配置，支持环境变量覆盖
3. **初始化核心服务** — `Logger`、`SQLiteStore`（建表）、`EmbeddingProvider`、`IndexCoordinator`、`SearchService`、`LlmClient`、`SummaryGenerator`，全部本地初始化无网络依赖
4. **创建 MCP Server** — 注册所有工具，通过 stdin/stdout 与 MCP 宿主通信
5. **可选启动 Web 面板** — 指定 `--web-port` 时启动 Express HTTP 服务
6. **注册信号处理** — `SIGINT`/`SIGTERM` 触发优雅关闭

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
- 若宿主需要并行调试，可在配置中加上 `--web-port 8787`，通过 HTTP 接口独立验证。

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

# LLM 配置（支持 OpenAI 兼容接口）
llmApiUrl = "https://api.deepseek.com/v1/chat/completions"
llmApiKey = "sk-xxx"
llmModel = "deepseek-reasoner"
llmMaxTokens = 4096
llmTemperature = 0.0
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
- `ACE_MCP_LLM_API_URL`
- `ACE_MCP_LLM_API_KEY`
- `ACE_MCP_LLM_MODEL`

#### v4.3.6 新增配置项

Ask Codebase 限制配置（解决查询不准确问题）：

- `ACE_MCP_QA_MAX_SOURCES_DEFAULT` - 默认检索源数量（默认 10）
- `ACE_MCP_QA_MAX_SOURCES_MAX` - 最大检索源数量上限（默认 50）
- `ACE_MCP_QA_MAX_CONTEXT_TOKENS` - LLM 上下文 token 预算（默认 6000）
- `ACE_MCP_SEARCH_PER_FILE_LIMIT` - 每个文件最多保留的搜索结果数（默认 2）
- `ACE_MCP_SEARCH_FANOUT_MULTIPLIER` - 搜索候选集扩展倍数（默认 3）

### 远程 Embedding API

通过环境变量配置远程 Embedding API，用于语义搜索的向量生成：

```bash
ACE_MCP_EMBEDDING_PROVIDER=remote \
ACE_MCP_EMBEDDING_API_URL=https://api.openai.com/v1/embeddings \
ACE_MCP_EMBEDDING_API_KEY=sk-xxx \
ACE_MCP_EMBEDDING_MODEL=text-embedding-3-small \
ace-mcp --web-port 8787
```

远程 API 请求失败时自动回退到本地内存哈希向量，保证搜索可用性。

## Web 调试面板

Web 面板提供完整的可视化调试体验：

### 智能问答

- **Ask Codebase**：基于 RAG 的代码问答，支持流式输出
- **多轮对话**：自动保留上下文，支持追问
- **代码引用**：`[N]` 引用可点击跳转
- **会话统计**：显示 token 用量和请求次数

### 代码搜索

- **交互式搜索**：支持所有搜索模式和过滤条件
- **语法高亮**：搜索词和代码语法高亮显示
- **搜索历史**：点击历史记录快速填充

### 项目管理

- **项目列表**：持久化存储，支持删除
- **索引控制**：手动触发索引和向量预热
- **代码摘要**：生成和查看项目摘要

### 主要接口

- `GET /health` - 健康检查
- `GET /api/runtime` - 运行时信息
- `GET /api/config` - 配置信息
- `GET /api/tools` - 工具列表
- `GET /api/projects` - 已索引项目
- `GET /api/project-stats` - 项目统计
- `POST /api/index-project` - 触发索引
- `POST /api/search-context` - 代码搜索
- `POST /api/find-definition` - 定义查找
- `POST /api/find-references` - 引用查找
- `POST /api/find-callers` - 调用者查找
- `POST /api/find-callees` - 被调用者查找
- `POST /api/qa/ask` - 代码问答
- `GET /api/qa/ask/stream` - 流式问答 (SSE)
- `POST /api/summary/generate` - 生成摘要
- `GET /api/summary` - 获取摘要
- `POST /api/index/warm` - 向量预热
- `GET/POST /api/llm/config` - LLM 配置

## 版本历史

### v4.4.5（当前版本）

- **LLM 最大输出 token 可配置**：智能问答高级选项新增 `maxTokens` 配置（默认 8192，范围 512~32768），用户可自行调整 LLM 回答的最大 token 数。此前默认 2048，结合本地代码后回答经常被截断
- **`llmMaxTokens` 默认值从 2048 提升到 8192**：确保回答不会被截断

### v4.4.4

- **"结合本地代码"开关**：智能问答高级选项新增 checkbox，控制是否读取搜索命中文件的完整本地源码。开启时使用 `full-file` 模式，LLM 能看到完整实现逻辑，更准确但消耗更多 token；关闭时使用 `chunk` 模式，更快更省 token。默认开启

### v4.4.3

- **调用链源码补全**：QA 管线在提取调用链关系后，自动读取每个 caller/callee 的源码（上下文 ±5 行），作为独立 section 注入 LLM 上下文。此前调用链只返回符号名和位置，LLM 无法理解具体实现逻辑
- **去重机制**：调用链源码与搜索结果按 `filePath:startLine` 去重，避免重复注入相同代码
- **`qaMaxContextTokens` 从 12000 提升到 24000**：token 预算翻倍确保搜索结果和调用链源码都能完整注入
- **`qaMaxSourcesMax` 从 50 提升到 100**：支持更多参考代码片段

### v4.4.2

- **HNSW 向量搜索**：纯 JS 实现 HNSW 近似最近邻索引，搜索复杂度从 O(n) 降到 O(log n)，大型项目性能显著提升
- **调用链深度增强**：支持 1-3 跳调用关系追踪，递归展开上下游调用链
- **Web 质量评估界面**：新增搜索质量评估面板，支持测试用例管理、批量评估、指标可视化

### v4.4.0

- **符号级语义索引**：索引阶段自动为英文符号名生成中文语义标签（200+ 词汇表翻译），写入 `chunk_semantic_fts`，使 FTS 天然支持中文搜索匹配英文代码
- **双轮搜索策略**：QA 问答先用原始查询搜索（受益于语义标签），再用 LLM 扩展的英文关键词补充搜索，两轮结果合并去重
- **中英文同义词扩充**：70+ 组中英文双向同义词映射，中文查询"出票"自动扩展匹配 "ticket"

### v4.3.9

- **LLM 查询扩展**：中文自然语言查询自动提取英文代码关键词（类名、方法名），解决跨语言搜索匹配问题
- **索引超时保护**：`ensureFreshIndex` 和 in-flight promise 复用均添加超时，避免卡住的索引阻塞搜索
- **projectQueue 清理 bug 修复**：修复等式比较永远为 false 导致的队列泄漏

### v4.3.8

- **全文件/合并文件上下文模式**：`ask_codebase` 支持 `contextMode` 参数，解决跨函数问答信息缺失
- **统一 QA 管线**：MCP `ask_codebase` 与 Web QA 共用完整管线（reranker、调用链、缓存、smart topK）
- **搜索 Reranker 通用化**：MCP `search_context` 新增 `enableReranker` 参数
- **动态 perFileLimit**：根据查询类型自动调整每文件结果数

### v4.3.0

- **智能 Sources 数量**：根据问题复杂度自动调整检索源数量
- **LLM 响应缓存**：相同问题 5 分钟内直接返回缓存结果
- **思考过程展示**：DeepSeek reasoning_content 实时显示

### v4.2.x

- **流式问答**：SSE 逐 token 输出
- **多轮对话**：支持上下文追问
- **代码引用高亮**：`[N]` 引用可点击跳转
- **中文界面**：全新设计的中文 Web 面板
- **搜索结果懒加载**：代码 snippet 折叠显示
- **错误分类展示**：区分网络/超时/LLM/索引错误
- **Token 统计**：会话级 token 累计统计

### v4.0.x

- **代码知识库**：摘要生成、语义问答 RAG、文档联合索引
- **LLM API 集成**：支持 OpenAI 兼容接口

### v3.x

- **语言级符号解析**：definition/reference、调用关系图
- **结构化查询**：布尔运算和字段限定
- **向量搜索**：语义召回、候选预过滤
- **索引优化**：新鲜度策略、缓存管理

## 路线图

- **查询扩展缓存**：相似问题复用 LLM 提取的关键词，减少 token 消耗
- **根目录索引防护**：拒绝对 `/`、`$HOME` 等过大路径的索引请求，从源头杜绝卡死
- **索引健康监控**：`/health` 端点暴露 in-flight 索引列表和耗时
- **语言适配器插件化**：Java/Python/.NET/JS 符号提取拆成独立插件，方便扩展 Go/Rust 等

## 开发建议

如果继续增强，建议按以下顺序推进：

1. `sqlite-vss` / ANN 等更高效的向量搜索后端
2. 更丰富的 Web 结果分析、质量回放与对比界面
3. 更深的调用关系与引用精度
4. 更细的语言适配器拆分

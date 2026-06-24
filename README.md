# ace-mcp

本地代码搜索 `MCP Server`，面向 `Java`、`JavaScript/TypeScript`、`.NET/C#`、`Python` 项目，支持本地扫描、增量索引、全文/符号/路径搜索，并通过标准 `MCP` 协议把结果提供给 AI 客户端。

当前版本：`v4.7.1`

更新日志见 [`CHANGELOG.md`](./CHANGELOG.md)。

仓库地址：[Gitee](https://gitee.com/AndrewFengCode/ace-mcp)

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
- **业务流程图**：问答涉及业务流程/处理逻辑时，答案末尾自动追加 Mermaid 流程图（`flowchart TD`）并渲染为可视化图表
- **流程图/调用链图导出**：渲染后的图可一键下载 PNG、下载 SVG 或复制 Mermaid 源码

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
- Windows 建议使用 Node.js 20/22 LTS。`better-sqlite3` 是原生依赖，过新的 Node 版本可能触发本地编译。

## 推荐安装方式

### npm 全局安装

发布到 npm registry 后可直接安装：

```bash
npm install -g ace-mcp
ace-mcp --version
ace-mcp-web
```

`ace-mcp-web` 等价于使用默认端口启动 Web 面板：

```bash
ace-mcp --web-port 8787
```

可通过环境变量改默认端口：

```bash
ACE_MCP_WEB_PORT=9000 ace-mcp-web
```

### tgz 全局安装

从 Gitee Release 下载 `ace-mcp-4.7.1.tgz` 后安装：

```bash
npm install -g ./ace-mcp-4.7.1.tgz
ace-mcp-web
```

Windows PowerShell：

```powershell
npm install -g .\ace-mcp-4.7.1.tgz
ace-mcp-web
```

### Windows zip 安装

从 Gitee Release 下载 `ace-mcp-v4.7.1-win-x64.zip`，解压后在目录内执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
.\start-web.cmd
```

cmd：

```cmd
install.cmd
start-web.cmd
```

详细说明见 [`scripts/README-WINDOWS.md`](./scripts/README-WINDOWS.md)。

### 源码安装

```bash
git clone https://gitee.com/AndrewFengCode/ace-mcp.git
cd ace-mcp
npm install
npm run build
npm start -- --web-port 8787
```

GitHub 镜像：

```bash
git clone https://github.com/0215AndrewFeng/ACE-MCP.git
```

> 启动后访问 http://127.0.0.1:8787/ 即可使用 Web 调试面板。

### Windows 启动脚本

全局安装后优先使用：

```powershell
ace-mcp-web
ace-mcp-web 9000
```

源码目录或解包后的 tgz 中也提供脚本：

```cmd
scripts\start-web.cmd
scripts\start-web.cmd 9000
```

PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-web.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-web.ps1 9000
```

### 本地打包

```bash
npm run release:pack
npm install -g ./ace-mcp-4.7.1.tgz
```

`release:pack` 使用仓库内 `.npm-cache/`，避免本机全局 npm cache 权限问题影响打包。

Windows zip：

```bash
npm run release:win
```

安装包 smoke test：

```bash
npm run release:smoke
```

`release:smoke` 会把当前 tgz 安装到临时目录，验证 `ace-mcp --version`、`ace-mcp --doctor` 和 `ace-mcp-web` 的 `/health`。

搜索 benchmark smoke：

```bash
npm run release:benchmark
```

`release:benchmark` 会启动隔离的临时 Web 服务，索引一个小项目并输出 search/health p95 与事件循环响应性。

## 本地运行

### 安装自检 / 排障

```bash
ace-mcp --doctor
```

`--doctor` 检查 Node/npm、`better-sqlite3`、SQLite FTS5、数据/日志目录写权限、默认 Web 端口和 LLM/Embedding 配置。安装失败、Web 面板打不开、`better-sqlite3` 编译失败或 MCP 客户端找不到命令时，先运行它查看下一步修复建议。

### 搜索质量回归（发版前建议）

将 golden 用例写入 `eval-cases/golden.json`（格式见 `example/eval-cases.example.json`），执行：

```bash
npm run build && npm test && npm run eval
```

`npm run eval` 等价于 `node dist/index.js --eval eval-cases/golden.json`：对每个被测项目增量索引后跑 `evaluate_search_quality`，打印逐用例 PASS/FAIL 与汇总指标（passRate/top1/top5/MRR），任一用例不达 `minPassRate`（默认 1.0）即退出码 1。真实业务用例所在的 `eval-cases/` 已 gitignore，不会入库。

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
| `--warm` | 启动后异步暖机已索引项目，消除首次查询延迟 |
| `--eval <caseFile>` | 跑搜索质量回归（加载 JSON golden 用例文件），打印报告后退出，退出码 0=通过 / 1=不达标 |
| `-v, --version` | 查看当前版本 |
| `-h, --help` | 查看帮助信息 |
| `--autostart enable` | 启用开机自启（macOS launchd / Linux systemd） |
| `--autostart disable` | 禁用开机自启 |
| `--autostart status` | 查看开机自启状态 |

### 开机自启管理

`--autostart` 当前支持 macOS launchd 和 Linux systemd user service。Windows 可先使用任务计划程序手动配置，后续版本再补内置管理。

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

全局安装后：

```json
{
  "mcpServers": {
    "ace-mcp": {
      "command": "ace-mcp"
    }
  }
}
```

Windows 全局安装后，如果 MCP 宿主找不到 PATH 中的命令，可使用 npm 全局 shim 的绝对路径：

```json
{
  "mcpServers": {
    "ace-mcp": {
      "command": "C:\\Users\\<用户名>\\AppData\\Roaming\\npm\\ace-mcp.cmd"
    }
  }
}
```

源码运行：

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

若需要启动时自动暖机已索引项目（消除首次查询延迟）：

```json
{
  "mcpServers": {
    "ace-mcp": {
      "command": "node",
      "args": [
        "/Users/fengandrew/code/ace-mcp/dist/index.js",
        "--warm"
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

- `ACE_MCP_QA_MAX_SOURCES_DEFAULT` - 默认检索源数量（默认 15）
- `ACE_MCP_QA_MAX_SOURCES_MAX` - 最大检索源数量上限（默认 100）
- `ACE_MCP_QA_MAX_CONTEXT_TOKENS` - LLM 上下文 token 预算（默认 48000；放大可让大接口带更完整代码，受模型上下文窗口约束）
- `ACE_MCP_QA_MAX_CONTEXT_TOKENS_MAX` - 上下文预算上限，用于钳制按请求传入的 `maxContextTokens`（默认 200000）
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
- `POST /api/qa/cache/clear` - 清除 QA 缓存
- `GET /api/qa/ask/stream` - 流式问答 (SSE)
- `POST /api/summary/generate` - 生成摘要
- `GET /api/summary` - 获取摘要
- `POST /api/index/warm` - 向量预热
- `GET/POST /api/llm/config` - LLM 配置

## 版本历史

### v4.7.1（当前版本）

- **搜索 benchmark 工具**：新增 `npm run benchmark:search`，可对已索引项目输出 search p95、health p95 和事件循环响应性；`npm run release:benchmark` 提供隔离 smoke，当前 release check 结果为 resultCount 1、search p95 78ms、health p95 12ms、event-loop responsive 1/1
- **SQLite 连接稳定性**：SQLite store 构造阶段统一设置 WAL、`busy_timeout=30000`、`synchronous=NORMAL` 等连接级 PRAGMA，搜索 worker 的独立连接也会应用同样的锁等待策略，降低并发索引/搜索时 `database is locked` 的概率
- **发布诊断增强**：benchmark smoke 隔离 HOME、关闭一次性服务的 auto-watch，并在失败时输出子进程 stdout/stderr 与 `.ace-mcp/log`，便于定位 release 阶段崩溃

### v4.7.0

- **SQLite 搜索 worker**：`search_context` 普通/结构化查询中的 lexical、semantic FTS、unicode substring、symbol、path 和文件预览读取改由独立 SQLite 搜索 worker 执行，避免 `better-sqlite3` 同步大查询占住 Web/MCP 主事件循环
- **源码测试兼容**：dist 使用 `worker_thread`，源码/dev/test 运行时使用 `node --import tsx` IPC 子进程执行同一 worker 入口，保证开发环境和发布包都走异步搜索读路径
- **并发回归测试**：新增 `searchServiceConcurrency.test.ts`，证明 SQLite 搜索 pending 时 `setTimeout(0)` 能先于搜索 Promise 完成被调度

### v4.6.9

- **安装自检（`--doctor`）**：新增本地健康检查，覆盖 Node/npm、`better-sqlite3`、SQLite FTS5、数据/日志/配置目录写权限、Web 端口占用与 LLM/Embedding 配置，输出明确修复建议
- **安装包 smoke test**：新增 `npm run release:smoke`，从当前 tgz 安装到临时目录，验证 `ace-mcp --version`、`ace-mcp --doctor`、`ace-mcp-web` 与 `/health`
- **Windows 安装闭环**：zip 安装脚本在 `npm install --omit=dev` 后自动运行 `node dist\index.js --doctor`，更早暴露原生依赖和环境问题

### v4.6.8

- **Windows zip 打包**：新增 `npm run release:win`，构建后生成 `release/ace-mcp-v4.6.8-win-x64.zip`，包含 `dist/`、生产依赖安装入口、README、许可证与启动脚本
- **Windows 安装脚本**：新增 `install.cmd` / `install.ps1` 包装入口及 `scripts/install-windows.{cmd,ps1}`，检查 Node/npm 版本并执行 `npm install --omit=dev`，失败时提示 `better-sqlite3` 与 Visual Studio Build Tools 处理方式
- **Windows 专用 README + 发布清单**：补充 zip/npm/tgz 全局安装、`ace-mcp.cmd` MCP 路径、`ExecutionPolicy` 说明，并新增 `docs/release-checklist.md` 固化发版验证步骤

### v4.6.7

- **npm/tgz 全局安装**：包从私有项目改为可发布包，新增 `ace-mcp-web` 全局命令，`npm install -g ace-mcp` 或 `npm install -g ./ace-mcp-4.6.7.tgz` 后可直接启动 Web 面板
- **Windows 启动脚本**：新增 `scripts/start-web.cmd` 与 `scripts/start-web.ps1`，支持默认 8787 端口、位置参数端口和 `ACE_MCP_WEB_PORT`
- **发布打包脚本**：新增 `npm run release:pack`，打包时包含 `scripts/`，并继续排除 `dist/**/*.test.*` 与 `dist/test/**`

### v4.6.6

- **补齐质量防线**：恢复 `npm test` 的真实可执行性，补齐脚本中引用但仓库缺失的 17 个测试文件，覆盖 CLI、查询分析、端到端索引/搜索、Web `/health` 与参数校验、SQLite/VectorCache、搜索打分/辅助函数、语义文本、远程 Embedding fallback、QA 缓存、共享 schema、源码解码、IndexCoordinator freshness 与 evalRunner。当前仓库 `npm test` 跑 50 个用例全绿
- **中文复杂问题 source 估算修复**：`estimateOptimalSources` 先判断复杂/Review 意图，再走短查询兜底，避免中文无空格问题因 `wordCount <= 3` 被误判为简单查询，只给 5 个参考源
- **中文源码解码评分修复**：`decodeSourceBuffer` 评分对可读 CJK 字符加权，GBK 中文源码不再被 latin1 乱码误判

### v4.6.5

- **修复暖机窗口内索引元数据失真**：v4.6.4 暖机用硬编码 `vectorIndex.enabled=false`、全零 `timings`/计数的合成结果恢复 freshness 状态，导致暖机窗口内（`stale` 默认 30s，`manual` 则无限期）所有工具/Web 响应把向量索引误报为禁用。改为铺展真实的 `latestIndexEvent`，仅 `null` 时回退默认值；不改动跳描行为，仅修正上报元数据

### v4.6.4

- **冷启动暖机（`--warm`）**：新增 `--warm` CLI 标志，服务启动后异步暖机已索引项目，消除重启后首次查询 18-22s 延迟。三层暖机策略：① 从数据库恢复 `ensureFreshIndex` 内存状态使 `"stale"` 策略跳过已知最新项目；② 预加载向量缓存 + 触发异步 HNSW 构建；③ 确保 `semantic FTS` 索引完整。暖机完全异步、不阻塞 MCP/Web 可用性

### v4.6.3

- **修复 PNG 导出失败**：mermaid flowchart 默认 `htmlLabels:true` 用 `<foreignObject>` 渲染文字，导致含 foreignObject 的 SVG 光栅化到 canvas 被污染、`toBlob` 抛错。改 `flowchart:{htmlLabels:false}` 用纯 `<text>` 渲染（外观无退化），并将 PNG 加载改为 data URL。已用真实 Chrome 验证 PNG 正常导出

### v4.6.2

- **流程图导出**：业务流程图与调用链图渲染后均提供导出工具栏——下载 PNG（SVG→canvas 光栅化、白底、×2 清晰度）、下载 SVG（矢量无损）、复制 Mermaid 源码（可粘到其他编辑器）。纯前端，不动后端

### v4.6.1

- **业务流程图**：智能问答分析完业务逻辑后，答案末尾自动追加「业务流程图」一节（`flowchart TD`），把关键步骤/判断可视化。仅改一处 `QA_SYSTEM_PROMPT` 覆盖 MCP/Web/SSE 三条路径；前端 `renderMarkdown` 先抽取 ```` ```mermaid ```` 块再走其余变换（避免被引用正则/段落变换破坏），流式结束后 `mermaid.run()` 渲染为 SVG，失败回退保留原文代码块
- **自动化质量防线（`--eval`）**：新增 `--eval <caseFile>` CLI 与 `npm run eval`，加载 JSON golden 用例、逐 suite 跑 `evaluateSearchQuality`、打印 PASS/FAIL + passRate/top1/top5/MRR，按 `minPassRate`（默认 1.0）以退出码 0/1 判定，可纳入发版前回归。提交脱敏模板 `example/eval-cases.example.json`；真实业务用例放 `eval-cases/`（已 gitignore）

### v4.6.0

- **SSE 断连中止上游 LLM（#39）**：客户端断连后通过 `AbortController` 真正中止上游 LLM 请求，不再白烧 token；LLM 阶段前增加断连早退
- **引用跳转容错**：前端正则容错 LLM 偶发输出的 `[1:L60-L88]` 形式引用（此前显示为死文本），并在提示词中明确只用纯 `[N]`
- **cosineSimilarity 合一（#34）**、**缓存淘汰 FIFO 化（#35，remoteEmbedding/searchService 两处 O(n log n) 排序消除）**、**Error/AppError 统一（#38，llmClient/summaryGenerator 六处，Web 出口不再一律 500）**

### v4.5.15

- **打分恰好一次（#23）**：搜索排序管线此前对同一结果重复打分并写回（碰撞结果 bonus 累加 3 次、无碰撞 2 次），排序被路径依赖扭曲。现 `choosePreferredResult` 仅比较不写回、`rerankResults` 删除二次打分，bonus 恰好加一次。实测业务逻辑类排位上升、枚举/常量类下降
- **CJK 语义 FTS 词数上限（#37）**：`buildSemanticFtsQuery` 截断改为 CJK 感知——含中文上限 15（配合 v4.5.13 bigram 分词），纯 ASCII 维持 8。中文查询 semantic 候选 15→18

### v4.5.14

- **ask_codebase reranker 对齐**：MCP `ask_codebase` 此前硬编码强制开启 LLM reranker（覆盖全局默认 `enableLlmReranker=false`），每次问答多付 ~10s reranker 调用。现回落配置默认，并新增可选 `enableReranker` 参数按请求覆盖。附 #42 重测结论：v4.5.13 后 QA 的 expansion/search 已降至几百 ms，剩余耗时主体为 LLM 端点生成速度（属配置/选型，可换更快模型或调低 `llmMaxTokens`/`maxSources`）

### v4.5.13

- **中文查询分词**：中文自然语言问题此前被切成一个整串 token（CJK 属字母、中文无空格），`queryAnalyzer` 新增 CJK bigram 切分（复用 `buildCjkBigrams`）：整串保留以保精确匹配，并追加 bigram（上界 16）
- **语义索引存在性检查性能修复（关键）**：`ensureSemanticIndex` 每次语义搜索都跑，此前用 `LEFT JOIN` FTS5 未索引列判断缺失 chunk，退化为 O(n²) 逐行扫 FTS，2k chunk 项目实测每次查询白跑 ~122s。改为 `NOT IN` 单次 O(n) 扫描（122s→1.2s）。中文问答端到端实测 **~64s → ~1.8s**

### v4.5.12

- **放开参考代码量**：对大接口提问时参考代码不够用（受 `qaMaxContextTokens` 默认 24000 限制，超出即被 `compressContext` 截断）。默认上下文预算提高到 48000、`qaMaxSourcesDefault` 提到 15；`ask_codebase` 与 Web `/api/qa/ask`（含 SSE）新增可选 `maxContextTokens` 按请求覆盖，受新增上限 `qaMaxContextTokensMax`（默认 200000）钳制。最终量仍受 LLM 上下文窗口约束

### v4.5.11

- **QA 上游使用方（caller）扩展**：智能问答对「X 场景有什么特殊处理」这类问题，此前只召回定义符号的 model/enum/VO 定义类，真正使用该符号做业务判断的逻辑类（caller）从未进入上下文。新增 `findUpstreamUsages`，从召回结果片段中提取已定义符号（getter/方法名），查它们的 `findCallers`，把使用方业务类源码（含调用点 ±15 行）拉进问答 context；对 service/logic/processor/handler/impl 等业务层 caller 加权、限量去噪。对称补齐 v4.4.8 的下游（callee）扩展，纯本地调用图查询，不增加 LLM 调用、不改通用打分

### v4.5.10

- **searchByPath 文件名匹配度排序**：路径搜索多取候选后按 basename 匹配度（去扩展名精确>精确>前缀>包含>仅目录）重排再截断，文件名精确匹配不再因路径长被截掉；评分逻辑不变
- **日志统一**：`RemoteEmbeddingProvider` 的 `console.warn` 改为注入的 `logger?.warn`，避免 MCP stdio 模式下污染 stdout

### v4.5.9

- **Web API 验证统一**：新增 `core/validation/schemas.ts` 作为入参枚举/边界/默认值的单一来源，MCP 工具与 Web 路由共用；Web 侧保持宽松（coerce+clamp），仅必填项缺失时返回 400。修正 `qa/ask` 的 `contextMode` 默认值与 MCP/SSE 对齐
- **关键路径测试覆盖**：测试 33→97，新增 9 个测试文件覆盖 `safeJsonParse`、搜索打分/工具纯函数、`QaCache`、共享/宽松校验、`VectorCacheStore` reconcile、`deleteFiles` 级联、源码解码助手

### v4.5.8

- **JSON.parse 防护**：数据库列解析新增 `safeJsonParse` 工具（6 处），列损坏时降级为空值并记日志，不再崩溃进程
- **大文件中等拆分**：公共 API 与现有测试不变的前提下，`sqliteStore.ts`（2879→2004，抽出 `VectorCacheStore`/types/helpers）、`app.ts`（1532→50，路由拆到 `web/routes/*`）、`searchService.ts`（1765→1073，纯函数拆到 `searchScoring.ts`/`searchHelpers.ts`）拆为聚焦模块

### v4.5.7

- **增量索引 vector 缓存精准失效**：增量索引后不再整体清空向量缓存，而是只移除受影响文件的向量、重查其当前向量并同步 `index_version`（`reconcileVectorCacheAfterIndex`）。改几个文件不再触发 10 万向量全量重载；HNSW 标记 stale 后按需异步重建，重建期间走暴力搜索保证结果正确。`deleteFiles`/`writeChunkVectors` 改为按路径/按 chunk 精准更新缓存

### v4.5.6

- **HNSW 构建分批 yield**：`addBatchAsync` 每 500 节点让出事件循环，避免大型项目冷启动阻塞数十秒
- **CJK 单字 token 搜索**：修复纯 CJK 单 token 被误判为 symbol-like 导致 semantic 召回被关闭的问题，中文查询恢复 bigram 前缀匹配
- **symbol full_name 函数索引**：新增 `idx_symbol_full_name_lower`，加速符号解析等值匹配

### v4.5.5

- **多源分数归一化**：`mergeResults` 合并前对每个搜索源（lexical/symbol/semantic/path）的分数做 min-max 归一化至 [0,1]，消除不同源分数量级差异导致的排序偏差
- **Java Lambda/方法引用解析**：Java 适配器新增 Lambda 表达式（`x -> foo(x)`）和方法引用（`Foo::bar`、`this::process`）的调用关系提取，调用链分析可追踪函数式调用路径
- **HNSW 二进制序列化**：HNSW 索引磁盘存储从 JSON 替换为紧凑二进制格式（Float32 向量 + 变长 ID），体积缩小约 5 倍，加载速度提升 3-10 倍；向后兼容自动识别旧 JSON 格式

### v4.5.4

- **vectorCache 内存控制**：HNSW 可用时释放 vectors 数组，省 600MB/10 项目
- **FTS 删除批量化**：逐条 DELETE → WHERE IN 批量删除
- **readFileSnippet LRU 缓存**：200 条上限 + mtime 失效，避免重复全量读取
- **callChain 同层并行**：callers/callees Promise.all 并行提取
- **符号解析消歧**：同文件/同模块优先排序，减少同名方法误解析

### v4.5.3

- **代码标识符优先搜索策略**：当查询同时包含代码标识符（camelCase/snake_case/PascalCase）和自然语言（中文/英文）时，新增标识符优先搜索轮次。纯标识符 FTS 搜索结果获得 0.5× 分数加成，使目标 Controller/Service 在混合查询中排名显著提升
- **上下文截断居中**：`compressContext` 截断逻辑从"从文件头开始截断"改为"以匹配行范围为中心截断"，确保大文件中目标方法始终在 LLM 上下文中可见

### v4.5.0

- **QA 上下文完整性修复**：下游搜索结果片段从索引原始大小（~1-3 行）展开至 ±15 行上下文，方法体实现正式可读。调用链片段截断限制从 200 提升至 600 字符。新增 `extractTypeReferencesFromSnippet`，从源码提取 PascalCase 类型引用（DTO/VO/Param 等），自动发现并注入 DTO 定义文件。

### v4.4.9

### v4.4.8

### v4.4.7

- **FTS 中文噪声过滤**：查询中包含代码标识符（camelCase/PascalCase）时，FTS 搜索自动排除 CJK 噪声词条，避免中文自然语言词条（如"接口"、"逻辑"）稀释 bm25 排序分数导致目标代码排名下降
- **覆盖率评分优化**：含代码标识符的非路径查询中，token 覆盖率计算排除 CJK token，确保标识符精确匹配获得应有的评分权重

### v4.4.6

- **QA 管线并行化**：查询扩展与 Round1 搜索并行执行（`Promise.all`），减少串行等待；Reranker 增加 10s 超时保护，避免无限阻塞；查询扩展结果缓存（100 条 LRU，5 分钟 TTL），相同问题不重复调用 LLM
- **向量搜索冷启动优化**：HNSW 索引磁盘读写改为异步（`fs.promises`），不阻塞主线程；首次加载返回空索引立即可用，后台异步构建 HNSW
- **调用链提取并行化**：多符号调用链查询从串行改为并行（`Promise.all`），递归深度展开同层也并行处理
- **SQL 查询优化**：新增 `LOWER(name)` 表达式索引加速符号模糊搜索；文本搜索用 FTS5 预过滤替代全表 `instr()` 扫描；3 处关联子查询改为 `LEFT JOIN` 减少重复查询

### v4.4.5

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

详见 [ROADMAP.md](./ROADMAP.md)

## 开发建议

如果继续增强，建议按以下顺序推进：

1. 更丰富的 Web 结果分析、质量回放与对比界面
2. 更深的调用关系与引用精度
3. 更细的语言适配器拆分

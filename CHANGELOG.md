# Changelog

本项目的重要版本变更记录如下。

## [4.7.6] - 2026-06-25

### Vue/Svelte SFC script extraction

- JavaScript adapter 支持 `.vue` / `.svelte`：仅保留 `<script>` / `<script setup>` 块交给现有 TS/JS AST 分析，避免 template/style 中看起来像代码的文本被误索引。
- SFC 脚本提取使用等长虚拟源码，symbols、imports、usages 的行号保持为原始组件文件行号，源码跳转和调用图定位不偏移。
- 默认 `textExtensions` 与测试环境加入 `.vue` / `.svelte`，SFC 文件会被收集为 `javascript` 语言文件，继续复用既有 JS/TS resolver、import alias、导出实例类型传播和调用图逻辑。
- 新增 JavaScript adapter 单测和端到端 workflow 测试，覆盖 Vue `<script setup lang="ts">`、Svelte `<script lang="ts">`、style/template 噪音隔离、跨文件 caller 解析。
- README、Windows README、release checklist 与发布契约测试更新到 v4.7.6。

## [4.7.5] - 2026-06-25

### Markdown symbol extraction for docs/RAG recall

- Markdown adapter 不再是空实现：`#`~`######` 标题会被索引为 `section` 符号，保留层级 `fullName`、父级 `containerName`、文档 `modulePath` 和稳定 canonical section path。
- fenced code block 内的代码标识符会写入 `symbol_usage`，用于 `find_references` 把代码定义反查到文档示例；dotted 调用只保留一条 usage，并把末尾成员作为候选名，减少重复噪音。
- fenced code 内的 `#` 文本不会被误识别为 Markdown heading；usage 不绑定 owner symbol，因此不会把文档章节注入调用图 caller 链路。
- 新增 Markdown adapter 单测和端到端索引/搜索工作流测试，覆盖 section definition 检索与 fenced code reference 解析。
- README、Windows README、release checklist 与发布契约测试更新到 v4.7.5。

## [4.7.4] - 2026-06-24

### JavaScript/TypeScript exported value type propagation

- JS/TS adapter 对 `export const value = new Type()` 记录内部导出值类型候选；其他文件 `import { value }` 后，`value.method()` 可解析到 `Type.method`。
- SQLite 符号解析在 import alias 第一阶段之后消费这些内部候选，把导出实例名映射回真实类型；同模块存在多个同名方法时，JavaScript 类型限定命中优先于同模块裸方法回退，避免误连到文件内更靠前的同名方法。
- 该增强限定在 JavaScript import alias：内部候选只由 JS/TS AST adapter 产生，resolver 只对 `language === "javascript"` 的导入补充类型映射，Java、Python、.NET、Markdown 的既有查询路径不变。
- 新增工作流回归测试：覆盖 exported instance 跨文件调用链，并保留 Python variable type inference guard，防止非 JS 语言调用链解析回退。
- README、Windows README、release checklist 与发布契约测试更新到 v4.7.4。

## [4.7.3] - 2026-06-24

### Index queue coalescing visibility

- 同项目索引运行期间的重复 `indexProject` 请求继续复用 in-flight Promise，并在 `getInFlightIndexInfo()` 中记录 `dedupedRequests`，让 `/health` 能暴露重复请求压力。
- in-flight 状态新增 `status: "running"` 与 `queuedRequests` 字段，健康检查可直接展示索引队列/去重状态，而不需要读深度 SQLite 统计。
- 修复 in-flight 复用 timeout 与队列清理派生 Promise 的资源/错误处理：timeout 完成后会清理 timer，失败索引不会通过 cleanup `finally` 产生额外 unhandled rejection。
- 新增 `IndexCoordinator` 重复请求回归测试和 Web health shape 断言。
- README、Windows README、release checklist 与发布契约测试更新到 v4.7.3。

## [4.7.2] - 2026-06-24

### Health responsiveness under background indexing

- `/health` 改为轻量健康检查，不再遍历项目并逐个调用 `getProjectStats` 做同步 SQLite 统计，避免后台索引、写锁或大库统计期间健康检查被拖慢到超时。
- 健康检查仍返回 runtime、watch 状态、项目数量、in-flight indexing、向量配置，并从 `listProjects()` 的轻量字段推导 `latestIndexAt`；深度 file/chunk/symbol 统计继续留在项目详情接口。
- 新增 Web 回归测试模拟慢速 per-project SQLite stats，验证 `/health` 不等待该路径；focused 测试从 252ms 降到约 8ms。
- README、Windows README、release checklist 与发布契约测试更新到 v4.7.2。

## [4.7.1] - 2026-06-24

### Benchmark tooling + SQLite lock stabilization

- 新增 `scripts/benchmark-search.mjs`、`npm run benchmark:search` 与 `npm run release:benchmark`：支持 `--project`、`--query`、`--iterations`、`--concurrency`、`--timeout-ms`、`--json` 和 `--smoke`，输出 search p95、health p95 与事件循环响应性。
- `release:check` 纳入 benchmark smoke；smoke 会启动隔离 HOME 的临时 Web 服务、索引小项目并跑一次 search/health 并发探针。当前 release check 结果：resultCount 1、search p95 78ms、health p95 12ms、event-loop responsive 1/1。
- SQLite store 构造阶段统一应用 WAL、`busy_timeout=30000`、`synchronous=NORMAL`、`cache_size`、`mmap_size` 等连接级 PRAGMA，确保搜索 worker 的独立 SQLite 连接也具备同样的锁等待策略。
- benchmark smoke 失败时会输出子进程 stdout/stderr 和 `.ace-mcp/log`；一次性 smoke 服务默认关闭 auto-watch，避免临时环境文件监听触发 `EMFILE` 干扰发布验证。
- README、Windows README、release checklist 与发布契约测试更新到 v4.7.1。

## [4.7.0] - 2026-06-24

### SQLite 搜索 worker — 避免 better-sqlite3 阻塞主事件循环

- 新增 `SQLiteSearchWorkerClient` 与 `sqliteSearchWorker`：普通/结构化搜索中的 lexical、semantic FTS、unicode substring、symbol、path 和文件预览读取改为通过独立 SQLite 搜索 worker 执行，主 Web/MCP 事件循环只等待异步消息，不再被这些 `better-sqlite3` 同步读查询占住。
- dist 运行时使用 `worker_thread` 打开独立 SQLite 连接；源码/dev/test 运行时使用 `node --import tsx` IPC 子进程执行同一 worker 入口，规避 Node 原生 TS strip 对参数属性等语法的限制。
- `SearchService` 的 identifier boost 与结构化查询 fallback 同步切到 worker 读路径；向量搜索仍保留主进程内存/HNSW 缓存路径，避免跨线程复制大向量。
- 新增 `searchServiceConcurrency.test.ts`，先复现搜索 Promise 在 `setTimeout(0)` 前完成的问题，再验证 worker 化后 SQLite 搜索 pending 时事件循环可继续调度。
- 版本号、README、Windows README、release checklist 与发布契约测试更新到 v4.7.0。

## [4.6.9] - 2026-06-23

### 安装自检 + 发布 smoke test

- 新增 `ace-mcp --doctor`，检查 Node/npm、`better-sqlite3` 原生绑定、SQLite FTS5、数据/日志/配置目录写权限、Web 端口占用，以及 LLM/Embedding 配置；输出 `OK/WARN/ERROR` 与 `Next steps`，有错误时退出码为 1。
- 新增 `npm run release:smoke`（`scripts/smoke-release.mjs`）：从当前 `ace-mcp-4.6.9.tgz` 安装到临时全局 prefix，验证 `ace-mcp --version`、`ace-mcp --doctor`、`ace-mcp-web <随机端口>` 和 `/health`，并要求 Windows zip 已生成。
- `release:check` 纳入 `release:smoke`，发版链路变为 `npm test && npm run build && npm run release:pack && npm run release:win && npm run release:smoke`。
- Windows zip 安装脚本在 `npm install --omit=dev` 后自动运行 `node dist\index.js --doctor`，安装阶段即可暴露原生依赖、FTS5、目录权限和端口问题。
- README、Windows README 与 release checklist 更新到 v4.6.9，并补充安装失败、Web 打不开、`better-sqlite3` 编译失败和 MCP 命令路径问题的 doctor 排障入口。

## [4.6.8] - 2026-06-23

### Windows zip 安装包 + 发布清单

- 新增 `npm run release:win`，执行 `npm run build && node scripts/package-windows.mjs`，生成 `release/ace-mcp-v4.6.8-win-x64.zip`，zip 内包含 `dist/`、`package-lock.json`、README/CHANGELOG/LICENSE、Windows 启动脚本和安装入口。
- 新增 `scripts/install-windows.cmd` 与 `scripts/install-windows.ps1`，用于 zip 解压后的 Windows 本地安装；脚本检查 Node/npm，执行 `npm install --omit=dev`，并对 `better-sqlite3` 原生依赖失败给出 Node LTS 与 Visual Studio Build Tools 提示。
- 新增 `scripts/README-WINDOWS.md`，覆盖 zip 安装、npm/tgz 全局安装、`start-web.cmd`/PowerShell 启动、MCP 客户端 `ace-mcp.cmd` 路径、`ExecutionPolicy` 与常见问题。
- 新增 `docs/release-checklist.md` 与 `release:check` 脚本，固化 `npm test`、`npm run build`、`release:pack`、`release:win`、包内容检查、git tag/push 的发版步骤；`release:pack` 使用仓库内 `.npm-cache/`，避免全局 npm cache 权限问题影响打包。
- `packageManifest.test.ts` 扩展到 Windows zip 打包器、安装脚本、Windows README 和 release checklist，作为发布契约测试。

## [4.6.7] - 2026-06-23

### npm/tgz 全局安装 + Windows 启动脚本

- 包发布配置调整：`package.json` 改为可发布包，新增全局命令 `ace-mcp-web`，保留 `ace-mcp` 主命令；`files` 纳入 `scripts/`，继续排除 `dist/**/*.test.*` 与 `dist/test/**`，避免测试产物进入安装包。
- 新增启动脚本：`scripts/start-web.mjs` 作为跨平台 bin，默认以 `--web-port 8787` 启动，也支持 `ace-mcp-web 9000` 或 `ACE_MCP_WEB_PORT=9000 ace-mcp-web`；Windows 额外提供 `scripts/start-web.cmd` 与 `scripts/start-web.ps1`。
- 新增 `npm run release:pack`，执行 `npm run build && npm pack`，用于生成可全局安装的 `ace-mcp-4.6.7.tgz`。
- README 补充 npm 全局安装、tgz 全局安装、Windows PowerShell/cmd 启动脚本、Windows MCP 客户端命令路径示例，以及 Windows 上 Node LTS 与 `better-sqlite3` 原生依赖注意事项。
- 新增 `packageManifest.test.ts` 覆盖发布包清单、全局 bin、release 打包脚本和 Windows 启动脚本。

## [4.6.6] - 2026-06-22

### 补齐质量防线

- 恢复 `npm test` 的真实可执行性：补齐脚本中引用但仓库缺失的 17 个测试文件，覆盖 CLI、查询分析、端到端索引/搜索、Web `/health` 与参数校验、SQLite/VectorCache、搜索打分/辅助函数、语义文本、远程 Embedding fallback、QA 缓存、共享 schema、源码解码、IndexCoordinator freshness 与 evalRunner。当前仓库测试为 50 个用例。
- 测试暴露并修复中文复杂问题 source 估算缺陷：中文无空格问题此前会先命中 `wordCount <= 3` 的简单查询分支，即使包含「流程/逻辑/实现/整体」也只给 5 个 sources；现复杂/Review 意图优先，复杂问题按 15~20 个 sources 估算。
- 测试暴露并修复 GBK 中文源码解码评分缺陷：旧评分只看可打印字符数，GBK 中文可能被 latin1 乱码误判；现对可读 CJK 字符加权，优先选择可读中文解码结果。
- 验证：`npm test`、`npm run build`。

## [4.6.5] - 2026-06-15

### 修复暖机窗口内索引元数据失真

- v4.6.4 的 `--warm` 暖机用一个**合成 `IndexProjectResult`** 恢复各项目的 freshness 状态，其中硬编码了 `vectorIndex: { enabled: false }`、全零 `timings` 与零文件计数。在默认 `indexFreshness: "stale"`（30s）下——`"manual"` 策略下则无限期——`ensureFreshIndex` 会原样返回该缓存结果，导致暖机窗口内每个工具/Web 响应都把**向量索引误报为禁用**（即便项目已建好向量索引），`timings`/文件计数同样归零。
- 修复：暖机恢复改为铺展真实的 `projectStats.latestIndexEvent`（持久化的 `IndexEventSummary`，含真实 `vectorIndex`/`timings`/计数），其上仅铺 `project`/`projectId`/`projectRootPath` 三个身份字段；仅当 `latestIndexEvent` 为 `null` 时才回退到旧的硬编码默认值。
- 不改动「暖机期间视为刚索引」的跳描行为（与 `stale` 契约一致且受 `indexFreshnessSeconds` 限界），仅修正上报的元数据。
- 新增本地回归测试（`indexCoordinator.test.ts`）：`"manual"` 策略下恢复带 `enabled:true` 的事件后 `ensureFreshIndex` 透传 `vectorIndex.enabled=true`，`null` 事件回退仍为 `false`；测试 124→126 全绿。

## [4.6.4] - 2026-06-15

### 冷启动暖机——消除重启后首次查询延迟

- 新增 `--warm` CLI 标志：服务启动后异步暖机已索引项目，首次查询不再触发全量增量扫描（此前冷启动首次查询 18-22s → 暖机后 <2s）
- 三层暖机策略：
  1. 从数据库恢复 `lastIndexedAtMs` / `lastIndexResult` 内存状态，使 `ensureFreshIndex("stale")` 跳过已知最新项目
  2. 预加载向量缓存 + 触发异步 HNSW 索引构建（含磁盘缓存加载），首次向量搜索不再阻塞加载
  3. 预构建语义 FTS 索引（如缺失），确保首次语义搜索无需等待
- 暖机完全异步、不阻塞 MCP/Web 可用性；尊重 `vectorCacheMaxProjects` 限制，仅预加载最近索引项目的向量
- 新增 `IndexCoordinator.restoreFreshnessState()` 方法 + `SQLiteStore.listProjectsWithIds()` 方法
- 暖机为可选功能，默认关闭；通过 `--warm` 启用

## [4.6.3] - 2026-06-15

### 修复 PNG 导出失败

- v4.6.2 的 PNG 导出在浏览器里失败：mermaid v10 的 flowchart 默认 `htmlLabels: true`，节点文字用 `<foreignObject>` 包 HTML 渲染；Chrome 把含 `foreignObject` 的 SVG 光栅化到 canvas 时会污染 canvas，`toBlob`/`toDataURL` 抛 SecurityError（SVG 导出不经 canvas 故正常）。
- 修复：`mermaid.initialize` 增加 `flowchart: { htmlLabels: false }`，标签改用纯 `<text>` 渲染，SVG 可无污染光栅化为 PNG；流程图与调用链图外观无退化（单行中文标签）。
- 同时 PNG 导出改用 data URL（`encodeURIComponent` 处理 UTF-8/中文）加载 `Image`，比 blob URL 跨浏览器更可靠。
- 用真实 Chrome（CDP）验证：渲染后 `foreignObject` 数为 0、`toDataURL("image/png")` 成功产出 33KB 有效 PNG、canvas 未污染、中文流程图显示正常。

## [4.6.2] - 2026-06-12

### 流程图导出（PNG / SVG / 复制 Mermaid 源码）

- v4.6.1 的业务流程图与 v4.3.5 的调用链图都只能看不能带走，业务方贴文档/聊天只能截图。本版给两类 Mermaid 图都加导出工具栏（渲染成功后注入，无 SVG 时不注入）：
  - **下载 PNG**：渲染后的 SVG 经 `serializeSvg`（补 `xmlns` + 从 `viewBox` 写明像素宽高）→ blob URL → `Image` → `canvas`（×2 清晰度、白底）→ `toBlob` 导出，失败提示改用 SVG
  - **下载 SVG**：序列化为独立 `image/svg+xml` 文件，矢量无损
  - **复制 Mermaid 源码**：原始源码写入剪贴板（`navigator.clipboard` 优先、非安全上下文回退 `execCommand`），按钮短暂显示「已复制 ✓」
- 文件名经 `sanitizeFileName` 清洗非法字符（中文保留）；调用链图容器跨问答复用，重渲染时旧工具栏被替换避免源码闭包过期/重复注入
- 纯前端增量，不动后端/索引/打分；后端测试 123 用例回归无变化

## [4.6.1] - 2026-06-12

### QA 答案附业务流程图 + 自动化质量防线（`--eval` golden 用例）

- **业务流程图（业务需求）**：智能问答分析完业务逻辑后，在答案末尾自动追加一节「业务流程图」（`flowchart TD`），把关键步骤/判断节点可视化，对业务方更直观。改动点：① `QA_SYSTEM_PROMPT` 新增规则——问题涉及流程/逻辑/场景/步骤时输出**一个** ```` ```mermaid ```` 块、节点用双引号包裹的中文标签、禁用 `<br/>` 与图内 `[N]` 引用、简单查找类问题不画图（一处提示词覆盖 MCP `ask_codebase`、Web POST、SSE 三条路径）；② 前端 `renderMarkdown` 先抽取 ```` ```mermaid ```` 块为占位符再走其余 markdown/引用变换、最后还原为 `<div class="qa-flow-diagram"><pre class="mermaid">`，避免图源被引用正则与段落变换破坏；③ 流式结束（`done`）后调用 `mermaid.run()` 渲染为 SVG，失败时 try/catch 回退保留原文代码块。MCP 路径答案含 mermaid 文本块，由宿主自行渲染
- **自动化质量防线（`--eval`）**：新增 `--eval <caseFile>` CLI 入口，加载 JSON golden 用例文件、对每个 suite `ensureFreshIndex` 后跑 `evaluateSearchQuality`，打印逐用例 PASS/FAIL（含 rank、缺失文件、原因）+ 汇总指标（passRate/top1/top5/MRR），按 `minPassRate`（默认 1.0）判定整体并以退出码 0/1 返回，可纳入发版前回归。新增 `npm run eval` 脚本、`src/core/search/evalRunner.ts`、`example/eval-cases.example.json`（脱敏示例，对 ace-mcp 自身可直接跑通）。真实业务 golden 用例置于 `eval-cases/`（已 gitignore，不入仓库）
- 测试 117→123（新增 `--eval` 解析与 evalRunner 配置/汇总用例）

## [4.6.0] - 2026-06-11

### P3 稳健性打包：SSE 断连中止（#39）+ cosine 合一（#34）+ 缓存淘汰 FIFO（#35）+ Error/AppError 统一（#38）

- **SSE 断连中止上游 LLM（#39）**：此前客户端断连后 handler 仅跳出流式循环，`streamComplete` 内部的 fetch 未被 abort——上游 LLM 继续生成直到完毕（浪费 token + 占连接）。现新建 `AbortController`，在 `res.on("close")` 中 abort 并通过既有 `options.signal` 接入 `streamComplete`；LLM 阶段前增加断连早退。（超时机制与断连检测此前已存在，本次补的是「断连即中止上游」这一缺口）
- **cosineSimilarity 合一（#34）**：`vectorCacheStore.ts` 的私有实现删除，统一引用 `embedding.ts` 导出版（两处函数体逐行相同，零行为变更；实际重复为 2 处而非 ROADMAP 所记 3 处）
- **缓存淘汰 FIFO 化（#35）**：`remoteEmbedding.evictQueryCache` 与 `searchService.evictSearchCache` 的超量裁剪此前全量收集 + O(n log n) 排序。两者条目均只在 miss 时插入、命中不重写，Map 插入序即时间序——前者改为头部 TTL 扫描（首个未过期即停）+ FIFO 裁剪；后者改为跨项目 k 路头比较取全局最旧。qaCache/queryExpander 本就是 FIFO，未动
- **Error/AppError 统一（#38）**：`llmClient`（未配置 400 `LLM_NOT_CONFIGURED`、API 非 2xx 502 `LLM_API_ERROR`、空响应 502 `LLM_EMPTY_RESPONSE`、超时 504 `TIMEOUT`）与 `summaryGenerator`（未配置 400、未索引 404 `PROJECT_NOT_INDEXED`）的裸 `Error` 改为 `AppError`，Web 出口不再一律落 500/INTERNAL_ERROR；`fallbackOnTimeout` 路径与错误文案不变。CLI/autostart/HNSW 二进制格式等进程级/内部错误维持原状
- **引用跳转容错修复**：LLM 偶发输出带行号的引用（如 `[1:L60-L88]`），前端正则只认纯 `[N]`，导致显示为死文本无法跳转源码卡片。前端正则改为容错 `[N(:Lx(-Ly))]` 形式（保留原文显示、按 N 跳转），同时提示词明确要求只用纯 `[N]`、行号写在括号外
- 测试 108→117（remoteEmbedding 用例纳入 test 脚本 + 新增 FIFO 淘汰用例）

## [4.5.15] - 2026-06-11

### 打分恰好一次（#23）+ CJK 语义 FTS 词数上限（#37）

- **打分恰好一次（#23，行为修复）**：`scoreMergedResult` 从 `result.score` 起算并叠加 bonus，但此前在排序管线被多次调用且把结果**写回 score**——`choosePreferredResult` ×1、`dedupeSameFileResults` per-file 排序 ×2、`rerankResults` ×3。即有碰撞的结果 bonus 累加 3 次、无碰撞 2 次，**加成倍数因代码路径而异，排序被路径依赖地扭曲**。现 `choosePreferredResult` 改为仅比较不写回、`rerankResults` 删除二次打分，`dedupeSameFileResults` 的 per-file 排序成为唯一打分点。实测中文/混合查询的业务逻辑类（Logic/Processor）排位上升、枚举/常量类下降；纯标识符查询不变。
- **CJK 语义 FTS 词数上限（#37）**：`buildSemanticFtsQuery` 此前硬截 8 个词，v4.5.13 的 CJK bigram 分词后中文问题轻松产出 13+ bigram 被截掉。现改为 CJK 感知：含 CJK 词上限 15，纯 ASCII 维持 8（行为不变）。实测中文查询 semantic 候选 15→18，热态耗时仍 ~1.4s。
- 测试 103→108：新增打分幂等回归用例与 `semanticText.test.ts`（CJK/ASCII 上限、空词）。

## [4.5.14] - 2026-06-10

### ask_codebase reranker 对齐 — 去掉硬编码强制开启

- **背景（#42 重测结论）**：v4.5.13 修掉 `ensureSemanticIndex` O(n²) 后重测 QA 分解：`queryExpansionMs 291 / searchMs 376 / rerankerMs 0(Web) / llmMs 116752`。此前「queryExpansion 8s 超时失效、实测 55s」属**误判**——旧测量中 expansion 与 search 共用 Promise.all 计时，真正慢的是已修复的搜索；abort 超时机制本来正常。剩余 ~97% 耗时是最终回答 LLM 端点的生成速度本身（慢端点 × 长输出 × 大上下文），属配置/选型问题：可换更快模型或调低 `llmMaxTokens`/`maxSources`。
- **修复**：MCP `ask_codebase` 此前硬编码 `enableReranker: true`，强制覆盖全局默认 `enableLlmReranker=false`，MCP 问答路径每次多付 ~10s reranker LLM 调用（Web POST/SSE 与 `search_context` 均尊重配置）。现去掉硬编码，回落配置默认；同时 schema 新增可选 `enableReranker` 参数，可按请求显式强开/强关（`参数 ?? 配置` 语义，与 QA 管线既有行为一致）。

## [4.5.13] - 2026-06-09

### 中文查询分词 + 语义索引存在性检查性能修复

- **中文查询分词**：自然语言中文问题（如「假确认场景的退规有什么特殊的吗」）在 `analyzeQuery` 被切成**一个 14 字整串 token**——因 CJK 属 `\p{L}`、中文无空格、`TOKEN_SPLIT_PATTERN` 在其间无断点。`queryAnalyzer` 新增 `segmentCjkTokens`，复用既有 `buildCjkBigrams`（semanticText.ts）把 CJK 连续串切成 bigram：**整串仍保留**（对「极速改签预订」等复合业务词保精确匹配）并追加 bigram（`MAX_CJK_TERMS=16` 上界）。`tokens`/`ftsQuery` 改用切分结果，`semanticTerms`/`naturalLanguage`/单字 CJK 行为不变。
- **语义索引存在性检查性能修复（关键）**：`ensureSemanticIndex`（每次语义搜索都会调用）此前用 `LEFT JOIN chunk_semantic_fts ON chunk_id ... WHERE IS NULL` 判断「哪些 chunk 缺语义文本」。因 FTS5 的 `chunk_id` 是 `UNINDEXED`，该 JOIN 退化为**逐 chunk 全表扫 FTS**（O(n²)），在 2k chunk 的项目上实测 **~122s**，且每次查询都白跑一遍（结果恒为 0 缺失）。改为 `chunk_id NOT IN (SELECT chunk_id FROM chunk_semantic_fts)`（对 FTS 仅一次 O(n) 扫描）：实测 **122s → 1.2s**。**这才是中文问答慢的真正根因**——实测同一查询端到端 **~64s → ~1.8s**。

## [4.5.12] - 2026-06-09

### 放开参考代码量 — 提高默认上下文预算 + 按请求覆盖

- **背景**：对实现较大的接口提问时，参考代码不够用。根因是上下文 token 预算 `qaMaxContextTokens` 默认仅 24000，超出后 `compressContext` 会把每个来源片段按 `预算/来源数` 截断，大方法实现被切掉。
- **提高默认**：`qaMaxContextTokens` 24000 → **48000**，`qaMaxSourcesDefault` 10 → **15**，让默认问答就带更多完整代码。
- **按请求覆盖**：`ask_codebase` 与 Web `/api/qa/ask`（含 SSE）新增可选 `maxContextTokens` 参数，按需调大单次问答的上下文预算；新增上限配置 `qaMaxContextTokensMax`（默认 200000，env `ACE_MCP_QA_MAX_CONTEXT_TOKENS_MAX`）做钳制，避免超出 LLM 上下文窗口。三处预算消费点（`runQaPipeline` 的 assemble/compress、SSE 流式路径）统一用钳制后的预算。
- **注意**：最终可用量仍受所配置 LLM 的上下文窗口约束；若模型窗口较小，请相应下调 `ACE_MCP_QA_MAX_CONTEXT_TOKENS`。

## [4.5.11] - 2026-06-09

### QA 上游使用方（caller）扩展 — 让业务逻辑类进入问答上下文

- **背景**：智能问答对「X 场景有什么特殊处理」这类问题答非所问。实测「假确认场景的退规有什么特殊的吗」时，召回的全是 model/enum/VO 定义类，而真正回答问题的业务逻辑 `ConfirmTraceEndorseProcessor`（它**调用** `TicketEndorseVO.isFakeConfirm()` 做特殊分支）从未被召回。
- **根因**：QA 管线的结果扩展只往「下游被调实现」方向走（v4.4.8 `findDownstreamImplementations` 用 `findCallees`）。而这类问题的答案恰是「**谁在使用该符号做业务判断**」=top 结果符号的 **caller**。通用打分只看 token/路径/符号匹配，定义符号的 model 类（字段+getter+setter 多次命中）必然压过只调用一次的业务类，使用方进不了候选集。
- **修复**：对称补齐 v4.4.8——新增 `findUpstreamUsages`（`callChainExtractor.ts`）。自然语言问答的召回结果多为 chunk 级、无显式 `symbol`，故从结果窗口（top 10）的**代码片段中提取已定义符号**（getter/方法名），对每个符号查 `findCallers`，把使用方源码（含调用点 ±15 行）拉进问答 context；对**业务层 caller**（service/logic/processor/handler/impl 等路径或符号）加权 1.5×、限量去噪后并入。QA 管线在 downstream 扩展之后接入。**纯本地调用图查询，不增加 LLM 调用、不改通用打分**。实测「假确认场景的退规」从只召回 model/enum 变为成功召回 `ConfirmTraceEndorseProcessor` 等业务处理类。

## [4.5.10] - 2026-06-09

### searchByPath 文件名匹配度排序（#24）+ 日志统一（#31）

- **searchByPath 文件名匹配度排序**：`searchByPath` 此前仅按路径长度排序 + LIMIT，导致路径较长但文件名精确匹配的文件可能被提前截断。现改为多取候选（`Math.max(limit*5, 50)`）后在 JS 中按 basename 匹配度重排（去扩展名精确 > basename 精确 > 前缀 > 包含 > 仅目录命中，同档按路径长度），再截断到 `limit`。评分逻辑（`scoreMergedResult`）不变，仅改善路径搜索的候选排序与存活。
- **日志统一**：`RemoteEmbeddingProvider` 的两处 `console.warn` 改为注入的 `logger?.warn`（`createEmbeddingProvider` 新增可选 `logger` 形参，由 `index.ts` 传入）。此前直接 `console.warn` 与全项目日志不一致，且在 MCP stdio 传输下向 stdout 打印有破坏协议风险。

## [4.5.9] - 2026-06-09

### Web API 验证统一（#29）+ 关键路径测试覆盖（#32）

- **Web API 验证统一**：新增 `src/core/validation/schemas.ts` 作为入参枚举/边界/默认值的**单一来源**（导出 `SEARCH_FILTER_LANGUAGES`/`SEARCH_MODES`/`SEARCH_RESULT_MODES`/`QA_CONTEXT_MODES`/`INDEX_MODES` 与 `TOPK_*` 等，及严格 zod schema 工厂）。MCP 工具（`search_context`/`find_definition`/`find_references`/`find_callers`/`find_callees`/`get_file_snippet`/`index_project`/`ask_codebase`）改为引用共享 schema，删除各文件重复的枚举常量，行为不变。新增 `src/web/requestValidation.ts` 宽松解析层：Web 路由复用同一套枚举/边界，沿用 coerce+clamp，仅当必填项（`query`/`projectRootPath`/`question`/`filePath`）缺失时返回 `400 VALIDATION_ERROR`，前端零改动。顺带修正 `qa/ask` POST 的 `contextMode` 默认值（`chunk`→`merged-file`，与 SSE/MCP 对齐）。
- **关键路径测试覆盖**：测试从 33 个增至 **97 个**。新增 9 个测试文件覆盖：`safeJsonParse`（#30 防护）与 `sqliteStoreHelpers`、`searchScoring`/`searchHelpers` 纯函数、`QaCache`、共享严格 schema（越界/未知枚举 reject）与 Web 宽松解析器（clamp/默认/400）、`VectorCacheStore` 增量 reconcile（临时 SQLite 夹具）、`sqliteStore.deleteFiles` 级联与覆盖率计数、`indexCoordinator` 的源码解码助手（UTF-8/GBK/二进制）。`decodeSourceBuffer`/`isValidUtf8`/`scoreDecodedContent` 导出以便单测（零行为变更）。

## [4.5.8] - 2026-06-08

### JSON.parse 防护（#30）+ 大文件拆分（#18）

- **JSON.parse 防护**：新增 `safeJsonParse<T>(raw, fallback, logger?, context?)` 工具，套用到 `sqliteStore` 读取数据库列后直接 `JSON.parse` 的 6 处（`project.languages` ×3、`index_event.metadata_json`、`symbol_usage.candidate_names`、`chunk.symbol_names`）。此前列内容损坏会同步抛错崩溃整个进程，其中 `candidate_names`/`symbol_names` 两处在事务循环内（一条坏行回滚整个事务）；现在损坏数据降级为空值并记 warn 日志。
- **大文件中等拆分**：在公共 API 与全部现有测试保持不变的前提下，把三个巨型文件拆成聚焦模块：
  - `sqliteStore.ts` 2879 → 2004 行：向量缓存 + HNSW 簇抽成独立 `VectorCacheStore` 类（`src/core/storage/vectorCacheStore.ts`，`SQLiteStore` 委托），row 类型 → `sqliteStoreTypes.ts`，纯函数 → `sqliteStoreHelpers.ts`。
  - `app.ts` 1532 → 50 行：30 条 Express 路由按域拆成 `src/web/routes/{meta,index,admin,search,summary,qa}Routes.ts`（各导出 `registerXRoutes(app, deps)`），类型 → `src/web/types.ts`，纯 helper → `src/web/routeHelpers.ts`。
  - `searchService.ts` 1765 → 1073 行：模块级纯函数拆到 `searchScoring.ts`（打分/去重/合并/重排）与 `searchHelpers.ts`（工具/归一化/片段展开），类体不变。
- 纯结构性重构，无行为变更；33 个现有测试不改动且全部通过。

## [4.5.7] - 2026-06-08

### 增量索引 vector 缓存精准失效

- **问题**：此前增量索引（含 watcher 自动触发）只要有任意文件变更，就会**整体清空**该项目的内存 vector 缓存——三处无脑 `clearVectorCache(projectId)`（`recordIndexEvent`、`deleteFiles`、`writeChunkVectors`）+ `index_version` 自增导致缓存键失配。结果：改 5 个文件也会让下一次向量搜索从 SQLite 全量 `SELECT` 10 万条向量并从零重建整个 HNSW 索引。
- **精准失效**：新增 `reconcileVectorCacheAfterIndex`，增量索引末尾只移除受影响文件的旧向量、重查这些文件的当前向量、并**同步缓存的 `index_version`**，使 `getProjectVectors` 在版本自增后仍命中缓存，彻底避免全量重载。`deleteFiles` 改用 `removeVectorCacheByPaths`（仅删受影响文件向量），`writeChunkVectors` 改用 `upsertVectorCacheByChunkIds`（仅更新已写入 chunk），`recordIndexEvent` 不再触碰缓存。
- **HNSW 处理**：因 HNSW 无法安全增量改图（`add` 不重连、`deserialize` 钉死 `maxElements`、`remove` 近似），受影响时标记索引 stale，下次向量搜索按需异步重建；重建期间基于已修补的 `vectors[]` 走暴力搜索返回正确结果，无"服务脏 HNSW"窗口。
- **兜底**：受影响文件数超过 400（全量重索引/大批变更）时回退为整体清空，同时规避 SQL `IN` 的 999 变量上限。`writeChunkVectors` 在缺省 `projectId` 时保留旧的整体清空行为。
- 纯运行期缓存一致性改动，无需重建磁盘索引。

## [4.5.6] - 2026-06-05

### HNSW 构建分批 yield + CJK 单字 token 搜索 + symbol full_name 函数索引

- **HNSW 构建分批 yield**：`HnswIndex` 新增 `addBatchAsync(items, yieldEvery=500)`，构建时每 500 个节点 `await setImmediate` 让出事件循环；`buildHnswIndexAsync` 的 `setImmediate` 回调改为 async 并 await 之。此前 `addBatch` 是同步紧循环，整个 HNSW 构建在一个 tick 内跑完，大型项目冷启动阻塞数十秒、卡住所有并发请求。
- **CJK 单字 token 搜索**：修复 `analyzeQuery` 的 `isSymbolLike` 判定——纯 CJK 单 token（如"票""出票"）此前因 `SYMBOL_TOKEN_PATTERN` 的 `\p{L}` 匹配被判为 symbol-like，导致 auto 模式关闭 semantic-fts 阶段，而 semantic FTS 正是靠 bigram 前缀匹配中文的唯一途径。新增 `!NON_ASCII_PATTERN.test(token)` 约束后，纯中文查询能正常走 semantic 召回。纯查询侧改动，无需重建索引。
- **symbol full_name 函数索引**：新增 `idx_symbol_full_name_lower ON symbol(LOWER(full_name))`，加速符号解析（findResolvedReferences）和 searchBySymbols 中的 `LOWER(s.full_name) = ?` 等值匹配。

## [4.5.5] - 2026-06-04

### 多源分数归一化 + Java Lambda/方法引用解析 + HNSW 二进制序列化

- **多源分数归一化**：`mergeResults` 合并前对每个搜索源的分数做 min-max 归一化至 [0,1]。此前各源分数量级差异大（lexical ~0-1, symbol ~0-0.8, path ~0-0.65, semantic ~0.35-1），直接求和导致高量级源垄断排序；归一化后每个源等权贡献，跨源命中结果排名更合理。
- **Java Lambda/方法引用解析**：Java 适配器新增 `METHOD_REF_PATTERN`（`Foo::bar`、`this::process`、`var::method`）和 `LAMBDA_PATTERN`（`x -> foo(x)`）的调用关系提取。方法引用解析接收者类型（通过 variableTypes/importMap），生成与普通方法调用一致的 candidateNames；Lambda 体中的方法调用额外补录。此前 `stream().map(Foo::getBar)` 等函数式调用无法被调用链追踪。
- **HNSW 二进制序列化**：`HnswIndex.serialize()` 从 JSON 替换为紧凑二进制格式（magic + version + config header + per-node 变长 ID + Float32 向量）。1536 维向量 JSON 约 30KB/node，二进制仅 6KB/node，总体缩小约 5 倍。`deserialize()` 自动检测 magic 字节区分新旧格式，向后兼容旧 JSON 缓存文件。

## [4.5.4] - 2026-06-04

### vectorCache 内存控制 + FTS 批量删除 + 文件片段缓存 + callChain 并行 + 符号解析消歧

- **vectorCache 内存控制**：HNSW 构建或从磁盘加载后释放 vectors 数组（节省约 600MB/10 项目），暴力搜索时从 SQLite 懒加载（`reloadVectorsFromDb`）。
- **FTS 删除批量化**：`deleteFiles` 中逐条 `DELETE FROM chunk_fts WHERE chunk_id = ?` 改为先收集所有 chunk_id 再 `WHERE chunk_id IN (...)` 批量删除，减少 SQL 语句数量。
- **readFileSnippet LRU 缓存**：新增 `fileSnippetCache`（200 条上限，mtime 失效），避免重复全量读取文件再切片。同一文件多次 snippet 请求直接从缓存行切片。
- **callChain 同层并行**：`extractCallChains` 中 callers/callees 的 `extractCallEntriesWithDepth` 调用从串行 `await` 改为 `Promise.all` 并行。
- **符号解析消歧**：`resolveRows` 排序新增同文件/同模块优先排序键。同名方法（如多个类的 `process`）在评分相同时优先选择与调用方同一文件的符号，减少调用链误解析。

## [4.5.3] - 2026-06-04

### HNSW heap 优化 + CTE 查询 + QA 上下文扩展 + 过滤修复 + catch 日志 + 组合索引

- **HNSW searchLayer heap 替代 Array.sort**：实现 `MinHeap` 和 `MaxHeap` 替代 `searchLayer` 中的 `Array.sort()` 操作。此前每次 neighbor 扩展都做全量排序，复杂度 O(ef·n·log n)；现在 push/pop 操作 O(log n)，整体搜索性能显著提升。
- **N+1 关联子查询 → CTE**：`getFilePreviewResults` 和 `searchByPath` 中的 3 个关联子查询（获取 first chunk 的 start_line/end_line/content）替换为 CTE + LEFT JOIN。此前 N 个文件产生 3N 次子查询；现在 CTE 一次计算所有 first chunk，再 LEFT JOIN 关联，查询效率大幅提升。
- **QA call chain 上下文扩展**：call chain 节点上下文从 ±5 行扩展到 ±15 行（CONTEXT_PAD: 5→15）。此前 Java/C# 方法（通常 15-30 行）在 ±5 行窗口中方法体大概率截断；现在 30 行窗口覆盖大部分方法，QA 答案质量显著提升。
- **identifier boost 过滤修复**：identifier-priority boost 二次搜索传入的 filters 从 `{}` 改为 `normalizedFilters`。此前用户指定 `languages: ["java"]` 时 boost 搜索会跨所有语言执行，返回不相关结果污染分数。
- **空 catch 加日志**：qaPipeline.ts（6 处）、app.ts（6 处）、searchContext.ts（1 处）、indexCoordinator.ts（1 处 `.catch(() => {})`）中的空 catch 块改为 `catch (err)` 并加 `logger.debug/warn` 日志。此前生产环境空 catch 吞错误，难以诊断问题。
- **symbol_usage 组合索引**：新增 `idx_symbol_usage_owner_resolved ON symbol_usage(owner_symbol_id, resolved_symbol_id)` 和 `idx_symbol_usage_resolved_owner ON symbol_usage(resolved_symbol_id, owner_symbol_id)` 双列组合索引，加速 findCallGraph/findResolvedReferences 的核心查询。

## [4.5.2] - 2026-06-03

### QA 缓存一致性 + 索引健康监控

- **QA 缓存键加入内容 hash**：`QaCache.hashSource()` 新增可选参数 `contentSnippet`，将搜索结果 snippet 前 512 字符纳入 MD5 计算。此前缓存键仅基于 `filePath:startLine-endLine`，文件内容变更后 5 分钟内再问同样问题会命中旧缓存、返回过时答案。现在内容变更自动导致缓存键变化，旧缓存自然失效。
- **QA 缓存清除 API**：新增 `POST /api/qa/cache/clear` 路由，支持手动清除 QA 缓存。
- **cache_stats 加入 QA 缓存统计**：MCP `cache_stats` 工具返回新增 `qaCache` 字段（size、maxSize、ttlMs），与已有 searchCache 统计并列。
- **索引健康监控**：`/health` 端点新增 `indexing` 字段，暴露当前正在索引的项目列表和已耗时（elapsedMs）。`IndexCoordinator` 新增 `inFlightStartTimes` Map 记录索引开始时间，`getInFlightIndexInfo()` 方法实时计算 elapsedMs。此前排查索引卡死问题时无法看到哪些项目正在索引、已耗时多久。

## [4.5.1] - 2026-06-03

### 搜索召回优化 + 上下文装配修复

- **代码标识符优先搜索策略（P0）**：当查询同时包含代码标识符（camelCase/snake_case/PascalCase）和自然语言（中文/英文）时，新增标识符优先搜索轮次。纯标识符 FTS 搜索结果获得 0.5× 分数加成，使目标 Controller/Service 在混合查询中排名显著提升。此前中文词条匹配大量无关文件，稀释标识符精确匹配，导致目标文件被推至 #20。
- **上下文截断居中（P1）**：`compressContext` 截断逻辑从"从文件头开始截断"改为"以匹配行范围为中心截断"。此前 182 行 Controller 文件截断后只保留前 N 行（import/package 声明），目标方法在 line 100+ 完全不可见。现在截断窗口以匹配方法为中心，确保核心代码始终在上下文中。
- **移除冗余 snippet windowing**：v4.5.0 在 qaPipeline 层的 snippet windowing 代码已由 compressContext 层的居中截断完全覆盖，移除以消除重复逻辑。

## [4.5.0] - 2026-06-02

### QA 上下文完整性修复

- **下游搜索片段展开**：`findDownstreamImplementations` 调用 `searchService.search()` 时 `includeContextLines` 从 0 改为 15，使下游搜索结果片段从索引原始大小（~1-3 行）展开至匹配行 ±15 行上下文，方法体实现正式可读。此前 `expandResultSnippets` 因 `includeContextLines=0` 短路，返回索引中的微小片段，LLM 只能看到方法签名而无法描述业务逻辑。
- **调用链片段截断提升**：`extractCallEntriesWithDepth` 中 `snippet.slice(0, 200)` 改为 `slice(0, 600)`，调用链上下文纳入更多代码细节。
- **DTO 类型自动发现**：新增 `extractTypeReferencesFromSnippet` 函数，从源码片段提取 PascalCase 类型引用（DTO/VO/Param/Query 等），与已有的方法调用提取并行运行。解决了此前 ASK 管线只能发现方法调用下游、完全遗漏 DTO 模型文件的问题。

## [4.4.9] - 2026-06-02

### 下游搜索回退逻辑修复

- **源码级提取与调用图并行**：修复了 `findDownstreamImplementations` 中源码级方法调用提取被阻隔的严重 bug。此前 `findCallees` 对未完整索引的方法（symbolId=None）返回文本匹配假阳性结果，导致 `if (calleeNames.size === 0)` 守护条件永远不满足，源码级正则提取实际从未执行。现移除条件守护，调用图与源码提取始终并行运行、结果合并，确保 Controller 方法的核心 Service/工具类实现能被稳定发现。

## [4.4.8] - 2026-06-02

### QA 下游实现自动发现

- **调用图驱动的下游搜索**：ASK 管线搜索到方法定义后，自动通过索引调用图（`findCallees`）提取被调用方法名，执行补充搜索并将下游 Service/工具类实现注入 LLM 上下文。解决了此前只找到 Controller 方法定义、看不到核心业务实现（如 `OrderTgqServiceImpl.queryForShowBySerialNo`）的问题。
- **源码级方法调用提取**：新增 `extractMethodCallsFromSnippet` 函数，从源码片段中提取方法调用名（而非仅定义），作为调用图索引的补充回退。支持 Java/C#、JavaScript/TypeScript、Python 四种语言。
- **调用链提取器增强**：`findDownstreamImplementations` 优先使用索引调用图，无结果时回退到源码级正则提取（≥8 字符的方法名过滤，±15 行上下文窗口）。

## [4.4.7] - 2026-06-02

### FTS 中文噪声过滤

- **FTS 查询净化**：查询中包含代码标识符（camelCase/PascalCase 如 `matchForShow`）时，FTS 搜索自动排除 CJK 噪声词条（如"接口"、"逻辑"、"什么样"），解决中文自然语言查询中关键词稀释导致目标代码排名下降的问题。
- **覆盖率评分优化**：含代码标识符的非路径查询中，token 覆盖率计算排除 CJK token，确保标识符精确匹配获得应有的评分权重。路径查询（如 `src/退款.service.ts`）不受影响。
- **搜索预算大幅提升**：`DEFAULT_SEARCH_BUDGET` 从 30s 提至 600s（20x），各子阶段同比例放大，解决大型项目搜索超时问题。
- **FTS5 查询优化**：语义前缀词上限从 24 降为 8，减少前缀扫描开销；`searchByTextSubstrings` 移除 `instr()` 全表扫描后校验，仅用 FTS5 MATCH 过滤。

## [4.4.6] - 2026-06-01

### 搜索性能优化

- **QA 管线并行化**：查询扩展与 Round1 搜索并行执行（`Promise.all`），减少串行等待时间。Reranker 增加 10s 超时保护，防止 LLM 调用无限阻塞。查询扩展结果新增 LRU 缓存（100 条，5 分钟 TTL），相同问题不重复调用 LLM。
- **向量搜索冷启动优化**：HNSW 索引磁盘读写从同步改为异步（`fs.promises`），不阻塞主线程。首次加载立即返回空索引，后台异步构建 HNSW 索引。
- **调用链提取并行化**：多符号调用链查询从串行 `for...of` 改为 `Promise.all` 并行。递归深度展开同层条目也并行处理。
- **SQL 查询优化**：新增 `LOWER(name)` 表达式索引加速符号模糊搜索；文本子串搜索用 FTS5 `MATCH` 预过滤替代全表 `instr()` 扫描；3 处关联子查询改为 `LEFT JOIN`。

## [4.4.5] - 2026-05-29

### LLM 最大输出 token 可配置

- **"LLM 最大输出"输入框**：智能问答高级选项新增 `maxTokens` 配置（默认 8192，范围 512~32768），用户可自行调整 LLM 回答的最大 token 数。此前默认 2048，结合本地代码后回答经常被截断。
- **`llmMaxTokens` 默认值从 2048 提升到 8192**：确保回答不会被截断。

## [4.4.4] - 2026-05-29

### 问答本地代码开关

- **"结合本地代码"开关**：智能问答高级选项新增 checkbox，控制是否读取搜索命中文件的完整本地源码。开启时使用 `full-file` 模式（读取完整文件内容），LLM 能看到完整实现逻辑，回答更准确但消耗更多 token；关闭时使用 `chunk` 模式（只用索引中的代码片段），更快更省 token。默认开启。

## [4.4.3] - 2026-05-29

### 调用链源码补全

- **调用链代码片段自动补全**：QA 管线在提取调用链关系后，自动读取每个 caller/callee 的源码（上下文 ±5 行），作为独立 section 注入 LLM 上下文。此前调用链只返回符号名和位置（如 "`processRefund` at RefundService.java:42"），LLM 无法理解调用链上的具体实现逻辑。现在 LLM 可以同时看到搜索结果和调用链上下游的源码。
- **去重机制**：调用链源码与搜索结果按 `filePath:startLine` 去重，避免重复注入相同代码。
- **prompt 分区展示**：调用链源码以 `[call-chain-N]` 标记在独立 `## Call Chain Source Code` section 中展示，与搜索结果的 `[N]` 引用区分。

### 上下文容量提升

- **`qaMaxContextTokens` 从 12000 提升到 24000**：调用链源码补全会增加上下文量，token 预算翻倍确保搜索结果和调用链源码都能完整注入。
- **`qaMaxSourcesMax` 从 50 提升到 100**：支持更多参考代码片段，配合更大 token 预算使用。
- **前端参考代码数量上限同步**：前端 `max` 从 50 提升到 100。

## [4.4.2] - 2026-05-29

### HNSW 向量搜索

- **HNSW 近似最近邻索引**：新增 `hnswIndex.ts`，实现纯 JS 的 HNSW（Hierarchical Navigable Small World）算法。搜索复杂度从 O(n) 暴力余弦相似度降低到 O(log n)，大幅提升大型项目（10k+ chunks）的向量搜索性能。
- **自动索引构建与缓存**：首次加载向量时异步构建 HNSW 索引，序列化到磁盘 `~/.ace-mcp/data/hnsw/`，后续启动直接加载避免重建。
- **透明回退**：当查询带有过滤条件或候选集预过滤时，自动回退到暴力搜索保证正确性。

### 调用链深度增强

- **可配置调用链深度**：`extractCallChains` 新增 `depth` 参数（1-3），支持多跳调用关系追踪。默认 depth=1 保持向后兼容，depth=2/3 可递归展开上下游调用链。
- **递归数据结构**：`CallChainEntry` 新增 `upstream` 和 `downstream` 可选字段，支持嵌套调用关系表示。
- **Mermaid 多层可视化**：`generateCallChainMermaid` 支持递归生成多层调用图，节点按层级着色区分。

### Web 质量评估界面

- **搜索质量评估面板**：新增「搜索质量评估」可折叠面板，支持测试用例录入、批量评估、结果可视化。
- **评估指标展示**：显示 passRate、top1Recall、top5Recall、MRR 四项核心指标。
- **用例持久化**：支持保存/加载测试用例到 localStorage，每个项目独立存储。

### 项目列表自动同步

- **启动时自动同步后端已索引项目**：页面加载时自动调用 `/api/projects` 获取后端所有已索引项目并合并到前端项目列表，通过 API 或其他方式索引的项目无需手动添加即可出现在下拉列表中。

## [4.4.1] - 2026-05-28

### 修复

- **参考代码数量尊重用户选择**：移除智能估算 `estimateOptimalSources()` 对前端选择的覆盖。此前当用户使用默认值（10）时，后端会根据问题复杂度自动调整检索源数量（5~20），导致用户通过前端"参考代码数量"设置的值被忽略，存在上下文不足的情况。现在前端选择的值直接传递到搜索管线，仅在 `[1, qaMaxSourcesMax]` 范围内做 clamping。
- **前端参考代码数量上限同步**：前端 `max` 从 30 提升到 50，与后端 `qaMaxSourcesMax` 默认值一致，用户可以选择更大的检索源数量。

## [4.4.0] - 2026-05-28

### 跨语言搜索（符号级语义索引）

- **符号中文标签生成**：新增 `symbolLabeler.ts`，为英文代码符号名自动生成中文语义标签。使用 200+ 词条的代码领域英中词汇表，通过 camelCase/PascalCase 拆分 + 词汇翻译 + 组合短语，实现零延迟的本地标签生成。
- **语义索引增强**：`buildSemanticText` 接受完整 `SymbolInfo[]`，将中文标签注入 `chunk_semantic_fts`。索引后 FTS 天然支持中文搜索匹配英文代码，无需运行时 LLM 调用。
- **中英文同义词扩充**：`SYNONYM_GROUPS` 从 15 组扩展到 70+ 组，新增中英文双向映射（如 `order↔订单`、`ticket↔出票`、`endorse↔改签`），搜索时中文词自动扩展匹配对应英文词。

### 双轮搜索策略

- **QA 管线双轮搜索**：Round 1 用原始查询搜索（受益于语义标签可直接匹配中文），Round 2 用 LLM 提取的英文关键词补充搜索。两轮结果按 `filePath:startLine:endLine` 去重合并，显著提升跨语言搜索召回率。
- **Web 流式端点同步**：流式问答也支持双轮搜索，SSE 事件新增 `search_round2` 阶段。

## [4.3.9] - 2026-05-28

### 跨语言搜索优化

- **LLM 查询扩展**：当用户使用中文等非 ASCII 语言提问时，自动调用 LLM 提取可能相关的英文代码关键词（类名、方法名、包路径），附加到搜索查询中，显著提升中文问题→英文代码的搜索召回率。
- **查询扩展集成**：QA 管线和 Web 流式问答端点均支持查询扩展，扩展结果在 timing 中返回 `queryExpansionMs`，调试用字段 `expandedQuery` 可查看扩展后的查询。

### 索引稳定性

- **ensureFreshIndex 超时保护**：索引等待超时后自动返回缓存结果或最小 stub，不再阻塞搜索请求。
- **in-flight promise 超时**：复用已有索引 promise 最多等 60 秒，超时后清除 stuck promise 并重新开始，解决卡住的索引操作永远阻塞后续请求的问题。
- **projectQueue 清理 bug 修复**：修复 `indexPromise.catch(() => {})` 每次创建新对象导致等式比较永远 false 的队列泄漏 bug。

## [4.3.8] - 2026-05-28

### 问答质量优化

- **QA 默认 merged-file 上下文**：问答时自动合并同文件的多个代码片段，从磁盘读取连续范围，解决方法体被截断导致的回答不准确问题。
- **搜索片段截断放宽**：`clampSnippet` 上限从 1200 字符提升到 2400 字符，搜索结果保留更多上下文。
- **上下文 token 预算翻倍**：`qaMaxContextTokens` 默认值从 6000 提升到 12000，支持 merged-file 模式下完整方法体。

## [4.3.7] - 2026-05-27

### 新功能

- **全文件/合并文件上下文模式**：`ask_codebase` 新增 `contextMode` 参数（`"chunk"` / `"merged-file"` / `"full-file"`），支持将搜索命中的代码片段扩展为完整文件内容，解决跨函数逻辑截断导致的问答信息缺失问题。
- **搜索 Reranker 通用化**：MCP `search_context` 工具新增 `enableReranker` 参数，允许搜索结果使用 LLM 二次排序。
- **动态 perFileLimit**：搜索引擎根据查询类型自动调整每文件结果数限制（定义查找 5 个、引用查找 3 个、常规查询使用配置默认值）。

### 架构优化

- **统一 QA 管线**：提取 `QaPipeline` 服务（`src/core/llm/qaPipeline.ts`），MCP `ask_codebase` 与 Web QA 共用完整管线：
  - LLM Reranker（搜索结果二次排序）
  - 调用链自动提取与注入
  - QA 响应缓存
  - Smart TopK（根据问题复杂度自动调整检索源数量）
  - 上下文压缩
  - 超时与降级处理

## [4.3.6] - 2026-05-27

### 可配置性增强

- **Ask 限制可配置**：将 Ask Codebase 的多层数量限制从硬编码改为可配置，解决用户反馈的"查询不准确"问题：
  - `qaMaxSourcesDefault` (默认 10)：默认检索源数量
  - `qaMaxSourcesMax` (默认 50，原 20/30)：最大检索源数量上限
  - `qaMaxContextTokens` (默认 6000)：LLM 上下文 token 预算
  - `searchPerFileLimit` (默认 2)：每个文件最多保留的搜索结果数
  - `searchFanoutMultiplier` (默认 3)：搜索候选集扩展倍数
- 支持通过环境变量配置：`ACE_MCP_QA_MAX_SOURCES_DEFAULT`、`ACE_MCP_QA_MAX_SOURCES_MAX` 等。

### 稳定性增强

- **索引队列机制**：新增 per-project 索引队列 + in-flight 去重，防止并发索引导致的 "database is locked" 错误。同一项目的多个索引请求会自动串行执行，后续请求复用进行中的索引结果。

### 可观测性增强

- **后台索引进度 SSE**：新增 `GET /api/index/stream` 端点，实时推送索引进度事件：
  - `collect:start/done` - 文件收集阶段
  - `parse:start/progress/done` - 文件解析阶段
  - `index:start/progress/done` - 数据库写入阶段
  - `vector:start/progress/done` - 向量索引阶段
  - `semantic:start/done` - 语义索引阶段
  - `complete:done` - 索引完成
- **健康检查增强**：`/health` 端点新增丰富的统计信息：
  - `watching`: 是否启用文件监控
  - `projects`: 项目数量统计 (total, ready)
  - `index`: 索引统计 (totalFiles, totalChunks, totalSymbols, latestIndexAt)
  - `vector`: 向量搜索配置 (enabled, mode)

### 内部改进

- `IndexCoordinator` 新增 `projectQueue` 和 `inFlightIndex` Map 实现队列机制。
- `indexProject()` 方法重构为队列包装 + `runIndexProject()` 实际逻辑。
- 新增 `IndexProgressEvent`、`IndexProgressCallback` 类型导出。
- `Settings` 接口新增 5 个 Ask/Search 限制配置项。
- `settings.ts` 新增对应环境变量解析。

## [4.3.5] - 2026-05-27

### 搜索增强

- **LLM Reranker（可选）**：新增 LLM 二次排序功能，使用 LLM 对搜索结果按相关性重排序，提升搜索精度。通过 `enableLlmReranker: true` 配置开启，适用于对搜索准确性要求较高的场景。默认关闭以节省 token 消耗。

### 可视化增强

- **调用链可视化**：Ask Codebase 回答完成后，自动将调用链关系渲染为 Mermaid 流程图，可视化展示函数之间的调用关系（谁调用了它 → 目标函数 → 它调用了谁）。支持折叠/展开操作。

### 内部改进

- 新增 `llmReranker.ts` 模块，提供 `rerankWithLlm()` 函数。
- `Settings` 接口新增 `enableLlmReranker` 和 `llmRerankerMaxCandidates` 配置项。
- `LlmClient` 新增 `getModelName()` 方法。
- SSE `done` 事件新增 `callChains` 字段，返回完整调用链数据供前端渲染。
- 前端新增 `renderCallChainDiagram()` 函数，使用 Mermaid.js 渲染调用链图。
- HTML 引入 Mermaid.js CDN，新增 `#qa-callchain-diagram` 容器。
- CSS 新增 `.qa-callchain-*` 系列样式类。

## [4.3.4] - 2026-05-27

### 上下文增强

- **调用链分析**：Ask Codebase 在回答问题时自动提取搜索结果中符号的调用链（callers/callees），将上下游调用关系作为额外上下文传递给 LLM，帮助 LLM 理解代码的完整执行流程，提供更准确的回答。SSE 流式输出新增 `callchain` 阶段（🔗 图标），展示调用链分析进度。

### 内部改进

- 新增 `callChainExtractor.ts` 模块，提供 `extractCallChains()`、`extractSymbolsFromResults()`、`formatCallChainsForLLM()` 等函数。
- `buildQaUserPrompt()` 函数新增 `callChainContext` 参数，在 Source Code Snippets 前插入调用链上下文。
- SSE 流式输出新增 Phase 3 `callchain`，位于 search 和 summary 之间。
- 前端新增调用链阶段图标和标签（🔗 分析调用链...）。

## [4.3.3] - 2026-05-27

### 性能优化

- **Git 增量索引**：Git 项目增量索引时，使用 `git diff` 检测变更文件，而非全量文件系统扫描。首次索引后记录 commit SHA，后续索引只处理两次 commit 之间的差异 + 未跟踪文件。大型 Git 仓库（10k+ 文件）的增量索引速度可提升 10-100 倍。

### 工程优化

- **NDJSON 结构化日志**：日志文件输出改为 NDJSON 格式（每行一个 JSON 对象），便于使用 `jq`、ELK、Loki 等工具进行日志分析和聚合。控制台输出保持人类可读格式。

### 内部改进

- 新增 `gitHelper.ts` 模块，提供 `getGitChangedFiles()`、`getHeadCommit()`、`isGitRepository()` 等函数。
- SQLite `project` 表新增 `last_indexed_commit` 列，存储上次索引的 Git commit SHA。
- `updateProjectAfterIndex()` 方法增加 `lastIndexedCommit` 参数。
- 新增 `getLastIndexedCommit()` 方法。
- `IndexEventPayload.metadata` 新增 `gitOptimization` 字段，记录是否启用 Git 优化及当前 commit。
- `Logger.write()` 改为生成 NDJSON 格式，`appendFileSync` 写入 `JSON.stringify(entry)`。

## [4.3.2] - 2026-05-26

### 用户体验

- **相关问题推荐**：回答完成后自动推荐 3 个相关后续问题，点击即可填充到输入框，引导用户深入探索代码库。推荐算法基于回答中提取的代码实体（函数、类名）和文件名，生成如"XXX 的调用者有哪些？"、"XXX 和 YYY 是如何交互的？"等语义相关问题。

### 内部改进

- 新增 `generateRelatedQuestions()` 函数，从回答和问题中提取代码实体生成相关问题。
- SSE done 事件新增 `relatedQuestions` 字段。
- 前端新增 `setupRelatedQuestions()` 函数和 `#qa-related-questions` 容器。
- CSS 新增 `.qa-related-*` 系列样式类。

## [4.3.1] - 2026-05-26

### 性能优化

- **fast-glob 文件收集**：使用 fast-glob 替代手动递归遍历，单次获取文件列表和 stat 信息，collectMs 预计减少 70%。
- **批量事务写入**：新增 `writeFileIndexBatch()` 方法，将多个文件的数据库写入合并为单一事务，indexMs 预计减少 80%。
- **SQLite 配置优化**：
  - `busy_timeout = 30000` - 消除 "database is locked" 错误
  - `cache_size = -128000` - 增加缓存到 128MB
  - `mmap_size = 268435456` - 启用 256MB 内存映射
  - `wal_autocheckpoint = 10000` - 减少 checkpoint 频率
- **IgnoreManager 缓存**：缓存 shouldIgnore 结果，避免重复正则匹配。

### 内部改进

- 新增 `fast-glob` 依赖。
- `fileCollector.ts` 完全重写，使用 fast-glob 的 stats 选项。
- `indexCoordinator.ts` 改为先并行读取解析，再批量写入数据库。
- `DB_WRITE_BATCH_SIZE = 50`：每 50 个文件一次事务提交。

## [4.3.0] - 2026-05-26

### 搜索增强

- **智能 Sources 数量**：根据问题复杂度自动调整检索源数量。简单查找类问题（"什么是"、"在哪里"）使用 5 个源；复杂架构类问题（"流程"、"原理"、"调用链"）自动扩展到 15-20 个源，在保证回答质量的同时减少 token 消耗。

### 工程优化

- **LLM 响应缓存**：新增 `QaCache` 类，基于问题 + 源码哈希生成缓存 key，相同问题 5 分钟内直接返回缓存结果（仍以流式方式展示），大幅降低重复提问的响应延迟和 token 消耗。
- **思考过程实时展示**：DeepSeek 模型的 `reasoning_content` 现以灰色斜体实时显示在生成中区域，回答完成后自动折叠为摘要，方便了解 LLM 推理过程。

### 内部改进

- 新增 `estimateOptimalSources()` 函数，支持中英文问题复杂度检测。
- 新增 `QaCache` 类，提供 `get()`、`set()`、`hashSource()`、`getStats()` 方法。
- 前端新增 `.qa-thinking-inline`、`.qa-thinking-collapsed` 样式类。
- SSE 流式响应新增 `isThinking` 字段区分思考内容和正式回答。

## [4.2.9] - 2026-05-26

### 性能优化

- **搜索结果懒加载**：代码 snippet 默认折叠显示，点击"查看代码"按钮展开。大量搜索结果时页面更流畅，减少 DOM 渲染负担。
- **向量增量更新**：`vectorIndexingMode: eager` 模式下，文件索引后立即生成 embedding，无需等待 warm_index。

### 稳定性增强

- **错误分类展示**：区分网络错误、超时、LLM 服务错误、索引错误四类，显示对应图标和排查建议，方便用户自助定位问题。
- **Token 用量统计**：新增会话级 token 累计统计，显示总提问次数、输入/输出 token 数量，支持一键重置。

### 内部改进

- 前端新增 `classifyError()` 函数，根据错误信息关键词自动分类错误类型。
- 前端新增 `sessionTokenUsage` 对象和相关函数，使用 LocalStorage 持久化会话统计。
- `renderSourceCard()` 默认生成折叠状态的代码块，`toggleSnippet()` 支持三态切换（折叠→预览→全部→折叠）。
- CSS 新增 `.qa-error-card`、`.session-token-stats` 等样式类。

## [4.2.8] - 2026-05-26

### 功能增强

- **全新中文界面**：页面布局重新设计，所有按钮和提示改为中文，功能分区更清晰直观。
- **停止按钮**：问答过程中可随时点击"停止"中断 LLM 生成，保留已生成的部分答案。
- **Enter 键提交**：在问答框和搜索框中按 Enter 直接提交（Shift+Enter 换行）。
- **搜索历史快速填充**：点击历史记录可同时填充搜索框和问答框，方便重复查询。

### 界面改进

- 主页面采用左右双栏布局：左侧为核心功能（项目选择、智能问答、代码搜索），右侧为辅助功能（项目管理、文件查看、配置）。
- 智能问答卡片高亮显示，作为核心功能突出展示。
- 高级选项默认折叠，减少界面干扰。
- 调试功能收纳到折叠面板中，保持界面简洁。
- 新增渐变色设计，视觉体验更现代。

### 内部改进

- 前端 Ask handler 重构为 `runAskQuestion()` 函数，便于复用和测试。
- 新增 `currentEventSource` 全局变量跟踪 SSE 连接状态。
- 新增 `qa-stop` 按钮事件处理器。
- 添加 Enter 键事件监听器支持快捷提交。

## [4.2.7] - 2026-05-26

### 功能增强

- **Ask 按钮默认流式响应**：移除单独的 "Stream" 按钮，"Ask" 按钮现默认使用 SSE 流式响应，答案逐 token 显示，无需额外点击。

### 内部改进

- 前端 Ask handler 重构为 SSE 模式，复用 `/api/qa/ask/stream` 接口。
- 移除冗余的 `run-ask-stream` 事件处理器。

## [4.2.6] - 2026-05-26

### 功能增强

- **项目列表持久化**：已添加的项目自动保存到 LocalStorage，刷新页面后下拉列表自动恢复，无需重复添加。
- **删除项目按钮**：新增 "🗑 Del" 按钮，可从下拉列表中移除不再需要的项目（索引数据保留在磁盘）。
- **代码语法高亮**：搜索结果 snippet 现支持语法高亮，根据语言类型（JavaScript/Java/Python/.NET）着色关键字、字符串、注释、数字等。
- **搜索词高亮**：搜索词在 snippet 中以黄色背景高亮显示，便于快速定位匹配位置。

### 内部改进

- 前端新增 `getStoredProjects()` / `addStoredProject()` / `removeStoredProject()` 函数管理项目列表。
- 前端新增 `highlightSyntax()` 函数，支持 JavaScript/Java/Python/.NET 四种语言的基础语法高亮。
- CSS 新增 `.syn-keyword` / `.syn-string` / `.syn-comment` / `.syn-number` / `.syn-decorator` / `.search-highlight` 样式类。

## [4.2.5] - 2026-05-26

### 功能增强

- **前端流式问答 (SSE Streaming)**：新增 "Stream" 按钮，使用 EventSource 接收 `/api/qa/ask/stream` 的 SSE 流，答案逐 token 显示，体验更流畅。
- **对话持久化**：多轮对话历史现存储到 LocalStorage，刷新页面后自动恢复，支持跨会话追问。
- **搜索结果去重增强**：新增 `mergeOverlappingResults()` 函数，自动合并同文件内行号重叠超过 50% 的 snippet，减少冗余结果。
- **项目摘要增量更新**：`SummaryGenerator` 通过 content hash 检测模块变更，未变更的模块复用缓存的摘要，节省 LLM token 消耗。

### 性能优化

- **远程 Embedding 超时保护**：`RemoteEmbeddingProvider.embedBatch()` 支持 `AbortSignal`，超时时真正中断请求而非仅 abandon promise。

### 内部改进

- `ModuleSummary` 新增 `contentHash` 字段，用于增量更新检测。
- `SummaryGenerationResult` 新增 `regeneratedModules` 和 `cachedModules` 字段，便于观察增量更新效果。
- 前端新增 `saveQaHistory()` / `clearQaHistory()` 函数管理 LocalStorage 中的对话历史。
- 前端 Stream 按钮复用已有的 SSE 后端，无需额外接口。

## [4.2.4] - 2026-05-26

### 功能增强

- **LLM 流式响应 (SSE Streaming)**：新增 `/api/qa/ask/stream` 端点，支持 Server-Sent Events 流式返回，前端可逐 token 显示生成进度。
- **多轮对话支持**：Ask Codebase 现支持上下文追问，自动保留最近 6 轮对话历史，新增"🔄 New"按钮清空对话。
- **代码引用高亮**：LLM 回答中的 `[N]` 引用可点击跳转到对应源码卡片，卡片高亮 2 秒便于定位。
- **LLM 降级策略**：当 LLM 超时或不可用时，返回降级响应（`fallback: true`），前端显示警告提示并展示检索结果供用户参考。
- **RAG 上下文压缩**：新增 `compressContext()` 函数，按 score 排序并截断低分 snippet，确保 context 不超过 6000 tokens。

### 性能优化

- **Query Embedding 缓存**：`EmbeddingProvider` 新增 `embedQuery()` 方法，支持 5 分钟 TTL 缓存，避免重复 query 重算 embedding。
- **LLM 超时控制**：`LlmClient.complete()` 支持 `timeoutMs` 和 `fallbackOnTimeout` 参数，使用 `AbortController` 实现真正的请求取消。

### 内部改进

- `LlmClient` 新增 `streamComplete()` async generator 方法，解析 SSE 流返回 token/done/error 事件。
- `qaPrompt.ts` 新增 `QaConversationTurn`、`buildQaMessagesWithHistory()`、`estimateTokens()`、`compressContext()` 导出。
- `EmbeddingProvider` 接口新增 `embedQuery()`、`getQueryCacheStats()`、`clearQueryCache()` 方法。
- 前端 `renderSourceCard()` 生成的卡片现带 `id="source-N"` 属性，支持引用跳转。
- 默认 timeout 从 60s 调整为 120s，max sources 上限从 20 调整为 30。

## [4.2.3] - 2026-05-25

### 性能优化

- **并行 FTS 搜索**：将 lexical、semantic-fts、unicode、symbol、path 五个搜索阶段并行化（`Promise.all`），减少串行等待时间。
- **候选预过滤（Candidate Prefiltering）**：向量搜索利用 FTS 阶段已返回的 chunkId 作为候选集，将 O(n) 全量向量扫描缩减为 O(candidates)，大幅降低大项目语义搜索延迟。
- **索引预热 API**：新增 `warm_index` MCP 工具和 `POST /api/index/warm` 端点，允许显式触发向量索引的批量生成，避免首次搜索时的延迟抖动。

### 内部改进

- `SearchResult` 新增 `chunkId` 字段，便于跨搜索阶段追踪候选。
- `SearchDiagnostics.vectorIndex` 新增 `prefiltered` 和 `prefilteredCandidates` 诊断字段。
- `searchByText` / `searchBySemantic` 返回 `chunkId`，`searchByVector` 支持 `candidateChunkIds` 参数。
- `TestProjectEnvironment` 接口导出 `embeddingProvider`，方便测试 warm_index 端点。

## [4.0.5] - 2026-05-22

### 改进

- **settings.toml LLM 配置模板**：初次创建或已有文件缺少 LLM 字段时，自动追加带注释的 LLM 配置段（含 API URL、Key、Model 等），注释中列出了 OpenAI / OneAI / Ollama 等常见配置示例，用户直接改文件即可切换模型平台。

## [4.0.4] - 2026-05-22

### 改进

- **LLM 配置持久化**：LLM 配置（`llmApiUrl`、`llmApiKey`、`llmModel`、`llmMaxTokens`、`llmTemperature`）现在从 `~/.ace-mcp/settings.toml` 读取，优先级为 环境变量 > TOML 配置 > 默认值。
- **Web 配置写回 TOML**：通过 `POST /api/llm/config` 修改 LLM 配置时，同时更新内存和 `settings.toml`，重启后依然生效，方便切换模型平台。
- **初始配置完整**：首次运行生成的 `settings.toml` 包含 LLM 配置项模板。

## [4.0.3] - 2026-05-22

### 改进

- **RAG 问答分步进度**：前端分步调用 index → search → LLM，每步完成即时更新 UI，搜索完成后立即展示检索到的源码卡片，无需等 LLM 回答完毕。
- **交互简化**：问题输入和 Ask 按钮并排，高级参数（Max sources、Timeout、Include summary）折叠在 Advanced options 中，一键即可提问。
- **Code Summary 说明优化**：详细解释了摘要功能的用途和产出文件。

### 修复

- 移除不可靠的 SSE 流式推送（Express 5 不 flush），改为前端分步 REST 调用实现实时进度。

## [4.0.2] - 2026-05-22

### 改进

- **RAG 问答流式进度展示**：后端改为 SSE 流式推送，前端实时显示每个阶段（索引检查 → 代码搜索 → 摘要加载 → LLM 生成）的进度和耗时。
- **超时控制**：用户可设定超时秒数（10-300s，默认60s），前后端双重超时保护，超时自动中断并提示。
- **功能说明增强**：Code Summary 和 Ask Codebase 面板增加详细功能描述；Max sources 和 Timeout 参数增加内联说明。

## [4.0.1] - 2026-05-22

### 改进

- **Web 调试面板 RAG 问答体验优化**：
  - 回答区支持 Markdown 渲染（代码块、行内代码、标题、列表、粗体、引用）
  - 源码引用以卡片形式展示（语言 badge、行号、相关度进度条、snippet 预览）
  - 加载过程增加脉冲动画 + 实时计时器
  - 完成后显示统计指标（耗时、prompt/completion tokens、源码数）
  - 原始 JSON 折叠在可展开区域内
  - 新增 LLM Config、Code Summary、Ask Codebase 三个交互面板

## [4.0.0] - 2026-05-22

### 新增

- **文档联合索引 MVP**：`.md` / `.mdx` 文件纳入搜索管线，与代码统一检索；新增 `markdown` 语言适配器（无符号/import 提取）。
- **LLM API 集成**：独立的 LLM 配置（`ACE_MCP_LLM_API_URL` / `ACE_MCP_LLM_API_KEY` / `ACE_MCP_LLM_MODEL`），支持 OpenAI 兼容接口；运行时可通过 `POST /api/llm/config` 动态更新。
- **代码摘要生成**：新增 `generate_summary` MCP 工具，自动按目录分模块、调用 LLM 生成模块摘要和项目架构概览，持久化到 `{projectRoot}/.ace-mcp/summaries/`（`project-summary.json`、`architecture.md`、`modules/*.md`）。
- **摘要查询**：新增 `get_summary` MCP 工具，无需 LLM 即可读取已生成的摘要数据。
- **语义问答 RAG**：新增 `ask_codebase` MCP 工具，基于代码搜索 + 文档 + 摘要上下文，调用 LLM 合成回答并附带源码引用。
- **Web 调试端点**：新增 `GET/POST /api/llm/config`、`POST /api/summary/generate`、`GET /api/summary`、`POST /api/qa/ask` 共 5 个端点。

## [3.9.0] - 2026-05-21

### 新增

- **符号类型扩展**：新增 `constructor`、`field`、`property` 符号类型，覆盖更完整的代码结构。

### 改进

- **Java 适配器增强**：
  - 提取构造函数（constructor）和字段（field）作为独立符号
  - 追踪 `extends` / `implements` 类型继承关系，生成 type usage
  - 提取注解使用（`@Autowired`、`@Service` 等），建立 usage 关联
  - 字段类型推断增强：import-resolved 类型名用于调用图候选
  - 方法内局部变量类型追踪（非 `new` 赋值）
  - 跳过注释行，减少误匹配
  - 静态导入生成额外 usage 记录

- **Python 适配器增强**：
  - 装饰器使用追踪（`@app.route`、`@classmethod` 等），生成 usage 关联
  - 基类提取（`class Foo(Base):`），建立 type usage
  - 参数和返回值类型提示追踪（`def bar(x: int) -> str:`），生成 type usage
  - 多行 import 支持（括号和反斜杠续行）
  - 模块级 lambda 赋值识别为 function 符号
  - import 别名映射用于 usage 候选名解析

- **.NET 适配器增强**：
  - 提取 `struct`（映射为 class 符号）、`property`、`constructor`、`delegate`、`event`
  - 支持 `using static`、`using alias`、`global using` 语法
  - attribute 使用追踪（`[Authorize]` 等），生成 usage 关联
  - 基类/接口继承关系提取（`class Foo : Bar, IFoo`），建立 type usage
  - 属性类型推断生成 type usage
  - 跳过注释行，减少误匹配

## [3.6.0] - 2026-05-14

### 新增

- **语言级符号解析**：索引阶段新增 `imports` / `usages` / `canonicalName` / `modulePath` 持久化，并在增量索引后解析 symbol graph，definition/reference 查找优先走已解析符号关系。
- **调用关系工具**：新增 `find_callers` 与 `find_callees` MCP 工具及对应 Web API，支持返回 caller/callee 命中、owner symbol、resolved symbol 和统一 envelope 结构。
- **质量指标化**：`evaluate_search_quality` 摘要新增 `top1Recall`、`top5Recall`、`meanReciprocalRank`，可直接用于回归对比。

### 改进

- JavaScript/TypeScript AST 分析扩展到 import/usage 解析，并为 Java / Python / .NET 适配器补齐轻量调用与类型推断。
- `find_references` 现在优先返回已解析 symbol usage，只有图中无命中时才回退到 lexical 搜索，结果更稳定。
- Web 调试面板工具目录与 HTTP 端点扩展到 callers/callees，MCP 与 Web 调试入口继续保持一致。

### 测试

- 新增 Python 语言级 reference/call graph 回归测试。
- 新增 callers/callees Web API 集成测试，并补充质量指标断言。

## [3.7.0] - 2026-05-15

### 新增

- **多跳调用图**：`find_callers` 与 `find_callees` 新增 `depth` 参数，支持最多 5 层的 caller/callee 展开，并在结果中返回 `hopCount` 与 `symbolPath`。

### 改进

- **跨文件引用精度提升**：namespace import、模块别名、wildcard/module import 的解析优先级提高，同名跨文件符号会优先按导入上下文和模块路径收敛。
- **调用图遍历**：调用图查询改为循环安全的逐层遍历，结果按 hop 优先级稳定排序，避免深层节点把直连关系挤掉。
- **Web / MCP 对齐**：`find_callers` / `find_callees` 的 MCP 工具与 Web API 同步支持多跳参数，并暴露深度统计信息。

### 测试

- 新增 JavaScript namespace import + 同名符号歧义场景下的 reference 精度回归测试。
- 新增多跳 caller/callee 遍历的搜索服务与 Web API 集成测试。

## [3.8.0] - 2026-05-20

### 新增

- **索引新鲜度策略**：新增 `indexFreshness` 配置（`always` / `stale` / `manual`），`stale` 模式下搜索工具在索引仍新鲜时跳过全量扫描，大幅减少搜索延迟。
- **诊断管理工具**：新增 `cache_stats`、`clear_project_index`、`list_symbols` MCP 工具，支持缓存诊断、索引清除和符号列表查看。
- **可配置参数暴露**：新增 `indexFreshnessSeconds`、`searchCacheTtlMs`、`searchCacheMaxSize`、`vectorCacheMaxProjects`、`searchFanoutLimit` 配置项，支持 TOML 和环境变量。

### 改进

- **向量搜索性能**：Top-K 堆替代全量排序（O(n) → O(n log K)），查询向量预转 Float32Array 加速余弦相似度计算。
- **符号图增量解析**：`resolveSymbolGraph` 支持仅处理变更文件的 import/usage，新增 suffix 索引替代 O(n) filter 扫描。
- **搜索缓存全模式覆盖**：semantic/hybrid 模式在 indexVersion 不变时启用缓存（此前完全不走缓存），缓存结构从 flat Map 改为嵌套 `Map<projectId, Map<key, entry>>` 提升清理效率。
- **错误处理统一**：`AppError` 扩展 `cause` / `statusCode` / `retryable`，Web API 按错误码映射 HTTP 状态码（不再全部 500），结构化查询解析错误类型化。
- **Watcher 脏路径追踪**：文件变更事件标记项目为 dirty，配合索引新鲜度策略实现精确的缓存失效。

### 测试

- 更新 semantic 缓存测试以适配全模式缓存覆盖行为。

## [3.5.0] - 2026-05-12

### 新增

- **结构化查询语言**：`search_context` 现支持 `AND` / `OR` / `NOT` 布尔运算和 field-scoped 子句（`symbol:`、`path:`、`content:`），可直接组合路径、符号与内容约束。
- **代码导航工具**：新增 `find_definition` 与 `find_references` MCP 工具，并同步提供 Web API，支持基于现有符号索引做轻量 definition/reference 定位。
- **搜索质量评估**：新增 `evaluate_search_quality` 工具与 Web API，可批量执行预期文件断言，输出通过率和逐 case 结果，便于离线回归评估搜索质量。

### 改进

- 结构化查询按文件粒度执行布尔过滤，并与现有搜索重排、片段展开和统一 envelope 返回兼容。
- Web 调试面板工具目录与 HTTP 端点扩展到 definition/reference/quality evaluation，MCP 与 Web 调试入口保持一致。

### 测试

- 新增结构化查询、definition/reference 检索、质量评估流程的搜索服务回归测试。
- 新增 Web definition/reference/evaluation API 集成测试。

## [3.4.0] - 2026-05-10

### 新增

- **远程 Embedding API Provider**：支持 OpenAI 兼容的远程 Embedding API（如 `text-embedding-3-small`），通过环境变量 `ACE_MCP_EMBEDDING_PROVIDER=remote` 启用。失败时自动回退到内存哈希向量。
- **文件监听自动索引**：索引完成后自动启动文件监听（`fs.watch`，2500ms 防抖），代码改动后自动触发增量索引。可通过 `autoWatch` 配置项或 `ACE_MCP_AUTO_WATCH` 环境变量控制。
- **Web API 新增**：`POST /api/watch/start` 和 `POST /api/watch/stop` 端点，支持手动控制文件监听状态。

### 改进

- **EmbeddingProvider 依赖注入**：`IndexCoordinator` 和 `SearchService` 改为通过构造函数注入 `EmbeddingProvider`，替代原有的模块级单例模式，便于后续扩展不同的向量后端。

### 新增环境变量

- `ACE_MCP_EMBEDDING_PROVIDER`：设置 `remote` 启用远程 Embedding API
- `ACE_MCP_EMBEDDING_API_URL`：远程 Embedding API 地址
- `ACE_MCP_EMBEDDING_API_KEY`：远程 Embedding API 密钥
- `ACE_MCP_EMBEDDING_MODEL`：远程 Embedding 模型名（默认 `text-embedding-3-small`）
- `ACE_MCP_AUTO_WATCH`：是否自动启用文件监听（默认 `true`）

### 测试

- 新增 `RemoteEmbeddingProvider` 单元测试（mock fetch，验证请求/回退/维度缓存）
- 新增文件监听 API 集成测试

## [3.3.0] - 2026-04-29

### 新增

- MCP 工具返回统一升级为 `meta / request / data / stats / notes` 结构，并同时通过 `content.text` 与 `structuredContent` 暴露同一份 JSON。
- 搜索结果新增结构化诊断信息，包括查询分析、执行阶段耗时、候选量、结果来源分布与向量命中状态。
- Web 调试面板增加结果摘要卡片，便于快速查看搜索耗时、候选数、索引总耗时与向量模式。
- 搜索结果缓存：新增 LRU 缓存（最大 100 条，TTL 60s），支持 lexical/auto 模式搜索结果复用。

### 改进

- 向量索引默认改为 `lazy`：增量索引不再为每个 chunk 预先生成向量，改为首次 `semantic / hybrid` 查询时按需补齐，显著降低大仓库索引开销。
- 向量检索改为稳定的哈希向量实现，并增加项目级向量缓存，避免重复查询反复拉取和计算全量向量。
- 项目 `index_version` 现在仅在实际索引内容发生变化时递增，避免无变更增量同步频繁打穿缓存。
- 索引事件与搜索响应补充阶段耗时、向量模式和失败提示，便于判断慢点来自扫描、索引、重排还是懒加载向量。
- Web `/api/index-project`、`/api/search-context`、`/api/project-stats` 与 `/api/file-snippet` 的返回结构与 MCP 工具保持一致。
- **向量质量提升**: 维度从 128 增加到 256，采用双重 hash 减少碰撞，添加 bigram 特征增强局部顺序感知。
- **向量缓存 LRU**: 最多缓存 10 个项目的向量，避免内存无限增长。
- **Float32Array 存储**: 向量直接使用 Float32Array 存储，避免转换为 number[] 的内存翻倍开销。

### 测试

- 增加懒向量生成、向量缓存命中与 Web 新响应结构的回归测试。

## [3.0.1] - 2026-04-03

### 新增

- 新增 `--version` 与 `/api/runtime`，便于宿主升级后确认当前进程版本、PID 与运行时长。

### 改进

- 进程启动/关闭增加运行诊断与优雅退出日志，便于 MCP 宿主重连排查。
- `batchSize` 现在用于并发文件收集与变更文件索引，降低大仓库增量扫描开销。
- 索引与搜索日志增加分段耗时字段，方便定位性能瓶颈。
- Web 调试面板补充 runtime 快捷入口，并修复 `/api/search-context` 未接受 `semantic` 模式的问题。

### 测试

- 增加 CLI 版本参数、Web runtime 接口、混合标识符查询保护的回归测试。

## [3.0.0] - 2026-04-03

### 新增

- 增加自动化回归测试，覆盖 Unicode 查询分析、索引/搜索过滤、metadata 返回模式与文件片段安全边界。

### 改进

- 查询分析现在保留 Unicode / 中文 token，提升自然语言检索可用性。
- 源码解码优先保留有效 UTF-8，避免包含中文的源码在索引时被误判编码。
- `get_file_snippet` 与 `project_stats` 统一项目根路径规范化，并阻止片段读取越出项目根目录。
- `search_context` 在 `auto` 模式下遇到明显的复合代码标识符查询时，会跳过高开销的 semantic 分支，避免大仓库混合查询触发 MCP 请求超时。

## [2.0.0] - 2026-03-23

### 新增

- `search_context` 支持 `includeContextLines`，可按命中位置展开上下文代码片段。
- `search_context` 支持 `languages` 与 `pathPrefix` 过滤条件。
- 搜索结果新增紧凑的 `explanation` 字段，用于解释命中来源、token 覆盖、路径/符号匹配类型。
- Web 调试面板支持上下文行、语言和路径前缀过滤调试。

### 改进

- 索引流程升级为文件级容错，单文件失败不再中断整次索引。
- `index_project`、`search_context`、`project_stats` 现在都会暴露索引失败诊断摘要。
- 搜索排序加入查询感知重排，优化精确路径、符号名、文件名和多信号重合结果的排序质量。
- `get_file_snippet` 行区间处理增加边界裁剪，减少越界片段问题。

### 保持能力

- 本地项目扫描与 `.gitignore` 过滤。
- 增量索引。
- `SQLite + FTS5` 全文检索。
- 轻量符号抽取。
- MCP 标准协议接入与可选 Web 调试面板。

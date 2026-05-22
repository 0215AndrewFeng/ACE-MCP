# Changelog

本项目的重要版本变更记录如下。

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

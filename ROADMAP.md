# ace-mcp 路线图

按优先级排序（✅ = 已完成）：

## P0 — 正确性/高影响

1. ✅ **QA 缓存一致性**：缓存键加入文件内容 hash，避免代码变更后返回旧答案；提供手动清除 API（v4.5.2）
2. ✅ **索引健康监控**：`/health` 端点暴露 in-flight 索引列表和耗时（v4.5.2）
3. ✅ **符号解析消歧**：resolveRows 排序新增同文件/同模块优先排序键（v4.5.4）
4. ✅ **Java Lambda/方法引用**：新增 METHOD_REF_PATTERN 和 LAMBDA_PATTERN，方法引用和 Lambda 内调用可被调用链追踪（v4.5.5）
5. ✅ **HNSW searchLayer 用 Array.sort 替代 heap**：实现 MinHeap/MaxHeap 替代，搜索复杂度从 O(ef·n·log n) 降至 O(ef·log n)（v4.5.3）
6. ✅ **N+1 关联子查询 → CTE**：getFilePreviewResults/searchByPath 用 CTE + LEFT JOIN 替代 3N 次子查询（v4.5.3）
7. ✅ **增量索引 vector 缓存全量清空**：`reconcileVectorCacheAfterIndex` 只失效受影响文件的向量并同步 `index_version`，避免改几个文件就全量重载 10 万向量；HNSW 标记 stale 后按需异步重建（v4.5.7）
8. ✅ **v4.10.8 watcher 资源止血**：默认最多 8 个 root-only watcher，其余项目使用 periodic-only reconciliation；创建/runtime `EMFILE` 具备 single-flight、退避、重试上限和全局熔断，49 项目 soak 的 FD 维持低位且无重试风暴。
9. ✅ **v4.10.8 maintenance lease 活性**：lease 控制独立于 bulk SQLite worker，并在持久化阶段间按剩余 TTL 主动续租和 fencing；真实长事务及 49 项目 soak 均未出现 expiry、foreign-owner 误报或 lease loss。
10. ✅ **v4.10.8 启动维护队列限流**：startup/periodic 自动维护有界串行排队，显式索引优先获取全局 slot；真实 49 项目 startup 在约 4 分 36 秒内完成 49/49。
11. ✅ **v4.10.8 搜索并发执行模型收口**：候选策略合并为一次 bounded worker 请求，默认 2-reader pool 提供 pending cap、总 deadline、in-flight 复用、生命周期隔离和显式 503 overload/timeout。
12. ✅ **v4.10.8 搜索并发验收门禁**：真实 8/16/32 idle 与 during-index 基准均满足 5 秒 p95/p99 门槛，timeout/error 为 0、结果非空且稳定，并已纳入 `release:benchmark` fail-closed 契约。

## P1 — 性能/体验

8. ✅ **vectorCache 内存控制**：HNSW 可用时释放 vectors 数组，暴力搜索时从 SQLite 懒加载（v4.5.4）
9. ✅ **HNSW 二进制序列化**：JSON 替换为紧凑二进制格式（Float32 + 变长 ID），体积缩小约 5 倍；向后兼容旧 JSON 格式（v4.5.5）
10. ✅ **better-sqlite3 阻塞事件循环**：普通/结构化搜索中的 lexical、semantic FTS、unicode substring、symbol、path 与文件预览读取移到 SQLite 搜索 worker；dist 用 `worker_thread`，源码/dev/test 用 `node --import tsx` IPC 子进程；新增事件循环响应性回归测试（v4.7.0）
11. ✅ **搜索 benchmark + SQLite 锁等待稳定性**：新增 `benchmark:search`/`release:benchmark` 输出 search/health p95 与事件循环响应性；SQLite worker 连接构造阶段应用 WAL 与 `busy_timeout=30000`，降低并发索引/搜索锁冲突（v4.7.1）
12. ✅ **Health 不等待 SQLite 深度统计**：`/health` 使用轻量项目列表与 in-flight 状态，不再逐项目读取 `getProjectStats`，后台索引时保持健康检查可响应（v4.7.2）
13. ✅ **索引去重状态可见**：同项目重复索引请求复用 in-flight Promise，并在 `/health` 暴露 `status`、`queuedRequests`、`dedupedRequests`；修复 timeout timer 与 cleanup unhandled rejection（v4.7.3）
14. ✅ **symbol_usage 组合索引**：添加双列组合索引加速 findCallGraph/findResolvedReferences（v4.5.3）
15. ✅ **HNSW 构建不阻塞**：addBatchAsync 每 500 节点 await setImmediate 让出事件循环（v4.5.6）
16. ✅ **多源分数归一化**：mergeResults 合并前对每个源 min-max 归一化至 [0,1]，消除量级差异（v4.5.5）
17. ✅ **searchBySymbols 按匹配度打分**：当前按行号位置递减打分，应改为符号名精确/模糊匹配度（v4.5.3 identifier boost 过滤修复）
18. ✅ **QA call chain 上下文扩展**：上下文从 ±5 行提升到 ±15 行（v4.5.3）
19. ✅ **JS 跨文件类型传播**：`export const foo = new Bar()` 被其他文件 `import { foo }` 后，`foo.method()` 可解析到 `Bar.method`；内部导出值类型候选仅由 JS/TS adapter 产生并只在 JavaScript import alias 解析中消费，其他语言查询路径不变（v4.7.4）
20. ✅ **空 catch 加日志**：qaPipeline/app/searchContext/indexCoordinator 空 catch 改为 debug/warn 日志（v4.5.3）
21. ✅ **大文件拆分**：`sqliteStore.ts`（2879→2004，抽出 `VectorCacheStore`/types/helpers）、`app.ts`（1532→50，路由拆到 `web/routes/*`）、`searchService.ts`（1765→1073，纯函数拆到 `searchScoring.ts`/`searchHelpers.ts`），公共 API 与测试不变（v4.5.8）

## P2 — 中等优化

19. ✅ **FTS 删除批量化**：WHERE IN 批量删除替代逐条 DELETE（v4.5.4）
20. ✅ **readFileSnippet LRU 缓存**：200 条上限 + mtime 失效（v4.5.4）
21. ✅ **symbol full_name 函数索引**：添加 `idx_symbol_full_name_lower ON symbol(LOWER(full_name))`（v4.5.6）
22. ✅ **callChain 同层并行**：extractCallEntriesWithDepth 已用 Promise.all + .map 并行处理同层 entries（v4.5.4）
23. ✅ **scoreMergedResult 缓存**：实为行为修复——打分被重复执行且写回，碰撞结果 bonus 累加 3 次、无碰撞 2 次，排序被路径依赖扭曲。`choosePreferredResult` 改为仅比较不写回、`rerankResults` 删除二次打分，`dedupeSameFileResults` per-file 排序成为唯一打分点（v4.5.15）
24. ✅ **searchByPath 按文件名匹配度排序**：多取候选后按 basename 匹配度（去扩展名精确>精确>前缀>包含>仅目录，同档按路径长度）JS 重排再截断，评分逻辑不变（v4.5.10）
25. ✅ **CJK 单字 token 搜索**：修复 isSymbolLike 误判纯 CJK 单 token 导致 semantic-fts 被关闭（v4.5.6）
26. ✅ **identifier boost 过滤修复**：二次搜索传 `{}` 绕过语言/路径过滤，已改为传 normalizedFilters（v4.5.3）
27. ✅ **Markdown 符号提取**：提取标题为 section 符号、代码块标识符为 usage；文档标题可走 symbol/definition 检索，fenced code 示例中的标识符可解析为代码定义的 references（v4.7.5）
28. ✅ **.vue/.svelte 单文件组件**：提取 `<script>` / `<script setup>` 块内容用 TS/JS 解析器分析，保留原始 SFC 行号并参与 JS/TS 调用图解析（v4.7.6）
29. ✅ **Vue/Svelte 模板引用提取**：提取 Vue template 和 Svelte markup 中的组件标签、事件/绑定/插值表达式标识符为 ownerless usage，提升 `find_references` 和 RAG 召回且不污染调用图 caller（v4.7.7）
30. ✅ **片段/上下文最大化快捷入口**：`includeContextLines` 共享上限 50→200；Web 搜索上下文、文件片段范围、QA 参考代码数量和 `maxContextTokens` 都提供“最大”按钮，减少大接口/长文件漏代码风险（v4.7.8）
31. ✅ **Vue Options API 符号提取**：真实 Vue 2 项目 `tc-flight-endorse-mng` 暴露出 `export default { methods/computed/watch }` 内方法不一定建成 symbol 的缺口；现提取 `methods` / `computed` / `watch` / 常见生命周期函数为组件内 method 符号，模板 usage 可解析回 `EndorseLookup.search`、`Navbar.changeLanguage` 等定义，并保持 ownerless 不污染 caller（v4.7.9）
32. ✅ **Vue Options API 状态字段提取**：提取 `props` object/array 形式和 `data()` 返回对象字段为组件内 property 符号，模板 usage 可解析回 `Navbar.currentLang`、`Pagination.total`、`Pagination.hidden` 等定义，并保持 ownerless 不污染 caller（v4.7.10）
33. ✅ **更大代码片段与高级选项最大值补齐**：`includeContextLines` 共享上限 200→500；Web 搜索结果数量、上下文行数、文件片段范围、QA 参考代码数量、上下文预算、LLM 最大输出、超时时间和失败重试次数都提供“最大”按钮（v4.7.11）
34. ✅ **Web 运行状态与请求参数可见性**：Web 页头展示 `/health` 的版本/watch/项目/最近索引状态；bounded numeric 高级选项显示当前/最大值；QA 完成后回显后端实际 clamp 后的请求参数（v4.7.12）
35. ✅ **Java 注解入口与接口实现召回**：提取 Spring mapping 注解 path，类级/方法级路径合并为完整接口入口；Java 字段类型参与方法调用解析，接口方法查询可带出实现类方法和上游 Controller 调用（v4.8.1）
36. ✅ **长任务可观测与维护脚本**：`/health` 暴露摘要生成长任务，Web full index 对聚合父目录要求确认，新增 `maintenance:reindex` 逐项目 full index + 可选摘要生成脚本（v4.8.2）
37. ✅ **摘要长任务异步化**：`POST /api/summary/generate` 快速返回 `202 + taskId`，新增 `/api/tasks` 查询成功/失败/耗时/结果，Web 和维护脚本改为提交后轮询完成（v4.8.3）
38. ✅ **索引任务异步化与统一任务中心**：`POST /api/index-project` 快速返回 `202 + taskId`，`/api/tasks` 统一查询 index/summary 任务，Web 和维护脚本都改为轮询任务完成（v4.8.4）
39. ✅ **Web 任务中心**：右侧任务中心展示最近 index/summary 任务，支持按类型、状态和当前项目过滤，成功/失败任务可展开查看结果或错误（v4.8.5）
40. ✅ **任务去重与取消**：active task 支持按 key 复用，新增 `canceled` 状态和 `POST /api/tasks/:id/cancel`，任务中心可取消 running task（v4.8.6）
41. ✅ **macOS 一键安装**：新增 `scripts/install-macos.sh` 和 README 依赖需求清单，一条命令完成 Release tgz 下载、全局安装和 doctor 自检（v4.8.7）
42. ✅ **安装发布闭环**：README macOS installer 使用 tag 固定来源，新增 `release:verify-assets` 校验 Gitee tag、tgz、Windows zip 和 installer 下载链路（v4.8.8）
43. ✅ **Gitee Release 自动发布**：新增 `release:publish`，通过 Gitee OpenAPI 创建/更新 Release、替换上传 tgz/Windows zip 附件并自动验证下载链路（v4.8.9）
44. ✅ **Release 防泄漏检查**：新增 `security:secrets` 扫描环境变量 token 是否出现在项目文件、tgz/Windows zip 产物或 git history 中，并接入 `release:check`（v4.8.10）
45. ✅ **项目级搜索画像**：新增 `/api/project-profile` 和 Web“搜索画像”入口，汇总文件/代码块/符号/语言/摘要/向量覆盖，并给出索引、摘要、向量、符号和失败文件诊断建议（v4.9.1）
46. ✅ **画像一键修复**：搜索画像诊断建议可直接触发全量索引、摘要生成、向量预热或失败文件查看，任务完成后自动刷新任务中心和画像（v4.9.2）
47. ✅ **画像修复结果可见化**：一键修复完成后展示任务状态、耗时、画像前后差异；失败文件查看改为明细面板，显示路径/错误并支持复制路径（v4.9.3）
48. ✅ **搜索结果命中解释**：Web 搜索结果摘要区和问答来源卡片展示 `reason`、`score`、命中来源、关键词覆盖、路径/符号/片段命中，说明“为什么命中”（v4.9.4）
49. ✅ **搜索结果可操作化**：Web 搜索结果和 QA 来源卡片可复制文件路径、`path:line` 引用和代码片段，搜索摘要支持展开/收起所有命中解释（v4.9.5）
50. ✅ **懒加载上下文预览**：Web 搜索结果和 QA 来源卡片可按需加载命中行前后代码上下文；metadata 模式不带 snippet 时也能通过 `/api/file-snippet` 继续定位源码，默认搜索响应体积不变（v4.9.6）
51. ✅ **IDE / Agent 定位闭环**：Web 搜索结果和 QA 来源卡片可复制绝对路径、打开 VS Code/IDEA，并复制 Codex/Claude 交接提示词；不直接执行本机 agent CLI（v4.9.7）
52. ✅ **结果上下文打包**：Web 搜索结果和 QA 来源卡片可多选后复制 Markdown 上下文包，包含项目根目录、绝对路径、引用、片段、命中原因和分数，便于多文件交接给 Codex/Claude（v4.9.8）
53. ✅ **上下文包任务草稿**：Web 上下文包工具栏新增任务说明输入框和“解释这段逻辑 / 找潜在 bug / 生成修改方案 / 补测试”预设，复制给 Codex/Claude 的 Markdown 顶部带上明确任务意图（v4.9.9）
54. ✅ **Web 查询/任务模板**：Web 搜索和智能问答输入框新增“查调用链 / 查影响面 / 找潜在 bug / 补单元测试 / 梳理业务流程”模板按钮，点击只填充对应输入框并聚焦，不改变后端请求语义（v4.9.10）
55. ✅ **运行时数据健康诊断**：`/health` 和项目画像暴露 `dataHealth`，识别 DB/项目列表读取失败、注册项目路径丢失、项目画像统计/向量/文件读取失败等 degraded/repairable 状态，并给出全量索引、检查路径或清理重建的修复建议（v4.9.11）
56. ✅ **Web API 验证统一**：新增 `core/validation/schemas.ts` 单一来源，MCP 工具与 Web 路由共用枚举/边界/默认值；Web 宽松解析（coerce+clamp）仅必填缺失时 400（v4.5.9）
57. ✅ **JSON.parse 防护**：新增 `safeJsonParse` 工具，套用到 sqliteStore 读 DB 列的 6 处，损坏降级为空值 + warn 日志而非崩溃（v4.5.8）
58. ✅ **日志格式统一**：RemoteEmbedding 用 console.warn 替代 logger（v4.5.10）
59. ✅ **关键路径测试覆盖**：测试 33→97，新增 9 个测试文件覆盖 safeJsonParse、搜索打分/工具纯函数、QaCache、共享/宽松校验、VectorCacheStore reconcile、deleteFiles 级联、源码解码助手（v4.5.9）

## P3 — 长线

33. **Go/Rust/Kotlin/Swift 适配器**：正则解析即可覆盖基本符号提取
34. ✅ **cosineSimilarity 统一**：实际剩 2 处重复（v4.5.8 拆分时已消一处），vectorCacheStore 私有实现删除、统一引用 embedding.ts 导出版（v4.6.0）
35. ✅ **cache eviction 优化**：remoteEmbedding/searchService 两处超量裁剪由全量收集 + O(n log n) 排序改为利用 Map 插入序——前者头部 TTL 扫描 + FIFO 裁剪，后者跨项目 k 路头比较；qaCache/queryExpander 本就是 FIFO（v4.6.0）
36. **Python 前向引用类型**：提取 `"TypeName"` 形式的字符串类型注解
37. ✅ **CJK 语义 FTS 词数**：`buildSemanticFtsQuery` 截断改为 CJK 感知——含 CJK 词上限 15（配合 v4.5.13 bigram 分词），纯 ASCII 维持 8；中文查询 semantic 候选 15→18（v4.5.15）
38. ✅ **Error/AppError 统一**：llmClient（未配置/API 错/空响应/超时）与 summaryGenerator（未配置/未索引）六处裸 Error 改 AppError，Web 出口按 statusCode/code 返回而非一律 500；CLI/autostart/HNSW 内部错误维持原状（v4.6.0）
39. ✅ **SSE 连接超时**：实际缺口为「断连未中止上游」——超时与断连检测此前已存在，但断连后 streamComplete 的 fetch 未 abort、上游 LLM 继续生成。现 `res.on("close")` 触发 AbortController 接入 `options.signal`，并在 LLM 阶段前断连早退（v4.6.0）
40. **Qdrant 条件式评估**：仅在搜索并发模型、调度隔离和可重复基准完成后开展 SQLite/HNSW 与 Qdrant 对照；以大规模向量、过滤 ANN、8/16/32 并发 p95/p99、吞吐、索引/重建成本、资源占用、部署与故障恢复复杂度为准入依据。若达到预设收益门槛，采用 SQLite 保留项目/文件/FTS5/符号/调用图、Qdrant 仅承载向量与过滤 payload 的混合架构，并提供双写一致性、全量重建、灰度切换和一键回退路径。

## QA 问答（召回质量 / 性能）

40. ✅ **QA 上游使用方（caller）扩展**：对 QA top 结果符号查 `findCallers`，把使用方业务逻辑类拉进问答上下文，对称补齐 v4.4.8 的下游（callee）扩展。解决「X 场景有什么特殊处理」类问题只召回 model/enum 定义、漏掉真正业务逻辑类的问题（v4.5.11）
41. ✅ **放开参考代码量**：默认上下文预算 24000→48000、`qaMaxSourcesDefault` 10→15；新增按请求 `maxContextTokens` 覆盖 + 上限 `qaMaxContextTokensMax`（默认 200000）钳制，大接口可带更完整代码（v4.5.12）
42. ✅ **QA 性能**：分三步收尾——① `ensureSemanticIndex` O(n²) JOIN 已修（122s→1.2s，v4.5.13），中文搜索端到端 ~64s→~1.8s；② 「queryExpansion 8s 超时失效」经 v4.5.13 后重测确认为**误判**（旧测量与慢搜索共用 Promise.all 计时，现 expansion 仅 ~291ms，abort 机制正常）；③ `ask_codebase` 硬编码强制开 reranker 已对齐为回落配置默认 + 可选参数覆盖（v4.5.14）。**剩余耗时主体（llmMs ~117s）为 LLM 端点生成速度本身**（慢端点 × 长输出 × 大上下文），属配置/选型而非代码项：建议换更快模型，或按需调低 `llmMaxTokens`/`maxSources`/`maxContextTokens`
43. ✅ **中文查询分词**：`queryAnalyzer` 新增 `segmentCjkTokens`，复用 `buildCjkBigrams` 把 CJK 连续串切成 bigram（整串保留 + 追加 bigram，上界 16），消除「整句被当成单个 14 字 token」的退化切词；纯查询侧、不需重索引（v4.5.13）
44. ✅ **语义索引存在性检查性能**：`ensureSemanticIndex` 的 `LEFT JOIN` FTS5 未索引列改为 `NOT IN` 单次扫描，O(n²)→O(n)，每次语义查询白跑的 ~122s 降到 ~1.2s（v4.5.13）

## 体验 / 工程化

45. ✅ **QA 答案业务流程图**：问答涉及业务流程/处理逻辑时，答案末尾自动追加 Mermaid `flowchart TD`，把关键步骤/判断可视化。一处 `QA_SYSTEM_PROMPT` 覆盖 MCP/Web/SSE；前端 `renderMarkdown` 先抽取 ```` ```mermaid ```` 块再走其余变换、流式结束后 `mermaid.run()` 渲染、失败回退（v4.6.1）
46. ✅ **自动化质量防线（`--eval`）**：新增 `--eval <caseFile>` CLI + `npm run eval`，加载 JSON golden 用例跑 `evaluateSearchQuality`，按 `minPassRate`（默认 1.0）以退出码 0/1 判定，发版前可回归。真实业务用例放 gitignore 的 `eval-cases/`，仓库仅提交脱敏模板（v4.6.1）
47. ✅ **流程图/调用链图导出**：渲染后的 Mermaid 图加导出工具栏——下载 PNG（SVG→canvas 光栅化、白底、×2 清晰度）、下载 SVG（矢量）、复制 Mermaid 源码（剪贴板，含 `execCommand` 回退）。文件名清洗非法字符、调用链容器复用时替换旧工具栏防源码过期。纯前端（v4.6.2）；PNG 失败修复——`flowchart:{htmlLabels:false}` 消除 foreignObject 导致的 canvas 污染 + data URL 加载（v4.6.3）
48. ✅ **冷启动暖机（`--warm`）**：新增 `--warm` CLI 标志，服务启动后异步暖机已索引项目——从 DB 恢复 `ensureFreshIndex` 内存状态跳过已知最新项目、预加载向量缓存 + 异步 HNSW 构建、确保 semantic FTS 完整——首次查询延迟从 18-22s 降至 <2s；暖机不阻塞 MCP/Web 可用性（v4.6.4）；暖机元数据失真修复——恢复缓存改为铺展真实 `latestIndexEvent`，暖机窗口内 `vectorIndex`/`timings`/计数不再误报为禁用/零值（v4.6.5）
49. ✅ **质量防线补齐**：补齐 `npm test` 引用但仓库缺失的 17 个测试文件，覆盖 CLI、查询分析、索引/搜索工作流、Web、SQLite/VectorCache、搜索纯函数、QA 缓存、校验、源码解码、IndexCoordinator 与 evalRunner；测试暴露并修复中文复杂问题 source 估算与 GBK 中文解码评分问题（v4.6.6）
50. ✅ **npm/tgz 全局安装 + Windows 启动脚本**：包改为可发布，新增 `ace-mcp-web` 全局命令、`release:pack`、`scripts/start-web.{mjs,cmd,ps1}`，README 补充 npm/tgz 全局安装与 Windows MCP 配置（v4.6.7）
51. ✅ **Windows zip 安装包 + 发布清单**：新增 `release:win` 与 `scripts/package-windows.mjs` 生成 `ace-mcp-v4.6.8-win-x64.zip`，补 `install-windows.{cmd,ps1}`、`scripts/README-WINDOWS.md`、`docs/release-checklist.md` 与发布契约测试（v4.6.8）
52. ✅ **安装自检 + 发布 smoke test**：新增 `--doctor` 检查 Node/npm、better-sqlite3、SQLite FTS5、目录写权限、Web 端口与 LLM/Embedding 配置；新增 `release:smoke` 临时安装 tgz 并验证 `ace-mcp --version`、`--doctor`、`ace-mcp-web` 与 `/health`；Windows zip 安装后自动运行 doctor（v4.6.9）
53. **Web 最近任务历史 / 草稿恢复**：记录搜索与问答最近历史，保留项目路径、输入、结果数、耗时和实际高级参数；支持一键回填/重跑，以及按项目隔离的输入草稿自动恢复。
54. ✅ **Windows 自包含绿色包**：ZIP 内置 Node.js 22、生产依赖和 `better-sqlite3` 原生二进制，提供无需 Node/npm/VS Build Tools 的 CLI、MCP、Web 与 doctor 入口；发布 smoke 在无 Node/npm PATH 下验证完整启动链路（v4.10.1）
55. ✅ **可靠的多项目自动索引**：每项目 watcher、debounce/max-wait、generation 追赶、全局并发限制、启动 catch-up 和周期校准协同工作；Web/守护进程是唯一自动维护 owner，stdio MCP 仅按请求索引（v4.10.1）
56. ✅ **项目删除 API**：删除已注册项目时等待活动索引、停止 watcher、抑制后台复活并清理搜索缓存，Web 项目管理使用同一后端闭环（v4.10.1）
57. ✅ **自动项目路由**：新增全局有界候选召回与 `resolve_projects`，按问题关键词返回 single/multiple/abstain、置信度和证据；Web 默认自动识别项目，手动路径继续作为显式覆盖，并以独立 golden 指标验证路由质量（v4.10.2）
58. ✅ **父子项目自动维护 ownership**：自动维护跳过拥有两个及以上已登记后代项目的聚合父目录，由具体子项目各自 watcher/catch-up/reconciliation；删除项目后立即刷新 ownership，单调 sequence 防止旧刷新快照回滚新拓扑；单一嵌套子项目和显式索引保持兼容（v4.10.3）
59. ✅ **Git clean fast path**：可靠 clean Git 项目的 periodic reconciliation 在 HEAD 未变化、watcher 干净且无失败/在途任务时跳过 source collection，任何不可靠状态保守回退（v4.10.3）
60. ✅ **独立索引 worker**：索引侧 SQLite 写入、删除、向量、symbol graph 和 semantic 操作移出 Web 主事件循环，源码 IPC 与 dist worker thread 使用独立生命周期和错误隔离（v4.10.3）
61. ✅ **索引调度与响应性诊断**：解析 batch 主动 yield；`/health` 展示 active/queued phase、origin、进度、queue/phase elapsed，完成事件记录 prepare/parse/write/vector/symbolGraph/semantic/finalize 等耗时（v4.10.3）
62. ✅ **during-index 响应性门禁**：benchmark 必须观察到 active indexing，只在活动窗口采集至少 20 个 health/resolve 样本，并按 p95 和超时阈值失败（v4.10.3）
63. ✅ **项目路由公平性与证据边界**：FTS 按项目窗口配额召回，重复证据边际递减；SQLite 显式返回 `matchedTerms`，并限制 query、terms、identifiers、候选证据和匹配文本大小，避免大项目规模偏置及 snippet/substring 覆盖误判（v4.10.3）
64. ✅ **SQLite search worker 生命周期隔离**：pending request 绑定 worker identity，close 幂等并跟踪 live/terminating worker，旧 generation 的迟到 error/exit 不再影响替代 worker（v4.10.3）
65. ✅ **混合业务词项目归属**：保留 `A转D` 等 ASCII/CJK 混合概念，过滤路由停用词，并用精确证据 + 仓库名锚点 + 有证据的同族兄弟召回修复复制枚举/测试夹具误路由（v4.10.4）
66. ✅ **有界且异常安全的日志**：文件等级过滤、20 MiB × 3 归档轮转、跨进程原子锁、EPIPE/磁盘/metadata 失败隔离，以及守护进程重复 stderr 抑制（v4.10.4）
67. ✅ **Git dirty 重复索引修复**：Git dirty/untracked 路径不再被直接判定为必须重建，而是继续经过已有文件指纹校验；长期未提交工作区不会在每次 periodic reconciliation 中重复索引未变化文件（v4.10.5）
68. ✅ **跨进程索引写入协调**：Web startup/periodic catch-up 和 watcher 自动索引持有可续租 maintenance lease；stdio freshness 在有效 lease 期间直接复用最后成功索引，owner 崩溃或 lease 过期后自动恢复按需索引（v4.10.6）
69. ✅ **Codex 沙箱初始化闭环**：新增 `ace-mcp-configure-codex` 原子合并 `~/.ace-mcp` 到 `[sandbox_workspace_write].writable_roots`；macOS 一键安装检测到 Codex 后自动配置，避免 SQLite 数据库因沙箱目录未授权而只读（v4.10.7）
70. ✅ **摘要辅助项目路由**：复用现有项目摘要的 architecture、模块描述、模块路径和 keySymbols 作为有界附加证据，按 mtime 缓存刷新；摘要缺失或损坏时继续使用代码/符号证据并保持 abstain 边界（v4.10.9）

## v4.10.8 运行时稳定性、搜索并发与启动调度

Owner: feng.ling

目标：先消除 watcher/lease 后台风暴，再完成搜索并发和 50 项目启动调度隔离，确保下个版本的并发提升建立在稳定运行时上。Qdrant 不属于本版本交付范围，仅在本版本完成后按 P3 准入条件评估。

### Phase 0 - RED 基线与验收契约（工具与 idle/active 数据完成，warm/cold 标注待补）

- **实施**：复用 `scripts/benchmark-search.mjs` 的请求、percentile、active-index 观察和 JSON 输出模式，新增真实并发搜索场景；从 `/health` 和 worker 客户端补齐 active/pending/queueMs，不先改执行模型。
- **参考**：`scripts/benchmark-search.mjs`、`src/test/benchmarkSearchCli.test.mjs`、`src/core/search/searchServiceConcurrency.test.ts`、`src/core/storage/sqliteSearchWorkerClient.ts`。
- **验证**：在小型仓库和生产量级 SQLite 副本上分别采集 warm/cold、idle/active-index、1/8/16/32 并发；每档必须有足够样本、非空结果和稳定结果集合，并记录 CPU、RSS、DB/WAL 大小与超时。
- **禁止**：不把当前 `--concurrency` 的 health probe 数量误当成搜索并发；不凭单次 28 秒样本设定性能目标；基线采集不得成为推迟 Phase 1-3 的理由。

### Phase 1 - 合并候选请求与有限 worker pool（P0，完成）

- **实施**：沿用 `SQLiteSearchWorkerProtocol` 的 discriminated union 和 `handleRequest` dispatch 模式，新增一次返回 lexical/semantic/unicode/symbol/path 分组结果的 bounded request；随后复用现有 worker identity/generation/close/idle 模式扩展为有限池，增加确定性负载分配、pending cap、排队 deadline、同 key in-flight 合并和显式 overload 错误。将 `ensureSemanticIndex` 补写移出 search reader pool，把 pool close 接入生产 shutdown；definition/reference/call graph 等仍在主线程同步读 SQLite 的路径必须纳入同轮基准，迁移到有界 worker 执行或以明确门禁证明不构成阻塞。默认 pool 大小从 2 个 reader 起测，以 1/2/4 worker 实测确定最终默认值。
- **参考**：`src/core/search/searchService.ts` 的五路候选召回，`src/core/storage/sqliteSearchWorkerProtocol.ts`、`sqliteSearchWorkerClient.ts`、`sqliteSearchWorker.ts` 的现有 IPC 契约。
- **验证**：增加协议边界、过滤透传、策略失败隔离和结果等价测试；覆盖 pool 全关闭、生产 shutdown、单 worker 崩溃替换、迟到响应隔离、队列满、同 key 冷并发合并、并发公平性，以及超时请求不继续形成 queue debt；证明 search reader 不执行 semantic FTS 写入，结构化搜索不会阻塞主事件循环。
- **禁止**：不把五类结果提前混成不可解释的单列表；不改变打分或过滤语义换性能；不建立无界 worker/连接池；不把 semantic FTS 写操作放入并行 reader；不因每个 `SQLiteStore` 自带 vector cache 而重复加载向量，ANN 仍留在原主进程路径。

### Phase 2 - watcher FD 资源与失败恢复（P0，完成）

- **实施**：为 watcher 创建/runtime `EMFILE` 增加 per-project 单一恢复任务、指数退避+jitter、重试上限和全局熔断；失败期间依赖 periodic reconciliation 保证最终一致性，不再为每次 watcher 重建先执行一次增量索引。选择并验证有界 watcher 策略，避免对 `.git`、`node_modules`、`target`、`dist` 等无关目录分配递归监听资源；补充 FD 预算诊断，并把 macOS 服务的文件描述符软限制提升作为安装/运行时缓解措施。
- **参考**：`src/core/indexing/indexCoordinator.ts` 的 `defaultWatchFactory`、`startWatching`、`recoverFailedWatcher`、现有 watch-triggered index backoff，以及 `startAutomaticUpdates` 的 periodic reconciliation fallback。
- **验证**：严格 TDD 覆盖同步创建失败与异步连续 `EMFILE`；证明不会热循环、不会因 watcher 重试反复索引、同项目只有一个恢复任务、stop/close 清理计时器、熔断后 periodic reconciliation 仍工作，且资源恢复后可重新监听。用至少 50 个登记项目做 macOS FD/CPU/日志速率验收。
- **禁止**：不只提高 `ulimit` 掩盖无界恢复；不向 Node `fs.watch` 发明不存在的 ignore 参数；不把失败重试绑定到一次完整索引；不丢失 null filename、rename 和 Git/project control-file 变更的最终一致性。

### Phase 3 - maintenance lease 活性与真实状态（P0，完成）

- **实施**：让 lease acquisition/renewal 不再排在 bulk index write 的无界 FIFO 后方，并约束单次写 batch/事务占用；定义 foreign-owner busy、same-owner expired/lost、renewal failure 的独立状态与安全重获/fencing 规则，在 `/health` 暴露 owner、expiry、renewal 和 lost 原因。lease 失效后停止新的 automatic work，避免 stdio freshness 立即形成竞争写入反馈环。
- **参考**：`src/core/indexing/indexCoordinator.ts` 的 `startAutomaticMaintenanceLeaseHeartbeat`、`enter/exitAutomaticMaintenanceLease`、`withAutomaticMaintenanceLease`，`src/core/storage/sqliteStore.ts` 的 lease CAS，以及 `SQLiteIndexWorkerClient` 请求队列。
- **验证**：严格 TDD 覆盖超过 TTL 的 worker 排队、真实 SQLite 写锁/长 batch、same-owner expiry、foreign owner、owner 崩溃和 shutdown；证明续租或安全停止在门限内发生，状态文案真实，owner 恢复后无双写。仅拆独立 worker 不算通过，必须用真实锁竞争测试证明设计有效。
- **禁止**：不靠放大 TTL 隐藏心跳饥饿；不把本进程 lease 过期继续映射为 `Another process owns...`；不允许失效 owner 继续批量提交 automatic work；不以破坏跨进程单写者约束换取恢复速度。

### Phase 4 - 50 项目启动队列限流（P0，完成）

- **实施**：保留现有 per-project serialize/dedupe、`indexConcurrency`、watch generation 和 maintenance lease，给 search/resolve/health 及 explicit/freshness 更高服务优先级；约 50 项目的 startup catch-up 和后续 periodic/watcher 使用有界低优先队列、分批提交、资源预算与背压，并暴露 active/pending/queueMs、合并、等待和退避指标。
- **参考**：`src/core/indexing/indexCoordinator.ts` 的 `withGlobalIndexSlot`、`projectQueue`、`reconcileWatchedProjects`、watcher follow-up 和 lease 实现，以及对应 coordinator tests。
- **验证**：用至少 50 个登记项目复现启动 catch-up；证明后台队列饱和时 search/resolve/health 仍满足门槛，显式索引不会被长期饿死，周期任务保持 coalescing，单项目不会并发写，owner 失效后仍能恢复。
- **禁止**：不重复实现已有的启动串行和全局索引并发限制；不破坏跨进程单一 maintenance owner；不以无限提高 `indexConcurrency` 缩短 catch-up。

### Phase 5 - 8/16/32 并发与 during-index 门禁（P0，完成）

- **实施**：将真实 8/16/32 并发搜索和 50 项目 startup/active-index 场景固化为 benchmark CLI 与测试契约；记录 search p50/p95/p99、吞吐、queueMs、timeout/error、结果稳定性，以及 health/resolve p95 和相对 idle 的退化比例，在实测后固化明确阈值。
- **参考**：`scripts/benchmark-search.mjs` 的 during-index 样本门禁、`src/test/benchmarkSearchCli.test.mjs` 的失败契约、`package.json` 的 `release:benchmark`/`release:check`。
- **验证**：先证明 watcher 无重试风暴且 lease 无丢失，再补齐生产规模 Phase 0 基线；三个并发档位和 during-index 场景都必须使用足量非空、稳定结果样本并满足门槛。完整运行 focused tests、`npm test`、`npm run build` 和 `git diff --check`。门禁必须能对超阈值、超时、空结果、lease loss、watcher 热循环和未观察到 active indexing 返回非零退出码。
- **禁止**：不只测 health/resolve，不用单样本或空结果判定通过，不把环境差异隐藏在汇总数字里；任一并发档位未通过，v4.10.8 不标记完成。

### 后续 - Qdrant ADR 与可回退 PoC（P3，条件触发）

- **准入条件**：Phase 1-3 已完成，且向量搜索在目标规模/过滤场景中成为主要延迟或吞吐瓶颈；先根据 Qdrant 官方文档锁定部署模式、Node client 版本和实际 API，写 ADR 后再实现。
- **实施**：SQLite 继续作为项目、文件、chunk 文本、FTS5、符号和调用图的事实源；Qdrant point 使用稳定 `chunkId`，payload 只承载 project/model/path/language/indexVersion 等过滤与一致性字段。PoC 必须支持 feature flag、SQLite/HNSW 基线、可重放全量重建、校验式双写和快速回退。
- **验证**：用相同语料、embedding、query 和过滤条件做质量等价与 1/8/16/32 并发对照；测 p95/p99、吞吐、索引/增量更新/重建时间、磁盘/RSS/CPU、故障注入和恢复时间，并把运维成本计入决策。
- **禁止**：不让 Qdrant 取代 FTS5、符号或调用图；不在请求链做无法恢复的非原子双写；不假设客户端 API、过滤语法或一致性级别，必须以选定版本官方文档为准。

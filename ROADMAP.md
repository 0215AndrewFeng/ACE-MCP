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

## P1 — 性能/体验

8. ✅ **vectorCache 内存控制**：HNSW 可用时释放 vectors 数组，暴力搜索时从 SQLite 懒加载（v4.5.4）
9. ✅ **HNSW 二进制序列化**：JSON 替换为紧凑二进制格式（Float32 + 变长 ID），体积缩小约 5 倍；向后兼容旧 JSON 格式（v4.5.5）
10. **better-sqlite3 阻塞事件循环**：同步查询阻塞所有并发请求，大结果集应移 worker_thread 或分页
11. ✅ **symbol_usage 组合索引**：添加双列组合索引加速 findCallGraph/findResolvedReferences（v4.5.3）
12. ✅ **HNSW 构建不阻塞**：addBatchAsync 每 500 节点 await setImmediate 让出事件循环（v4.5.6）
13. ✅ **多源分数归一化**：mergeResults 合并前对每个源 min-max 归一化至 [0,1]，消除量级差异（v4.5.5）
14. ✅ **searchBySymbols 按匹配度打分**：当前按行号位置递减打分，应改为符号名精确/模糊匹配度（v4.5.3 identifier boost 过滤修复）
15. ✅ **QA call chain 上下文扩展**：上下文从 ±5 行提升到 ±15 行（v4.5.3）
16. **JS 跨文件类型传播**：`foo.method()` 无法解析到 `Bar.method`，import 端缺失 export 端的 variableTypes
17. ✅ **空 catch 加日志**：qaPipeline/app/searchContext/indexCoordinator 空 catch 改为 debug/warn 日志（v4.5.3）
18. ✅ **大文件拆分**：`sqliteStore.ts`（2879→2004，抽出 `VectorCacheStore`/types/helpers）、`app.ts`（1532→50，路由拆到 `web/routes/*`）、`searchService.ts`（1765→1073，纯函数拆到 `searchScoring.ts`/`searchHelpers.ts`），公共 API 与测试不变（v4.5.8）

## P2 — 中等优化

19. ✅ **FTS 删除批量化**：WHERE IN 批量删除替代逐条 DELETE（v4.5.4）
20. ✅ **readFileSnippet LRU 缓存**：200 条上限 + mtime 失效（v4.5.4）
21. ✅ **symbol full_name 函数索引**：添加 `idx_symbol_full_name_lower ON symbol(LOWER(full_name))`（v4.5.6）
22. ✅ **callChain 同层并行**：extractCallEntriesWithDepth 已用 Promise.all + .map 并行处理同层 entries（v4.5.4）
23. ✅ **scoreMergedResult 缓存**：实为行为修复——打分被重复执行且写回，碰撞结果 bonus 累加 3 次、无碰撞 2 次，排序被路径依赖扭曲。`choosePreferredResult` 改为仅比较不写回、`rerankResults` 删除二次打分，`dedupeSameFileResults` per-file 排序成为唯一打分点（v4.5.15）
24. ✅ **searchByPath 按文件名匹配度排序**：多取候选后按 basename 匹配度（去扩展名精确>精确>前缀>包含>仅目录，同档按路径长度）JS 重排再截断，评分逻辑不变（v4.5.10）
25. ✅ **CJK 单字 token 搜索**：修复 isSymbolLike 误判纯 CJK 单 token 导致 semantic-fts 被关闭（v4.5.6）
26. ✅ **identifier boost 过滤修复**：二次搜索传 `{}` 绕过语言/路径过滤，已改为传 normalizedFilters（v4.5.3）
27. **Markdown 符号提取**：提取标题为 section 符号、代码块标识符为 usage
28. **.vue/.svelte 单文件组件**：提取 `<script>` 块内容用 TS 解析器分析
29. ✅ **Web API 验证统一**：新增 `core/validation/schemas.ts` 单一来源，MCP 工具与 Web 路由共用枚举/边界/默认值；Web 宽松解析（coerce+clamp）仅必填缺失时 400（v4.5.9）
30. ✅ **JSON.parse 防护**：新增 `safeJsonParse` 工具，套用到 sqliteStore 读 DB 列的 6 处，损坏降级为空值 + warn 日志而非崩溃（v4.5.8）
31. ✅ **日志格式统一**：RemoteEmbedding 用 console.warn 替代 logger（v4.5.10）
32. ✅ **关键路径测试覆盖**：测试 33→97，新增 9 个测试文件覆盖 safeJsonParse、搜索打分/工具纯函数、QaCache、共享/宽松校验、VectorCacheStore reconcile、deleteFiles 级联、源码解码助手（v4.5.9）

## P3 — 长线

33. **Go/Rust/Kotlin/Swift 适配器**：正则解析即可覆盖基本符号提取
34. ✅ **cosineSimilarity 统一**：实际剩 2 处重复（v4.5.8 拆分时已消一处），vectorCacheStore 私有实现删除、统一引用 embedding.ts 导出版（v4.6.0）
35. ✅ **cache eviction 优化**：remoteEmbedding/searchService 两处超量裁剪由全量收集 + O(n log n) 排序改为利用 Map 插入序——前者头部 TTL 扫描 + FIFO 裁剪，后者跨项目 k 路头比较；qaCache/queryExpander 本就是 FIFO（v4.6.0）
36. **Python 前向引用类型**：提取 `"TypeName"` 形式的字符串类型注解
37. ✅ **CJK 语义 FTS 词数**：`buildSemanticFtsQuery` 截断改为 CJK 感知——含 CJK 词上限 15（配合 v4.5.13 bigram 分词），纯 ASCII 维持 8；中文查询 semantic 候选 15→18（v4.5.15）
38. ✅ **Error/AppError 统一**：llmClient（未配置/API 错/空响应/超时）与 summaryGenerator（未配置/未索引）六处裸 Error 改 AppError，Web 出口按 statusCode/code 返回而非一律 500；CLI/autostart/HNSW 内部错误维持原状（v4.6.0）
39. ✅ **SSE 连接超时**：实际缺口为「断连未中止上游」——超时与断连检测此前已存在，但断连后 streamComplete 的 fetch 未 abort、上游 LLM 继续生成。现 `res.on("close")` 触发 AbortController 接入 `options.signal`，并在 LLM 阶段前断连早退（v4.6.0）

## QA 问答（召回质量 / 性能）

40. ✅ **QA 上游使用方（caller）扩展**：对 QA top 结果符号查 `findCallers`，把使用方业务逻辑类拉进问答上下文，对称补齐 v4.4.8 的下游（callee）扩展。解决「X 场景有什么特殊处理」类问题只召回 model/enum 定义、漏掉真正业务逻辑类的问题（v4.5.11）
41. ✅ **放开参考代码量**：默认上下文预算 24000→48000、`qaMaxSourcesDefault` 10→15；新增按请求 `maxContextTokens` 覆盖 + 上限 `qaMaxContextTokensMax`（默认 200000）钳制，大接口可带更完整代码（v4.5.12）
42. ✅ **QA 性能**：分三步收尾——① `ensureSemanticIndex` O(n²) JOIN 已修（122s→1.2s，v4.5.13），中文搜索端到端 ~64s→~1.8s；② 「queryExpansion 8s 超时失效」经 v4.5.13 后重测确认为**误判**（旧测量与慢搜索共用 Promise.all 计时，现 expansion 仅 ~291ms，abort 机制正常）；③ `ask_codebase` 硬编码强制开 reranker 已对齐为回落配置默认 + 可选参数覆盖（v4.5.14）。**剩余耗时主体（llmMs ~117s）为 LLM 端点生成速度本身**（慢端点 × 长输出 × 大上下文），属配置/选型而非代码项：建议换更快模型，或按需调低 `llmMaxTokens`/`maxSources`/`maxContextTokens`
43. ✅ **中文查询分词**：`queryAnalyzer` 新增 `segmentCjkTokens`，复用 `buildCjkBigrams` 把 CJK 连续串切成 bigram（整串保留 + 追加 bigram，上界 16），消除「整句被当成单个 14 字 token」的退化切词；纯查询侧、不需重索引（v4.5.13）
44. ✅ **语义索引存在性检查性能**：`ensureSemanticIndex` 的 `LEFT JOIN` FTS5 未索引列改为 `NOT IN` 单次扫描，O(n²)→O(n)，每次语义查询白跑的 ~122s 降到 ~1.2s（v4.5.13）

## 体验 / 工程化

45. ✅ **QA 答案业务流程图**：问答涉及业务流程/处理逻辑时，答案末尾自动追加 Mermaid `flowchart TD`，把关键步骤/判断可视化。一处 `QA_SYSTEM_PROMPT` 覆盖 MCP/Web/SSE；前端 `renderMarkdown` 先抽取 ```` ```mermaid ```` 块再走其余变换、流式结束后 `mermaid.run()` 渲染、失败回退（v4.6.1）
46. ✅ **自动化质量防线（`--eval`）**：新增 `--eval <caseFile>` CLI + `npm run eval`，加载 JSON golden 用例跑 `evaluateSearchQuality`，按 `minPassRate`（默认 1.0）以退出码 0/1 判定，发版前可回归。真实业务用例放 gitignore 的 `eval-cases/`，仓库仅提交脱敏模板（v4.6.1）
47. ✅ **流程图/调用链图导出**：渲染后的 Mermaid 图加导出工具栏——下载 PNG（SVG→canvas 光栅化、白底、×2 清晰度）、下载 SVG（矢量）、复制 Mermaid 源码（剪贴板，含 `execCommand` 回退）。文件名清洗非法字符、调用链容器复用时替换旧工具栏防源码过期。纯前端（v4.6.2）

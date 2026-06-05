# ace-mcp 路线图

按优先级排序（✅ = 已完成）：

## P0 — 正确性/高影响

1. ✅ **QA 缓存一致性**：缓存键加入文件内容 hash，避免代码变更后返回旧答案；提供手动清除 API（v4.5.2）
2. ✅ **索引健康监控**：`/health` 端点暴露 in-flight 索引列表和耗时（v4.5.2）
3. ✅ **符号解析消歧**：resolveRows 排序新增同文件/同模块优先排序键（v4.5.4）
4. ✅ **Java Lambda/方法引用**：新增 METHOD_REF_PATTERN 和 LAMBDA_PATTERN，方法引用和 Lambda 内调用可被调用链追踪（v4.5.5）
5. ✅ **HNSW searchLayer 用 Array.sort 替代 heap**：实现 MinHeap/MaxHeap 替代，搜索复杂度从 O(ef·n·log n) 降至 O(ef·log n)（v4.5.3）
6. ✅ **N+1 关联子查询 → CTE**：getFilePreviewResults/searchByPath 用 CTE + LEFT JOIN 替代 3N 次子查询（v4.5.3）
7. **增量索引 vector 缓存全量清空**：改 5 个文件导致 10 万向量全部重新加载，应只失效受影响 chunk 的向量

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
18. **大文件拆分**：sqliteStore.ts 2634 行/searchService.ts 1747 行/app.ts 1532 行，应拆为聚焦模块

## P2 — 中等优化

19. ✅ **FTS 删除批量化**：WHERE IN 批量删除替代逐条 DELETE（v4.5.4）
20. ✅ **readFileSnippet LRU 缓存**：200 条上限 + mtime 失效（v4.5.4）
21. ✅ **symbol full_name 函数索引**：添加 `idx_symbol_full_name_lower ON symbol(LOWER(full_name))`（v4.5.6）
22. ✅ **callChain 同层并行**：extractCallEntriesWithDepth 已用 Promise.all + .map 并行处理同层 entries（v4.5.4）
23. **scoreMergedResult 缓存**：dedupe/rerank 中重复调用 600 次，应合并阶段一次计算
24. **searchByPath 按文件名匹配度排序**：当前仅按路径长度排序，basename 精确匹配应优先
25. ✅ **CJK 单字 token 搜索**：修复 isSymbolLike 误判纯 CJK 单 token 导致 semantic-fts 被关闭（v4.5.6）
26. ✅ **identifier boost 过滤修复**：二次搜索传 `{}` 绕过语言/路径过滤，已改为传 normalizedFilters（v4.5.3）
27. **Markdown 符号提取**：提取标题为 section 符号、代码块标识符为 usage
28. **.vue/.svelte 单文件组件**：提取 `<script>` 块内容用 TS 解析器分析
29. **Web API 验证统一**：与 MCP 工具 Zod schema 不一致，应共用验证逻辑
30. **JSON.parse 防护**：数据库字段 JSON.parse 无 try-catch，损坏会崩溃
31. **日志格式统一**：RemoteEmbedding 用 console.warn 替代 logger
32. **关键路径测试覆盖**：sqliteStore/indexCoordinator/qaPipeline 缺少单元测试

## P3 — 长线

33. **Go/Rust/Kotlin/Swift 适配器**：正则解析即可覆盖基本符号提取
34. **cosineSimilarity 统一**：3 处重复实现，应合并到 embedding.ts
35. **cache eviction 优化**：利用 Map 插入顺序做 FIFO，替代 O(n) 排序
36. **Python 前向引用类型**：提取 `"TypeName"` 形式的字符串类型注解
37. **CJK 语义 FTS 词数**：查询词截断为 8 个，中文查询应提升到 12-15
38. **Error/AppError 统一**：混用 Error 和 AppError，应标准化
39. **SSE 连接超时**：无超时机制，客户端断连可能资源泄漏

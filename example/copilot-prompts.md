# Copilot Prompt Templates for ace-mcp

下面这些提示词模板适合在已经接入 `ace-mcp` MCP server 的 GitHub Copilot CLI / Copilot Agent 场景中直接复用。

## 智能问答 (RAG)

### 1. 直接问代码库

```text
请使用 ace-mcp 的 ask_codebase 工具，问"这个项目的整体架构是什么样的？主要模块有哪些？"
```

### 2. 理解业务流程

```text
请使用 ace-mcp 问"订单取消的完整流程是什么？从用户发起请求到最终状态变更，经过了哪些步骤？"
```

### 3. 追问细节（多轮对话）

```text
继续追问"刚才提到的 OrderService，它的 cancelOrder 方法具体是怎么实现的？有哪些边界情况处理？"
```

### 4. 代码审查

```text
请使用 ace-mcp 问"SearchService 的实现有没有潜在的性能问题或可以优化的地方？"
```

### 5. 生成项目摘要

```text
请先使用 ace-mcp 的 generate_summary 生成项目摘要，然后用 get_summary 查看架构概览。
```

## 代码搜索

### 6. 先索引再搜索某个业务实现

```text
请先对项目做增量索引，然后使用 ace-mcp 的 search_context 搜索"refund service implementation"，返回最相关的 5 个结果，并说明每个结果为什么相关。
```

### 7. 只做低成本候选筛选

```text
请使用 ace-mcp 的 search_context，以 metadata 模式搜索"order create flow"，只返回候选文件、行号范围、分数和 explanation，先不要展开代码片段。
```

### 8. 按语言过滤搜索

```text
请使用 ace-mcp 搜索"user login handler"，只看 JavaScript/TypeScript 相关结果，返回最相关的 8 条。
```

### 9. 按目录前缀过滤

```text
请使用 ace-mcp 搜索"payment callback"，只搜索 pathPrefix 为 src/server 的代码，返回结果后总结入口文件和核心处理链路。
```

### 10. 排除无关目录

```text
请使用 ace-mcp 搜索"project stats"，排除 dist 和 example 目录，优先给我源代码里的实现位置。
```

## 符号导航

### 11. 查找符号定义

```text
请使用 ace-mcp 的 find_definition 查找"SearchService.search"的定义位置。
```

### 12. 查找符号引用

```text
请使用 ace-mcp 的 find_references 查找所有调用"processRefund"的地方。
```

### 13. 查找调用者（多跳）

```text
请使用 ace-mcp 的 find_callers 查找谁调用了"handlePayment"，深度设为 2，看看调用链。
```

### 14. 查找被调用者

```text
请使用 ace-mcp 的 find_callees 查找"OrderController.createOrder"内部调用了哪些方法。
```

## 项目管理

### 15. 项目初始化排查模板

```text
请先调用 ace-mcp 的 project_stats 看当前项目是否已经建立索引；如果没有或者索引信息异常，就先执行 index_project，再搜索"application bootstrap"。
```

### 16. 预热向量索引

```text
请使用 ace-mcp 的 warm_index 预热项目的向量索引，为后续语义搜索做准备。
```

### 17. 查问题时顺带看索引健康度

```text
请使用 ace-mcp 搜索"login auth middleware"。如果搜索前发生了增量索引，请同时检查返回里的 indexing 摘要，告诉我是否有 failedFiles，以及这些失败是否可能影响结果完整性。
```

## 高级用法

### 18. 先 metadata，再按需展开 snippet

```text
请先使用 ace-mcp 的 metadata 模式搜索"index coordinator"，帮我挑出最相关的 3 个结果；然后只对这 3 个结果再获取代码片段并总结调用关系。
```

### 19. 结构化查询

```text
请使用 ace-mcp 搜索"symbol:RefundService AND path:src/refund NOT path:test"，找到退款服务的核心实现。
```

### 20. 多条件组合过滤模板

```text
请使用 ace-mcp 搜索"search context"，条件如下：
- languages: ["javascript"]
- pathPrefix: "src"
- pathContains: "search"
- excludePathPrefix: "src/web"
- resultMode: "metadata"

请返回最相关的 10 条，并按 explanation 帮我归类。
```

### 21. 让 Copilot 主动选择搜索策略

```text
请使用 ace-mcp 帮我理解"订单取消逻辑"分布在哪些文件里：
1. 先低成本筛选候选结果
2. 再展开最关键的代码片段
3. 最后给出文件之间的调用关系总结
```

### 22. 最通用的模板

```text
请使用 ace-mcp 搜索"<你的查询词>"。
如果结果很多，先用 metadata 模式筛选；
如果结果不够清晰，再切换到 full 模式并增加 includeContextLines；
最后总结最值得阅读的文件、符号和原因。
```

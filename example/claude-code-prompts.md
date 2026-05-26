# Claude Code Prompt Templates for ace-mcp

下面这些提示词模板适合在已经接入 `ace-mcp` MCP server 的 Claude Code / Claude Desktop 场景中直接复用。

## 智能问答 (RAG)

### 1. 直接问代码库

```text
使用 ace-mcp 的 ask_codebase 工具，问"这个项目的整体架构是什么样的？主要模块有哪些？"
```

### 2. 理解业务流程

```text
使用 ace-mcp 问"订单取消的完整流程是什么？从用户发起请求到最终状态变更，经过了哪些步骤？"
```

### 3. 追问细节（多轮对话）

```text
继续追问"刚才提到的 OrderService，它的 cancelOrder 方法具体是怎么实现的？有哪些边界情况处理？"
```

### 4. 代码审查

```text
使用 ace-mcp 问"SearchService 的实现有没有潜在的性能问题或可以优化的地方？"
```

### 5. 生成项目摘要

```text
先使用 ace-mcp 的 generate_summary 生成项目摘要，然后用 get_summary 查看架构概览。
```

## 代码搜索

### 6. 直接搜索某个业务实现

```text
使用 ace-mcp 搜索"refund service implementation"，返回最相关的 5 个结果，并说明每个结果为什么相关。
```

### 7. 先做低成本筛选

```text
使用 ace-mcp 的 metadata 模式搜索"order create flow"，先只给我候选文件、行号范围、分数和 explanation，不要直接展开代码片段。
```

### 8. 只看某种语言

```text
使用 ace-mcp 搜索"user login handler"，只保留 JavaScript/TypeScript 结果，并按相关性排序。
```

### 9. 限定目录范围

```text
使用 ace-mcp 搜索"payment callback"，只搜索 pathPrefix 为 src/server 的代码，并总结入口文件和核心处理链路。
```

### 10. 组合路径过滤

```text
使用 ace-mcp 搜索"search service"，要求：
- pathPrefix: "src"
- pathContains: "search"
- excludePathPrefix: "src/web"

请返回最相关的结果，并说明哪些文件最值得先读。
```

## 符号导航

### 11. 查找符号定义

```text
使用 ace-mcp 的 find_definition 查找"SearchService.search"的定义位置。
```

### 12. 查找符号引用

```text
使用 ace-mcp 的 find_references 查找所有调用"processRefund"的地方。
```

### 13. 查找调用者（多跳）

```text
使用 ace-mcp 的 find_callers 查找谁调用了"handlePayment"，深度设为 2，看看调用链。
```

### 14. 查找被调用者

```text
使用 ace-mcp 的 find_callees 查找"OrderController.createOrder"内部调用了哪些方法。
```

## 项目管理

### 15. 查看项目状态

```text
使用 ace-mcp 的 project_stats 查看项目索引状态，包括文件数、符号数、最近索引时间。
```

### 16. 预热向量索引

```text
使用 ace-mcp 的 warm_index 预热项目的向量索引，为后续语义搜索做准备。
```

### 17. 初始化项目时的通用模板

```text
先用 ace-mcp 查看 project_stats，确认项目是否已经建立索引；如果索引不存在或状态异常，就先执行 index_project，然后再搜索"application bootstrap"。
```

## 高级用法

### 18. 先筛选，再补片段

```text
先使用 ace-mcp 的 metadata 模式搜索"index coordinator"，帮我挑出最相关的 3 个结果；再只对这 3 个结果展开代码片段，并总结调用关系。
```

### 19. 结构化查询

```text
使用 ace-mcp 搜索"symbol:RefundService AND path:src/refund NOT path:test"，找到退款服务的核心实现。
```

### 20. 最通用模板

```text
使用 ace-mcp 搜索"<你的查询词>"。
如果结果很多，先用 metadata 模式筛选；
如果需要读代码，再切换到 full 模式并增加 includeContextLines；
最后总结最值得继续深挖的文件、符号和原因。
```

## 面向大仓库的优化

### 21. 节省 token 模板

```text
在整个仓库里用 ace-mcp 搜索"payment reconcile"。
先用 metadata 模式返回候选结果；
如果候选很多，只保留最相关的 5 个；
然后再展开其中 2 个最重要结果的 snippet。
```

### 22. 让 Claude Code 主动分步执行

```text
请用 ace-mcp 帮我理解"订单取消逻辑"：
1. 先用 metadata 模式筛选候选文件
2. 再对最关键的结果展开 snippet
3. 最后总结入口、关键符号和调用链路
```

# Copilot Prompt Templates for ace-mcp

下面这些提示词模板适合在已经接入 `ace-mcp` MCP server 的 GitHub Copilot CLI / Copilot Agent 场景中直接复用。

## 1. 先索引再搜索某个业务实现

```text
请先对项目做增量索引，然后使用 ace-mcp 的 search_context 搜索“refund service implementation”，返回最相关的 5 个结果，并说明每个结果为什么相关。
```

## 2. 只做低成本候选筛选

```text
请使用 ace-mcp 的 search_context，以 metadata 模式搜索“order create flow”，只返回候选文件、行号范围、分数和 explanation，先不要展开代码片段。
```

## 3. 按语言过滤搜索

```text
请使用 ace-mcp 搜索“user login handler”，只看 JavaScript/TypeScript 相关结果，返回最相关的 8 条。
```

## 4. 按目录前缀过滤

```text
请使用 ace-mcp 搜索“payment callback”，只搜索 pathPrefix 为 src/server 的代码，返回结果后总结入口文件和核心处理链路。
```

## 5. 按路径包含片段过滤

```text
请使用 ace-mcp 搜索“search service”，只保留路径中包含 search 的结果，并告诉我最应该先看的 3 个文件。
```

## 6. 排除无关目录

```text
请使用 ace-mcp 搜索“project stats”，排除 dist 和 example 目录，优先给我源代码里的实现位置。
```

## 7. 带上下文展开代码

```text
请使用 ace-mcp 搜索“SearchService”，返回 full 模式结果，并为每条命中额外展开 12 行上下文，方便直接阅读实现。
```

## 8. 先 metadata，再按需展开 snippet

```text
请先使用 ace-mcp 的 metadata 模式搜索“index coordinator”，帮我挑出最相关的 3 个结果；然后只对这 3 个结果再获取代码片段并总结调用关系。
```

## 9. 查问题时顺带看索引健康度

```text
请使用 ace-mcp 搜索“login auth middleware”。如果搜索前发生了增量索引，请同时检查返回里的 indexing 摘要，告诉我是否有 failedFiles，以及这些失败是否可能影响结果完整性。
```

## 10. 项目初始化排查模板

```text
请先调用 ace-mcp 的 project_stats 看当前项目是否已经建立索引；如果没有或者索引信息异常，就先执行 index_project，再搜索“application bootstrap”。
```

## 11. 多条件组合过滤模板

```text
请使用 ace-mcp 搜索“search context”，条件如下：
- languages: ["javascript"]
- pathPrefix: "src"
- pathContains: "search"
- excludePathPrefix: "src/web"
- resultMode: "metadata"

请返回最相关的 10 条，并按 explanation 帮我归类。
```

## 12. 快速定位入口文件模板

```text
请使用 ace-mcp 搜索“http server startup”或“app bootstrap”，优先找入口文件、路由注册位置和主初始化流程。
```

## 13. 快速定位符号定义模板

```text
请使用 ace-mcp 搜索符号“SearchService”，如果有多个命中，请优先给出定义位置而不是普通文本引用。
```

## 14. 让 Copilot 主动选择搜索策略

```text
请使用 ace-mcp 帮我理解“订单取消逻辑”分布在哪些文件里：
1. 先低成本筛选候选结果
2. 再展开最关键的代码片段
3. 最后给出文件之间的调用关系总结
```

## 15. 最通用的模板

```text
请使用 ace-mcp 搜索“<你的查询词>”。
如果结果很多，先用 metadata 模式筛选；
如果结果不够清晰，再切换到 full 模式并增加 includeContextLines；
最后总结最值得阅读的文件、符号和原因。
```

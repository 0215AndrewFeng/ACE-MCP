# Claude Code Prompt Templates for ace-mcp

下面这些提示词模板适合在已经接入 `ace-mcp` MCP server 的 Claude Code / Claude Desktop 场景中直接复用。

## 1. 直接搜索某个业务实现

```text
使用 ace-mcp 搜索“refund service implementation”，返回最相关的 5 个结果，并说明每个结果为什么相关。
```

## 2. 先做低成本筛选

```text
使用 ace-mcp 的 metadata 模式搜索“order create flow”，先只给我候选文件、行号范围、分数和 explanation，不要直接展开代码片段。
```

## 3. 只看某种语言

```text
使用 ace-mcp 搜索“user login handler”，只保留 JavaScript/TypeScript 结果，并按相关性排序。
```

## 4. 限定目录范围

```text
使用 ace-mcp 搜索“payment callback”，只搜索 pathPrefix 为 src/server 的代码，并总结入口文件和核心处理链路。
```

## 5. 组合路径过滤

```text
使用 ace-mcp 搜索“search service”，要求：
- pathPrefix: "src"
- pathContains: "search"
- excludePathPrefix: "src/web"

请返回最相关的结果，并说明哪些文件最值得先读。
```

## 6. 直接展开上下文

```text
使用 ace-mcp 搜索“SearchService”，返回 full 模式结果，并为每个命中展开 12 行上下文，方便直接阅读实现。
```

## 7. 先筛选，再补片段

```text
先使用 ace-mcp 的 metadata 模式搜索“index coordinator”，帮我挑出最相关的 3 个结果；再只对这 3 个结果展开代码片段，并总结调用关系。
```

## 8. 查问题时顺带看索引状态

```text
使用 ace-mcp 搜索“login auth middleware”。如果搜索前发生了增量索引，请同时检查返回中的 indexing 摘要，告诉我是否存在 failedFiles，以及这些失败会不会影响结果完整性。
```

## 9. 初始化项目时的通用模板

```text
先用 ace-mcp 查看 project_stats，确认项目是否已经建立索引；如果索引不存在或状态异常，就先执行 index_project，然后再搜索“application bootstrap”。
```

## 10. 让 Claude Code 主动分两步执行

```text
请用 ace-mcp 帮我理解“订单取消逻辑”：
1. 先用 metadata 模式筛选候选文件
2. 再对最关键的结果展开 snippet
3. 最后总结入口、关键符号和调用链路
```

## 11. 精确定位符号定义

```text
使用 ace-mcp 搜索符号“SearchService”，如果有多个结果，请优先给出定义位置，而不是普通文本引用。
```

## 12. 快速定位入口文件

```text
使用 ace-mcp 搜索“http server startup”或“app bootstrap”，优先找入口文件、初始化流程和路由注册位置。
```

## 13. 面向大仓库的节省 token 模板

```text
在整个仓库里用 ace-mcp 搜索“payment reconcile”。
先用 metadata 模式返回候选结果；
如果候选很多，只保留最相关的 5 个；
然后再展开其中 2 个最重要结果的 snippet。
```

## 14. 多条件高级过滤模板

```text
使用 ace-mcp 搜索“search context”，条件如下：
- languages: ["javascript"]
- pathPrefix: "src"
- pathContains: "search"
- excludePathPrefix: "src/web"
- resultMode: "metadata"

请返回前 10 条，并根据 explanation 解释它们为什么排在前面。
```

## 15. 最通用模板

```text
使用 ace-mcp 搜索“<你的查询词>”。
如果结果很多，先用 metadata 模式筛选；
如果需要读代码，再切换到 full 模式并增加 includeContextLines；
最后总结最值得继续深挖的文件、符号和原因。
```

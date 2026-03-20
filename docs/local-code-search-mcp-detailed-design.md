# 本地代码搜索 MCP Server 详细设计

## 1. 文档目标

本文档在概要设计基础上，进一步说明本地代码搜索 `MCP Server` 的模块拆分、数据模型、核心流程、接口定义、异常处理和演进方案。系统目标是支持 `Java`、`JavaScript/TypeScript`、`.NET/C#`、`Python` 代码库，在本地提供接近 AceMCP 的检索体验。

## 2. 设计范围与假设

### 2.1 设计范围

- 基于本地目录的项目识别
- 文件扫描、排除规则、编码识别
- 源码分块、轻量符号抽取、索引持久化
- 全文、路径、符号、混合搜索
- MCP 工具层与可选 Web 调试层

### 2.2 关键假设

- 运行环境可访问本地文件系统
- 以单机本地场景为主
- 对四类语言先实现“轻量代码理解”，不要求完整跨文件语义解析
- 文本型源码占主导，二进制和构建产物默认排除

## 3. 总体模块设计

```text
src/
  server/
    mcpServer.ts
    toolRegistry.ts
    tools/
      searchContext.ts
      indexProject.ts
      getFileSnippet.ts
      projectStats.ts
  core/
    project/
      projectDetector.ts
      fileCollector.ts
      ignoreManager.ts
      pathNormalizer.ts
    indexing/
      indexCoordinator.ts
      fileFingerprint.ts
      chunker.ts
      symbolExtractor.ts
      indexWriter.ts
      embeddingProvider.ts
    search/
      queryAnalyzer.ts
      lexicalSearcher.ts
      symbolSearcher.ts
      pathSearcher.ts
      hybridSearcher.ts
      reranker.ts
      resultFormatter.ts
    storage/
      sqliteStore.ts
      projectRepository.ts
      fileRepository.ts
      chunkRepository.ts
      symbolRepository.ts
    common/
      types.ts
      errors.ts
      logger.ts
  adapters/
    java/
    javascript/
    dotnet/
    python/
  web/
    app.ts
    routes/
    websocket/
  config/
    settings.ts
```

## 4. 模块职责设计

### 4.1 `server/`

#### `mcpServer.ts`

- 初始化 MCP Server
- 注册工具
- 绑定 stdio transport
- 对请求打日志和异常兜底

#### `toolRegistry.ts`

- 统一管理工具元信息
- 定义参数 schema
- 负责工具与业务处理器的映射

#### `tools/searchContext.ts`

- 校验参数
- 调用索引协调器执行增量更新
- 调用检索层获取结果
- 格式化输出为 AI 友好的结构

### 4.2 `core/project/`

#### `projectDetector.ts`

输入：项目根路径  
输出：项目类型、语言集合、候选源码目录、工程配置文件

识别逻辑：

- Java：检查 `pom.xml`、`build.gradle`、`settings.gradle`
- JavaScript：检查 `package.json`、`tsconfig.json`
- .NET：检查 `*.sln`、`*.csproj`
- Python：检查 `pyproject.toml`、`requirements.txt`、`setup.py`

#### `fileCollector.ts`

- 遍历文件系统
- 过滤排除目录与文件
- 根据扩展名与文本判定规则筛选索引文件

#### `ignoreManager.ts`

- 读取 `.gitignore`
- 合并默认排除模式
- 提供 `shouldIgnore(path)` 方法

#### `pathNormalizer.ts`

- 统一绝对路径、相对路径
- 处理 Windows、macOS、Linux、WSL 差异
- 所有内部存储统一为 `/` 分隔

### 4.3 `core/indexing/`

#### `indexCoordinator.ts`

索引入口，负责串联以下步骤：

1. 读取项目注册信息
2. 执行文件扫描
3. 计算增量变更集
4. 解析与切块
5. 写入索引
6. 更新索引状态

#### `fileFingerprint.ts`

生成文件指纹：

- 快速指纹：`mtime + size`
- 强校验：`sha256`

策略：

- 默认先比较 `mtime + size`
- 命中变化或启用严格模式时再计算 `sha256`

#### `chunker.ts`

分块原则：

- 按固定行窗口切块，如 `200~400` 行
- 尝试以函数、类、空行边界优先切块
- 对超大文件按保底窗口强切

每个 chunk 记录：

- 文件路径
- 起止行
- 内容正文
- token 估算
- 包含的符号名列表

#### `symbolExtractor.ts`

提供统一接口：

```ts
interface SymbolExtractor {
  supports(language: Language): boolean;
  extract(filePath: string, content: string): SymbolInfo[];
}
```

每种语言适配器实现各自规则。

#### `indexWriter.ts`

- 把文件、chunk、symbol 写入 SQLite
- 更新全文索引
- 删除失效文件对应数据

#### `embeddingProvider.ts`

第二阶段能力：

- 提供文本向量化
- 可接本地 ONNX 模型或本地 embedding 服务

### 4.4 `core/search/`

#### `queryAnalyzer.ts`

解析查询类型：

- 是否更像路径查询
- 是否更像符号名查询
- 是否是自然语言问题
- 是否带限定词（如文件名、扩展名、目录）

#### `lexicalSearcher.ts`

- 基于 SQLite FTS5 或外部全文索引库
- 支持关键词、短语和布尔搜索

#### `symbolSearcher.ts`

- 基于 `symbol` 表搜索类名、函数名、接口名
- 返回 symbol 命中分数

#### `pathSearcher.ts`

- 基于文件路径与目录名匹配
- 提高配置文件和入口文件的召回率

#### `hybridSearcher.ts`

召回来源：

- lexical topN
- symbol topN
- path topN
- embedding topN（可选）

然后统一进入重排层。

#### `reranker.ts`

重排评分建议：

```text
final_score =
  lexical_score * 0.45 +
  symbol_score  * 0.25 +
  path_score    * 0.10 +
  semantic_score* 0.15 +
  recency_bonus * 0.05
```

可按阶段裁剪：无语义索引时移除 `semantic_score`。

#### `resultFormatter.ts`

输出统一结构：

- 文件路径
- 语言
- 起止行
- 命中分数
- 命中原因
- 片段正文
- 可选周边上下文

### 4.5 `core/storage/`

建议使用 `SQLite` 作为统一持久化存储。

优点：

- 部署简单
- 本地单文件
- 支持事务
- 支持 FTS5

## 5. 数据模型设计

### 5.1 逻辑实体

#### `project`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| project_id | TEXT PK | 项目标识 |
| root_path | TEXT UNIQUE | 项目根路径 |
| project_type | TEXT | mono/multi-module/mixed |
| languages | TEXT | 语言集合，JSON |
| last_scan_at | TEXT | 最近扫描时间 |
| last_index_at | TEXT | 最近索引时间 |
| index_version | INTEGER | 索引版本 |
| status | TEXT | ready/indexing/error |

#### `file`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| file_id | TEXT PK | 文件标识 |
| project_id | TEXT | 所属项目 |
| relative_path | TEXT | 相对路径 |
| language | TEXT | 语言 |
| size | INTEGER | 文件大小 |
| mtime | INTEGER | 修改时间 |
| sha256 | TEXT | 内容摘要 |
| encoding | TEXT | 文件编码 |
| line_count | INTEGER | 行数 |
| indexed_at | TEXT | 索引时间 |

#### `chunk`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| chunk_id | TEXT PK | 片段标识 |
| file_id | TEXT | 所属文件 |
| start_line | INTEGER | 起始行 |
| end_line | INTEGER | 结束行 |
| content | TEXT | 片段内容 |
| summary | TEXT | 可选摘要 |
| token_count | INTEGER | token 数估算 |

#### `symbol`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| symbol_id | TEXT PK | 符号标识 |
| file_id | TEXT | 所属文件 |
| chunk_id | TEXT | 所属片段 |
| name | TEXT | 符号名 |
| full_name | TEXT | 全限定名 |
| kind | TEXT | class/function/interface/method |
| line | INTEGER | 所在行 |
| signature | TEXT | 简签名 |

#### `index_event`

记录每次索引任务的执行情况，用于统计和排障。

### 5.2 FTS 设计

如采用 SQLite FTS5，建议建立：

```sql
CREATE VIRTUAL TABLE chunk_fts USING fts5(
  chunk_id UNINDEXED,
  relative_path,
  language,
  content,
  symbol_names
);
```

## 6. 关键流程设计

### 6.1 项目初始化流程

```text
客户端调用 index_project
  -> 校验 project_root_path
  -> 检测项目类型与语言
  -> 建立 project 记录
  -> 执行全量扫描
  -> 建立 file/chunk/symbol/fts 数据
  -> 返回索引统计
```

### 6.2 增量索引流程

```text
search_context / index_project
  -> 扫描文件列表
  -> 对比上次 file 指纹
  -> 产生 added/updated/deleted 集合
  -> 删除失效 file/chunk/symbol/fts
  -> 对 added/updated 文件重新解析
  -> 批量写入 SQLite
  -> 更新 project.last_index_at
```

### 6.3 搜索流程

```text
客户端调用 search_context
  -> 参数校验
  -> 执行项目增量索引
  -> queryAnalyzer 判断查询类型
  -> lexical/symbol/path/semantic 并行召回
  -> reranker 重排
  -> 截断 top_k
  -> resultFormatter 格式化输出
```

### 6.4 取片段流程

```text
客户端调用 get_file_snippet
  -> 校验路径与行号范围
  -> 读取原文件
  -> 返回指定范围及前后上下文
```

## 7. 语言适配设计

### 7.1 统一适配接口

```ts
interface LanguageAdapter {
  language: Language;
  detectProject(rootPath: string): Promise<boolean>;
  collectSourceGlobs(): string[];
  extractSymbols(filePath: string, content: string): SymbolInfo[];
}
```

### 7.2 Java 适配

- 目录偏好：`src/main/java`、`src/test/java`
- 抽取规则：
  - `package xxx;`
  - `class/interface/enum`
  - 方法签名

### 7.3 JavaScript/TypeScript 适配

- 目录偏好：`src`、`lib`
- 抽取规则：
  - `function`
  - `class`
  - `export`
  - `const name = (...) =>`

### 7.4 .NET/C# 适配

- 目录偏好：项目文件所在目录
- 抽取规则：
  - `namespace`
  - `class/interface/record`
  - `public/private/protected` 方法

### 7.5 Python 适配

- 目录偏好：项目根、`src`
- 抽取规则：
  - `class`
  - `def`
  - `async def`

## 8. MCP 接口设计

### 8.1 `search_context`

请求：

```json
{
  "project_root_path": "/path/to/project",
  "query": "查找订单退款服务实现",
  "mode": "auto",
  "top_k": 8,
  "include_context_lines": 12
}
```

参数说明：

- `project_root_path`：项目绝对路径
- `query`：搜索文本
- `mode`：`auto | lexical | symbol | hybrid`
- `top_k`：最大返回数
- `include_context_lines`：附加上下文行数

响应：

```json
{
  "project_root_path": "/path/to/project",
  "query": "查找订单退款服务实现",
  "results": [
    {
      "file_path": "src/refund/service.py",
      "language": "python",
      "start_line": 48,
      "end_line": 76,
      "symbol": "RefundService.process_refund",
      "score": 0.91,
      "reason": "keyword+symbol",
      "snippet": "..."
    }
  ],
  "stats": {
    "scanned_files": 215,
    "indexed_files": 3,
    "search_ms": 143
  }
}
```

### 8.2 `index_project`

请求：

```json
{
  "project_root_path": "/path/to/project",
  "mode": "incremental"
}
```

### 8.3 `get_file_snippet`

请求：

```json
{
  "project_root_path": "/path/to/project",
  "file_path": "src/refund/service.py",
  "start_line": 40,
  "end_line": 90
}
```

### 8.4 `project_stats`

返回项目级索引统计、最近任务、失败文件列表等信息。

## 9. 配置设计

建议配置文件：`~/.ace-mcp/settings.toml`

```toml
batch_size = 32
max_lines_per_chunk = 300
max_file_size_kb = 1024
enable_semantic_search = false
default_top_k = 8
text_extensions = [".java", ".js", ".jsx", ".ts", ".tsx", ".cs", ".py"]
exclude_patterns = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "bin",
  "obj",
  "__pycache__",
  ".venv"
]
```

配置优先级建议：

`CLI 参数 > 环境变量 > settings.toml > 默认值`

## 10. 日志与可观测性

### 10.1 日志要求

- 工具调用日志
- 索引任务日志
- 文件读取失败日志
- 搜索耗时日志
- 异常栈信息

### 10.2 指标建议

- `scan_file_count`
- `indexed_file_count`
- `index_duration_ms`
- `search_duration_ms`
- `search_hit_count`
- `decode_failure_count`

### 10.3 Web 调试能力

可选实现：

- 查看服务器状态
- 查看项目索引统计
- 实时日志流
- 手工调用工具调试

## 11. 异常处理设计

### 11.1 文件级异常

场景：

- 编码不兼容
- 文件权限不足
- 文件扫描过程中被删除

策略：

- 单文件失败不终止全量任务
- 记录失败原因
- 将失败文件加入 `index_event` 明细

### 11.2 索引写入异常

策略：

- 使用事务保证单批一致性
- 批量失败时回滚当前批
- 记录失败批次范围

### 11.3 搜索异常

策略：

- 参数异常直接返回可读错误
- 索引未初始化时触发自动索引
- 检索失败时返回明确错误码和错误消息

## 12. 安全与边界控制

- 仅允许访问用户显式指定的项目目录
- 拒绝越权读取项目根外路径
- 默认跳过隐藏敏感文件和二进制文件
- 控制单次响应片段数量和长度，避免结果过大

## 13. 性能设计

### 13.1 索引优化

- 遍历阶段并发读取文件
- 增量检测优先使用 `mtime + size`
- 分批写入 SQLite
- 按文件级别替换索引，避免全表重建

### 13.2 搜索优化

- 热路径上优先使用 FTS
- `symbol` 和 `path` 建普通索引
- topN 召回后再重排，避免全量评分

### 13.3 大文件策略

- 超过阈值进行分块
- 对极大文件限制最大参与搜索块数
- 可对自动生成文件降低权重或排除

## 14. 测试设计

### 14.1 单元测试

- 路径规范化
- `.gitignore` 匹配
- 文件指纹比较
- 分块逻辑
- 各语言符号抽取
- 查询分析与排序

### 14.2 集成测试

- Java/JS/.NET/Python 示例工程索引
- 全量索引到增量索引
- `search_context` 返回结构正确性
- 删除文件后的索引清理

### 14.3 回归测试

- 编码混合文件
- 大文件
- 空仓库
- 多模块工程
- 路径大小写差异

## 15. 版本演进建议

### V1

- 本地 MCP Server
- 项目扫描
- 增量索引
- 关键词/路径/符号检索
- SQLite FTS5

### V2

- 本地 embedding
- hybrid search
- Web 管理台
- 更精准的 chunk 切分

### V3

- 引用关系
- 调用链辅助检索
- 搜索质量评估与自动调参

## 16. 落地建议

如果目标是尽快做出一个可用版本，建议采用以下实施顺序：

1. `Node.js + TypeScript + MCP SDK + SQLite FTS5`
2. 先实现 `search_context / index_project / get_file_snippet / project_stats`
3. 先做轻量符号抽取，不强依赖完整 AST
4. 先支持四类语言的工程识别与文件发现
5. 在结果重排与片段质量稳定后，再引入语义检索

## 17. 结论

本详细设计将系统拆分为“项目发现、索引、检索、存储、MCP 接入、运维管理”六大能力面，并通过统一接口屏蔽多语言差异。这样既能较快交付一个可用的本地代码搜索 MCP Server，又为后续引入语义搜索、调用关系和 Web 调试能力预留了清晰的扩展点。

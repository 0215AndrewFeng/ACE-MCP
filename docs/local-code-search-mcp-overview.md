# 本地代码搜索 MCP Server 概要设计

## 1. 背景与目标

本文档设计一个本地运行的代码搜索 `MCP Server`，面向 `Java`、`JavaScript/TypeScript`、`.NET/C#`、`Python` 四类项目，整体交互体验参考 AceMCP：

- 使用标准 `MCP` 协议，通过 `stdio` 接入 Claude、Copilot、Cherry Studio 等客户端
- 自动发现项目并执行增量索引
- 支持自然语言、关键词、符号名、路径等多种检索方式
- 返回适合 AI 消费的结果：文件路径、语言、命中区间、代码片段、命中原因
- 整体方案优先本地离线运行，不依赖远端索引服务

本系统在能力上模拟 AceMCP 的“自动索引 + 上下文搜索”体验，但架构上改为“本地扫描 + 本地索引 + 本地检索”。

## 2. 建设范围

### 2.1 In Scope

- 本地仓库/目录扫描
- `.gitignore` 与通用排除规则支持
- 四类语言工程识别与源码发现
- 全文检索、路径检索、轻量符号检索
- 增量索引与索引元数据持久化
- MCP 工具暴露
- 可选 Web 调试面板

### 2.2 Out of Scope

- 远程代码托管平台联邦搜索
- 精确到引用关系级别的全语言静态分析
- 大规模分布式索引集群
- 在线多租户检索服务

## 3. 设计原则

1. **本地优先**：默认脱离外部服务可运行。
2. **先可用后增强**：MVP 先保证关键词、符号、路径搜索稳定可用，再逐步扩展语义检索。
3. **增量更新**：仅重建新增/修改/删除文件对应的索引数据。
4. **AI 友好返回**：结果必须带行号、上下文、命中原因，而不是只返回文件列表。
5. **多语言统一抽象**：语言适配只负责识别工程、发现文件、抽取符号；核心索引与检索框架保持统一。
6. **可观测性**：索引、搜索、异常、性能统计必须可记录与排查。

## 4. 总体架构

```text
+--------------------+
| MCP Client         |
| Claude/Copilot/... |
+---------+----------+
          |
          | MCP over stdio
          v
+------------------------------+
| Local Code Search MCP Server |
+-------------+----------------+
              |
   +----------+----------+-----------+------------+
   |                     |           |            |
   v                     v           v            v
项目发现层           索引构建层    检索层       管理层
Project Scan        Indexing      Search       Config/Log/Web
```

### 4.1 项目发现层

负责识别项目类型、根目录、源码目录、排除规则以及参与索引的文件集合。

### 4.2 索引构建层

负责内容读取、编码处理、分块、符号抽取、倒排索引更新、向量索引更新和元数据持久化。

### 4.3 检索层

负责关键词检索、符号检索、路径检索、混合召回、结果重排与格式化。

### 4.4 管理层

负责本地配置、日志、状态查询、索引统计和可选 Web 调试界面。

## 5. 支持语言与识别规则

| 语言 | 工程识别 | 源码扩展名 | 轻量符号抽取重点 |
| --- | --- | --- | --- |
| Java | `pom.xml` `build.gradle` `settings.gradle` | `.java` | package、import、class、interface、enum、method |
| JavaScript/TypeScript | `package.json` `tsconfig.json` | `.js` `.jsx` `.ts` `.tsx` | function、class、export、arrow function |
| .NET/C# | `*.sln` `*.csproj` | `.cs` | namespace、class、interface、record、method |
| Python | `pyproject.toml` `requirements.txt` `setup.py` | `.py` | class、def、import |

第一阶段不强依赖完整 AST，可采用“正则 + 轻量解析器 + 可插拔 Tree-sitter”的组合方式。

## 6. 核心能力

### 6.1 索引能力

- 全量索引
- 增量索引
- 文件指纹识别（`mtime + size`，必要时 `sha256`）
- 大文件分块
- 多编码读取
- `.gitignore` 集成

### 6.2 搜索能力

- 关键词搜索
- 路径搜索
- 符号搜索
- 自然语言混合搜索（第二阶段）
- 返回命中片段与上下文

### 6.3 管理能力

- 配置文件加载
- 索引状态查看
- 实时日志
- 工具调试

## 7. MCP 工具设计

### 7.1 `search_context`

核心工具，执行自动增量索引后返回相关代码片段。

输入：

```json
{
  "project_root_path": "/path/to/project",
  "query": "查找订单退款接口实现",
  "mode": "hybrid",
  "top_k": 10
}
```

输出：

```json
{
  "meta": {
    "ok": true,
    "tool": "search_context"
  },
  "data": {
    "results": [
      {
        "file_path": "src/refund/service.py",
        "language": "python",
        "start_line": 40,
        "end_line": 72,
        "score": 0.91,
        "symbol": "RefundService.process_refund",
        "reason": "keyword+symbol",
        "snippet": "..."
      }
    ]
  },
  "stats": {
    "project": {
      "indexedFileCount": 215
    },
    "indexSync": {
      "indexedFileCount": 3,
      "scannedFileCount": 215
    },
    "search": {
      "searchMs": 143
    }
  }
}
```

### 7.2 `index_project`

手动触发全量或增量索引，适合初始化或调试。

### 7.3 `get_file_snippet`

按路径和行号范围返回源码片段，用于模型追加阅读。

### 7.4 `project_stats`

返回统一 envelope，其中 `stats.project` 表示项目当前持久化索引总量，`stats.latestIndexing` 表示最近一次索引任务摘要。

## 8. 技术选型建议

### 8.1 推荐技术栈

优先建议使用 `TypeScript + Node.js`，因为更贴近 AceMCP Node 版：

- MCP SDK：`@modelcontextprotocol/sdk`
- 存储：`SQLite`
- 全文检索：`MiniSearch / FlexSearch / SQLite FTS5`
- 轻量解析：`Tree-sitter` 或基于规则的抽取器
- Web：`Express`
- 配置：`TOML`

备选方案为 `Python + mcp[cli] + SQLite + Whoosh/Tantivy`，开发效率更高，但若目标是模拟 AceMCP 体验，Node 方案更自然。

### 8.2 存储建议

本地目录统一放在：

```text
~/.ace-mcp/
  settings.toml
  data/
    projects.json
    index.db
  log/
    ace-mcp.log
```

## 9. 非功能设计

### 9.1 性能

- 首次全量索引接受分钟级
- 增量索引目标为秒级
- 搜索目标为亚秒到秒级

### 9.2 可靠性

- 文件读取失败不阻断整体索引
- 局部批次失败应记录并跳过
- 搜索失败返回明确错误信息

### 9.3 可维护性

- 统一语言适配接口
- 核心组件解耦
- 配置、日志、存储和搜索层独立

## 10. 分阶段建设建议

### 阶段一：MVP

- MCP Server
- 项目扫描
- 增量索引
- 全文/路径/符号搜索
- SQLite 元数据持久化

### 阶段二：增强版

- 向量语义检索
- 混合召回
- Web 调试台
- 更丰富的语言抽取器

### 阶段三：高级版

- 跨仓库检索
- 引用关系与调用链
- 检索结果质量评估体系

## 11. 风险与应对

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| 多语言解析复杂 | 四类语言语法差异较大 | 第一阶段只做轻量符号抽取 |
| 本地性能波动 | 大仓库索引成本高 | 分块、增量、并发与缓存 |
| 搜索结果噪声高 | 单纯全文可能误召回 | 加入路径权重、符号权重和上下文裁剪 |
| Windows/WSL 路径兼容 | 路径格式不一致 | 统一路径规范化层 |

## 12. 结论

本方案的关键是保留 AceMCP 的交互体验，同时把能力完全下沉到本地：通过“统一项目发现 + 增量索引 + 多策略检索 + MCP 工具暴露”完成一个可落地的本地代码搜索服务器。MVP 可先以关键词、路径、符号检索为核心，后续再演进到语义检索与更精细的代码理解能力。

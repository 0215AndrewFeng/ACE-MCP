# Changelog

本项目的重要版本变更记录如下。

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

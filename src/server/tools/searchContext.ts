import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, type SearchResponse, type SearchResult } from "../../core/common/types.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { buildSearchContextToolPayload, createStructuredToolResult } from "../toolPayloads.js";

const SEARCH_FILTER_LANGUAGES = ["java", "javascript", "dotnet", "python"] as const;
const SEARCH_RESULT_MODES = ["full", "metadata"] as const;
const SEARCH_MODES = ["auto", "lexical", "symbol", "semantic", "hybrid"] as const;

export function registerSearchContextTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "search_context",
    {
      description:
        "Incrementally index the project and return code snippets relevant to a natural language, symbol, path, or semantic query, with optional context lines and path/language filters.",
      inputSchema: {
        excludePathPrefix: z.string().min(1).optional(),
        includeContextLines: z
          .number()
          .int()
          .min(DEFAULT_INCLUDE_CONTEXT_LINES)
          .max(MAX_INCLUDE_CONTEXT_LINES)
          .default(DEFAULT_INCLUDE_CONTEXT_LINES),
        languages: z.array(z.enum(SEARCH_FILTER_LANGUAGES)).min(1).optional(),
        mode: z.enum(SEARCH_MODES).default("auto"),
        pathContains: z.string().min(1).optional(),
        pathPrefix: z.string().min(1).optional(),
        projectPaths: z.array(z.string().min(1)).min(1).optional(),
        projectRootPath: z.string().min(1),
        query: z.string().min(1),
        resultMode: z.enum(SEARCH_RESULT_MODES).default("full"),
        topK: z.number().int().min(1).max(50).default(dependencies.settings.defaultTopK),
      },
      title: "Search Context",
    },
    async ({ excludePathPrefix, includeContextLines, languages, mode, pathContains, pathPrefix, projectPaths, projectRootPath, query, resultMode, topK }) => {
      // 确定要搜索的项目路径列表
      const searchProjectPaths = projectPaths && projectPaths.length > 0 ? projectPaths : [projectRootPath];

      // 索引所有需要搜索的项目
      const indexedProjects = await Promise.all(
        searchProjectPaths.map(async (path) => {
          return dependencies.indexCoordinator.indexProject(path, "incremental");
        }),
      );

      // 并行搜索所有项目
      const searchResults = await Promise.all(
        indexedProjects.map((indexResult) =>
          dependencies.searchService.search(
            indexResult.projectRootPath,
            query,
            mode,
            topK,
            includeContextLines,
            {
              excludePathPrefix,
              languages,
              pathContains,
              pathPrefix,
            },
            resultMode,
          ),
        ),
      );

      // 合并所有搜索结果（去重，按分数排序）
      const mergedResults = mergeSearchResults(searchResults, topK);

      // 使用第一个项目的索引结果作为主结果
      const primaryIndexResult = indexedProjects[0];
      const primaryResponse = searchResults[0];

      const payload = buildSearchContextToolPayload(
        {
          ...primaryResponse,
          results: mergedResults,
        },
        primaryIndexResult,
        dependencies.store.getProjectStats(primaryIndexResult.projectRootPath),
        {
          filters: {
            excludePathPrefix,
            languages,
            pathContains,
            pathPrefix,
          },
          includeContextLines,
          mode,
          projectRootPath: primaryIndexResult.projectRootPath,
          query,
          resultMode,
          topK,
        },
      );

      return createStructuredToolResult(payload);
    },
  );
}

/**
 * 合并多个项目的搜索结果
 */
function mergeSearchResults(results: SearchResponse[], topK: number): SearchResult[] {
  // 收集所有结果并按分数排序
  const allResults: SearchResult[] = [];

  for (const result of results) {
    allResults.push(...result.results);
  }

  // 按分数降序排序并取 topK
  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, topK);
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES } from "../../core/common/types.js";
import type { ToolDependencies } from "../toolRegistry.js";

const SEARCH_FILTER_LANGUAGES = ["java", "javascript", "dotnet", "python"] as const;

export function registerSearchContextTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "search_context",
    {
      description:
        "Incrementally index the project and return code snippets relevant to a natural language, symbol, or path query, with optional context lines, language filters, and path-prefix filtering.",
      inputSchema: {
        includeContextLines: z
          .number()
          .int()
          .min(DEFAULT_INCLUDE_CONTEXT_LINES)
          .max(MAX_INCLUDE_CONTEXT_LINES)
          .default(DEFAULT_INCLUDE_CONTEXT_LINES),
        languages: z.array(z.enum(SEARCH_FILTER_LANGUAGES)).min(1).optional(),
        mode: z.enum(["auto", "lexical", "symbol", "hybrid"]).default("auto"),
        pathPrefix: z.string().min(1).optional(),
        projectRootPath: z.string().min(1),
        query: z.string().min(1),
        topK: z.number().int().min(1).max(50).default(dependencies.settings.defaultTopK),
      },
      title: "Search Context",
    },
    async ({ includeContextLines, languages, mode, pathPrefix, projectRootPath, query, topK }) => {
      const indexResult = await dependencies.indexCoordinator.indexProject(projectRootPath, "incremental");
      const response = await dependencies.searchService.search(
        indexResult.projectRootPath,
        query,
        mode,
        topK,
        includeContextLines,
        {
          languages,
          pathPrefix,
        },
      );
      response.indexing = {
        changedFiles: indexResult.changedFiles,
        chunkCount: indexResult.chunkCount,
        createdAt: indexResult.createdAt,
        deletedFiles: indexResult.deletedFiles,
        failedFileCount: indexResult.failedFileCount,
        failedFiles: indexResult.failedFiles,
        indexedFiles: indexResult.indexedFiles,
        scannedFiles: indexResult.scannedFiles,
      };
      response.stats.indexedFiles = indexResult.indexedFiles;
      response.stats.scannedFiles = indexResult.scannedFiles;

      return {
        content: [
          {
            text: JSON.stringify(response, null, 2),
            type: "text",
          },
        ],
      };
    },
  );
}

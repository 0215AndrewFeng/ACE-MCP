import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES } from "../../core/common/types.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

const SEARCH_FILTER_LANGUAGES = ["java", "javascript", "dotnet", "python"] as const;
const SEARCH_RESULT_MODES = ["full", "metadata"] as const;

export function registerFindDefinitionTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "find_definition",
    {
      description: "Incrementally index the project and locate symbol definitions with file paths, signatures, and code snippets.",
      inputSchema: {
        excludePathPrefix: z.string().min(1).optional(),
        includeContextLines: z
          .number()
          .int()
          .min(DEFAULT_INCLUDE_CONTEXT_LINES)
          .max(MAX_INCLUDE_CONTEXT_LINES)
          .default(DEFAULT_INCLUDE_CONTEXT_LINES),
        languages: z.array(z.enum(SEARCH_FILTER_LANGUAGES)).min(1).optional(),
        pathContains: z.string().min(1).optional(),
        pathPrefix: z.string().min(1).optional(),
        projectRootPath: z.string().min(1),
        query: z.string().min(1),
        resultMode: z.enum(SEARCH_RESULT_MODES).default("full"),
        topK: z.number().int().min(1).max(50).default(dependencies.settings.defaultTopK),
      },
      title: "Find Definition",
    },
    async ({ excludePathPrefix, includeContextLines, languages, pathContains, pathPrefix, projectRootPath, query, resultMode, topK }) => {
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(projectRootPath);
      const response = await dependencies.searchService.findDefinitions(
        indexResult.projectRootPath,
        query,
        topK,
        includeContextLines,
        {
          excludePathPrefix,
          languages,
          pathContains,
          pathPrefix,
        },
        resultMode,
      );
      const payload = buildEnvelope(
        {
          excludePathPrefix,
          includeContextLines,
          languages,
          pathContains,
          pathPrefix,
          projectRootPath: indexResult.projectRootPath,
          query,
          resultMode,
          topK,
        },
        {
          projectRootPath: response.projectRootPath,
          query: response.query,
          resultMode: response.resultMode,
          results: response.results,
        },
        {
          indexSync: {
            changedFiles: indexResult.changedFiles,
            chunkCount: indexResult.chunkCount,
            createdAt: indexResult.createdAt,
            deletedFiles: indexResult.deletedFiles,
            failedFileCount: indexResult.failedFileCount,
            failedFiles: indexResult.failedFiles,
            indexedFiles: indexResult.indexedFiles,
            scannedFiles: indexResult.scannedFiles,
            timings: indexResult.timings,
            vectorIndex: indexResult.vectorIndex,
          },
          lookup: {
            resultCount: response.stats.resultCount,
            searchMs: response.stats.searchMs,
          },
        },
        [
          ...response.notes,
          ...(indexResult.failedFileCount > 0 ? ["Index sync had file-level failures; review stats.indexSync.failedFiles."] : []),
        ],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

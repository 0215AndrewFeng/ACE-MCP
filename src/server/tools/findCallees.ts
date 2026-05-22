import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  DEFAULT_CALL_GRAPH_DEPTH,
  DEFAULT_INCLUDE_CONTEXT_LINES,
  MAX_CALL_GRAPH_DEPTH,
  MAX_INCLUDE_CONTEXT_LINES,
} from "../../core/common/types.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

const SEARCH_FILTER_LANGUAGES = ["java", "javascript", "dotnet", "python", "markdown"] as const;
const SEARCH_RESULT_MODES = ["full", "metadata"] as const;

export function registerFindCalleesTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "find_callees",
    {
      description: "Incrementally index the project, resolve the target symbol, and return indexed callee relationships.",
      inputSchema: {
        excludePathPrefix: z.string().min(1).optional(),
        depth: z.number().int().min(DEFAULT_CALL_GRAPH_DEPTH).max(MAX_CALL_GRAPH_DEPTH).default(DEFAULT_CALL_GRAPH_DEPTH),
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
      title: "Find Callees",
    },
    async ({ depth, excludePathPrefix, includeContextLines, languages, pathContains, pathPrefix, projectRootPath, query, resultMode, topK }) => {
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(projectRootPath);
      const response = await dependencies.searchService.findCallees(
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
        depth,
      );
      const payload = buildEnvelope(
        {
          depth,
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
          definition: response.definition,
          definitions: response.definitions,
          direction: response.direction,
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
            depthReached: response.stats.depthReached,
            depthRequested: response.stats.depthRequested,
            definitionCount: response.stats.definitionCount,
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

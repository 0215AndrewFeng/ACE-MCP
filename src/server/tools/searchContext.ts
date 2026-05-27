import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES } from "../../core/common/types.js";
import { rerankWithLlm } from "../../core/search/llmReranker.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

const SEARCH_FILTER_LANGUAGES = ["java", "javascript", "dotnet", "python", "markdown"] as const;
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
        projectRootPath: z.string().min(1),
        query: z.string().min(1),
        resultMode: z.enum(SEARCH_RESULT_MODES).default("full"),
        topK: z.number().int().min(1).max(50).default(dependencies.settings.defaultTopK),
        enableReranker: z.boolean().default(false).describe("Enable LLM reranker for search results (requires LLM API configured and enableLlmReranker=true in settings)"),
      },
      title: "Search Context",
    },
    async ({ excludePathPrefix, includeContextLines, languages, mode, pathContains, pathPrefix, projectRootPath, query, resultMode, topK, enableReranker }) => {
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(projectRootPath);
      const response = await dependencies.searchService.search(
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
      );

      // v4.3.7: Optional LLM reranker
      let rerankerMs = 0;
      let usedLlmReranker = false;
      if (enableReranker && dependencies.settings.enableLlmReranker && dependencies.llmClient.isConfigured() && response.results.length > 3) {
        try {
          const rerankerStart = Date.now();
          const rerankerResult = await rerankWithLlm(
            dependencies.llmClient,
            query,
            response.results,
            topK,
            dependencies.settings.llmRerankerMaxCandidates,
          );
          if (rerankerResult.usedLlm) {
            response.results = rerankerResult.rerankedResults;
            usedLlmReranker = true;
          }
          rerankerMs = Date.now() - rerankerStart;
        } catch {
          // Reranker is optional — silently fall back to original order
        }
      }

      const indexSync = {
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
      };
      response.indexing = indexSync;
      response.stats.indexedFiles = indexResult.indexedFiles;
      response.stats.scannedFiles = indexResult.scannedFiles;
      const projectStats = dependencies.store.getProjectStats(indexResult.projectRootPath);
      const payload = buildEnvelope(
        {
          excludePathPrefix,
          includeContextLines,
          languages,
          mode,
          pathContains,
          pathPrefix,
          projectRootPath: indexResult.projectRootPath,
          query,
          resultMode,
          topK,
          enableReranker,
        },
        {
          diagnostics: response.diagnostics,
          projectRootPath: response.projectRootPath,
          query: response.query,
          resultMode: response.resultMode,
          results: response.results,
        },
        {
          indexSync,
          project: projectStats
            ? {
                chunkCount: projectStats.chunkCount,
                fileCount: projectStats.fileCount,
                indexedFileCount: response.stats.indexedFiles,
                languages: projectStats.languages,
                status: projectStats.status,
                symbolCount: projectStats.symbolCount,
              }
            : null,
          search: {
            candidateCount: response.diagnostics.candidateCount,
            resultCount: response.stats.resultCount,
            searchMs: response.stats.searchMs,
          },
          reranker: enableReranker ? {
            enabled: true,
            usedLlm: usedLlmReranker,
            durationMs: rerankerMs,
          } : undefined,
        },
        [
          ...response.notes,
          ...(indexResult.failedFileCount > 0 ? ["Index sync had file-level failures; review stats.indexSync.failedFiles."] : []),
          ...(usedLlmReranker ? [`LLM reranker applied (${rerankerMs}ms)`] : []),
        ],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

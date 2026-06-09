import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { rerankWithLlm } from "../../core/search/llmReranker.js";
import { searchContextShape } from "../../core/validation/schemas.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerSearchContextTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "search_context",
    {
      description:
        "Incrementally index the project and return code snippets relevant to a natural language, symbol, path, or semantic query, with optional context lines and path/language filters.",
      inputSchema: searchContextShape(dependencies.settings),
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
          dependencies.logger.debug("reranker failed in search_context");
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

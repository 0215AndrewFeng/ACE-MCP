import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { callGraphShape } from "../../core/validation/schemas.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerFindCallersTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "find_callers",
    {
      description: "Incrementally index the project, resolve the target symbol, and return indexed caller relationships.",
      inputSchema: callGraphShape(dependencies.settings),
      title: "Find Callers",
    },
    async ({ depth, excludePathPrefix, includeContextLines, languages, pathContains, pathPrefix, projectRootPath, query, resultMode, topK }) => {
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(projectRootPath);
      const response = await dependencies.searchService.findCallers(
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

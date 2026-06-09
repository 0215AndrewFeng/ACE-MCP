import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { symbolLookupShape } from "../../core/validation/schemas.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerFindDefinitionTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "find_definition",
    {
      description: "Incrementally index the project and locate symbol definitions with file paths, signatures, and code snippets.",
      inputSchema: symbolLookupShape(dependencies.settings),
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

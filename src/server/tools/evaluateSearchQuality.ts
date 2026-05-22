import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

const SEARCH_FILTER_LANGUAGES = ["java", "javascript", "dotnet", "python", "markdown"] as const;
const SEARCH_MODES = ["auto", "lexical", "symbol", "semantic", "hybrid"] as const;

export function registerEvaluateSearchQualityTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "evaluate_search_quality",
    {
      description: "Incrementally index the project and run a set of expected-result search cases to measure retrieval quality.",
      inputSchema: {
        cases: z.array(
          z.object({
            excludePathPrefix: z.string().min(1).optional(),
            expectedFiles: z.array(z.string().min(1)).optional(),
            expectedTopFile: z.string().min(1).optional(),
            languages: z.array(z.enum(SEARCH_FILTER_LANGUAGES)).min(1).optional(),
            mode: z.enum(SEARCH_MODES).default("auto"),
            name: z.string().min(1),
            pathContains: z.string().min(1).optional(),
            pathPrefix: z.string().min(1).optional(),
            query: z.string().min(1),
            topK: z.number().int().min(1).max(50).optional(),
          }),
        ).min(1),
        projectRootPath: z.string().min(1),
      },
      title: "Evaluate Search Quality",
    },
    async ({ cases, projectRootPath }) => {
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(projectRootPath);
      const evaluation = await dependencies.searchService.evaluateSearchQuality(indexResult.projectRootPath, cases);
      const payload = buildEnvelope(
        {
          cases,
          projectRootPath: indexResult.projectRootPath,
        },
        evaluation,
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
          summary: evaluation.summary,
        },
        indexResult.failedFileCount > 0 ? ["Index sync had file-level failures; review stats.indexSync.failedFiles."] : [],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

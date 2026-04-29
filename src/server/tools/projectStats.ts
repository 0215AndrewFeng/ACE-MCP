import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { normalizeAbsolutePath } from "../../core/project/pathNormalizer.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerProjectStatsTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "project_stats",
    {
      description: "Return indexing stats for a local project.",
      inputSchema: {
        projectRootPath: z.string().min(1),
      },
      title: "Project Stats",
    },
    async ({ projectRootPath }) => {
      const normalizedProjectRootPath = normalizeAbsolutePath(projectRootPath);
      const stats = dependencies.store.getProjectStats(normalizedProjectRootPath);
      const payload = buildEnvelope(
        { projectRootPath: normalizedProjectRootPath },
        {
          indexed: stats !== null,
          projectRootPath: normalizedProjectRootPath,
          status: stats?.status ?? "unknown",
        },
        {
          latestIndexing: stats?.latestIndexEvent ?? null,
          project: stats
            ? {
                chunkCount: stats.chunkCount,
                fileCount: stats.fileCount,
                languages: stats.languages,
                lastIndexAt: stats.lastIndexAt,
                lastScanAt: stats.lastScanAt,
                status: stats.status,
                symbolCount: stats.symbolCount,
              }
            : null,
        },
        stats ? [] : ["Project has not been indexed yet."],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

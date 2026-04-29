import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerIndexProjectTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "index_project",
    {
      description: "Scan and index a local project for keyword, symbol, and path search.",
      inputSchema: {
        mode: z.enum(["full", "incremental"]).default("incremental"),
        projectRootPath: z.string().min(1),
      },
      title: "Index Project",
    },
    async ({ mode, projectRootPath }) => {
      const result = await dependencies.indexCoordinator.indexProject(projectRootPath, mode);
      const payload = buildEnvelope(
        { mode, projectRootPath: result.projectRootPath },
        {
          project: result.project,
          projectId: result.projectId,
          projectRootPath: result.projectRootPath,
        },
        {
          indexSync: {
            changedFiles: result.changedFiles,
            chunkCount: result.chunkCount,
            deletedFiles: result.deletedFiles,
            failedFileCount: result.failedFileCount,
            failedFiles: result.failedFiles,
            indexedFiles: result.indexedFiles,
            scannedFiles: result.scannedFiles,
            timings: result.timings,
            vectorIndex: result.vectorIndex,
          },
        },
        result.failedFileCount > 0 ? ["Some files failed during indexing; see stats.indexSync.failedFiles for details."] : [],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

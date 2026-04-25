import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { normalizeAbsolutePath } from "../../core/project/pathNormalizer.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { buildProjectStatsToolPayload, createStructuredToolResult } from "../toolPayloads.js";

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
      const payload = buildProjectStatsToolPayload(
        normalizedProjectRootPath,
        dependencies.store.getProjectStats(normalizedProjectRootPath),
      );
      return createStructuredToolResult(payload);
    },
  );
}

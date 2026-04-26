import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { normalizeAbsolutePath } from "../../core/project/pathNormalizer.js";
import type { ToolDependencies } from "../toolRegistry.js";

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
      return {
        content: [
          {
            text: JSON.stringify(
              stats ?? {
                message: "Project has not been indexed yet.",
                projectRootPath: normalizedProjectRootPath,
              },
              null,
              2,
            ),
            type: "text",
          },
        ],
      };
    },
  );
}

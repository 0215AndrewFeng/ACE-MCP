import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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
      const stats = dependencies.store.getProjectStats(projectRootPath);
      return {
        content: [
          {
            text: JSON.stringify(
              stats ?? {
                message: "Project has not been indexed yet.",
                projectRootPath,
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

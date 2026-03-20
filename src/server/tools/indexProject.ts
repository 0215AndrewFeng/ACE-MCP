import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDependencies } from "../toolRegistry.js";

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
      return {
        content: [
          {
            text: JSON.stringify(result, null, 2),
            type: "text",
          },
        ],
      };
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDependencies } from "../toolRegistry.js";

export function registerSearchContextTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "search_context",
    {
      description:
        "Incrementally index the project and return code snippets relevant to a natural language, symbol, or path query.",
      inputSchema: {
        mode: z.enum(["auto", "lexical", "symbol", "hybrid"]).default("auto"),
        projectRootPath: z.string().min(1),
        query: z.string().min(1),
        topK: z.number().int().min(1).max(50).default(dependencies.settings.defaultTopK),
      },
      title: "Search Context",
    },
    async ({ mode, projectRootPath, query, topK }) => {
      const indexResult = await dependencies.indexCoordinator.indexProject(projectRootPath, "incremental");
      const response = dependencies.searchService.search(indexResult.projectRootPath, query, mode, topK);
      response.stats.indexedFiles = indexResult.indexedFiles;
      response.stats.scannedFiles = indexResult.scannedFiles;

      return {
        content: [
          {
            text: JSON.stringify(response, null, 2),
            type: "text",
          },
        ],
      };
    },
  );
}

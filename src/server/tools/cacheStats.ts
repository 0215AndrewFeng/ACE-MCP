import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerCacheStatsTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "cache_stats",
    {
      description: "Return search cache and vector cache diagnostics.",
      inputSchema: {},
      title: "Cache Stats",
    },
    async () => {
      const searchCacheStats = dependencies.searchService.getCacheStats();
      const payload = buildEnvelope(
        {},
        {
          searchCache: searchCacheStats,
        },
        {},
        [],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

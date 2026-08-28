import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerListSymbolsTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "list_symbols",
    {
      description: "List indexed symbols for a project, optionally filtered by name pattern or file path. Useful for debugging search and understanding project structure.",
      inputSchema: {
        namePattern: z.string().min(1).optional().describe("Filter symbols by name (case-insensitive substring match)"),
        pathPrefix: z.string().min(1).optional().describe("Filter symbols by file path prefix"),
        projectRootPath: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
      },
      title: "List Symbols",
    },
    async ({ namePattern, pathPrefix, projectRootPath, limit }) => {
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(projectRootPath);

      const filters = pathPrefix ? { pathPrefix } : undefined;
      const definitions = namePattern
        ? dependencies.store.findDefinitions(indexResult.projectId, namePattern, limit, filters)
        : dependencies.store.listDefinitions(indexResult.projectId, limit, filters);

      const payload = buildEnvelope(
        { namePattern, pathPrefix, projectRootPath: indexResult.projectRootPath },
        {
          count: definitions.length,
          symbols: definitions.map((d) => ({
            filePath: d.filePath,
            kind: d.kind,
            language: d.language,
            line: d.startLine,
            name: d.name,
            fullName: d.fullName,
          })),
        },
        {},
        [],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

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

      const query = namePattern
        ? `SELECT s.name, s.full_name, s.kind, s.line, f.relative_path, f.language
           FROM symbol s
           JOIN file f ON f.file_id = s.file_id
           WHERE f.project_id = ?
             AND LOWER(s.name) LIKE ?
             ${pathPrefix ? "AND LOWER(f.relative_path) LIKE ?" : ""}
           ORDER BY s.name
           LIMIT ?`
        : `SELECT s.name, s.full_name, s.kind, s.line, f.relative_path, f.language
           FROM symbol s
           JOIN file f ON f.file_id = s.file_id
           WHERE f.project_id = ?
             ${pathPrefix ? "AND LOWER(f.relative_path) LIKE ?" : ""}
           ORDER BY f.relative_path, s.line
           LIMIT ?`;

      const params: Array<string | number> = [indexResult.projectId];
      if (namePattern) {
        params.push(`%${namePattern.toLowerCase()}%`);
      }
      if (pathPrefix) {
        params.push(`${pathPrefix.toLowerCase()}%`);
      }
      params.push(limit);

      // Access the db via store's internal query — we need a public method
      // For now, use findDefinitions as a proxy for listing
      const definitions = dependencies.store.findDefinitions(
        indexResult.projectId,
        namePattern ?? "*",
        limit,
        pathPrefix ? { pathPrefix } : undefined,
      );

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

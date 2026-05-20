import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { normalizeAbsolutePath } from "../../core/project/pathNormalizer.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerClearProjectIndexTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "clear_project_index",
    {
      description: "Clear the index for a project (useful for corruption recovery or settings changes). The project will need to be re-indexed after clearing.",
      inputSchema: {
        projectRootPath: z.string().min(1),
      },
      title: "Clear Project Index",
    },
    async ({ projectRootPath }) => {
      const normalizedRoot = normalizeAbsolutePath(projectRootPath);
      const project = dependencies.store.getProjectByRoot(normalizedRoot);
      if (!project) {
        const payload = buildEnvelope(
          { projectRootPath: normalizedRoot },
          { cleared: false, projectRootPath: normalizedRoot },
          {},
          ["Project has not been indexed yet."],
        );
        return asStructuredToolResponse(payload);
      }

      // Delete all files (which cascades to chunks, symbols, imports, usages, vectors)
      const files = dependencies.store.listProjectFiles(project.project_id);
      const paths = files.map((f) => f.relativePath);
      dependencies.store.deleteFiles(project.project_id, paths);

      // Clear caches
      dependencies.searchService.clearSearchCache(project.project_id);

      const payload = buildEnvelope(
        { projectRootPath: normalizedRoot },
        { cleared: true, deletedFiles: paths.length, projectRootPath: normalizedRoot },
        {},
        [],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

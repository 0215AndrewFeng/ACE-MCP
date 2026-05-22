import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerGenerateSummaryTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "generate_summary",
    {
      description:
        "Generate a project architecture summary using LLM. Creates .ace-mcp/summaries/ with architecture overview, module descriptions, and key symbol summaries. Requires LLM API to be configured.",
      inputSchema: {
        projectRootPath: z.string().min(1),
      },
      title: "Generate Summary",
    },
    async ({ projectRootPath }) => {
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(projectRootPath);

      const result = await dependencies.summaryGenerator.generateProjectSummary(
        indexResult.projectRootPath,
        indexResult.projectId,
      );

      const payload = buildEnvelope(
        { projectRootPath: indexResult.projectRootPath },
        {
          outputDir: result.outputDir,
          filesWritten: result.filesWritten,
          moduleCount: result.moduleCount,
        },
        {
          tokensUsed: result.tokensUsed,
          durationMs: result.durationMs,
        },
        [],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

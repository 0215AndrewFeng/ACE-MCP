import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerGetSummaryTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "get_summary",
    {
      description:
        "Read a previously generated project architecture summary. Returns architecture overview, module descriptions, and key symbols. Does not require LLM.",
      inputSchema: {
        projectRootPath: z.string().min(1),
      },
      title: "Get Summary",
    },
    async ({ projectRootPath }) => {
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(projectRootPath);
      const summary = await dependencies.summaryGenerator.loadSummary(indexResult.projectRootPath);

      if (!summary) {
        const payload = buildEnvelope(
          { projectRootPath: indexResult.projectRootPath },
          { found: false },
          {},
          ["No summary found. Run generate_summary first."],
        );
        return asStructuredToolResponse(payload);
      }

      const payload = buildEnvelope(
        { projectRootPath: indexResult.projectRootPath },
        {
          found: true,
          generatedAt: summary.generatedAt,
          architecture: summary.architecture,
          moduleCount: summary.modules.length,
          modules: summary.modules,
        },
        { tokensUsed: summary.tokensUsed },
        [],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { resolveProjectsShape } from "../../core/validation/schemas.js";
import type { ToolRegistryDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerResolveProjectsTool(server: McpServer, dependencies: ToolRegistryDependencies): void {
  server.registerTool(
    "resolve_projects",
    {
      description:
        "Resolve a natural-language or code query to the most relevant indexed projects without indexing every project. Returns confidence, evidence, and single/multiple/abstain decisions.",
      inputSchema: resolveProjectsShape,
      title: "Resolve Projects",
    },
    async ({ query, topK }) => {
      const resolution = await dependencies.projectRouter.resolve(query, { topK });
      const payload = buildEnvelope(
        { query, topK },
        resolution,
        {
          routing: {
            candidateCount: resolution.candidates.length,
            decision: resolution.decision,
            durationMs: resolution.durationMs,
          },
        },
        resolution.decision === "abstain"
          ? ["No indexed project had enough evidence for this query."]
          : resolution.decision === "multiple"
            ? ["Several projects have similar evidence; inspect the candidates before choosing one."]
            : [],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerWarmIndexTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "warm_index",
    {
      description:
        "Pre-build vector embeddings for a project in the background. " +
        "This prepares the project for fast semantic/hybrid search by generating vectors ahead of time. " +
        "Use this after indexing a project if you plan to use semantic search.",
      inputSchema: {
        projectRootPath: z.string().min(1).describe("Absolute path to the project root"),
      },
      title: "Warm Vector Index",
    },
    async ({ projectRootPath }) => {
      const project = dependencies.store.getProjectByRoot(projectRootPath);
      if (!project) {
        return asStructuredToolResponse(
          buildEnvelope(
            { projectRootPath },
            { success: false, error: "Project not indexed. Run index_project first." },
            {},
            ["Project must be indexed before warming vector index."],
          ),
        );
      }

      const projectRecord = dependencies.store.getProjectByRoot(projectRootPath);
      if (!projectRecord) {
        return asStructuredToolResponse(
          buildEnvelope(
            { projectRootPath },
            { success: false, error: "Project record not found." },
            {},
            [],
          ),
        );
      }

      const modelName = dependencies.embeddingProvider.getModelName();
      const coverageBefore = dependencies.store.getVectorCoverage(projectRecord.project_id, modelName);

      // Generate vectors for all chunks that don't have them
      const missingChunks = dependencies.store.listChunksMissingVectors(projectRecord.project_id, modelName);
      if (missingChunks.length === 0) {
        return asStructuredToolResponse(
          buildEnvelope(
            { projectRootPath },
            {
              success: true,
              warmed: false,
              message: "All chunks already have vectors indexed.",
              coverage: coverageBefore,
            },
            {},
            [],
          ),
        );
      }

      const startedAt = Date.now();
      const batchSize = Math.max(8, Math.min(64, dependencies.settings.batchSize));
      let hydratedCount = 0;

      for (let i = 0; i < missingChunks.length; i += batchSize) {
        const batch = missingChunks.slice(i, i + batchSize);
        const embeddings = await dependencies.embeddingProvider.embedBatch(batch.map((c) => c.content));
        dependencies.store.writeChunkVectors(
          batch.map((chunk, idx) => ({
            chunkId: chunk.chunkId,
            embedding: embeddings[idx],
            modelName,
          })),
          projectRecord.project_id,
        );
        hydratedCount += batch.length;
      }

      const durationMs = Date.now() - startedAt;
      const coverageAfter = dependencies.store.getVectorCoverage(projectRecord.project_id, modelName);

      return asStructuredToolResponse(
        buildEnvelope(
          { projectRootPath },
          {
            success: true,
            warmed: true,
            hydratedChunks: hydratedCount,
            durationMs,
            coverage: coverageAfter,
          },
          {},
          [`Warmed ${hydratedCount} chunk vectors in ${durationMs}ms.`],
        ),
      );
    },
  );
}

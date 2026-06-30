import type { Express, Request, Response } from "express";

import { AppError } from "../../core/common/errors.js";
import { type IndexProgressEvent } from "../../core/indexing/indexCoordinator.js";
import { normalizeAbsolutePath } from "../../core/project/pathNormalizer.js";
import { buildEnvelope } from "../../server/tools/responseEnvelope.js";
import { parseIndexProjectRequest } from "../requestValidation.js";
import type { WebAppDependencies } from "../types.js";

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const parent = normalizeAbsolutePath(parentPath);
  const candidate = normalizeAbsolutePath(candidatePath);
  return candidate !== parent && candidate.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function findRegisteredChildProjects(projectRootPath: string, dependencies: WebAppDependencies): string[] {
  return dependencies.store
    .listProjects()
    .map((project) => project.projectRootPath)
    .filter((registeredPath) => isPathInside(projectRootPath, registeredPath))
    .slice(0, 20);
}

export function registerIndexRoutes(app: Express, dependencies: WebAppDependencies): void {
  app.post("/api/index-project", async (req: Request, res: Response) => {
    try {
      const parsed = parseIndexProjectRequest(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: "VALIDATION_ERROR" });
        return;
      }
      const { confirmParentDirectory, projectRootPath, mode } = parsed.value;
      if (mode === "full" && !confirmParentDirectory) {
        const childProjects = findRegisteredChildProjects(projectRootPath, dependencies);
        if (childProjects.length > 1) {
          res.status(409).json({
            error: "Full indexing this path would include registered child projects. Pass confirmParentDirectory=true to proceed.",
            code: "PARENT_DIRECTORY_REQUIRES_CONFIRMATION",
            childProjects,
            projectRootPath: normalizeAbsolutePath(projectRootPath),
          });
          return;
        }
      }
      const normalizedProjectRootPath = normalizeAbsolutePath(projectRootPath);
      if (dependencies.longTaskTracker) {
        const task = dependencies.longTaskTracker.run("index", normalizedProjectRootPath, async () => {
          const result = await dependencies.indexCoordinator.indexProject(projectRootPath, mode);
          return {
            changedFiles: result.changedFiles,
            chunkCount: result.chunkCount,
            deletedFiles: result.deletedFiles,
            failedFileCount: result.failedFileCount,
            failedFiles: result.failedFiles,
            indexedFiles: result.indexedFiles,
            mode,
            project: result.project,
            projectId: result.projectId,
            projectRootPath: result.projectRootPath,
            scannedFiles: result.scannedFiles,
            timings: result.timings,
            vectorIndex: result.vectorIndex,
          };
        });

        res.status(202).json(
          buildEnvelope(
            { mode, projectRootPath: normalizedProjectRootPath },
            {
              mode,
              projectRootPath: normalizedProjectRootPath,
              status: task.status,
              taskId: task.taskId,
              taskUrl: `/api/tasks/${encodeURIComponent(task.taskId)}`,
            },
            { elapsedMs: task.elapsedMs },
            ["Indexing is running in the background. Poll the task URL for completion."],
          ),
        );
        return;
      }
      const result = await dependencies.indexCoordinator.indexProject(projectRootPath, mode);
      res.json(
        buildEnvelope(
          { mode, projectRootPath: result.projectRootPath },
          {
            project: result.project,
            projectId: result.projectId,
            projectRootPath: result.projectRootPath,
          },
          {
            indexSync: {
              changedFiles: result.changedFiles,
              chunkCount: result.chunkCount,
              deletedFiles: result.deletedFiles,
              failedFileCount: result.failedFileCount,
              failedFiles: result.failedFiles,
              indexedFiles: result.indexedFiles,
              scannedFiles: result.scannedFiles,
              timings: result.timings,
              vectorIndex: result.vectorIndex,
            },
          },
          result.failedFileCount > 0 ? ["Some files failed during indexing; see stats.indexSync.failedFiles for details."] : [],
        ),
      );
    } catch (error: unknown) {
      const statusCode = error instanceof AppError ? error.statusCode : 500; res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error), code: error instanceof AppError ? error.code : "INTERNAL_ERROR" });
    }
  });

  // v4.3.6: SSE endpoint for index progress streaming
  app.get("/api/index/stream", async (req: Request, res: Response) => {
    const { projectRootPath, mode } = req.query;

    if (!projectRootPath) {
      res.status(400).json({ error: "projectRootPath is required" });
      return;
    }

    // Set up SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendEvent = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
        (res as unknown as { flush: () => void }).flush();
      }
    };

    // Track client disconnection
    let disconnected = false;
    req.on("close", () => {
      disconnected = true;
    });

    try {
      dependencies.logger.info("SSE index stream started", { projectRootPath });

      const onProgress = (event: IndexProgressEvent) => {
        if (!disconnected) {
          sendEvent({ type: "progress", ...event });
        }
      };

      const result = await dependencies.indexCoordinator.indexProject(
        String(projectRootPath),
        mode === "full" ? "full" : "incremental",
        onProgress,
      );

      if (!disconnected) {
        sendEvent({
          type: "done",
          result: {
            changedFiles: result.changedFiles,
            chunkCount: result.chunkCount,
            deletedFiles: result.deletedFiles,
            failedFileCount: result.failedFileCount,
            indexedFiles: result.indexedFiles,
            scannedFiles: result.scannedFiles,
            timings: result.timings,
            vectorIndex: result.vectorIndex,
          },
        });
        dependencies.logger.info("SSE index stream completed", {
          projectRootPath,
          totalMs: result.timings.totalMs,
          indexedFiles: result.indexedFiles,
        });
      }

      res.end();
    } catch (error: unknown) {
      if (!disconnected) {
        sendEvent({ type: "error", error: error instanceof Error ? error.message : String(error) });
        res.end();
      }
      dependencies.logger.error("SSE index stream error", { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // v4.2.3: Warm vector index endpoint
  app.post("/api/index/warm", async (req: Request, res: Response) => {
    try {
      const { projectRootPath } = req.body;
      if (!projectRootPath) {
        res.status(400).json({ error: "projectRootPath is required" });
        return;
      }

      const normalizedPath = normalizeAbsolutePath(String(projectRootPath));
      const projectRecord = dependencies.store.getProjectByRoot(normalizedPath);
      if (!projectRecord) {
        res.status(404).json({ error: "Project not indexed. Run index_project first." });
        return;
      }

      const modelName = dependencies.embeddingProvider.getModelName();
      const coverageBefore = dependencies.store.getVectorCoverage(projectRecord.project_id, modelName);
      const missingChunks = dependencies.store.listChunksMissingVectors(projectRecord.project_id, modelName);

      if (missingChunks.length === 0) {
        res.json({
          success: true,
          warmed: false,
          message: "All chunks already have vectors indexed.",
          coverage: coverageBefore,
        });
        return;
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

      res.json({
        success: true,
        warmed: true,
        hydratedChunks: hydratedCount,
        durationMs,
        coverage: coverageAfter,
      });
    } catch (error: unknown) {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
      res.status(statusCode).json({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
      });
    }
  });

  app.post("/api/watch/start", (req: Request, res: Response) => {
    try {
      const { projectRootPath } = req.body;
      if (!projectRootPath) {
        res.status(400).json({ error: "projectRootPath is required" });
        return;
      }
      dependencies.indexCoordinator.startWatching(String(projectRootPath));
      res.json({ projectRootPath: normalizeAbsolutePath(String(projectRootPath)), watching: true });
    } catch (error: unknown) {
      const statusCode = error instanceof AppError ? error.statusCode : 500; res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error), code: error instanceof AppError ? error.code : "INTERNAL_ERROR" });
    }
  });

  app.post("/api/watch/stop", (_req: Request, res: Response) => {
    dependencies.indexCoordinator.stopWatching();
    res.json({ watching: false });
  });
}

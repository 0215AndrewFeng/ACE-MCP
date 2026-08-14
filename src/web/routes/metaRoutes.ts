import type { Express, Request, Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError } from "../../core/common/errors.js";
import { readFileSnippet } from "../../core/project/fileSnippet.js";
import { normalizeAbsolutePath } from "../../core/project/pathNormalizer.js";
import { buildEnvelope } from "../../server/tools/responseEnvelope.js";
import { buildProjectListDataHealth, buildDataHealthReport, unavailableDataHealthCheck } from "../dataHealth.js";
import { buildRuntimeStatus, toolCatalog } from "../routeHelpers.js";
import { parseFileSnippetRequest } from "../requestValidation.js";
import type { WebAppDependencies } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticPath = path.join(__dirname, "..", "static");

function getWatchHealth(indexCoordinator: WebAppDependencies["indexCoordinator"]) {
  const summary = indexCoordinator.getWatchHealthSummary?.();
  if (summary) {
    return summary;
  }
  const watching = indexCoordinator.isWatching();
  return {
    active: watching ? 1 : 0,
    circuitOpen: false,
    expected: watching ? 1 : 0,
    exhausted: 0,
    periodicOnly: 0,
    retrying: 0,
    status: watching ? "healthy" : "disabled",
  };
}

function getMaintenanceLeaseHealth(indexCoordinator: WebAppDependencies["indexCoordinator"]) {
  return indexCoordinator.getAutomaticMaintenanceLeaseStatus?.() ?? {
    expiresAt: null,
    lastError: null,
    lastLostReason: null,
    lastRenewedAt: null,
    observedOwnerId: null,
    ownerId: null,
    state: "unavailable",
  };
}

function getIndexSchedulerHealth(
  indexCoordinator: WebAppDependencies["indexCoordinator"],
  indexConcurrency: number,
) {
  return indexCoordinator.getIndexSchedulerStatus?.() ?? {
    active: 0,
    concurrency: Math.max(1, Math.floor(indexConcurrency || 1)),
    oldestQueueMs: 0,
    pending: 0,
    pendingAutomatic: 0,
    pendingExplicit: 0,
  };
}

function getMaintenanceQueueHealth(indexCoordinator: WebAppDependencies["indexCoordinator"]) {
  return indexCoordinator.getAutomaticMaintenanceQueueStatus?.() ?? {
    active: false,
    coalescedRequests: 0,
    completed: 0,
    currentProjectRootPath: null,
    elapsedMs: 0,
    pending: 0,
    reason: null,
    startedAt: null,
    total: 0,
  };
}

function getSearchWorkerHealth(searchService: WebAppDependencies["searchService"]) {
  return searchService.getWorkerDiagnostics?.() ?? {
    activeRequests: 0,
    liveWorkers: 0,
    pendingRequests: 0,
    queueMs: {
      currentMax: 0,
      last: 0,
      max: 0,
      samples: 0,
      total: 0,
    },
  };
}

export function registerMetaRoutes(app: Express, dependencies: WebAppDependencies): void {
  // Health check - keep this path free of per-project SQLite stats reads.
  app.get("/health", (_req: Request, res: Response) => {
    try {
      const projects = dependencies.store.listProjects();
      const readyProjects = projects.filter(p => p.status === "ready");
      const latestIndexAt = projects.reduce<string | null>(
        (latest, project) => project.lastIndexAt && (!latest || project.lastIndexAt > latest) ? project.lastIndexAt : latest,
        null,
      );

      res.json({
        status: "ok",
        ...buildRuntimeStatus(dependencies.runtime),
        dataHealth: buildProjectListDataHealth(projects),
        indexScheduler: getIndexSchedulerHealth(
          dependencies.indexCoordinator,
          dependencies.settings.indexConcurrency,
        ),
        maintenanceLease: getMaintenanceLeaseHealth(dependencies.indexCoordinator),
        maintenanceQueue: getMaintenanceQueueHealth(dependencies.indexCoordinator),
        searchWorker: getSearchWorkerHealth(dependencies.searchService),
        watching: dependencies.indexCoordinator.isWatching(),
        watchHealth: getWatchHealth(dependencies.indexCoordinator),
        watchers: dependencies.indexCoordinator.getWatchStatuses?.() ?? [],
        projects: {
          total: projects.length,
          ready: readyProjects.length,
        },
        index: {
          totalFiles: null,
          totalChunks: null,
          totalSymbols: null,
          latestIndexAt,
        },
        indexing: dependencies.indexCoordinator.getInFlightIndexInfo(),
        tasks: dependencies.longTaskTracker?.listActive() ?? [],
        vector: {
          enabled: dependencies.settings.enableVectorSearch,
          mode: dependencies.settings.vectorIndexingMode,
        },
      });
    } catch (error) {
      res.json({
        status: "ok",
        ...buildRuntimeStatus(dependencies.runtime),
        dataHealth: buildDataHealthReport([unavailableDataHealthCheck("PROJECT_LIST_UNAVAILABLE", error)]),
        indexScheduler: getIndexSchedulerHealth(
          dependencies.indexCoordinator,
          dependencies.settings.indexConcurrency,
        ),
        maintenanceLease: getMaintenanceLeaseHealth(dependencies.indexCoordinator),
        maintenanceQueue: getMaintenanceQueueHealth(dependencies.indexCoordinator),
        searchWorker: getSearchWorkerHealth(dependencies.searchService),
        watching: dependencies.indexCoordinator.isWatching(),
        watchHealth: getWatchHealth(dependencies.indexCoordinator),
        watchers: dependencies.indexCoordinator.getWatchStatuses?.() ?? [],
        projects: {
          total: 0,
          ready: 0,
        },
        index: {
          totalFiles: null,
          totalChunks: null,
          totalSymbols: null,
          latestIndexAt: null,
        },
        indexing: dependencies.indexCoordinator.getInFlightIndexInfo(),
        tasks: dependencies.longTaskTracker?.listActive() ?? [],
        vector: {
          enabled: dependencies.settings.enableVectorSearch,
          mode: dependencies.settings.vectorIndexingMode,
        },
      });
    }
  });

  // API routes
  app.get("/api/runtime", (_req: Request, res: Response) => {
    res.json(buildRuntimeStatus(dependencies.runtime));
  });

  app.get("/api/config", (_req: Request, res: Response) => {
    res.json({
      autoWatch: dependencies.settings.autoWatch,
      batchSize: dependencies.settings.batchSize,
      dataDir: dependencies.settings.dataDir,
      databasePath: dependencies.settings.databasePath,
      defaultTopK: dependencies.settings.defaultTopK,
      enableVectorSearch: dependencies.settings.enableVectorSearch,
      excludePatterns: dependencies.settings.excludePatterns,
      logFilePath: dependencies.settings.logFilePath,
      maxFileSizeKb: dependencies.settings.maxFileSizeKb,
      maxLinesPerChunk: dependencies.settings.maxLinesPerChunk,
      indexConcurrency: dependencies.settings.indexConcurrency,
      textExtensions: dependencies.settings.textExtensions,
      vectorIndexingMode: dependencies.settings.vectorIndexingMode,
      watchDebounceMs: dependencies.settings.watchDebounceMs,
      watchMaxWaitMs: dependencies.settings.watchMaxWaitMs,
      watchReconcileSeconds: dependencies.settings.watchReconcileSeconds,
    });
  });

  app.get("/api/tools", (_req: Request, res: Response) => {
    res.json({ tools: toolCatalog() });
  });

  app.get("/api/projects", (_req: Request, res: Response) => {
    res.json({ projects: dependencies.store.listProjects() });
  });

  app.delete("/api/projects", async (req: Request, res: Response) => {
    const projectRootPath =
      typeof req.query.projectRootPath === "string"
        ? req.query.projectRootPath
        : typeof req.body?.projectRootPath === "string"
          ? req.body.projectRootPath
          : "";
    if (!projectRootPath.trim()) {
      res.status(400).json({ error: "projectRootPath is required", code: "VALIDATION_ERROR" });
      return;
    }

    const normalized = normalizeAbsolutePath(projectRootPath);
    try {
      const result = await dependencies.indexCoordinator.withProjectIndexPaused(
        normalized,
        () => {
          const project = dependencies.store.getProjectByRoot(normalized);
          const result = dependencies.store.deleteProject(normalized);
          if (project) {
            dependencies.searchService.clearSearchCache(project.project_id);
          }
          return result;
        },
      );

      if (result.deleted) {
        try {
          await dependencies.indexCoordinator.refreshAutomaticProjectOwnership(normalized);
        } catch (error) {
          dependencies.logger.warn("automatic project refresh failed after deletion", {
            error: error instanceof Error ? error.message : String(error),
            projectRootPath: normalized,
          });
        }
      }

      res.json(
        buildEnvelope(
          { projectRootPath: normalized },
          result,
          {},
          result.deleted ? [] : ["Project has not been indexed yet."],
        ),
      );
    } catch (error) {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
      res.status(statusCode).json({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
      });
    }
  });

  app.get("/api/project-stats", (req: Request, res: Response) => {
    const projectRootPath = req.query.projectRootPath as string;
    if (!projectRootPath) {
      res.status(400).json({ error: "projectRootPath is required" });
      return;
    }
    const normalized = normalizeAbsolutePath(projectRootPath);
    const stats = dependencies.store.getProjectStats(normalized);
    res.json(
      buildEnvelope(
        { projectRootPath: normalized },
        {
          indexed: stats !== null,
          projectRootPath: normalized,
          status: stats?.status ?? "unknown",
        },
        {
          latestIndexing: stats?.latestIndexEvent ?? null,
          project: stats
            ? {
                chunkCount: stats.chunkCount,
                fileCount: stats.fileCount,
                languages: stats.languages,
                lastIndexAt: stats.lastIndexAt,
                lastScanAt: stats.lastScanAt,
                status: stats.status,
                symbolCount: stats.symbolCount,
              }
            : null,
        },
        stats ? [] : ["Project has not been indexed yet."],
      ),
    );
  });

  app.post("/api/file-snippet", async (req: Request, res: Response) => {
    try {
      const parsed = parseFileSnippetRequest(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: "VALIDATION_ERROR" });
        return;
      }
      const { projectRootPath, filePath, startLine, endLine } = parsed.value;
      const result = await readFileSnippet(projectRootPath, filePath, startLine, endLine);
      res.json(
        buildEnvelope(
          {
            endLine,
            filePath,
            projectRootPath: result.projectRootPath,
            startLine,
          },
          {
            filePath: result.filePath,
            projectRootPath: result.projectRootPath,
            snippet: result.snippet,
          },
          {
            snippet: {
              endLine: result.endLine,
              lineCount: result.endLine - result.startLine + 1,
              startLine: result.startLine,
            },
          },
        ),
      );
    } catch (error: unknown) {
      const statusCode = error instanceof AppError ? error.statusCode : 500; res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error), code: error instanceof AppError ? error.code : "INTERNAL_ERROR" });
    }
  });

  // Serve index.html for root
  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });
}

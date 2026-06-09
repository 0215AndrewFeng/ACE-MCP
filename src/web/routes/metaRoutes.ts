import type { Express, Request, Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError } from "../../core/common/errors.js";
import { readFileSnippet } from "../../core/project/fileSnippet.js";
import { normalizeAbsolutePath } from "../../core/project/pathNormalizer.js";
import { buildEnvelope } from "../../server/tools/responseEnvelope.js";
import { buildRuntimeStatus, toolCatalog } from "../routeHelpers.js";
import { parseFileSnippetRequest } from "../requestValidation.js";
import type { WebAppDependencies } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticPath = path.join(__dirname, "..", "static");

export function registerMetaRoutes(app: Express, dependencies: WebAppDependencies): void {
  // Health check - v4.3.6: Enhanced with project and index stats
  app.get("/health", (_req: Request, res: Response) => {
    try {
      const projects = dependencies.store.listProjects();
      const readyProjects = projects.filter(p => p.status === "ready");

      // Calculate aggregate stats
      let totalFiles = 0;
      let totalChunks = 0;
      let totalSymbols = 0;
      let latestIndexAt: string | null = null;

      for (const project of projects) {
        const stats = dependencies.store.getProjectStats(project.projectRootPath);
        if (stats) {
          totalFiles += stats.fileCount;
          totalChunks += stats.chunkCount;
          totalSymbols += stats.symbolCount;
          if (stats.lastIndexAt && (!latestIndexAt || stats.lastIndexAt > latestIndexAt)) {
            latestIndexAt = stats.lastIndexAt;
          }
        }
      }

      res.json({
        status: "ok",
        ...buildRuntimeStatus(dependencies.runtime),
        watching: dependencies.indexCoordinator.isWatching(),
        projects: {
          total: projects.length,
          ready: readyProjects.length,
        },
        index: {
          totalFiles,
          totalChunks,
          totalSymbols,
          latestIndexAt,
        },
        indexing: dependencies.indexCoordinator.getInFlightIndexInfo(),
        vector: {
          enabled: dependencies.settings.enableVectorSearch,
          mode: dependencies.settings.vectorIndexingMode,
        },
      });
    } catch (error) {
      // Fallback to basic health if stats fail
      res.json({
        status: "ok",
        ...buildRuntimeStatus(dependencies.runtime),
        watching: dependencies.indexCoordinator.isWatching(),
      });
    }
  });

  // API routes
  app.get("/api/runtime", (_req: Request, res: Response) => {
    res.json(buildRuntimeStatus(dependencies.runtime));
  });

  app.get("/api/config", (_req: Request, res: Response) => {
    res.json({
      batchSize: dependencies.settings.batchSize,
      dataDir: dependencies.settings.dataDir,
      databasePath: dependencies.settings.databasePath,
      defaultTopK: dependencies.settings.defaultTopK,
      enableVectorSearch: dependencies.settings.enableVectorSearch,
      excludePatterns: dependencies.settings.excludePatterns,
      logFilePath: dependencies.settings.logFilePath,
      maxFileSizeKb: dependencies.settings.maxFileSizeKb,
      maxLinesPerChunk: dependencies.settings.maxLinesPerChunk,
      textExtensions: dependencies.settings.textExtensions,
      vectorIndexingMode: dependencies.settings.vectorIndexingMode,
    });
  });

  app.get("/api/tools", (_req: Request, res: Response) => {
    res.json({ tools: toolCatalog() });
  });

  app.get("/api/projects", (_req: Request, res: Response) => {
    res.json({ projects: dependencies.store.listProjects() });
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

import express, { type Express, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError } from "../core/common/errors.js";
import {
  DEFAULT_CALL_GRAPH_DEPTH,
  DEFAULT_INCLUDE_CONTEXT_LINES,
  MAX_CALL_GRAPH_DEPTH,
  MAX_INCLUDE_CONTEXT_LINES,
  type AppRuntimeInfo,
  type Settings,
  type SupportedLanguage,
} from "../core/common/types.js";
import type { Logger } from "../core/common/logger.js";
import { IndexCoordinator } from "../core/indexing/indexCoordinator.js";
import { readFileSnippet } from "../core/project/fileSnippet.js";
import { normalizeAbsolutePath } from "../core/project/pathNormalizer.js";
import { SearchService } from "../core/search/searchService.js";
import { SQLiteStore } from "../core/storage/sqliteStore.js";
import { buildEnvelope } from "../server/tools/responseEnvelope.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface WebAppDependencies {
  indexCoordinator: IndexCoordinator;
  logger: Logger;
  runtime: AppRuntimeInfo;
  searchService: SearchService;
  settings: Settings;
  store: SQLiteStore;
}

export interface WebAppHandle {
  close: () => Promise<void>;
  port: number;
}

const SUPPORTED_SEARCH_LANGUAGES = new Set<SupportedLanguage>(["java", "javascript", "dotnet", "python"]);

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numericValue)));
}

function normalizePathPrefix(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSupportedLanguages(value: unknown): SupportedLanguage[] | undefined {
  const rawValues = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const languages = [...new Set(rawValues
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((item): item is SupportedLanguage => SUPPORTED_SEARCH_LANGUAGES.has(item as SupportedLanguage)))];
  return languages.length > 0 ? languages : undefined;
}

function toolCatalog(): Array<{ description: string; name: string }> {
  return [
    { description: "Scan and index a local project for keyword, symbol, and path search.", name: "index_project" },
    { description: "Incrementally index the project and return code snippets relevant to a natural language, symbol, path, or semantic query.", name: "search_context" },
    { description: "Incrementally index the project and locate symbol definitions with signatures and snippets.", name: "find_definition" },
    { description: "Incrementally index the project, resolve the best definition, and return likely references.", name: "find_references" },
    { description: "Incrementally index the project, resolve the target symbol, and return indexed caller relationships with optional multi-hop depth.", name: "find_callers" },
    { description: "Incrementally index the project, resolve the target symbol, and return indexed callee relationships with optional multi-hop depth.", name: "find_callees" },
    { description: "Run expected-result search cases to measure retrieval quality on an indexed project.", name: "evaluate_search_quality" },
    { description: "Read a range of lines from a project file.", name: "get_file_snippet" },
    { description: "Return indexing stats for a local project.", name: "project_stats" },
  ];
}

function buildRuntimeStatus(runtime: AppRuntimeInfo) {
  return { ...runtime, uptimeMs: Math.round(Date.now() - Date.parse(runtime.startedAt)) };
}

export async function startWebApp(port: number, dependencies: WebAppDependencies): Promise<WebAppHandle> {
  const app: Express = express();
  app.use(express.json());

  // Static files
  const staticPath = path.join(__dirname, "static");
  app.use("/static", express.static(staticPath));

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", ...buildRuntimeStatus(dependencies.runtime) });
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
      const { projectRootPath, filePath, startLine, endLine } = req.body;
      const result = await readFileSnippet(String(projectRootPath ?? ""), String(filePath ?? ""), Number(startLine ?? 1), Number(endLine ?? 1));
      res.json(
        buildEnvelope(
          {
            endLine: Number(endLine ?? 1),
            filePath: String(filePath ?? ""),
            projectRootPath: result.projectRootPath,
            startLine: Number(startLine ?? 1),
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

  app.post("/api/index-project", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, mode } = req.body;
      const result = await dependencies.indexCoordinator.indexProject(String(projectRootPath ?? ""), mode === "full" ? "full" : "incremental");
      res.json(
        buildEnvelope(
          { mode: mode === "full" ? "full" : "incremental", projectRootPath: result.projectRootPath },
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

  app.post("/api/search-context", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, query, mode, topK, includeContextLines, excludePathPrefix, languages, pathContains, pathPrefix, resultMode } = req.body;
      const normalizedMode = ["auto", "lexical", "symbol", "semantic", "hybrid"].includes(String(mode ?? "auto")) ? mode : "auto";
      const normalizedResultMode = ["full", "metadata"].includes(String(resultMode ?? "full")) ? resultMode : "full";
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(String(projectRootPath ?? ""));
      const result = await dependencies.searchService.search(
        indexResult.projectRootPath,
        String(query ?? ""),
        normalizedMode,
        clampInteger(topK, 1, 50, dependencies.settings.defaultTopK),
        clampInteger(includeContextLines, DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, DEFAULT_INCLUDE_CONTEXT_LINES),
        {
          excludePathPrefix: normalizePathPrefix(excludePathPrefix),
          languages: normalizeSupportedLanguages(languages),
          pathContains: normalizePathPrefix(pathContains),
          pathPrefix: normalizePathPrefix(pathPrefix),
        },
        normalizedResultMode,
      );
      const indexSync = {
        changedFiles: indexResult.changedFiles,
        chunkCount: indexResult.chunkCount,
        createdAt: indexResult.createdAt,
        deletedFiles: indexResult.deletedFiles,
        failedFileCount: indexResult.failedFileCount,
        failedFiles: indexResult.failedFiles,
        indexedFiles: indexResult.indexedFiles,
        scannedFiles: indexResult.scannedFiles,
        timings: indexResult.timings,
        vectorIndex: indexResult.vectorIndex,
      };
      result.indexing = indexSync;
      result.stats.indexedFiles = indexResult.indexedFiles;
      result.stats.scannedFiles = indexResult.scannedFiles;
      const projectStats = dependencies.store.getProjectStats(indexResult.projectRootPath);
      res.json(
        buildEnvelope(
          {
            excludePathPrefix: normalizePathPrefix(excludePathPrefix),
            includeContextLines: clampInteger(includeContextLines, DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, DEFAULT_INCLUDE_CONTEXT_LINES),
            languages: normalizeSupportedLanguages(languages),
            mode: normalizedMode,
            pathContains: normalizePathPrefix(pathContains),
            pathPrefix: normalizePathPrefix(pathPrefix),
            projectRootPath: indexResult.projectRootPath,
            query: String(query ?? ""),
            resultMode: normalizedResultMode,
            topK: clampInteger(topK, 1, 50, dependencies.settings.defaultTopK),
          },
          {
            diagnostics: result.diagnostics,
            projectRootPath: result.projectRootPath,
            query: result.query,
            resultMode: result.resultMode,
            results: result.results,
          },
          {
            indexSync,
            project: projectStats
              ? {
                  chunkCount: projectStats.chunkCount,
                  fileCount: projectStats.fileCount,
                  indexedFileCount: result.stats.indexedFiles,
                  languages: projectStats.languages,
                  status: projectStats.status,
                  symbolCount: projectStats.symbolCount,
                }
              : null,
            search: {
              candidateCount: result.diagnostics.candidateCount,
              resultCount: result.stats.resultCount,
              searchMs: result.stats.searchMs,
            },
          },
          [
            ...result.notes,
            ...(indexResult.failedFileCount > 0 ? ["Index sync had file-level failures; review stats.indexSync.failedFiles."] : []),
          ],
        ),
      );
    } catch (error: unknown) {
      const statusCode = error instanceof AppError ? error.statusCode : 500; res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error), code: error instanceof AppError ? error.code : "INTERNAL_ERROR" });
    }
  });

  app.post("/api/find-definition", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, query, topK, includeContextLines, excludePathPrefix, languages, pathContains, pathPrefix, resultMode } = req.body;
      const normalizedResultMode = ["full", "metadata"].includes(String(resultMode ?? "full")) ? resultMode : "full";
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(String(projectRootPath ?? ""));
      const response = await dependencies.searchService.findDefinitions(
        indexResult.projectRootPath,
        String(query ?? ""),
        clampInteger(topK, 1, 50, dependencies.settings.defaultTopK),
        clampInteger(includeContextLines, DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, DEFAULT_INCLUDE_CONTEXT_LINES),
        {
          excludePathPrefix: normalizePathPrefix(excludePathPrefix),
          languages: normalizeSupportedLanguages(languages),
          pathContains: normalizePathPrefix(pathContains),
          pathPrefix: normalizePathPrefix(pathPrefix),
        },
        normalizedResultMode,
      );
      res.json(
        buildEnvelope(
          {
            excludePathPrefix: normalizePathPrefix(excludePathPrefix),
            includeContextLines: clampInteger(includeContextLines, DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, DEFAULT_INCLUDE_CONTEXT_LINES),
            languages: normalizeSupportedLanguages(languages),
            pathContains: normalizePathPrefix(pathContains),
            pathPrefix: normalizePathPrefix(pathPrefix),
            projectRootPath: indexResult.projectRootPath,
            query: String(query ?? ""),
            resultMode: normalizedResultMode,
            topK: clampInteger(topK, 1, 50, dependencies.settings.defaultTopK),
          },
          {
            projectRootPath: response.projectRootPath,
            query: response.query,
            resultMode: response.resultMode,
            results: response.results,
          },
          {
            indexSync: {
              changedFiles: indexResult.changedFiles,
              chunkCount: indexResult.chunkCount,
              createdAt: indexResult.createdAt,
              deletedFiles: indexResult.deletedFiles,
              failedFileCount: indexResult.failedFileCount,
              failedFiles: indexResult.failedFiles,
              indexedFiles: indexResult.indexedFiles,
              scannedFiles: indexResult.scannedFiles,
              timings: indexResult.timings,
              vectorIndex: indexResult.vectorIndex,
            },
            lookup: {
              resultCount: response.stats.resultCount,
              searchMs: response.stats.searchMs,
            },
          },
          [
            ...response.notes,
            ...(indexResult.failedFileCount > 0 ? ["Index sync had file-level failures; review stats.indexSync.failedFiles."] : []),
          ],
        ),
      );
    } catch (error: unknown) {
      const statusCode = error instanceof AppError ? error.statusCode : 500; res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error), code: error instanceof AppError ? error.code : "INTERNAL_ERROR" });
    }
  });

  app.post("/api/find-references", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, query, topK, includeContextLines, excludePathPrefix, languages, pathContains, pathPrefix, resultMode } = req.body;
      const normalizedResultMode = ["full", "metadata"].includes(String(resultMode ?? "full")) ? resultMode : "full";
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(String(projectRootPath ?? ""));
      const response = await dependencies.searchService.findReferences(
        indexResult.projectRootPath,
        String(query ?? ""),
        clampInteger(topK, 1, 50, dependencies.settings.defaultTopK),
        clampInteger(includeContextLines, DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, DEFAULT_INCLUDE_CONTEXT_LINES),
        {
          excludePathPrefix: normalizePathPrefix(excludePathPrefix),
          languages: normalizeSupportedLanguages(languages),
          pathContains: normalizePathPrefix(pathContains),
          pathPrefix: normalizePathPrefix(pathPrefix),
        },
        normalizedResultMode,
      );
      res.json(
        buildEnvelope(
          {
            excludePathPrefix: normalizePathPrefix(excludePathPrefix),
            includeContextLines: clampInteger(includeContextLines, DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, DEFAULT_INCLUDE_CONTEXT_LINES),
            languages: normalizeSupportedLanguages(languages),
            pathContains: normalizePathPrefix(pathContains),
            pathPrefix: normalizePathPrefix(pathPrefix),
            projectRootPath: indexResult.projectRootPath,
            query: String(query ?? ""),
            resultMode: normalizedResultMode,
            topK: clampInteger(topK, 1, 50, dependencies.settings.defaultTopK),
          },
          {
            definition: response.definition,
            definitions: response.definitions,
            projectRootPath: response.projectRootPath,
            query: response.query,
            resultMode: response.resultMode,
            results: response.results,
          },
          {
            indexSync: {
              changedFiles: indexResult.changedFiles,
              chunkCount: indexResult.chunkCount,
              createdAt: indexResult.createdAt,
              deletedFiles: indexResult.deletedFiles,
              failedFileCount: indexResult.failedFileCount,
              failedFiles: indexResult.failedFiles,
              indexedFiles: indexResult.indexedFiles,
              scannedFiles: indexResult.scannedFiles,
              timings: indexResult.timings,
              vectorIndex: indexResult.vectorIndex,
            },
            lookup: {
              definitionCount: response.stats.definitionCount,
              referenceCount: response.stats.referenceCount,
              searchMs: response.stats.searchMs,
            },
          },
          [
            ...response.notes,
            ...(indexResult.failedFileCount > 0 ? ["Index sync had file-level failures; review stats.indexSync.failedFiles."] : []),
          ],
        ),
      );
    } catch (error: unknown) {
      const statusCode = error instanceof AppError ? error.statusCode : 500; res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error), code: error instanceof AppError ? error.code : "INTERNAL_ERROR" });
    }
  });

  app.post("/api/find-callers", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, query, topK, depth, includeContextLines, excludePathPrefix, languages, pathContains, pathPrefix, resultMode } = req.body;
      const normalizedResultMode = ["full", "metadata"].includes(String(resultMode ?? "full")) ? resultMode : "full";
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(String(projectRootPath ?? ""));
      const response = await dependencies.searchService.findCallers(
        indexResult.projectRootPath,
        String(query ?? ""),
        clampInteger(topK, 1, 50, dependencies.settings.defaultTopK),
        clampInteger(includeContextLines, DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, DEFAULT_INCLUDE_CONTEXT_LINES),
        {
          excludePathPrefix: normalizePathPrefix(excludePathPrefix),
          languages: normalizeSupportedLanguages(languages),
          pathContains: normalizePathPrefix(pathContains),
          pathPrefix: normalizePathPrefix(pathPrefix),
        },
        normalizedResultMode,
        clampInteger(depth, DEFAULT_CALL_GRAPH_DEPTH, MAX_CALL_GRAPH_DEPTH, DEFAULT_CALL_GRAPH_DEPTH),
      );
      res.json(
        buildEnvelope(
          {
            depth: clampInteger(depth, DEFAULT_CALL_GRAPH_DEPTH, MAX_CALL_GRAPH_DEPTH, DEFAULT_CALL_GRAPH_DEPTH),
            excludePathPrefix: normalizePathPrefix(excludePathPrefix),
            includeContextLines: clampInteger(includeContextLines, DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, DEFAULT_INCLUDE_CONTEXT_LINES),
            languages: normalizeSupportedLanguages(languages),
            pathContains: normalizePathPrefix(pathContains),
            pathPrefix: normalizePathPrefix(pathPrefix),
            projectRootPath: indexResult.projectRootPath,
            query: String(query ?? ""),
            resultMode: normalizedResultMode,
            topK: clampInteger(topK, 1, 50, dependencies.settings.defaultTopK),
          },
          {
            definition: response.definition,
            definitions: response.definitions,
            direction: response.direction,
            projectRootPath: response.projectRootPath,
            query: response.query,
            resultMode: response.resultMode,
            results: response.results,
          },
          {
            indexSync: {
              changedFiles: indexResult.changedFiles,
              chunkCount: indexResult.chunkCount,
              createdAt: indexResult.createdAt,
              deletedFiles: indexResult.deletedFiles,
              failedFileCount: indexResult.failedFileCount,
              failedFiles: indexResult.failedFiles,
              indexedFiles: indexResult.indexedFiles,
              scannedFiles: indexResult.scannedFiles,
              timings: indexResult.timings,
              vectorIndex: indexResult.vectorIndex,
            },
            lookup: {
              depthReached: response.stats.depthReached,
              depthRequested: response.stats.depthRequested,
              definitionCount: response.stats.definitionCount,
              resultCount: response.stats.resultCount,
              searchMs: response.stats.searchMs,
            },
          },
          [
            ...response.notes,
            ...(indexResult.failedFileCount > 0 ? ["Index sync had file-level failures; review stats.indexSync.failedFiles."] : []),
          ],
        ),
      );
    } catch (error: unknown) {
      const statusCode = error instanceof AppError ? error.statusCode : 500; res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error), code: error instanceof AppError ? error.code : "INTERNAL_ERROR" });
    }
  });

  app.post("/api/find-callees", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, query, topK, depth, includeContextLines, excludePathPrefix, languages, pathContains, pathPrefix, resultMode } = req.body;
      const normalizedResultMode = ["full", "metadata"].includes(String(resultMode ?? "full")) ? resultMode : "full";
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(String(projectRootPath ?? ""));
      const response = await dependencies.searchService.findCallees(
        indexResult.projectRootPath,
        String(query ?? ""),
        clampInteger(topK, 1, 50, dependencies.settings.defaultTopK),
        clampInteger(includeContextLines, DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, DEFAULT_INCLUDE_CONTEXT_LINES),
        {
          excludePathPrefix: normalizePathPrefix(excludePathPrefix),
          languages: normalizeSupportedLanguages(languages),
          pathContains: normalizePathPrefix(pathContains),
          pathPrefix: normalizePathPrefix(pathPrefix),
        },
        normalizedResultMode,
        clampInteger(depth, DEFAULT_CALL_GRAPH_DEPTH, MAX_CALL_GRAPH_DEPTH, DEFAULT_CALL_GRAPH_DEPTH),
      );
      res.json(
        buildEnvelope(
          {
            depth: clampInteger(depth, DEFAULT_CALL_GRAPH_DEPTH, MAX_CALL_GRAPH_DEPTH, DEFAULT_CALL_GRAPH_DEPTH),
            excludePathPrefix: normalizePathPrefix(excludePathPrefix),
            includeContextLines: clampInteger(includeContextLines, DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, DEFAULT_INCLUDE_CONTEXT_LINES),
            languages: normalizeSupportedLanguages(languages),
            pathContains: normalizePathPrefix(pathContains),
            pathPrefix: normalizePathPrefix(pathPrefix),
            projectRootPath: indexResult.projectRootPath,
            query: String(query ?? ""),
            resultMode: normalizedResultMode,
            topK: clampInteger(topK, 1, 50, dependencies.settings.defaultTopK),
          },
          {
            definition: response.definition,
            definitions: response.definitions,
            direction: response.direction,
            projectRootPath: response.projectRootPath,
            query: response.query,
            resultMode: response.resultMode,
            results: response.results,
          },
          {
            indexSync: {
              changedFiles: indexResult.changedFiles,
              chunkCount: indexResult.chunkCount,
              createdAt: indexResult.createdAt,
              deletedFiles: indexResult.deletedFiles,
              failedFileCount: indexResult.failedFileCount,
              failedFiles: indexResult.failedFiles,
              indexedFiles: indexResult.indexedFiles,
              scannedFiles: indexResult.scannedFiles,
              timings: indexResult.timings,
              vectorIndex: indexResult.vectorIndex,
            },
            lookup: {
              depthReached: response.stats.depthReached,
              depthRequested: response.stats.depthRequested,
              definitionCount: response.stats.definitionCount,
              resultCount: response.stats.resultCount,
              searchMs: response.stats.searchMs,
            },
          },
          [
            ...response.notes,
            ...(indexResult.failedFileCount > 0 ? ["Index sync had file-level failures; review stats.indexSync.failedFiles."] : []),
          ],
        ),
      );
    } catch (error: unknown) {
      const statusCode = error instanceof AppError ? error.statusCode : 500; res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error), code: error instanceof AppError ? error.code : "INTERNAL_ERROR" });
    }
  });

  app.post("/api/evaluate-search-quality", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, cases } = req.body;
      const normalizedCases = Array.isArray(cases) ? cases : [];
      if (normalizedCases.length === 0) {
        res.status(400).json({ error: "cases must be a non-empty array" });
        return;
      }
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(String(projectRootPath ?? ""));
      const evaluation = await dependencies.searchService.evaluateSearchQuality(indexResult.projectRootPath, normalizedCases);
      res.json(
        buildEnvelope(
          {
            cases: normalizedCases,
            projectRootPath: indexResult.projectRootPath,
          },
          evaluation,
          {
            indexSync: {
              changedFiles: indexResult.changedFiles,
              chunkCount: indexResult.chunkCount,
              createdAt: indexResult.createdAt,
              deletedFiles: indexResult.deletedFiles,
              failedFileCount: indexResult.failedFileCount,
              failedFiles: indexResult.failedFiles,
              indexedFiles: indexResult.indexedFiles,
              scannedFiles: indexResult.scannedFiles,
              timings: indexResult.timings,
              vectorIndex: indexResult.vectorIndex,
            },
            summary: evaluation.summary,
          },
          indexResult.failedFileCount > 0 ? ["Index sync had file-level failures; review stats.indexSync.failedFiles."] : [],
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

  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const listeningPort = typeof address === "object" && address !== null && "port" in address ? address.port : port;
      dependencies.logger.info("web debug panel started", { port: listeningPort });
      resolve({
        close: () => new Promise<void>((res, rej) => server.close((err) => err ? rej(err) : res())),
        port: listeningPort,
      });
    });
    server.on("error", reject);
  });
}

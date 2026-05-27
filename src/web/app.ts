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
import type { EmbeddingProvider } from "../core/search/embedding.js";
import { IndexCoordinator } from "../core/indexing/indexCoordinator.js";
import type { LlmClient } from "../core/llm/llmClient.js";
import { buildQaUserPrompt, buildQaMessagesWithHistory, compressContext, generateRelatedQuestions, QA_SYSTEM_PROMPT, type QaConversationTurn } from "../core/llm/qaPrompt.js";
import { qaCache, QaCache } from "../core/llm/qaCache.js";
import { readFileSnippet } from "../core/project/fileSnippet.js";
import { normalizeAbsolutePath } from "../core/project/pathNormalizer.js";
import { extractCallChains, formatCallChainsForLLM } from "../core/search/callChainExtractor.js";
import { SearchService } from "../core/search/searchService.js";
import { estimateOptimalSources } from "../core/search/queryAnalyzer.js";
import { SQLiteStore } from "../core/storage/sqliteStore.js";
import type { SummaryGenerator } from "../core/summary/summaryGenerator.js";
import { buildEnvelope } from "../server/tools/responseEnvelope.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface WebAppDependencies {
  embeddingProvider: EmbeddingProvider;
  indexCoordinator: IndexCoordinator;
  llmClient: LlmClient;
  logger: Logger;
  runtime: AppRuntimeInfo;
  searchService: SearchService;
  settings: Settings;
  store: SQLiteStore;
  summaryGenerator: SummaryGenerator;
}

export interface WebAppHandle {
  close: () => Promise<void>;
  port: number;
}

const SUPPORTED_SEARCH_LANGUAGES = new Set<SupportedLanguage>(["java", "javascript", "dotnet", "python", "markdown"]);

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
    { description: "Pre-build vector embeddings for a project to enable fast semantic search.", name: "warm_index" },
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

  // Static files with cache control to ensure fresh content during development
  const staticPath = path.join(__dirname, "static");
  app.use("/static", express.static(staticPath, {
    etag: true,
    maxAge: 0, // No caching for development
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    },
  }));

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

  // ── LLM config endpoints ──────────────────────────────
  app.get("/api/llm/config", (_req: Request, res: Response) => {
    res.json(dependencies.llmClient.getConfig());
  });

  app.post("/api/llm/config", async (req: Request, res: Response) => {
    const { apiUrl, apiKey, model } = req.body;
    if (!apiUrl || !apiKey) {
      res.status(400).json({ error: "apiUrl and apiKey are required" });
      return;
    }
    dependencies.llmClient.updateConfig(String(apiUrl), String(apiKey), model ? String(model) : undefined);

    // Persist to settings.toml
    try {
      const { saveLlmConfig } = await import("../config/settings.js");
      await saveLlmConfig(dependencies.settings.settingsFilePath, {
        llmApiUrl: String(apiUrl),
        llmApiKey: String(apiKey),
        ...(model ? { llmModel: String(model) } : {}),
      });
    } catch {
      // best-effort persist
    }

    res.json(dependencies.llmClient.getConfig());
  });

  // Autostart management
  app.get("/api/autostart", async (_req: Request, res: Response) => {
    try {
      const { getAutostartStatus } = await import("../autostart/index.js");
      const status = await getAutostartStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/autostart", async (req: Request, res: Response) => {
    try {
      const { action, webPort } = req.body;
      const { enableAutostart, disableAutostart, getAutostartStatus } = await import("../autostart/index.js");

      if (action === "enable") {
        await enableAutostart({ enabled: true, webPort: webPort ? Number(webPort) : dependencies.runtime.webPort });
        res.json({ success: true, message: "Autostart enabled" });
      } else if (action === "disable") {
        await disableAutostart();
        res.json({ success: true, message: "Autostart disabled" });
      } else {
        res.status(400).json({ error: "Invalid action. Must be 'enable' or 'disable'." });
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
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

  // ── Summary endpoints ─────────────────────────────────
  app.post("/api/summary/generate", async (req: Request, res: Response) => {
    try {
      const { projectRootPath } = req.body;
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(String(projectRootPath ?? ""));
      const result = await dependencies.summaryGenerator.generateProjectSummary(indexResult.projectRootPath, indexResult.projectId);
      res.json(buildEnvelope(
        { projectRootPath: indexResult.projectRootPath },
        { outputDir: result.outputDir, filesWritten: result.filesWritten, moduleCount: result.moduleCount },
        { tokensUsed: result.tokensUsed, durationMs: result.durationMs },
        [],
      ));
    } catch (error: unknown) {
      const message = error instanceof AppError ? error.message : String(error);
      const status = error instanceof AppError ? error.statusCode : 500;
      res.status(status).json({ error: message, code: error instanceof AppError ? error.code : "UNKNOWN" });
    }
  });

  app.get("/api/summary", async (req: Request, res: Response) => {
    try {
      const projectRootPath = String(req.query.projectRootPath ?? "");
      const normalized = normalizeAbsolutePath(projectRootPath);
      const summary = await dependencies.summaryGenerator.loadSummary(normalized);
      if (!summary) {
        res.json({ found: false, note: "No summary found. Run generate_summary first." });
        return;
      }
      res.json({ found: true, ...summary });
    } catch (error: unknown) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ── QA endpoint ────────────────────────────────────────
  app.post("/api/qa/ask", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, question, maxSources, includeSummary, languages, timeoutSeconds, history } = req.body;
      if (!dependencies.llmClient.isConfigured()) {
        res.status(400).json({ error: "LLM API not configured" });
        return;
      }

      const timeout = clampInteger(timeoutSeconds, 10, 600, 120) * 1000;
      const startMs = Date.now();
      const checkTimeout = (phase: string) => {
        if (Date.now() - startMs > timeout) {
          throw new AppError("TIMEOUT", `Timeout at ${phase}: exceeded ${timeout / 1000}s limit`);
        }
      };

      // Phase 1: Index
      const indexStart = Date.now();
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(String(projectRootPath ?? ""));
      const indexMs = Date.now() - indexStart;
      checkTimeout("index");

      // Phase 2: Search
      const topK = clampInteger(maxSources, 1, 30, 10);
      const searchStart = Date.now();
      const searchResult = await dependencies.searchService.search(
        indexResult.projectRootPath,
        String(question ?? ""),
        "auto",
        topK,
        0,
        { languages: normalizeSupportedLanguages(languages) },
        "full",
      );
      const searchMs = Date.now() - searchStart;
      checkTimeout("search");

      // Phase 3: Load summary
      let summaryArchitecture: string | undefined;
      if (includeSummary !== false) {
        const summary = await dependencies.summaryGenerator.loadSummary(indexResult.projectRootPath);
        if (summary) {
          summaryArchitecture = summary.architecture;
        }
      }
      checkTimeout("summary");

      // Phase 4: LLM with context compression and multi-turn support
      const sources = searchResult.results.map((r) => ({
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        language: r.language,
        score: r.score,
        snippet: r.snippet,
      }));

      // v4.2.4: Compress context to fit token budget
      const maxContextTokens = 6000;
      const compressedSources = compressContext(sources, maxContextTokens);

      // v4.2.4: Build messages with conversation history if provided
      const conversationHistory: QaConversationTurn[] = Array.isArray(history) ? history : [];
      const messages = conversationHistory.length > 0
        ? buildQaMessagesWithHistory(String(question ?? ""), compressedSources, summaryArchitecture, conversationHistory)
        : [
            { role: "system" as const, content: QA_SYSTEM_PROMPT },
            { role: "user" as const, content: buildQaUserPrompt(String(question ?? ""), compressedSources, summaryArchitecture) },
          ];

      const llmStart = Date.now();
      // v4.2.4: Add timeout and fallback support
      const result = await dependencies.llmClient.complete({
        messages,
        timeoutMs: Math.max(timeout - (Date.now() - startMs), 5000),
        fallbackOnTimeout: true,
      });
      const llmMs = Date.now() - llmStart;
      const totalMs = Date.now() - startMs;

      // v4.2.4: Handle fallback response
      if (result.fallback) {
        res.json({
          answer: null,
          fallback: true,
          fallbackReason: result.fallbackReason,
          message: "LLM 服务暂时不可用，以下是检索到的相关代码片段，您可以直接参考。",
          sources: searchResult.results.map((r, i) => ({
            index: i + 1,
            filePath: r.filePath,
            startLine: r.startLine,
            endLine: r.endLine,
            language: r.language,
            score: r.score,
            snippet: r.snippet.slice(0, 200),
          })),
          usage: result.usage,
          hadSummary: Boolean(summaryArchitecture),
          timing: { indexMs, searchMs, llmMs, totalMs },
        });
        return;
      }

      res.json({
        answer: result.content,
        sources: searchResult.results.map((r, i) => ({
          index: i + 1,
          filePath: r.filePath,
          startLine: r.startLine,
          endLine: r.endLine,
          language: r.language,
          score: r.score,
          snippet: r.snippet.slice(0, 200),
        })),
        usage: result.usage,
        hadSummary: Boolean(summaryArchitecture),
        timing: { indexMs, searchMs, llmMs, totalMs },
      });
    } catch (error: unknown) {
      const message = error instanceof AppError ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  // ── QA streaming endpoint (SSE) - supports both GET and POST ────────────────────────────────────
  const handleQaStream = async (req: Request, res: Response) => {
    // Set up SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

    const sendEvent = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      // Flush immediately for real-time streaming
      if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
        (res as unknown as { flush: () => void }).flush();
      }
    };

    // Handle client disconnect - check socket state for reliable detection
    let clientDisconnected = false;
    const checkDisconnected = () => {
      // Check if socket is still writable (client still connected)
      if (res.writableEnded || res.destroyed || !res.socket || res.socket.destroyed) {
        return true;
      }
      return clientDisconnected;
    };

    // Only mark disconnected when socket actually closes
    res.on("close", () => {
      clientDisconnected = true;
      dependencies.logger.info("SSE client disconnected");
    });

    try {
      // Support both GET (query params) and POST (body)
      const isPost = req.method === "POST";
      const projectRootPath = isPost ? req.body?.projectRootPath : req.query.projectRootPath as string;
      const question = isPost ? req.body?.question : req.query.question as string;
      const maxSources = Number(isPost ? req.body?.maxSources : req.query.maxSources) || 10;
      const includeSummary = isPost ? req.body?.includeSummary !== false : req.query.includeSummary !== "false";
      const languages = isPost ? req.body?.languages : req.query.languages as string | undefined;
      const timeoutSeconds = Number(isPost ? req.body?.timeoutSeconds : req.query.timeoutSeconds) || 120;
      const historyData = isPost ? req.body?.history : req.query.history as string | undefined;

      dependencies.logger.info("SSE stream started", { projectRootPath, question: question?.slice(0, 50) });

      if (!dependencies.llmClient.isConfigured()) {
        sendEvent({ type: "error", error: "LLM API not configured" });
        res.end();
        return;
      }

      const timeout = clampInteger(timeoutSeconds, 10, 600, 120) * 1000;
      const startMs = Date.now();

      // Phase 1: Index
      dependencies.logger.info("SSE phase: index start");
      sendEvent({ type: "phase", phase: "index", status: "start" });
      const indexStart = Date.now();
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(String(projectRootPath ?? ""));
      const indexMs = Date.now() - indexStart;
      sendEvent({ type: "phase", phase: "index", status: "done", ms: indexMs });
      dependencies.logger.info("SSE phase: index done", { indexMs });

      if (Date.now() - startMs > timeout) {
        sendEvent({ type: "error", error: "Timeout at index phase" });
        res.end();
        return;
      }

      // Phase 2: Search
      dependencies.logger.info("SSE phase: search start");
      sendEvent({ type: "phase", phase: "search", status: "start" });
      // v4.3.0: Smart sources - auto-adjust based on question complexity
      const smartTopK = maxSources === 10 ? estimateOptimalSources(String(question ?? ""), 10) : maxSources;
      const topK = clampInteger(smartTopK, 1, 30, 10);
      const searchStart = Date.now();
      const searchResult = await dependencies.searchService.search(
        indexResult.projectRootPath,
        String(question ?? ""),
        "auto",
        topK,
        0,
        { languages: normalizeSupportedLanguages(languages?.split(",")) },
        "full",
      );
      const searchMs = Date.now() - searchStart;
      sendEvent({ type: "phase", phase: "search", status: "done", ms: searchMs, resultCount: searchResult.results.length });
      dependencies.logger.info("SSE phase: search done", { searchMs, resultCount: searchResult.results.length, smartTopK });

      // Send sources immediately
      const sources = searchResult.results.map((r, i) => ({
        index: i + 1,
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        language: r.language,
        score: r.score,
        snippet: r.snippet,
      }));
      sendEvent({ type: "sources", sources });

      // v4.3.0: Generate source hashes for caching
      const sourceHashes = sources.map(s => QaCache.hashSource(s.filePath, s.startLine, s.endLine));

      if (Date.now() - startMs > timeout) {
        sendEvent({ type: "error", error: "Timeout at search phase" });
        res.end();
        return;
      }

      // Phase 3: Extract call chains (v4.3.4)
      dependencies.logger.info("SSE phase: callchain start");
      sendEvent({ type: "phase", phase: "callchain", status: "start" });
      let callChainContext = "";
      let callChainMs = 0;
      try {
        const callChainStart = Date.now();
        const callChainResult = await extractCallChains(
          dependencies.searchService,
          indexResult.projectRootPath,
          searchResult.results,
          2,  // max 2 symbols
          3,  // max 3 callers per symbol
          3,  // max 3 callees per symbol
        );
        callChainMs = Date.now() - callChainStart;
        callChainContext = formatCallChainsForLLM(callChainResult.chains);
        sendEvent({
          type: "phase",
          phase: "callchain",
          status: "done",
          ms: callChainMs,
          symbolCount: callChainResult.extractedSymbols.length,
          chainCount: callChainResult.chains.length,
        });
        dependencies.logger.info("SSE phase: callchain done", {
          callChainMs,
          extractedSymbols: callChainResult.extractedSymbols,
          chainCount: callChainResult.chains.length,
        });
      } catch (error) {
        // Call chain extraction is optional, don't fail the request
        dependencies.logger.warn("SSE call chain extraction failed", { error: String(error) });
        sendEvent({ type: "phase", phase: "callchain", status: "done", ms: 0, error: "skipped" });
      }

      // Phase 4: Load summary
      dependencies.logger.info("SSE phase: summary start");
      sendEvent({ type: "phase", phase: "summary", status: "start" });
      let summaryArchitecture: string | undefined;
      if (includeSummary) {
        const summary = await dependencies.summaryGenerator.loadSummary(indexResult.projectRootPath);
        if (summary) {
          summaryArchitecture = summary.architecture;
        }
      }
      sendEvent({ type: "phase", phase: "summary", status: "done", hadSummary: Boolean(summaryArchitecture) });
      dependencies.logger.info("SSE phase: summary done", { hadSummary: Boolean(summaryArchitecture) });

      // Parse conversation history first (POST sends array directly, GET sends JSON string)
      let conversationHistory: QaConversationTurn[] = [];
      if (historyData) {
        try {
          conversationHistory = typeof historyData === 'string' ? JSON.parse(historyData) : historyData;
        } catch {
          // Ignore parse errors
        }
      }

      // v4.3.0: Check LLM response cache (only for non-conversation queries)
      const questionStr = String(question ?? "");
      if (conversationHistory.length === 0) {
        const cachedResponse = qaCache.get(questionStr, sourceHashes);
        if (cachedResponse) {
          dependencies.logger.info("SSE cache hit", { questionLength: questionStr.length });
          sendEvent({ type: "phase", phase: "llm", status: "start" });
          // Send cached answer as tokens (simulate streaming for consistent UX)
          const chunks = cachedResponse.answer.match(/.{1,50}/g) || [cachedResponse.answer];
          for (const chunk of chunks) {
            sendEvent({ type: "token", content: chunk });
          }
          const totalMs = Date.now() - startMs;
          // v4.3.2: Generate related questions for cached responses too
          const compressedSourcesForCache = compressContext(sources.map(s => ({
            filePath: s.filePath,
            startLine: s.startLine,
            endLine: s.endLine,
            language: s.language,
            score: s.score,
            snippet: s.snippet,
          })), 6000);
          const relatedQuestions = generateRelatedQuestions(questionStr, cachedResponse.answer, compressedSourcesForCache);
          sendEvent({
            type: "done",
            answer: cachedResponse.answer,
            usage: cachedResponse.usage,
            hadSummary: Boolean(summaryArchitecture),
            timing: { indexMs, searchMs, llmMs: 0, totalMs },
            cached: true,
            relatedQuestions,
          });
          dependencies.logger.info("SSE stream completed (cached)", { totalMs });
          res.end();
          return;
        }
      }

      // Phase 5: LLM streaming
      dependencies.logger.info("SSE phase: llm start");
      sendEvent({ type: "phase", phase: "llm", status: "start" });
      const llmStart = Date.now();

      const compressedSources = compressContext(sources.map(s => ({
        filePath: s.filePath,
        startLine: s.startLine,
        endLine: s.endLine,
        language: s.language,
        score: s.score,
        snippet: s.snippet,
      })), 6000);

      // v4.3.4: Include call chain context in prompt
      const messages = conversationHistory.length > 0
        ? buildQaMessagesWithHistory(questionStr, compressedSources, summaryArchitecture, conversationHistory)
        : [
            { role: "system" as const, content: QA_SYSTEM_PROMPT },
            { role: "user" as const, content: buildQaUserPrompt(questionStr, compressedSources, summaryArchitecture, callChainContext) },
          ];

      let fullContent = "";
      let usage = { promptTokens: 0, completionTokens: 0 };

      dependencies.logger.info("SSE calling LLM streamComplete", { messageCount: messages.length });
      for await (const chunk of dependencies.llmClient.streamComplete({
        messages,
        timeoutMs: Math.max(timeout - (Date.now() - startMs), 5000),
      })) {
        // Check if client disconnected
        if (checkDisconnected()) {
          dependencies.logger.info("SSE client disconnected during LLM streaming, stopping");
          return;
        }
        if (chunk.type === "token" && chunk.content) {
          fullContent += chunk.content;
          sendEvent({ type: "token", content: chunk.content, isThinking: chunk.isThinking });
        } else if (chunk.type === "done") {
          usage = chunk.usage ?? usage;
        } else if (chunk.type === "error") {
          dependencies.logger.error("SSE LLM error", { error: chunk.error });
          sendEvent({ type: "error", error: chunk.error });
          res.end();
          return;
        }
      }

      // v4.3.0: Cache the response for future queries (only non-conversation)
      if (conversationHistory.length === 0 && fullContent) {
        qaCache.set(questionStr, sourceHashes, fullContent, usage);
        dependencies.logger.info("SSE response cached", { questionLength: questionStr.length });
      }

      const llmMs = Date.now() - llmStart;
      const totalMs = Date.now() - startMs;
      dependencies.logger.info("SSE phase: llm done", { llmMs, contentLength: fullContent.length });

      // v4.3.2: Generate related questions for follow-up suggestions
      const relatedQuestions = generateRelatedQuestions(questionStr, fullContent, compressedSources);

      sendEvent({
        type: "done",
        answer: fullContent,
        usage,
        hadSummary: Boolean(summaryArchitecture),
        hadCallChain: callChainContext.length > 0,
        timing: { indexMs, searchMs, callChainMs, llmMs, totalMs },
        relatedQuestions,
      });
      dependencies.logger.info("SSE stream completed", { totalMs });
      res.end();
    } catch (error: unknown) {
      dependencies.logger.error("SSE stream error", { error: error instanceof Error ? error.message : String(error) });
      if (!checkDisconnected()) {
        sendEvent({ type: "error", error: error instanceof Error ? error.message : String(error) });
        res.end();
      }
    }
  };

  // Register both GET and POST handlers
  app.get("/api/qa/ask/stream", handleQaStream);
  app.post("/api/qa/ask/stream", handleQaStream);

  // ── QA Feedback endpoint ───────────────────────────────────────
  app.post("/api/qa/feedback", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, question, answer, sources, rating, correction, usage, timing } = req.body;

      if (!projectRootPath || !question || !answer || !rating) {
        res.status(400).json({ error: "Missing required fields: projectRootPath, question, answer, rating" });
        return;
      }

      if (rating !== "positive" && rating !== "negative") {
        res.status(400).json({ error: "rating must be 'positive' or 'negative'" });
        return;
      }

      const feedbackId = dependencies.store.saveQaFeedback({
        projectRoot: String(projectRootPath),
        question: String(question),
        answer: String(answer),
        sources: Array.isArray(sources) ? sources : undefined,
        rating,
        correction: correction ? String(correction) : undefined,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        searchMs: timing?.searchMs,
        llmMs: timing?.llmMs,
      });

      res.json({ success: true, feedbackId });
    } catch (error: unknown) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ── QA Feedback stats endpoint ─────────────────────────────────
  app.get("/api/qa/feedback/stats", async (req: Request, res: Response) => {
    try {
      const projectRoot = req.query.projectRoot as string | undefined;
      const stats = dependencies.store.getQaFeedbackStats(projectRoot);
      res.json(stats);
    } catch (error: unknown) {
      res.status(500).json({ error: String(error) });
    }
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

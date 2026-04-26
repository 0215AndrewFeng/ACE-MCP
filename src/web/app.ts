import express, { type Express, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_INCLUDE_CONTEXT_LINES,
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
      excludePatterns: dependencies.settings.excludePatterns,
      logFilePath: dependencies.settings.logFilePath,
      maxFileSizeKb: dependencies.settings.maxFileSizeKb,
      maxLinesPerChunk: dependencies.settings.maxLinesPerChunk,
      textExtensions: dependencies.settings.textExtensions,
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
    res.json({
      data: stats,
      meta: { ok: stats !== null, generatedAt: new Date().toISOString() },
      projectRootPath: normalized,
    });
  });

  app.post("/api/file-snippet", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, filePath, startLine, endLine } = req.body;
      const result = await readFileSnippet(String(projectRootPath ?? ""), String(filePath ?? ""), Number(startLine ?? 1), Number(endLine ?? 1));
      res.json({
        data: result,
        meta: { ok: true, generatedAt: new Date().toISOString() },
        request: { endLine: Number(endLine ?? 1), filePath: String(filePath ?? ""), projectRootPath: String(projectRootPath ?? ""), startLine: Number(startLine ?? 1) },
      });
    } catch (error: unknown) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/index-project", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, mode } = req.body;
      const result = await dependencies.indexCoordinator.indexProject(String(projectRootPath ?? ""), mode === "full" ? "full" : "incremental");
      const stats = dependencies.store.getProjectStats(result.projectRootPath);
      res.json({
        data: result,
        meta: { ok: true, generatedAt: new Date().toISOString() },
        projectRootPath: result.projectRootPath,
        stats,
      });
    } catch (error: unknown) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/search-context", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, query, mode, topK, includeContextLines, excludePathPrefix, languages, pathContains, pathPrefix, resultMode } = req.body;
      const normalizedMode = ["auto", "lexical", "symbol", "semantic", "hybrid"].includes(String(mode ?? "auto")) ? mode : "auto";
      const normalizedResultMode = ["full", "metadata"].includes(String(resultMode ?? "full")) ? resultMode : "full";
      const indexResult = await dependencies.indexCoordinator.indexProject(String(projectRootPath ?? ""), "incremental");
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
      result.indexing = {
        changedFiles: indexResult.changedFiles,
        chunkCount: indexResult.chunkCount,
        createdAt: indexResult.createdAt,
        deletedFiles: indexResult.deletedFiles,
        failedFileCount: indexResult.failedFileCount,
        failedFiles: indexResult.failedFiles,
        indexedFiles: indexResult.indexedFiles,
        scannedFiles: indexResult.scannedFiles,
      };
      result.stats.indexedFiles = indexResult.indexedFiles;
      result.stats.scannedFiles = indexResult.scannedFiles;
      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
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

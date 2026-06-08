import type { Express, Request, Response } from "express";

import { AppError } from "../../core/common/errors.js";
import {
  DEFAULT_CALL_GRAPH_DEPTH,
  DEFAULT_INCLUDE_CONTEXT_LINES,
  MAX_CALL_GRAPH_DEPTH,
  MAX_INCLUDE_CONTEXT_LINES,
} from "../../core/common/types.js";
import { buildEnvelope } from "../../server/tools/responseEnvelope.js";
import { clampInteger, normalizePathPrefix, normalizeSupportedLanguages } from "../routeHelpers.js";
import type { WebAppDependencies } from "../types.js";

export function registerSearchRoutes(app: Express, dependencies: WebAppDependencies): void {
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
}

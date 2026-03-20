import { performance } from "node:perf_hooks";

import type { Logger } from "../common/logger.js";
import type { SearchMode, SearchResponse, SearchResult } from "../common/types.js";
import { AppError } from "../common/errors.js";
import { analyzeQuery } from "./queryAnalyzer.js";
import { SQLiteStore } from "../storage/sqliteStore.js";

function clampSnippet(snippet: string, maxLength = 1200): string {
  if (snippet.length <= maxLength) {
    return snippet;
  }

  return `${snippet.slice(0, maxLength)}\n...`;
}

function mergeResults(resultSets: SearchResult[][], limit: number): SearchResult[] {
  const byLocation = new Map<string, SearchResult>();

  for (const results of resultSets) {
    for (const result of results) {
      const key = `${result.filePath}:${result.startLine}:${result.endLine}:${result.symbol ?? ""}`;
      const existing = byLocation.get(key);
      if (!existing) {
        byLocation.set(key, {
          ...result,
          snippet: clampSnippet(result.snippet),
        });
        continue;
      }

      const reasons = new Set([...existing.reason.split("+"), ...result.reason.split("+")]);
      byLocation.set(key, {
        ...existing,
        reason: [...reasons].sort().join("+"),
        score: existing.score + result.score,
        symbol: existing.symbol ?? result.symbol,
      });
    }
  }

  return [...byLocation.values()]
    .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath))
    .slice(0, limit);
}

export class SearchService {
  public constructor(
    private readonly store: SQLiteStore,
    private readonly logger: Logger,
  ) {}

  public search(projectRootPath: string, query: string, mode: SearchMode, topK: number): SearchResponse {
    const startedAt = performance.now();
    const project = this.store.getProjectByRoot(projectRootPath);
    if (!project) {
      throw new AppError("PROJECT_NOT_INDEXED", `Project has not been indexed yet: ${projectRootPath}`);
    }

    const analysis = analyzeQuery(query);
    const resultSets: SearchResult[][] = [];

    if ((mode === "auto" || mode === "lexical" || mode === "hybrid") && analysis.ftsQuery) {
      try {
        resultSets.push(this.store.searchByText(project.project_id, analysis.ftsQuery, topK));
      } catch (error: unknown) {
        this.logger.warn("fts query failed", {
          error: error instanceof Error ? error.message : String(error),
          projectRootPath,
          query,
        });
      }
    }

    if (mode === "auto" || mode === "symbol" || mode === "hybrid" || analysis.isSymbolLike) {
      resultSets.push(this.store.searchBySymbols(project.project_id, analysis.tokens, topK));
    }

    if (mode === "auto" || mode === "hybrid" || analysis.isPathLike) {
      resultSets.push(this.store.searchByPath(project.project_id, analysis.tokens, topK));
    }

    const results = mergeResults(resultSets, topK);
    const stats = this.store.getProjectStats(projectRootPath);
    const searchMs = Math.round(performance.now() - startedAt);

    return {
      projectRootPath,
      query,
      results,
      stats: {
        indexedFiles: stats?.fileCount ?? 0,
        scannedFiles: stats?.fileCount ?? 0,
        searchMs,
      },
    };
  }
}

import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Logger } from "../common/logger.js";
import {
  DEFAULT_INCLUDE_CONTEXT_LINES,
  MAX_INCLUDE_CONTEXT_LINES,
  type QueryAnalysis,
  type SearchDiagnostics,
  type SearchFilters,
  type SearchMatchSource,
  type SearchMode,
  type SearchPhaseStat,
  type SearchResponse,
  type SearchResultExplanation,
  type SearchResultMode,
  type SearchResult,
  type Settings,
  type SupportedLanguage,
} from "../common/types.js";
import { AppError } from "../common/errors.js";
import { readFileSnippet } from "../project/fileSnippet.js";
import { analyzeQuery } from "./queryAnalyzer.js";
import { InMemoryEmbeddingProvider } from "./embedding.js";
import { SQLiteStore } from "../storage/sqliteStore.js";

// 共享的嵌入实例
let embeddingProvider: InMemoryEmbeddingProvider | null = null;

function getEmbeddingProvider(): InMemoryEmbeddingProvider {
  if (!embeddingProvider) {
    embeddingProvider = new InMemoryEmbeddingProvider();
  }
  return embeddingProvider;
}

const SUPPORTED_SEARCH_LANGUAGES = new Set<SupportedLanguage>(["java", "javascript", "dotnet", "python"]);
const SEARCH_FANOUT_LIMIT = 50;
const SEARCH_FANOUT_MULTIPLIER = 3;
const SEARCH_MATCH_SOURCES = new Set<SearchMatchSource>(["lexical", "path", "symbol", "semantic"]);
const NON_ASCII_PATTERN = /[^\x00-\x7F]/;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function clampSnippet(snippet: string, maxLength = 1200): string {
  if (snippet.length <= maxLength) {
    return snippet;
  }

  return `${snippet.slice(0, maxLength)}\n...`;
}

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function normalizeComparablePath(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasBoundaryMatch(text: string, token: string): boolean {
  if (!text || !token) {
    return false;
  }

  return new RegExp(`(^|[\\s/_.#$-])${escapeRegExp(token)}(?=$|[\\s/_.#$-])`).test(text);
}

function countCoveredTokens(fields: string[], tokens: string[]): number {
  return tokens.filter((token) => fields.some((field) => field.includes(token))).length;
}

function countReasons(reason: string): number {
  return new Set(reason.split("+").filter(Boolean)).size;
}

function containsUnicodeToken(tokens: string[]): boolean {
  return tokens.some((token) => NON_ASCII_PATTERN.test(token));
}

function isCjkToken(token: string): boolean {
  return CJK_PATTERN.test(token);
}

function parseMatchedSources(reason: string): SearchMatchSource[] {
  return [...new Set(reason.split("+").filter((value): value is SearchMatchSource => SEARCH_MATCH_SOURCES.has(value as SearchMatchSource)))];
}

function scoreMergedResult(
  result: SearchResult,
  analysis: QueryAnalysis,
): { explanation: SearchResultExplanation; score: number } {
  const normalizedQuery = normalizeText(analysis.rawQuery.trim());
  const normalizedPathQuery = normalizeComparablePath(analysis.rawQuery);
  const normalizedPath = normalizeComparablePath(result.filePath);
  const basename = path.posix.basename(normalizedPath);
  const basenameWithoutExtension = basename.replace(/\.[^.]+$/, "");
  const normalizedSymbol = normalizeText(result.symbol ?? "");
  const normalizedSnippet = normalizeText(result.snippet);
  const searchableFields = [normalizedPath, basename, basenameWithoutExtension, normalizedSymbol, normalizedSnippet].filter(Boolean);
  const matchedSources = parseMatchedSources(result.reason);
  const matchedTokens = analysis.tokens.filter((token) => searchableFields.some((field) => field.includes(token)));
  const explanation: SearchResultExplanation = {
    matchedSources,
    matchedTokens,
  };

  let score = result.score;
  const coveredTokenCount = matchedTokens.length;
  if (analysis.tokens.length > 0) {
    explanation.tokenCoverage = {
      matched: coveredTokenCount,
      total: analysis.tokens.length,
    };
    score += (coveredTokenCount / analysis.tokens.length) * 0.45;
    if (coveredTokenCount === analysis.tokens.length && analysis.tokens.length > 1) {
      score += 0.18;
    }
  }

  score += Math.max(0, countReasons(result.reason) - 1) * 0.14;
  if (matchedSources.length > 1) {
    explanation.multiSource = true;
  }

  if (normalizedQuery.length > 0) {
    if (analysis.tokens.length > 1 && normalizedSnippet.includes(normalizedQuery)) {
      score += 0.45;
      explanation.snippetMatch = "query";
    }

    if (normalizedPath === normalizedPathQuery) {
      score += 1.25;
      explanation.pathMatch = "exact";
    } else if (basename === normalizedPathQuery || basenameWithoutExtension === normalizedPathQuery) {
      score += 0.95;
      explanation.pathMatch = "basename";
    } else if (analysis.isPathLike && normalizedPath.endsWith(`/${normalizedPathQuery}`)) {
      score += 0.85;
      explanation.pathMatch = "suffix";
    } else if (analysis.isPathLike && normalizedPath.startsWith(normalizedPathQuery)) {
      score += 0.55;
      explanation.pathMatch = "prefix";
    }

    if (normalizedSymbol) {
      if (normalizedSymbol === normalizedQuery) {
        score += 1.15;
        explanation.symbolMatch = "exact";
      } else if (
        normalizedSymbol.endsWith(`.${normalizedQuery}`) ||
        normalizedSymbol.endsWith(`#${normalizedQuery}`) ||
        normalizedSymbol.endsWith(`$${normalizedQuery}`)
      ) {
        score += 0.8;
        explanation.symbolMatch = "qualified-suffix";
      }
    }

    if (normalizedSnippet.includes(normalizedQuery)) {
      score += 0.2;
      explanation.snippetMatch = "query";
    }
  }

  for (const token of analysis.tokens) {
    if (normalizedSymbol && hasBoundaryMatch(normalizedSymbol, token)) {
      score += 0.16;
      explanation.symbolMatch ??= "boundary";
    }

    if (basename === token || basenameWithoutExtension === token) {
      score += 0.22;
      explanation.pathMatch ??= "basename";
    } else if (hasBoundaryMatch(basenameWithoutExtension, token)) {
      score += 0.1;
      explanation.pathMatch ??= "boundary";
    }

    if (analysis.isPathLike && hasBoundaryMatch(normalizedPath, token)) {
      score += 0.06;
      explanation.pathMatch ??= "boundary";
    }

    if (isCjkToken(token) && normalizedSnippet.includes(token)) {
      score += 0.08;
    }
  }

  if (result.reason.includes("symbol") && normalizedSymbol) {
    score += 0.1;
  }

  if (result.reason.includes("path") && analysis.isPathLike) {
    score += 0.1;
  }

  if (result.reason.includes("semantic")) {
    score += analysis.isPathLike || analysis.isSymbolLike ? 0.04 : 0.16;
  }

  return {
    explanation,
    score,
  };
}

function choosePreferredResult(existing: SearchResult, incoming: SearchResult, analysis: QueryAnalysis): SearchResult {
  const existingScored = scoreMergedResult(existing, analysis);
  const incomingScored = scoreMergedResult(incoming, analysis);
  if (incomingScored.score > existingScored.score) {
    return {
      ...incoming,
      explanation: incomingScored.explanation,
      score: incomingScored.score,
    };
  }

  return {
    ...existing,
    explanation: existingScored.explanation,
    score: existingScored.score,
  };
}

function dedupeSameFileResults(results: SearchResult[], analysis: QueryAnalysis, perFileLimit = 2): SearchResult[] {
  const grouped = new Map<string, SearchResult[]>();
  for (const result of results) {
    const current = grouped.get(result.filePath) ?? [];
    current.push(result);
    grouped.set(result.filePath, current);
  }

  const deduped: SearchResult[] = [];
  for (const fileResults of grouped.values()) {
    const mergedBySymbol = new Map<string, SearchResult>();
    for (const result of fileResults) {
      const key = result.symbol ? `symbol:${result.symbol}` : `range:${result.startLine}:${result.endLine}`;
      const existing = mergedBySymbol.get(key);
      if (!existing) {
        mergedBySymbol.set(key, result);
        continue;
      }

      const reasons = new Set([...existing.reason.split("+"), ...result.reason.split("+")]);
      const preferred = choosePreferredResult(
        {
          ...existing,
          reason: [...reasons].sort().join("+"),
          score: existing.score + result.score,
        },
        {
          ...result,
          reason: [...reasons].sort().join("+"),
          score: existing.score + result.score,
        },
        analysis,
      );
      mergedBySymbol.set(key, preferred);
    }

    const ranked = [...mergedBySymbol.values()]
      .map((result) => {
        const scored = scoreMergedResult(result, analysis);
        return {
          ...result,
          explanation: scored.explanation,
          score: scored.score,
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          countReasons(right.reason) - countReasons(left.reason) ||
          left.startLine - right.startLine,
      )
      .slice(0, perFileLimit);

    deduped.push(...ranked);
  }

  return deduped;
}

function rerankResults(results: SearchResult[], analysis: QueryAnalysis, limit: number): SearchResult[] {
  return dedupeSameFileResults(results, analysis)
    .map((result) => {
      const scored = scoreMergedResult(result, analysis);
      return {
        ...result,
        explanation: scored.explanation,
        score: scored.score,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        countReasons(right.reason) - countReasons(left.reason) ||
        left.filePath.length - right.filePath.length ||
        left.filePath.localeCompare(right.filePath),
    )
    .slice(0, limit);
}

function buildExpandedUnicodeTokens(analysis: QueryAnalysis): string[] {
  const expanded = new Set(analysis.tokens);
  for (const token of analysis.tokens) {
    if (isCjkToken(token) && [...token].length > 1) {
      for (let index = 0; index < token.length - 1; index += 1) {
        const part = token.slice(index, index + 2);
        if (part.length >= 2) {
          expanded.add(part);
        }
      }
    }
  }

  return [...expanded];
}

function applyResultMode(results: SearchResult[], resultMode: SearchResultMode): SearchResult[] {
  if (resultMode === "full") {
    return results.map((result) => ({
      ...result,
      snippetIncluded: true,
    }));
  }

  return results.map((result) => ({
    ...result,
    snippet: "",
    snippetIncluded: false,
  }));
}

function mergeResults(resultSets: SearchResult[][]): SearchResult[] {
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

  return [...byLocation.values()];
}

function normalizeIncludeContextLines(includeContextLines: number | undefined): number {
  if (includeContextLines === undefined || Number.isNaN(includeContextLines)) {
    return DEFAULT_INCLUDE_CONTEXT_LINES;
  }

  return Math.min(
    MAX_INCLUDE_CONTEXT_LINES,
    Math.max(DEFAULT_INCLUDE_CONTEXT_LINES, Math.trunc(includeContextLines)),
  );
}

function normalizePathPrefix(pathPrefix: string | undefined): string | undefined {
  if (!pathPrefix) {
    return undefined;
  }

  const normalized = pathPrefix.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePathContains(pathContains: string | undefined): string | undefined {
  return normalizePathPrefix(pathContains);
}

function normalizeSearchFilters(filters: SearchFilters | undefined): SearchFilters | undefined {
  if (!filters) {
    return undefined;
  }

  const languages = filters.languages
    ? [...new Set(filters.languages.filter((language): language is SupportedLanguage => SUPPORTED_SEARCH_LANGUAGES.has(language)))]
    : undefined;
  const excludePathPrefix = normalizePathPrefix(filters.excludePathPrefix);
  const pathContains = normalizePathContains(filters.pathContains);
  const pathPrefix = normalizePathPrefix(filters.pathPrefix);

  if ((!languages || languages.length === 0) && !pathPrefix && !pathContains && !excludePathPrefix) {
    return undefined;
  }

  return {
    excludePathPrefix,
    languages: languages && languages.length > 0 ? languages : undefined,
    pathContains,
    pathPrefix,
  };
}

async function expandResultSnippets(
  projectRootPath: string,
  results: SearchResult[],
  includeContextLines: number,
): Promise<SearchResult[]> {
  if (includeContextLines === DEFAULT_INCLUDE_CONTEXT_LINES) {
    return results;
  }

  return Promise.all(
    results.map(async (result) => {
      const snippet = await readFileSnippet(
        projectRootPath,
        result.filePath,
        result.startLine - includeContextLines,
        result.endLine + includeContextLines,
      );

      return {
        ...result,
        endLine: snippet.endLine,
        snippet: snippet.snippet,
        startLine: snippet.startLine,
      };
    }),
  );
}

function buildResultSourceBreakdown(results: SearchResult[]): Partial<Record<SearchMatchSource, number>> {
  const breakdown: Partial<Record<SearchMatchSource, number>> = {};
  for (const result of results) {
    for (const source of parseMatchedSources(result.reason)) {
      breakdown[source] = (breakdown[source] ?? 0) + 1;
    }
  }

  return breakdown;
}

const SEARCH_CACHE_MAX_SIZE = 100;
const SEARCH_CACHE_TTL_MS = 60 * 1000; // 1 minute

interface SearchCacheEntry {
  response: SearchResponse;
  timestamp: number;
}

export class SearchService {
  private readonly searchCache = new Map<string, SearchCacheEntry>();

  public constructor(
    private readonly store: SQLiteStore,
    private readonly logger: Logger,
    private readonly settings: Settings,
  ) {}

  private buildCacheKey(
    projectId: string,
    indexVersion: number,
    query: string,
    mode: SearchMode,
    topK: number,
    filters?: SearchFilters,
    resultMode?: SearchResultMode,
  ): string {
    return JSON.stringify({ filters, indexVersion, mode, projectId, query, resultMode, topK });
  }

  private evictSearchCache(): void {
    const now = Date.now();
    // 先清理过期条目
    for (const [key, entry] of this.searchCache) {
      if (now - entry.timestamp > SEARCH_CACHE_TTL_MS) {
        this.searchCache.delete(key);
      }
    }
    // 如果仍然超过限制，删除最旧的条目
    if (this.searchCache.size > SEARCH_CACHE_MAX_SIZE) {
      const entries = [...this.searchCache.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = entries.slice(0, this.searchCache.size - SEARCH_CACHE_MAX_SIZE);
      for (const [key] of toDelete) {
        this.searchCache.delete(key);
      }
    }
  }

  public clearSearchCache(projectId?: string): void {
    if (projectId) {
      for (const key of this.searchCache.keys()) {
        if (key.includes(projectId)) {
          this.searchCache.delete(key);
        }
      }
    } else {
      this.searchCache.clear();
    }
  }

  private async ensureProjectVectors(projectId: string, modelName: string): Promise<number> {
    const missingChunks = this.store.listChunksMissingVectors(projectId, modelName);
    if (missingChunks.length === 0) {
      return 0;
    }

    const provider = getEmbeddingProvider();
    const batchSize = Math.max(8, Math.min(64, this.settings.batchSize));
    let hydratedChunkCount = 0;

    for (let index = 0; index < missingChunks.length; index += batchSize) {
      const batch = missingChunks.slice(index, index + batchSize);
      const embeddings = await provider.embedBatch(batch.map((chunk) => chunk.content));
      this.store.writeChunkVectors(
        batch.map((chunk, embeddingIndex) => ({
          chunkId: chunk.chunkId,
          embedding: embeddings[embeddingIndex],
          modelName,
        })),
        projectId,
      );
      hydratedChunkCount += batch.length;
    }

    return hydratedChunkCount;
  }

  public async search(
    projectRootPath: string,
    query: string,
    mode: SearchMode,
    topK: number,
    includeContextLines = DEFAULT_INCLUDE_CONTEXT_LINES,
    filters?: SearchFilters,
    resultMode: SearchResultMode = "full",
  ): Promise<SearchResponse> {
    const startedAt = performance.now();
    const project = this.store.getProjectByRoot(projectRootPath);
    if (!project) {
      throw new AppError("PROJECT_NOT_INDEXED", `Project has not been indexed yet: ${projectRootPath}`);
    }

    // 检查缓存（semantic 模式需要重新检查向量缓存状态，不使用搜索缓存）
    const cacheKey = this.buildCacheKey(project.project_id, project.index_version, query, mode, topK, filters, resultMode);
    const cached = this.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SEARCH_CACHE_TTL_MS && mode !== "semantic" && mode !== "hybrid") {
      return {
        ...cached.response,
        notes: [...(cached.response.notes || []), "Cache hit"],
      };
    }

    const analysis = analyzeQuery(query);
    const notes: string[] = [];
    const resultSets: SearchResult[][] = [];
    const executedStrategies: SearchPhaseStat[] = [];
    const normalizedIncludeContextLines = normalizeIncludeContextLines(includeContextLines);
    const normalizedFilters = normalizeSearchFilters(filters);
    const fanoutLimit = Math.min(SEARCH_FANOUT_LIMIT, Math.max(topK, topK * SEARCH_FANOUT_MULTIPLIER));
    let vectorCacheHit = false;
    let vectorCandidateCount = 0;
    let vectorHydratedChunkCount = 0;

    const runPhase = async (
      name: string,
      enabled: boolean,
      operation: () => SearchResult[] | Promise<SearchResult[]>,
      reason: string,
    ): Promise<SearchResult[]> => {
      if (!enabled) {
        executedStrategies.push({
          candidateCount: 0,
          durationMs: 0,
          name,
          reason,
          skipped: true,
        });
        return [];
      }

      const phaseStartedAt = performance.now();
      try {
        const results = await operation();
        executedStrategies.push({
          candidateCount: results.length,
          durationMs: Math.round(performance.now() - phaseStartedAt),
          name,
        });
        return results;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("search phase failed", {
          error: message,
          phase: name,
          projectRootPath,
          query,
        });
        executedStrategies.push({
          candidateCount: 0,
          durationMs: Math.round(performance.now() - phaseStartedAt),
          error: message,
          name,
        });
        notes.push(`${name} failed: ${message}`);
        return [];
      }
    };

    const lexicalEnabled = (mode === "auto" || mode === "lexical" || mode === "hybrid") && Boolean(analysis.ftsQuery);
    resultSets.push(
      await runPhase(
        "lexical",
        lexicalEnabled,
        () => this.store.searchByText(project.project_id, analysis.ftsQuery ?? "", fanoutLimit, normalizedFilters),
        analysis.ftsQuery ? "mode-disabled" : "no-fts-query",
      ),
    );

    const semanticFtsEnabled =
      (mode === "semantic" ||
        mode === "hybrid" ||
        (mode === "auto" &&
          !analysis.isPathLike &&
          !analysis.isSymbolLike &&
          !analysis.hasIdentifierLikeSegments)) &&
      analysis.semanticTerms.length > 0;
    resultSets.push(
      await runPhase(
        "semantic-fts",
        semanticFtsEnabled,
        () => {
          this.store.ensureSemanticIndex(project.project_id);
          return this.store.searchBySemantic(project.project_id, analysis.semanticTerms, fanoutLimit, normalizedFilters);
        },
        analysis.semanticTerms.length > 0 ? "mode-disabled" : "no-semantic-terms",
      ),
    );

    const provider = getEmbeddingProvider();
    const vectorModelName = provider.getModelName();
    const vectorCoverage = this.store.getVectorCoverage(project.project_id, vectorModelName);
    const vectorEnabled = this.settings.enableVectorSearch && (mode === "semantic" || mode === "hybrid");
    resultSets.push(
      await runPhase(
        "vector",
        vectorEnabled,
        async () => {
          if (this.settings.vectorIndexingMode === "lazy") {
            vectorHydratedChunkCount = await this.ensureProjectVectors(project.project_id, vectorModelName);
            if (vectorHydratedChunkCount > 0) {
              notes.push(`Lazy vector hydration indexed ${vectorHydratedChunkCount} chunk vectors for this query.`);
            }
          }

          const queryEmbedding = await provider.embed(query);
          const vectorSearch = this.store.searchByVector(
            project.project_id,
            queryEmbedding,
            fanoutLimit,
            vectorModelName,
            normalizedFilters,
            project.index_version,
          );
          vectorCacheHit = vectorSearch.cacheHit;
          vectorCandidateCount = vectorSearch.candidateCount;
          return vectorSearch.results;
        },
        this.settings.enableVectorSearch ? "mode-disabled" : "vector-search-disabled",
      ),
    );

    const unicodeEnabled = (mode === "auto" || mode === "lexical" || mode === "hybrid") && containsUnicodeToken(analysis.tokens);
    resultSets.push(
      await runPhase(
        "unicode-substring",
        unicodeEnabled,
        () =>
          this.store.searchByTextSubstrings(
            project.project_id,
            buildExpandedUnicodeTokens(analysis),
            fanoutLimit,
            normalizedFilters,
          ),
        containsUnicodeToken(analysis.tokens) ? "mode-disabled" : "no-unicode-tokens",
      ),
    );

    const symbolEnabled = mode === "auto" || mode === "symbol" || mode === "hybrid" || analysis.isSymbolLike;
    resultSets.push(
      await runPhase(
        "symbol",
        symbolEnabled,
        () => this.store.searchBySymbols(project.project_id, analysis.tokens, fanoutLimit, normalizedFilters),
        "mode-disabled",
      ),
    );

    const pathEnabled = mode === "auto" || mode === "hybrid" || analysis.isPathLike;
    resultSets.push(
      await runPhase(
        "path",
        pathEnabled,
        () => this.store.searchByPath(project.project_id, analysis.tokens, fanoutLimit, normalizedFilters),
        analysis.isPathLike ? "mode-disabled" : "query-not-path-like",
      ),
    );

    const rerankStartedAt = performance.now();
    const mergedResults = mergeResults(resultSets);
    const rerankedResults = rerankResults(mergedResults, analysis, topK);
    executedStrategies.push({
      candidateCount: rerankedResults.length,
      durationMs: Math.round(performance.now() - rerankStartedAt),
      name: "rerank",
    });

    const snippetStartedAt = performance.now();
    const hydratedResults =
      resultMode === "full"
        ? await expandResultSnippets(
            projectRootPath,
            rerankedResults,
            normalizedIncludeContextLines,
          )
        : rerankedResults;
    executedStrategies.push({
      candidateCount: hydratedResults.length,
      durationMs: Math.round(performance.now() - snippetStartedAt),
      name: "snippet-expand",
      reason: resultMode === "full" ? undefined : "metadata-mode",
      skipped: resultMode !== "full",
    });
    const results = applyResultMode(hydratedResults, resultMode);
    const stats = this.store.getProjectStats(projectRootPath);
    const searchMs = Math.round(performance.now() - startedAt);
    const diagnostics: SearchDiagnostics = {
      candidateCount: mergedResults.length,
      executedStrategies,
      queryAnalysis: analysis,
      resultSourceBreakdown: buildResultSourceBreakdown(results),
      vectorIndex: {
        cacheHit: vectorCacheHit,
        candidateCount: vectorCandidateCount,
        enabled: this.settings.enableVectorSearch,
        hydratedChunkCount: vectorHydratedChunkCount,
        mode: this.settings.vectorIndexingMode,
      },
    };

    if (!this.settings.enableVectorSearch) {
      notes.push("Vector search is disabled in settings; semantic results came from semantic FTS only.");
    } else if (this.settings.vectorIndexingMode === "lazy" && vectorCoverage.missingChunkCount > 0 && vectorHydratedChunkCount === 0) {
      notes.push("Vector coverage was already warm for this query; no lazy hydration was needed.");
    }

    this.logger.info("search completed", {
      candidateCount: mergedResults.length,
      mode,
      projectRootPath,
      query,
      resultCount: results.length,
      resultMode,
      searchMs,
      topK,
      vectorCacheHit,
      vectorCandidateCount,
      vectorHydratedChunkCount,
    });

    const response: SearchResponse = {
      diagnostics,
      notes,
      projectRootPath,
      query,
      resultMode,
      results,
      stats: {
        indexedFiles: stats?.fileCount ?? 0,
        resultCount: results.length,
        scannedFiles: stats?.latestIndexEvent?.scannedFiles ?? stats?.fileCount ?? 0,
        searchMs,
      },
    };

    // 写入搜索缓存
    this.searchCache.set(cacheKey, { response, timestamp: Date.now() });
    this.evictSearchCache();

    return response;
  }
}

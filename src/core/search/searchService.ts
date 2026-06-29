import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Logger } from "../common/logger.js";
import {
  type CallGraphMatch,
  type CallGraphSearchResponse,
  DEFAULT_CALL_GRAPH_DEPTH,
  DEFAULT_INCLUDE_CONTEXT_LINES,
  DEFAULT_SEARCH_BUDGET,
  type DefinitionMatch,
  type DefinitionSearchResponse,
  MAX_CALL_GRAPH_DEPTH,
  MAX_INCLUDE_CONTEXT_LINES,
  type IndexedFileRecord,
  type QueryAnalysis,
  type ReferenceSearchResponse,
  type SearchBudget,
  type SearchDiagnostics,
  type SearchFilters,
  type SearchMatchSource,
  type SearchMode,
  type SearchPhaseStat,
  type SearchQualityCaseInput,
  type SearchQualityCaseResult,
  type SearchQualityEvaluation,
  type SearchResponse,
  type SearchResultExplanation,
  type SearchResultMode,
  type SearchResult,
  type Settings,
  type SupportedLanguage,
} from "../common/types.js";
import { AppError } from "../common/errors.js";
import { readFileSnippet } from "../project/fileSnippet.js";
import { analyzeQuery, buildFtsQuery } from "./queryAnalyzer.js";
import type { EmbeddingProvider } from "./embedding.js";
import { SQLiteStore } from "../storage/sqliteStore.js";
import { SQLiteSearchWorkerClient } from "../storage/sqliteSearchWorkerClient.js";
import { collectPositiveStructuredTerms, parseStructuredQuery, type StructuredQueryTerm } from "./structuredQuery.js";
import {
  SEARCH_FANOUT_LIMIT,
  SEARCH_FANOUT_MULTIPLIER,
  STRUCTURED_SEARCH_FANOUT_LIMIT,
  buildStructuredQueryAnalysis,
  containsUnicodeToken,
  evaluateStructuredNode,
  expandCallGraphSnippets,
  expandDefinitionSnippets,
  expandResultSnippets,
  matchesIndexedFileFilters,
  normalizeCallGraphDepth,
  normalizeComparablePath,
  normalizeIncludeContextLines,
  normalizeSearchFilters,
  withTimeout,
} from "./searchHelpers.js";
import {
  applyCallGraphResultMode,
  applyDefinitionResultMode,
  applyResultMode,
  buildExpandedUnicodeTokens,
  buildResultSourceBreakdown,
  getDynamicPerFileLimit,
  mergeDefinitionMatches,
  mergeResults,
  rerankResults,
} from "./searchScoring.js";

const SEARCH_CACHE_MAX_SIZE_DEFAULT = 100;

const SEARCH_CACHE_TTL_MS_DEFAULT = 60 * 1000; // 1 minute

interface SearchCacheEntry {
  response: SearchResponse;
  timestamp: number;
}

export class SearchService {
  /** Nested cache: projectId -> (cacheKey -> entry) for efficient per-project eviction */
  private readonly searchCache = new Map<string, Map<string, SearchCacheEntry>>();
  private readonly sqliteSearchWorker: SQLiteSearchWorkerClient;
  private searchCacheSize = 0;

  private get cacheTtlMs(): number {
    return this.settings.searchCacheTtlMs || SEARCH_CACHE_TTL_MS_DEFAULT;
  }

  private get cacheMaxSize(): number {
    return this.settings.searchCacheMaxSize || SEARCH_CACHE_MAX_SIZE_DEFAULT;
  }

  public constructor(
    private readonly store: SQLiteStore,
    private readonly logger: Logger,
    private readonly settings: Settings,
    private readonly embeddingProvider: EmbeddingProvider,
  ) {
    this.sqliteSearchWorker = new SQLiteSearchWorkerClient(
      {
        databasePath: this.store.getDatabasePath(),
        logFilePath: this.settings.logFilePath,
        logLevel: this.settings.logLevel,
      },
      this.logger,
    );
  }

  private buildCacheKey(
    projectId: string,
    indexVersion: number,
    query: string,
    mode: SearchMode,
    topK: number,
    filters?: SearchFilters,
    resultMode?: SearchResultMode,
  ): { key: string; projectId: string } {
    return {
      key: JSON.stringify({ filters, indexVersion, mode, projectId, query, resultMode, topK }),
      projectId,
    };
  }

  private evictSearchCache(): void {
    const now = Date.now();
    const ttl = this.cacheTtlMs;
    // Evict expired entries
    for (const [pid, entries] of this.searchCache) {
      for (const [key, entry] of entries) {
        if (now - entry.timestamp > ttl) {
          entries.delete(key);
          this.searchCacheSize--;
        }
      }
      if (entries.size === 0) {
        this.searchCache.delete(pid);
      }
    }

    // Evict oldest if over max.
    // v4.6.0 (#35): entries are only inserted on miss and never re-set, so each
    // per-project Map's insertion order is chronological — the globally oldest entry
    // is always one of the per-project heads. Compare heads (k-way) instead of
    // collecting and sorting every entry (O(evicted × projects) vs O(n log n)).
    while (this.searchCacheSize > this.cacheMaxSize) {
      let oldestPid: string | undefined;
      let oldestKey: string | undefined;
      let oldestTs = Infinity;
      for (const [pid, entries] of this.searchCache) {
        const head = entries.entries().next().value as [string, SearchCacheEntry] | undefined;
        if (head && head[1].timestamp < oldestTs) {
          oldestTs = head[1].timestamp;
          oldestPid = pid;
          oldestKey = head[0];
        }
      }
      if (oldestPid === undefined || oldestKey === undefined) break;
      const entries = this.searchCache.get(oldestPid)!;
      entries.delete(oldestKey);
      this.searchCacheSize--;
      if (entries.size === 0) {
        this.searchCache.delete(oldestPid);
      }
    }
  }

  /** Return cache diagnostics */
  public getCacheStats(): { projectCount: number; totalEntries: number; maxSize: number; ttlMs: number } {
    return {
      maxSize: this.cacheMaxSize,
      projectCount: this.searchCache.size,
      totalEntries: this.searchCacheSize,
      ttlMs: this.cacheTtlMs,
    };
  }

  public clearSearchCache(projectId?: string): void {
    if (projectId) {
      const entries = this.searchCache.get(projectId);
      if (entries) {
        this.searchCacheSize -= entries.size;
        this.searchCache.delete(projectId);
      }
      return;
    }

    this.searchCache.clear();
    this.searchCacheSize = 0;
  }

  public async close(): Promise<void> {
    await this.sqliteSearchWorker.close();
  }

  private async ensureProjectVectors(projectId: string, modelName: string): Promise<number> {
    const missingChunks = this.store.listChunksMissingVectors(projectId, modelName);
    if (missingChunks.length === 0) {
      return 0;
    }

    const provider = this.embeddingProvider;
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

  private async searchPlainQuery(
    projectRootPath: string,
    query: string,
    mode: SearchMode,
    topK: number,
    includeContextLines = DEFAULT_INCLUDE_CONTEXT_LINES,
    filters?: SearchFilters,
    resultMode: SearchResultMode = "full",
    budget: SearchBudget = DEFAULT_SEARCH_BUDGET,
  ): Promise<SearchResponse> {
    const startedAt = performance.now();
    const deadline = startedAt + budget.totalMs;
    const timedOutPhases: string[] = [];
    const project = this.store.getProjectByRoot(projectRootPath);
    if (!project) {
      throw new AppError("PROJECT_NOT_INDEXED", `Project has not been indexed yet: ${projectRootPath}`);
    }

    const { key: cacheKey, projectId: cacheProjectId } = this.buildCacheKey(project.project_id, project.index_version, query, mode, topK, filters, resultMode);
    const projectCache = this.searchCache.get(cacheProjectId);
    const cached = projectCache?.get(cacheKey);
    // Cache is valid for ALL modes (including semantic/hybrid) when indexVersion matches
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
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
    const fanoutLimit = Math.min(this.settings.searchFanoutLimit || SEARCH_FANOUT_LIMIT, Math.max(topK, topK * (this.settings.searchFanoutMultiplier || SEARCH_FANOUT_MULTIPLIER)));
    let vectorCacheHit = false;
    let vectorCandidateCount = 0;
    let vectorHydratedChunkCount = 0;
    let vectorSkippedNoVectors = false;

    const runPhase = async (
      name: string,
      enabled: boolean,
      operation: () => SearchResult[] | Promise<SearchResult[]>,
      reason: string,
      phaseBudgetMs?: number,
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

      // Check if we've exceeded total budget
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        executedStrategies.push({
          candidateCount: 0,
          durationMs: 0,
          name,
          reason: "total-budget-exceeded",
          skipped: true,
          timedOut: true,
        });
        timedOutPhases.push(name);
        return [];
      }

      const phaseStartedAt = performance.now();
      const effectiveBudget = Math.min(remainingMs, phaseBudgetMs ?? remainingMs);

      try {
        const operationPromise = Promise.resolve(operation());
        const { result: results, timedOut } = await withTimeout(
          operationPromise,
          effectiveBudget,
          [] as SearchResult[],
        );

        const durationMs = Math.round(performance.now() - phaseStartedAt);
        if (timedOut) {
          timedOutPhases.push(name);
          this.logger.warn("search phase timed out", {
            budgetMs: effectiveBudget,
            durationMs,
            phase: name,
            projectRootPath,
            query,
          });
        }

        executedStrategies.push({
          candidateCount: results.length,
          durationMs,
          name,
          timedOut,
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
    const semanticFtsEnabled =
      (mode === "semantic" ||
        mode === "hybrid" ||
        (mode === "auto" &&
          !analysis.isPathLike &&
          !analysis.isSymbolLike &&
          !analysis.hasIdentifierLikeSegments)) &&
      analysis.semanticTerms.length > 0;
    const unicodeEnabled = (mode === "auto" || mode === "lexical" || mode === "hybrid") && containsUnicodeToken(analysis.tokens);
    const symbolEnabled = mode === "auto" || mode === "symbol" || mode === "hybrid" || analysis.isSymbolLike;
    const pathEnabled = mode === "auto" || mode === "hybrid" || analysis.isPathLike;

    // v4.2.3: Run FTS phases in parallel for better performance
    const parallelStartedAt = performance.now();
    const [lexicalResults, semanticFtsResults, unicodeResults, symbolResults, pathResults] = await Promise.all([
      runPhase(
        "lexical",
        lexicalEnabled,
        () => this.sqliteSearchWorker.searchByText(project.project_id, analysis.ftsQuery ?? "", fanoutLimit, normalizedFilters),
        analysis.ftsQuery ? "mode-disabled" : "no-fts-query",
        budget.ftsMs,
      ),
      runPhase(
        "semantic-fts",
        semanticFtsEnabled,
        () => this.sqliteSearchWorker.searchBySemantic(project.project_id, analysis.semanticTerms, fanoutLimit, normalizedFilters),
        analysis.semanticTerms.length > 0 ? "mode-disabled" : "no-semantic-terms",
        budget.ftsMs,
      ),
      runPhase(
        "unicode-substring",
        unicodeEnabled,
        () =>
          this.sqliteSearchWorker.searchByTextSubstrings(
            project.project_id,
            buildExpandedUnicodeTokens(analysis),
            fanoutLimit,
            normalizedFilters,
          ),
        containsUnicodeToken(analysis.tokens) ? "mode-disabled" : "no-unicode-tokens",
        budget.ftsMs,
      ),
      runPhase(
        "symbol",
        symbolEnabled,
        () => this.sqliteSearchWorker.searchBySymbols(project.project_id, analysis.tokens, fanoutLimit, normalizedFilters),
        "mode-disabled",
        budget.symbolMs,
      ),
      runPhase(
        "path",
        pathEnabled,
        () => this.sqliteSearchWorker.searchByPath(project.project_id, analysis.tokens, fanoutLimit, normalizedFilters),
        analysis.isPathLike ? "mode-disabled" : "query-not-path-like",
        budget.symbolMs,
      ),
    ]);
    const parallelDurationMs = Math.round(performance.now() - parallelStartedAt);
    notes.push(`Parallel FTS phases completed in ${parallelDurationMs}ms`);

    resultSets.push(lexicalResults, semanticFtsResults, unicodeResults, symbolResults, pathResults);

    // v4.2.3: Collect chunkIds from FTS results for candidate prefiltering
    const ftsChunkIds = new Set<string>();
    for (const results of [lexicalResults, semanticFtsResults, unicodeResults]) {
      for (const result of results) {
        if (result.chunkId) {
          ftsChunkIds.add(result.chunkId);
        }
      }
    }

    const provider = this.embeddingProvider;
    const vectorModelName = provider.getModelName();
    const vectorCoverage = this.store.getVectorCoverage(project.project_id, vectorModelName);

    // v4.2.2: Check if vectors are available BEFORE enabling vector search
    // Do NOT do lazy hydration in the search path - it blocks for minutes
    const hasVectors = this.store.hasVectorIndex(project.project_id, vectorModelName);
    const vectorModeRequested = mode === "semantic" || mode === "hybrid";
    let effectiveVectorEnabled = this.settings.enableVectorSearch && vectorModeRequested && hasVectors;
    let vectorPrefiltered = false;

    // If vectors are requested but not available, add a note and skip
    if (this.settings.enableVectorSearch && vectorModeRequested && !hasVectors) {
      vectorSkippedNoVectors = true;
      notes.push("Vector search skipped: vectors not yet indexed. Run index_project first or enable eager vector indexing.");
    }

    resultSets.push(
      await runPhase(
        "vector",
        effectiveVectorEnabled,
        async () => {
          // v4.2.2: REMOVED lazy vector hydration from search path
          // Vectors should be built during indexing, not during search
          // v4.2.4: Use embedQuery with caching for query vectors
          const queryEmbedding = await provider.embedQuery(query, true);

          // v4.2.3: Use FTS results as candidate set for vector search if available
          // This reduces O(n) to O(ftsChunkIds.size) for most queries
          const candidateChunkIds = ftsChunkIds.size > 0 ? ftsChunkIds : undefined;
          const vectorSearch = this.store.searchByVector(
            project.project_id,
            queryEmbedding,
            fanoutLimit,
            vectorModelName,
            normalizedFilters,
            project.index_version,
            candidateChunkIds,
          );
          vectorCacheHit = vectorSearch.cacheHit;
          vectorCandidateCount = vectorSearch.candidateCount;
          vectorPrefiltered = vectorSearch.prefiltered;
          if (vectorPrefiltered) {
            notes.push(`Vector search prefiltered to ${ftsChunkIds.size} candidates from FTS results`);
          }
          return vectorSearch.results;
        },
        vectorSkippedNoVectors ? "no-vectors-available" : (this.settings.enableVectorSearch ? "mode-disabled" : "vector-search-disabled"),
        budget.vectorMs,
      ),
    );

    const rerankStartedAt = performance.now();
    let mergedResults = mergeResults(resultSets);
    let rerankedResults = rerankResults(mergedResults, analysis, topK, getDynamicPerFileLimit(analysis, this.settings.searchPerFileLimit || 2));

    // v4.5.1: Identifier-priority boost. When the query contains both code identifiers
    // and natural language (CJK or English), the FTS match is diluted by NL tokens.
    // Run a focused identifier-only FTS search and boost matching results' scores.
    if (analysis.identifiers.length > 0 && analysis.naturalLanguage.length > 0) {
      try {
        const idFtsQuery = buildFtsQuery(analysis.identifiers, false);
        if (idFtsQuery) {
          const idResults = await this.sqliteSearchWorker.searchByText(
            project.project_id, idFtsQuery, topK * 3, normalizedFilters,
          );
          if (idResults.length > 0) {
            const boostMap = new Map<string, number>();
            for (const r of idResults) {
              const key = `${r.filePath}:${r.startLine}:${r.endLine}`;
              boostMap.set(key, (boostMap.get(key) ?? 0) + r.score * 0.5);
            }
            for (const r of rerankedResults) {
              const key = `${r.filePath}:${r.startLine}:${r.endLine}`;
              const boost = boostMap.get(key);
              if (boost) r.score += boost;
            }
            rerankedResults.sort((a, b) => b.score - a.score);
            notes.push(`Identifier boost applied: ${idResults.length} id-matches, ${boostMap.size} boosted`);
          }
        }
      } catch {
        // Identifier boost is best-effort; never fail the main search
      }
    }
    executedStrategies.push({
      candidateCount: rerankedResults.length,
      durationMs: Math.round(performance.now() - rerankStartedAt),
      name: "rerank",
    });

    const snippetStartedAt = performance.now();
    const hydratedResults =
      resultMode === "full"
        ? await expandResultSnippets(projectRootPath, rerankedResults, normalizedIncludeContextLines)
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
        skippedNoVectors: vectorSkippedNoVectors,
        prefiltered: vectorPrefiltered,
        prefilteredCandidates: vectorPrefiltered ? ftsChunkIds.size : undefined,
      },
      budget: {
        totalMs: budget.totalMs,
        usedMs: searchMs,
        timedOutPhases,
      },
    };

    if (!this.settings.enableVectorSearch) {
      notes.push("Vector search is disabled in settings; semantic results came from semantic FTS only.");
    } else if (vectorSkippedNoVectors) {
      // Note already added above
    } else if (this.settings.vectorIndexingMode === "lazy" && vectorCoverage.missingChunkCount > 0 && vectorHydratedChunkCount === 0) {
      notes.push("Vector coverage was already warm for this query; no lazy hydration was needed.");
    }

    if (timedOutPhases.length > 0) {
      notes.push(`Search phases timed out: ${timedOutPhases.join(", ")}. Results may be incomplete.`);
    }

    this.logger.info("search completed", {
      candidateCount: mergedResults.length,
      mode,
      parallelDurationMs,
      projectRootPath,
      query,
      resultCount: results.length,
      resultMode,
      searchMs,
      timedOutPhases: timedOutPhases.length > 0 ? timedOutPhases : undefined,
      topK,
      vectorCacheHit,
      vectorCandidateCount,
      vectorHydratedChunkCount,
      vectorSkippedNoVectors,
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

    // Store in nested cache
    if (!this.searchCache.has(project.project_id)) {
      this.searchCache.set(project.project_id, new Map());
    }
    this.searchCache.get(project.project_id)!.set(cacheKey, { response, timestamp: Date.now() });
    this.searchCacheSize++;
    this.evictSearchCache();

    return response;
  }

  private async runStructuredTermSearch(
    projectRootPath: string,
    projectId: string,
    term: StructuredQueryTerm,
    mode: SearchMode,
    limit: number,
    filters?: SearchFilters,
  ): Promise<SearchResult[]> {
    if (term.field === "path") {
      const analysis = analyzeQuery(term.value);
      const tokens = term.phrase
        ? [normalizeComparablePath(term.value)]
        : analysis.tokens.length > 0
          ? analysis.tokens
          : [normalizeComparablePath(term.value)];
      return this.sqliteSearchWorker.searchByPath(projectId, tokens, limit, filters);
    }

    if (term.field === "content") {
      if (term.phrase) {
        return this.sqliteSearchWorker.searchByTextSubstrings(projectId, [term.value], limit, filters);
      }
      return (await this.searchPlainQuery(projectRootPath, term.value, "lexical", limit, 0, filters, "metadata")).results;
    }

    if (term.field === "symbol") {
      return (await this.searchPlainQuery(projectRootPath, term.value, "symbol", limit, 0, filters, "metadata")).results;
    }

    return (await this.searchPlainQuery(projectRootPath, term.value, mode, limit, 0, filters, "metadata")).results;
  }

  private async searchStructuredQuery(
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

    const parsed = parseStructuredQuery(query);
    if (!parsed) {
      return this.searchPlainQuery(projectRootPath, query, mode, topK, includeContextLines, filters, resultMode);
    }

    const notes: string[] = [];
    const executedStrategies: SearchPhaseStat[] = [];
    const normalizedIncludeContextLines = normalizeIncludeContextLines(includeContextLines);
    const normalizedFilters = normalizeSearchFilters(filters);
    const fanoutLimit = Math.max(SEARCH_FANOUT_LIMIT, Math.min(STRUCTURED_SEARCH_FANOUT_LIMIT, topK * 10));
    const universe = new Set(
      this.store
        .listProjectFiles(project.project_id)
        .filter((file) => matchesIndexedFileFilters(file, normalizedFilters))
        .map((file) => file.relativePath),
    );
    const termMatches = new Map<string, Set<string>>();
    const termResults = new Map<string, SearchResult[]>();

    for (const term of parsed.terms) {
      const phaseStartedAt = performance.now();
      try {
        const results = await this.runStructuredTermSearch(
          projectRootPath,
          project.project_id,
          term,
          mode,
          fanoutLimit,
          normalizedFilters,
        );
        termResults.set(term.termId, results);
        termMatches.set(term.termId, new Set(results.map((result) => result.filePath)));
        executedStrategies.push({
          candidateCount: results.length,
          durationMs: Math.round(performance.now() - phaseStartedAt),
          name: `structured:${term.field ?? "auto"}`,
          reason: term.value,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        executedStrategies.push({
          candidateCount: 0,
          durationMs: Math.round(performance.now() - phaseStartedAt),
          error: message,
          name: `structured:${term.field ?? "auto"}`,
          reason: term.value,
        });
        notes.push(`Structured clause "${term.value}" failed: ${message}`);
      }
    }

    const matchedFiles = evaluateStructuredNode(parsed.root, termMatches, universe);
    const positiveTermIds = collectPositiveStructuredTerms(parsed.root);
    let mergedResults = mergeResults(
      [...positiveTermIds].map((termId) =>
        (termResults.get(termId) ?? []).filter((result) => matchedFiles.has(result.filePath)),
      ),
    );

    if (mergedResults.length === 0 && matchedFiles.size > 0) {
      mergedResults = await this.sqliteSearchWorker.getFilePreviewResults(project.project_id, [...matchedFiles].slice(0, fanoutLimit));
      notes.push("Structured query matched files through boolean filtering; returning file previews because no positive clause produced direct snippets.");
    }

    const analysis = buildStructuredQueryAnalysis(query, parsed);
    const rerankStartedAt = performance.now();
    const rerankedResults = rerankResults(mergedResults, analysis, topK, getDynamicPerFileLimit(analysis, this.settings.searchPerFileLimit || 2));
    executedStrategies.push({
      candidateCount: rerankedResults.length,
      durationMs: Math.round(performance.now() - rerankStartedAt),
      name: "rerank",
    });

    const snippetStartedAt = performance.now();
    const hydratedResults =
      resultMode === "full"
        ? await expandResultSnippets(projectRootPath, rerankedResults, normalizedIncludeContextLines)
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
    return {
      diagnostics: {
        candidateCount: mergedResults.length,
        executedStrategies,
        queryAnalysis: buildStructuredQueryAnalysis(query, parsed),
        resultSourceBreakdown: buildResultSourceBreakdown(results),
        vectorIndex: {
          cacheHit: false,
          candidateCount: 0,
          enabled: this.settings.enableVectorSearch,
          hydratedChunkCount: 0,
          mode: this.settings.vectorIndexingMode,
        },
      },
      notes,
      projectRootPath,
      query,
      resultMode,
      results,
      stats: {
        indexedFiles: stats?.fileCount ?? 0,
        resultCount: results.length,
        scannedFiles: stats?.latestIndexEvent?.scannedFiles ?? stats?.fileCount ?? 0,
        searchMs: Math.round(performance.now() - startedAt),
      },
    };
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
    return parseStructuredQuery(query)
      ? this.searchStructuredQuery(projectRootPath, query, mode, topK, includeContextLines, filters, resultMode)
      : this.searchPlainQuery(projectRootPath, query, mode, topK, includeContextLines, filters, resultMode);
  }

  public async findDefinitions(
    projectRootPath: string,
    query: string,
    topK: number,
    includeContextLines = DEFAULT_INCLUDE_CONTEXT_LINES,
    filters?: SearchFilters,
    resultMode: SearchResultMode = "full",
  ): Promise<DefinitionSearchResponse> {
    const startedAt = performance.now();
    const project = this.store.getProjectByRoot(projectRootPath);
    if (!project) {
      throw new AppError("PROJECT_NOT_INDEXED", `Project has not been indexed yet: ${projectRootPath}`);
    }

    const normalizedIncludeContextLines = normalizeIncludeContextLines(includeContextLines);
    const normalizedFilters = normalizeSearchFilters(filters);
    const definitions = mergeDefinitionMatches(
      this.store.findDefinitions(project.project_id, query, Math.max(topK * 3, SEARCH_FANOUT_LIMIT), normalizedFilters),
    ).slice(0, topK);
    const hydratedDefinitions =
      resultMode === "full"
        ? await expandDefinitionSnippets(projectRootPath, definitions, normalizedIncludeContextLines)
        : definitions;

    return {
      notes: definitions.length > 0 ? [] : ["No definitions matched the requested symbol query."],
      projectRootPath,
      query,
      resultMode,
      results: applyDefinitionResultMode(hydratedDefinitions, resultMode),
      stats: {
        resultCount: definitions.length,
        searchMs: Math.round(performance.now() - startedAt),
      },
    };
  }

  public async findReferences(
    projectRootPath: string,
    query: string,
    topK: number,
    includeContextLines = DEFAULT_INCLUDE_CONTEXT_LINES,
    filters?: SearchFilters,
    resultMode: SearchResultMode = "full",
  ): Promise<ReferenceSearchResponse> {
    const startedAt = performance.now();
    const project = this.store.getProjectByRoot(projectRootPath);
    if (!project) {
      throw new AppError("PROJECT_NOT_INDEXED", `Project has not been indexed yet: ${projectRootPath}`);
    }
    const definitionResponse = await this.findDefinitions(projectRootPath, query, topK, includeContextLines, filters, resultMode);
    const primaryDefinition = definitionResponse.results[0] ?? null;
    const notes = [...definitionResponse.notes];

    if (!primaryDefinition) {
      return {
        definition: null,
        definitions: definitionResponse.results,
        notes,
        projectRootPath,
        query,
        resultMode,
        results: [],
        stats: {
          definitionCount: 0,
          referenceCount: 0,
          searchMs: Math.round(performance.now() - startedAt),
        },
      };
    }

    if (definitionResponse.results.length > 1) {
      notes.push("Multiple definition candidates matched; references are ranked against the top definition.");
    }

    let referenceResults = this.store.findResolvedReferences(
      project.project_id,
      [primaryDefinition.symbolId],
      Math.max(topK * 4, SEARCH_FANOUT_LIMIT),
      normalizeSearchFilters(filters),
    );
    if (referenceResults.length === 0) {
      const referenceQueries = [...new Set(
        [primaryDefinition.name, primaryDefinition.fullName, primaryDefinition.canonicalName].filter(
          (value): value is string => Boolean(value),
        ),
      )];
      referenceResults = mergeResults(
        await Promise.all(
          referenceQueries.map(async (referenceQuery) => {
            const response = await this.searchPlainQuery(
              projectRootPath,
              referenceQuery,
              "lexical",
              Math.max(topK * 4, SEARCH_FANOUT_LIMIT),
              0,
              filters,
              "metadata",
            );
            return response.results;
          }),
        ),
      ).filter(
        (result) =>
          result.filePath !== primaryDefinition.filePath ||
          result.startLine > primaryDefinition.line ||
          result.endLine < primaryDefinition.line,
      );
      notes.push("Reference lookup fell back to lexical matching because no resolved graph matches were available.");
    }

    const analysis = analyzeQuery([primaryDefinition.name, primaryDefinition.fullName, primaryDefinition.canonicalName].filter(Boolean).join(" "));
    const rerankedResults = rerankResults(referenceResults, analysis, topK, getDynamicPerFileLimit(analysis, this.settings.searchPerFileLimit || 2));
    const normalizedIncludeContextLines = normalizeIncludeContextLines(includeContextLines);
    const hydratedResults =
      resultMode === "full"
        ? await expandResultSnippets(projectRootPath, rerankedResults, normalizedIncludeContextLines)
        : rerankedResults;

    return {
      definition: primaryDefinition,
      definitions: definitionResponse.results,
      notes,
      projectRootPath,
      query,
      resultMode,
      results: applyResultMode(hydratedResults, resultMode),
      stats: {
        definitionCount: definitionResponse.results.length,
        referenceCount: rerankedResults.length,
        searchMs: Math.round(performance.now() - startedAt),
      },
    };
  }

  private async findCallGraphDirection(
    projectRootPath: string,
    query: string,
    direction: "callers" | "callees",
    topK: number,
    includeContextLines = DEFAULT_INCLUDE_CONTEXT_LINES,
    filters?: SearchFilters,
    resultMode: SearchResultMode = "full",
    depth = DEFAULT_CALL_GRAPH_DEPTH,
  ): Promise<CallGraphSearchResponse> {
    const startedAt = performance.now();
    const project = this.store.getProjectByRoot(projectRootPath);
    if (!project) {
      throw new AppError("PROJECT_NOT_INDEXED", `Project has not been indexed yet: ${projectRootPath}`);
    }

    const definitionResponse = await this.findDefinitions(projectRootPath, query, topK, includeContextLines, filters, resultMode);
    const primaryDefinition = definitionResponse.results[0] ?? null;
    const notes = [...definitionResponse.notes];
    const normalizedDepth = normalizeCallGraphDepth(depth);
    if (!primaryDefinition) {
      return {
        definition: null,
        definitions: definitionResponse.results,
        direction,
        notes,
        projectRootPath,
        query,
        resultMode,
        results: [],
        stats: {
          depthReached: 0,
          depthRequested: normalizedDepth,
          definitionCount: 0,
          resultCount: 0,
          searchMs: Math.round(performance.now() - startedAt),
        },
      };
    }

    const normalizedFilters = normalizeSearchFilters(filters);
    const graphSymbolIds = [...new Set(definitionResponse.results.map((definition) => definition.symbolId))];
    const graphResults = this.store.findCallGraph(
      project.project_id,
      graphSymbolIds,
      direction,
      normalizedDepth,
      Math.max(topK * 4, SEARCH_FANOUT_LIMIT),
      normalizedFilters,
    );
    const normalizedIncludeContextLines = normalizeIncludeContextLines(includeContextLines);
    const hydratedResults =
      resultMode === "full"
        ? await expandCallGraphSnippets(projectRootPath, graphResults.slice(0, topK), normalizedIncludeContextLines)
        : graphResults.slice(0, topK);

    if (graphResults.length === 0) {
      notes.push(`No ${direction} were resolved from the indexed call graph for this symbol.`);
    }

    return {
      definition: primaryDefinition,
      definitions: definitionResponse.results,
      direction,
      notes,
      projectRootPath,
      query,
      resultMode,
      results: applyCallGraphResultMode(hydratedResults, resultMode),
      stats: {
        depthReached: graphResults.reduce((max, result) => Math.max(max, result.hopCount), 0),
        depthRequested: normalizedDepth,
        definitionCount: definitionResponse.results.length,
        resultCount: Math.min(graphResults.length, topK),
        searchMs: Math.round(performance.now() - startedAt),
      },
    };
  }

  public async findCallers(
    projectRootPath: string,
    query: string,
    topK: number,
    includeContextLines = DEFAULT_INCLUDE_CONTEXT_LINES,
    filters?: SearchFilters,
    resultMode: SearchResultMode = "full",
    depth = DEFAULT_CALL_GRAPH_DEPTH,
  ): Promise<CallGraphSearchResponse> {
    return this.findCallGraphDirection(projectRootPath, query, "callers", topK, includeContextLines, filters, resultMode, depth);
  }

  public async findCallees(
    projectRootPath: string,
    query: string,
    topK: number,
    includeContextLines = DEFAULT_INCLUDE_CONTEXT_LINES,
    filters?: SearchFilters,
    resultMode: SearchResultMode = "full",
    depth = DEFAULT_CALL_GRAPH_DEPTH,
  ): Promise<CallGraphSearchResponse> {
    return this.findCallGraphDirection(projectRootPath, query, "callees", topK, includeContextLines, filters, resultMode, depth);
  }

  public async evaluateSearchQuality(
    projectRootPath: string,
    cases: SearchQualityCaseInput[],
  ): Promise<SearchQualityEvaluation> {
    const project = this.store.getProjectByRoot(projectRootPath);
    if (!project) {
      throw new AppError("PROJECT_NOT_INDEXED", `Project has not been indexed yet: ${projectRootPath}`);
    }

    const results: SearchQualityCaseResult[] = [];
    for (const testCase of cases) {
      const mode = testCase.mode ?? "auto";
      const response = await this.search(
        projectRootPath,
        testCase.query,
        mode,
        testCase.topK ?? this.settings.defaultTopK,
        0,
        normalizeSearchFilters({
          excludePathPrefix: testCase.excludePathPrefix,
          languages: testCase.languages,
          pathContains: testCase.pathContains,
          pathPrefix: testCase.pathPrefix,
        }),
        "metadata",
      );

      const actualFiles = [...new Set(response.results.map((result) => result.filePath))];
      const expectedFiles = testCase.expectedFiles ?? [];
      const reasons: string[] = [];
      for (const expectedFile of expectedFiles) {
        if (!actualFiles.includes(expectedFile)) {
          reasons.push(`Missing expected file: ${expectedFile}`);
        }
      }

      if (testCase.expectedTopFile && actualFiles[0] !== testCase.expectedTopFile) {
        reasons.push(`Top result mismatch: expected ${testCase.expectedTopFile}, got ${actualFiles[0] ?? "none"}`);
      }

      const firstRelevantRank =
        expectedFiles.length > 0
          ? actualFiles.findIndex((filePath) => expectedFiles.includes(filePath)) + 1 || undefined
          : testCase.expectedTopFile
            ? (actualFiles[0] === testCase.expectedTopFile ? 1 : undefined)
            : undefined;

      results.push({
        actualFiles,
        expectedFiles,
        expectedTopFile: testCase.expectedTopFile,
        firstRelevantRank,
        mode,
        name: testCase.name,
        passed: reasons.length === 0,
        query: testCase.query,
        reasons,
        topFile: actualFiles[0],
      });
    }

    const passed = results.filter((result) => result.passed).length;
    const total = results.length;
    const top1Recall = total === 0 ? 1 : results.filter((result) => (result.firstRelevantRank ?? Number.POSITIVE_INFINITY) <= 1).length / total;
    const top5Recall = total === 0 ? 1 : results.filter((result) => (result.firstRelevantRank ?? Number.POSITIVE_INFINITY) <= 5).length / total;
    const meanReciprocalRank = total === 0 ? 1 : results.reduce((sum, result) => sum + (result.firstRelevantRank ? 1 / result.firstRelevantRank : 0), 0) / total;
    return {
      cases: results,
      projectRootPath,
      summary: {
        failed: total - passed,
        meanReciprocalRank,
        passRate: total === 0 ? 1 : passed / total,
        passed,
        top1Recall,
        top5Recall,
        total,
      },
    };
  }
}

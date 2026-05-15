import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Logger } from "../common/logger.js";
import {
  type CallGraphMatch,
  type CallGraphSearchResponse,
  DEFAULT_CALL_GRAPH_DEPTH,
  DEFAULT_INCLUDE_CONTEXT_LINES,
  type DefinitionMatch,
  type DefinitionSearchResponse,
  MAX_CALL_GRAPH_DEPTH,
  MAX_INCLUDE_CONTEXT_LINES,
  type IndexedFileRecord,
  type QueryAnalysis,
  type ReferenceSearchResponse,
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
import { analyzeQuery } from "./queryAnalyzer.js";
import type { EmbeddingProvider } from "./embedding.js";
import { SQLiteStore } from "../storage/sqliteStore.js";
import { collectPositiveStructuredTerms, parseStructuredQuery, type ParsedStructuredQuery, type StructuredQueryNode, type StructuredQueryTerm } from "./structuredQuery.js";

const SUPPORTED_SEARCH_LANGUAGES = new Set<SupportedLanguage>(["java", "javascript", "dotnet", "python"]);
const SEARCH_FANOUT_LIMIT = 50;
const SEARCH_FANOUT_MULTIPLIER = 3;
const STRUCTURED_SEARCH_FANOUT_LIMIT = 250;
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

function normalizeCallGraphDepth(depth: number | undefined): number {
  if (depth === undefined || Number.isNaN(depth)) {
    return DEFAULT_CALL_GRAPH_DEPTH;
  }

  return Math.min(MAX_CALL_GRAPH_DEPTH, Math.max(DEFAULT_CALL_GRAPH_DEPTH, Math.trunc(depth)));
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

function matchesIndexedFileFilters(
  file: Pick<IndexedFileRecord, "language" | "relativePath">,
  filters: SearchFilters | undefined,
): boolean {
  if (!filters) {
    return true;
  }

  const normalizedPath = normalizeComparablePath(file.relativePath);
  if (filters.languages && filters.languages.length > 0 && !filters.languages.includes(file.language as SupportedLanguage)) {
    return false;
  }

  if (filters.pathPrefix && !normalizedPath.startsWith(normalizeComparablePath(filters.pathPrefix))) {
    return false;
  }

  if (filters.pathContains && !normalizedPath.includes(normalizeComparablePath(filters.pathContains))) {
    return false;
  }

  if (filters.excludePathPrefix && normalizedPath.startsWith(normalizeComparablePath(filters.excludePathPrefix))) {
    return false;
  }

  return true;
}

function unionStringSets(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left, ...right]);
}

function intersectStringSets(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((value) => right.has(value)));
}

function differenceStringSets(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((value) => !right.has(value)));
}

function evaluateStructuredNode(
  node: StructuredQueryNode,
  matchesByTerm: Map<string, Set<string>>,
  universe: Set<string>,
): Set<string> {
  if (node.type === "term") {
    return new Set(matchesByTerm.get(node.termId) ?? []);
  }

  if (node.type === "not") {
    return differenceStringSets(universe, evaluateStructuredNode(node.operand, matchesByTerm, universe));
  }

  const left = evaluateStructuredNode(node.left, matchesByTerm, universe);
  const right = evaluateStructuredNode(node.right, matchesByTerm, universe);
  return node.type === "and" ? intersectStringSets(left, right) : unionStringSets(left, right);
}

function buildStructuredQueryAnalysis(query: string, parsed: ParsedStructuredQuery): QueryAnalysis {
  const effectiveQuery = parsed.terms.map((term) => term.value).join(" ").trim() || query;
  const analysis = analyzeQuery(effectiveQuery);
  return {
    ...analysis,
    structuredQuery: {
      fields: parsed.fields,
      isStructured: true,
      operators: parsed.operators,
      originalQuery: query,
      termCount: parsed.terms.length,
    },
  };
}

function mergeDefinitionMatches(results: DefinitionMatch[]): DefinitionMatch[] {
  const bySymbol = new Map<string, DefinitionMatch>();
  for (const result of results) {
    const key = `${result.filePath}:${result.line}:${result.fullName}`;
    const existing = bySymbol.get(key);
    if (!existing || result.score > existing.score) {
      bySymbol.set(key, result);
    }
  }

  return [...bySymbol.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.filePath.localeCompare(right.filePath) ||
      left.line - right.line,
  );
}

async function expandDefinitionSnippets(
  projectRootPath: string,
  results: DefinitionMatch[],
  includeContextLines: number,
): Promise<DefinitionMatch[]> {
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

function applyDefinitionResultMode(results: DefinitionMatch[], resultMode: SearchResultMode): DefinitionMatch[] {
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

async function expandCallGraphSnippets(
  projectRootPath: string,
  results: CallGraphMatch[],
  includeContextLines: number,
): Promise<CallGraphMatch[]> {
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

function applyCallGraphResultMode(results: CallGraphMatch[], resultMode: SearchResultMode): CallGraphMatch[] {
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
    private readonly embeddingProvider: EmbeddingProvider,
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
    for (const [key, entry] of this.searchCache) {
      if (now - entry.timestamp > SEARCH_CACHE_TTL_MS) {
        this.searchCache.delete(key);
      }
    }

    if (this.searchCache.size > SEARCH_CACHE_MAX_SIZE) {
      const entries = [...this.searchCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
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
      return;
    }

    this.searchCache.clear();
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
  ): Promise<SearchResponse> {
    const startedAt = performance.now();
    const project = this.store.getProjectByRoot(projectRootPath);
    if (!project) {
      throw new AppError("PROJECT_NOT_INDEXED", `Project has not been indexed yet: ${projectRootPath}`);
    }

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

    const provider = this.embeddingProvider;
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

    this.searchCache.set(cacheKey, { response, timestamp: Date.now() });
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
      return this.store.searchByPath(projectId, tokens, limit, filters);
    }

    if (term.field === "content") {
      if (term.phrase) {
        return this.store.searchByTextSubstrings(projectId, [term.value], limit, filters);
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
      mergedResults = this.store.getFilePreviewResults(project.project_id, [...matchedFiles].slice(0, fanoutLimit));
      notes.push("Structured query matched files through boolean filtering; returning file previews because no positive clause produced direct snippets.");
    }

    const analysis = buildStructuredQueryAnalysis(query, parsed);
    const rerankStartedAt = performance.now();
    const rerankedResults = rerankResults(mergedResults, analysis, topK);
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
    const rerankedResults = rerankResults(referenceResults, analysis, topK);
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
    const graphResults = this.store.findCallGraph(
      project.project_id,
      [primaryDefinition.symbolId],
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

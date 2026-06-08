import {
  type CallGraphMatch,
  DEFAULT_CALL_GRAPH_DEPTH,
  DEFAULT_INCLUDE_CONTEXT_LINES,
  type DefinitionMatch,
  MAX_CALL_GRAPH_DEPTH,
  MAX_INCLUDE_CONTEXT_LINES,
  type IndexedFileRecord,
  type QueryAnalysis,
  type SearchFilters,
  type SearchMatchSource,
  type SearchResult,
  type SupportedLanguage,
} from "../common/types.js";
import { readFileSnippet } from "../project/fileSnippet.js";
import { analyzeQuery } from "./queryAnalyzer.js";
import { type ParsedStructuredQuery, type StructuredQueryNode } from "./structuredQuery.js";

export const SUPPORTED_SEARCH_LANGUAGES = new Set<SupportedLanguage>(["java", "javascript", "dotnet", "python", "markdown"]);
export const SEARCH_FANOUT_LIMIT = 50;
export const SEARCH_FANOUT_MULTIPLIER = 3;
export const STRUCTURED_SEARCH_FANOUT_LIMIT = 250;
export const SEARCH_MATCH_SOURCES = new Set<SearchMatchSource>(["lexical", "path", "symbol", "semantic"]);
export const NON_ASCII_PATTERN = /[^\x00-\x7F]/;
export const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Execute a promise with a timeout. If the promise takes longer than timeoutMs,
 * it will be abandoned and the fallback value will be returned.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<{ result: T; timedOut: boolean }> {
  if (timeoutMs <= 0) {
    return { result: fallback, timedOut: true };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ result: T; timedOut: true }>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ result: fallback, timedOut: true });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      promise.then((r) => ({ result: r, timedOut: false as const })),
      timeoutPromise,
    ]);
    return result;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function clampSnippet(snippet: string, maxLength = 2400): string {
  if (snippet.length <= maxLength) {
    return snippet;
  }

  return `${snippet.slice(0, maxLength)}\n...`;
}

export function normalizeText(value: string): string {
  return value.toLowerCase();
}

export function normalizeComparablePath(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasBoundaryMatch(text: string, token: string): boolean {
  if (!text || !token) {
    return false;
  }

  return new RegExp(`(^|[\\s/_.#$-])${escapeRegExp(token)}(?=$|[\\s/_.#$-])`).test(text);
}

export function containsUnicodeToken(tokens: string[]): boolean {
  return tokens.some((token) => NON_ASCII_PATTERN.test(token));
}

export function isCjkToken(token: string): boolean {
  return CJK_PATTERN.test(token);
}

export function normalizeIncludeContextLines(includeContextLines: number | undefined): number {
  if (includeContextLines === undefined || Number.isNaN(includeContextLines)) {
    return DEFAULT_INCLUDE_CONTEXT_LINES;
  }

  return Math.min(
    MAX_INCLUDE_CONTEXT_LINES,
    Math.max(DEFAULT_INCLUDE_CONTEXT_LINES, Math.trunc(includeContextLines)),
  );
}

export function normalizeCallGraphDepth(depth: number | undefined): number {
  if (depth === undefined || Number.isNaN(depth)) {
    return DEFAULT_CALL_GRAPH_DEPTH;
  }

  return Math.min(MAX_CALL_GRAPH_DEPTH, Math.max(DEFAULT_CALL_GRAPH_DEPTH, Math.trunc(depth)));
}

export function normalizePathPrefix(pathPrefix: string | undefined): string | undefined {
  if (!pathPrefix) {
    return undefined;
  }

  const normalized = pathPrefix.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizePathContains(pathContains: string | undefined): string | undefined {
  return normalizePathPrefix(pathContains);
}

export function normalizeSearchFilters(filters: SearchFilters | undefined): SearchFilters | undefined {
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

export async function expandResultSnippets(
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

export function matchesIndexedFileFilters(
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

export function unionStringSets(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left, ...right]);
}

export function intersectStringSets(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((value) => right.has(value)));
}

export function differenceStringSets(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((value) => !right.has(value)));
}

export function evaluateStructuredNode(
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

export function buildStructuredQueryAnalysis(query: string, parsed: ParsedStructuredQuery): QueryAnalysis {
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

export async function expandDefinitionSnippets(
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

export async function expandCallGraphSnippets(
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

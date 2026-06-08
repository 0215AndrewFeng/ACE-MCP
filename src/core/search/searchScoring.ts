import path from "node:path";

import {
  type CallGraphMatch,
  type DefinitionMatch,
  type QueryAnalysis,
  type SearchMatchSource,
  type SearchResult,
  type SearchResultExplanation,
  type SearchResultMode,
} from "../common/types.js";
import {
  SEARCH_MATCH_SOURCES,
  clampSnippet,
  hasBoundaryMatch,
  isCjkToken,
  normalizeComparablePath,
  normalizeText,
} from "./searchHelpers.js";

export function countCoveredTokens(fields: string[], tokens: string[]): number {
  return tokens.filter((token) => fields.some((field) => field.includes(token))).length;
}

export function countReasons(reason: string): number {
  return new Set(reason.split("+").filter(Boolean)).size;
}

export function parseMatchedSources(reason: string): SearchMatchSource[] {
  return [...new Set(reason.split("+").filter((value): value is SearchMatchSource => SEARCH_MATCH_SOURCES.has(value as SearchMatchSource)))];
}

export function scoreMergedResult(
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
  // When the query has code identifiers but is NOT path-like, CJK tokens are noise
  // — exclude them from coverage scoring to prevent dilution of identifier-match relevance
  const excludeCjkFromCoverage = analysis.hasIdentifierLikeSegments && !analysis.isPathLike;
  const coverageTokens = excludeCjkFromCoverage
    ? analysis.tokens.filter((t) => !isCjkToken(t))
    : analysis.tokens;
  const matchedCoverageTokens = matchedTokens.filter((t) => !excludeCjkFromCoverage || !isCjkToken(t));
  const coveredTokenCount = coverageTokens.length > 0 ? matchedCoverageTokens.length : matchedTokens.length;
  const effectiveTokenCount = coverageTokens.length > 0 ? coverageTokens.length : analysis.tokens.length;
  if (effectiveTokenCount > 0) {
    explanation.tokenCoverage = {
      matched: coveredTokenCount,
      total: effectiveTokenCount,
    };
    score += (coveredTokenCount / effectiveTokenCount) * 0.45;
    if (coveredTokenCount === effectiveTokenCount && effectiveTokenCount > 1) {
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

export function choosePreferredResult(existing: SearchResult, incoming: SearchResult, analysis: QueryAnalysis): SearchResult {
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

export function dedupeSameFileResults(results: SearchResult[], analysis: QueryAnalysis, perFileLimit = 2): SearchResult[] {
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

    // v4.2.5: Merge overlapping line ranges within same file
    const merged = mergeOverlappingResults([...mergedBySymbol.values()], analysis);

    const ranked = merged
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

/**
 * v4.2.5: Merge results with overlapping line ranges
 * If two results overlap by more than 50%, merge them into one
 */
export function mergeOverlappingResults(results: SearchResult[], analysis: QueryAnalysis): SearchResult[] {
  if (results.length <= 1) return results;

  // Sort by start line
  const sorted = [...results].sort((a, b) => a.startLine - b.startLine);
  const merged: SearchResult[] = [];

  for (const result of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(result);
      continue;
    }

    // Check for overlap
    const overlapStart = Math.max(last.startLine, result.startLine);
    const overlapEnd = Math.min(last.endLine, result.endLine);
    const overlapLines = Math.max(0, overlapEnd - overlapStart + 1);
    const lastLines = last.endLine - last.startLine + 1;
    const resultLines = result.endLine - result.startLine + 1;
    const minLines = Math.min(lastLines, resultLines);

    // If overlap > 50% of smaller range, merge them
    if (overlapLines > minLines * 0.5) {
      // Extend the range and combine scores
      const combinedReasons = new Set([...last.reason.split("+"), ...result.reason.split("+")]);
      const preferred = choosePreferredResult(last, result, analysis);
      merged[merged.length - 1] = {
        ...preferred,
        startLine: Math.min(last.startLine, result.startLine),
        endLine: Math.max(last.endLine, result.endLine),
        reason: [...combinedReasons].sort().join("+"),
        score: Math.max(last.score, result.score) + 0.1, // Bonus for merged result
      };
    } else {
      merged.push(result);
    }
  }

  return merged;
}

/**
 * v4.3.7: Dynamic perFileLimit based on query type.
 * Definition lookups need more results per file (overloads, implementations).
 */
export function getDynamicPerFileLimit(analysis: QueryAnalysis, configuredLimit: number): number {
  if (analysis.isSymbolLike) return Math.max(configuredLimit, 5);
  if (analysis.hasIdentifierLikeSegments) return Math.max(configuredLimit, 3);
  return configuredLimit;
}

export function rerankResults(results: SearchResult[], analysis: QueryAnalysis, limit: number, perFileLimit = 2): SearchResult[] {
  return dedupeSameFileResults(results, analysis, perFileLimit)
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

export function buildExpandedUnicodeTokens(analysis: QueryAnalysis): string[] {
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

export function applyResultMode(results: SearchResult[], resultMode: SearchResultMode): SearchResult[] {
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

export function normalizeSourceScores(results: SearchResult[]): SearchResult[] {
  if (results.length <= 1) return results;
  let min = Infinity;
  let max = -Infinity;
  for (const r of results) {
    if (r.score < min) min = r.score;
    if (r.score > max) max = r.score;
  }
  const range = max - min;
  if (range === 0) return results;
  for (const r of results) {
    r.score = (r.score - min) / range;
  }
  return results;
}

export function mergeResults(resultSets: SearchResult[][]): SearchResult[] {
  const byLocation = new Map<string, SearchResult>();

  for (const results of resultSets) {
    const normalized = normalizeSourceScores(results);
    for (const result of normalized) {
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

export function buildResultSourceBreakdown(results: SearchResult[]): Partial<Record<SearchMatchSource, number>> {
  const breakdown: Partial<Record<SearchMatchSource, number>> = {};
  for (const result of results) {
    for (const source of parseMatchedSources(result.reason)) {
      breakdown[source] = (breakdown[source] ?? 0) + 1;
    }
  }

  return breakdown;
}

export function mergeDefinitionMatches(results: DefinitionMatch[]): DefinitionMatch[] {
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

export function applyDefinitionResultMode(results: DefinitionMatch[], resultMode: SearchResultMode): DefinitionMatch[] {
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

export function applyCallGraphResultMode(results: CallGraphMatch[], resultMode: SearchResultMode): CallGraphMatch[] {
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

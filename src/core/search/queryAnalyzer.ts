import type { QueryAnalysis } from "../common/types.js";
import { buildSemanticTerms, buildCjkBigrams, CJK_PATTERN } from "./semanticText.js";

const TOKEN_SPLIT_PATTERN = /[^\p{L}\p{N}_.$/\\#-]+/u;
const FTS_TERM_SPLIT_PATTERN = /[.$/\\#-]+/u;
const NON_ASCII_PATTERN = /[^\x00-\x7F]/;
const ASCII_CJK_BOUNDARY = /(?<=[\x00-\x7F])(?=[^\x00-\x7F])|(?<=[^\x00-\x7F])(?=[\x00-\x7F])/;
const SYMBOL_TOKEN_PATTERN = /^[\p{L}_$][\p{L}\p{N}_$.#-]*$/u;
const IDENTIFIER_SEGMENT_PATTERN = /^[\p{L}\p{N}_.$/\\#-]+$/u;
const IDENTIFIER_BOUNDARY_PATTERN = /[._/$\\#-]|[a-z0-9][A-Z]|[A-Z]+[A-Z][a-z]/;

function normalizeToken(token: string): string {
  return token.normalize("NFKC").replaceAll("\\", "/").trim().toLowerCase();
}

function isMeaningfulToken(token: string): boolean {
  if (token.length === 0) {
    return false;
  }

  const codePointLength = [...token].length;
  if (NON_ASCII_PATTERN.test(token)) {
    return codePointLength >= 1;
  }

  return codePointLength >= 2;
}

export function buildFtsQuery(tokens: string[], excludeCjk = false): string | null {
  let terms = [...new Set(tokens
    .flatMap((token) => token.split(FTS_TERM_SPLIT_PATTERN))
    .map(normalizeToken)
    .filter(isMeaningfulToken))];

  // When the query contains code identifiers, extract ASCII portions from
  // mixed CJK+ASCII tokens to prevent NL noise from diluting bm25 ranking.
  // e.g. "matchforshow接口的具体业务逻辑" → ["matchforshow"]
  if (excludeCjk) {
    terms = terms.flatMap((t) => {
      const parts = t.split(/(?:[^\x00-\x7F])+/);
      return parts.map((p) => p.trim()).filter((p) => p.length > 0);
    });
  }

  return terms.length > 0 ? terms.map((term) => `${term}*`).join(" OR ") : null;
}

function hasIdentifierLikeSegments(query: string): boolean {
  return query
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .some((segment) => IDENTIFIER_SEGMENT_PATTERN.test(segment) && segment.length >= 8 && IDENTIFIER_BOUNDARY_PATTERN.test(segment));
}

const IDENTIFIER_PATTERN = /^[\p{L}_$][\p{L}\p{N}_$.#-]*$/u;
const CAMEL_SNAKE_PATTERN = /[a-z][A-Z]|[A-Z][A-Z][a-z]|_/;
// Noise tokens that should not be treated as identifiers even if they pass the pattern
const NOISE_TOKENS = new Set(["the", "for", "and", "not", "but", "how", "what", "where", "when", "why", "this", "that", "with", "from", "into", "can", "has"]);

/**
 * v4.5.1: Extract code identifiers from the ORIGINAL (pre-normalized) query segments.
 * Must run before lowercasing so camelCase boundaries are preserved for detection.
 * Returns normalized (lowercased) identifier tokens.
 */
function extractIdentifiersFromRaw(query: string): string[] {
  const segments = query
    .split(/\s+/)
    .flatMap((part) => part.split(TOKEN_SPLIT_PATTERN))
    .flatMap((part) => part.split(ASCII_CJK_BOUNDARY))
    .filter((segment) =>
      segment.length >= 3 &&
      IDENTIFIER_PATTERN.test(segment) &&
      (CAMEL_SNAKE_PATTERN.test(segment) || /^[A-Z][\p{L}\p{N}]*$/u.test(segment)) &&
      !NOISE_TOKENS.has(segment.toLowerCase()),
    );
  return [...new Set(segments.map(s => s.toLowerCase()))];
}

// v4.5.13: Chinese (CJK) queries have no whitespace, so a whole sentence becomes a
// single giant token (e.g. "假确认场景的退规有什么特殊的吗"), producing a degenerate
// 14-char FTS prefix term. Segment CJK runs into bigrams — mirroring buildSemanticTerms
// (semanticText.ts) which already bigram-indexes CJK for semantic-fts. The whole run is
// KEPT (precise phrase matching for compound business terms) and bigrams are appended.
const MAX_CJK_TERMS = 16;

function segmentCjkTokens(tokens: string[]): string[] {
  const out: string[] = [];
  let cjkBudget = MAX_CJK_TERMS;
  for (const token of tokens) {
    if (!CJK_PATTERN.test(token)) {
      out.push(token);
      continue;
    }
    out.push(token); // keep the whole run for precise matching
    if ([...token].length < 2) continue; // single char has no bigram
    for (const bigram of buildCjkBigrams(token)) {
      if (cjkBudget <= 0) break;
      out.push(bigram);
      cjkBudget -= 1;
    }
  }
  return [...new Set(out)];
}

export function analyzeQuery(query: string): QueryAnalysis {
  const normalizedQuery = query.normalize("NFKC");
  const tokens = normalizedQuery
    .split(/\s+/)
    .flatMap((part) => part.split(TOKEN_SPLIT_PATTERN))
    .flatMap((part) => part.split(ASCII_CJK_BOUNDARY))
    .map(normalizeToken)
    .filter(isMeaningfulToken);

  const uniqueTokens = [...new Set(tokens)];
  // v4.5.13: segment CJK runs into bigrams (whole run kept) so FTS/scoring don't
  // operate on a single degenerate giant token.
  const segmentedTokens = segmentCjkTokens(uniqueTokens);
  const hasIdentifiers = hasIdentifierLikeSegments(normalizedQuery);
  const isPathLike = /[/.\\]/.test(normalizedQuery);
  // When the query has code identifiers but is NOT path-like, exclude CJK tokens
  // from FTS to prevent NL noise from diluting bm25 ranking (e.g. "matchForShow 接口的逻辑")
  const ftsQuery = buildFtsQuery(segmentedTokens, hasIdentifiers && !isPathLike);

  // v4.5.1: Extract code identifiers from the ORIGINAL query (before lowercasing)
  // so camelCase/PascalCase boundaries are preserved for detection
  const identifiers = extractIdentifiersFromRaw(normalizedQuery);
  const identifierSet = new Set(identifiers);
  const naturalLanguage = uniqueTokens.filter(t => !identifierSet.has(t));

  return {
    ftsQuery,
    hasIdentifierLikeSegments: hasIdentifiers,
    identifiers,
    isPathLike,
    isSymbolLike: uniqueTokens.length === 1 && SYMBOL_TOKEN_PATTERN.test(uniqueTokens[0] ?? "") && !NON_ASCII_PATTERN.test(uniqueTokens[0] ?? ""),
    naturalLanguage,
    rawQuery: normalizedQuery,
    semanticTerms: buildSemanticTerms(normalizedQuery),
    tokens: segmentedTokens,
  };
}

/**
 * v4.3.0: Estimate optimal maxSources based on question complexity
 * Simple questions (symbol lookup, short queries) need fewer sources
 * Complex questions (architecture, flow, how-to) need more sources
 */
export function estimateOptimalSources(question: string, defaultTopK: number = 10): number {
  const normalized = question.normalize("NFKC").toLowerCase();
  const wordCount = question.split(/\s+/).filter(w => w.length > 1).length;

  // Simple symbol/function lookup - few sources needed
  const isSimpleLookup = /^(what is|where is|find|locate|定位|查找|在哪|是什么)\s/i.test(normalized) ||
    wordCount <= 3;

  // Complex architectural questions - more sources needed
  const isComplexQuestion = /(how does|how do|流程|架构|逻辑|原理|实现|设计|调用链|业务流|工作原理)/i.test(normalized) ||
    /(整体|全局|系统|模块间|交互|依赖)/i.test(normalized) ||
    wordCount >= 8;

  // Code review or refactoring questions
  const isReviewQuestion = /(review|重构|优化|改进|问题|bug|错误)/i.test(normalized);

  if (isComplexQuestion || isReviewQuestion) {
    return Math.min(Math.max(defaultTopK, 15), 20);
  }

  if (isSimpleLookup) {
    return Math.min(defaultTopK, 5);
  }

  return defaultTopK;
}

import type { QueryAnalysis } from "../common/types.js";
import { buildSemanticTerms } from "./semanticText.js";

const TOKEN_SPLIT_PATTERN = /[^\p{L}\p{N}_.$/\\#-]+/u;
const FTS_TERM_SPLIT_PATTERN = /[.$/\\#-]+/u;
const NON_ASCII_PATTERN = /[^\x00-\x7F]/;
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

function buildFtsQuery(tokens: string[]): string | null {
  const terms = [...new Set(tokens
    .flatMap((token) => token.split(FTS_TERM_SPLIT_PATTERN))
    .map(normalizeToken)
    .filter(isMeaningfulToken))];

  return terms.length > 0 ? terms.map((term) => `${term}*`).join(" OR ") : null;
}

function hasIdentifierLikeSegments(query: string): boolean {
  return query
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .some((segment) => IDENTIFIER_SEGMENT_PATTERN.test(segment) && segment.length >= 8 && IDENTIFIER_BOUNDARY_PATTERN.test(segment));
}

export function analyzeQuery(query: string): QueryAnalysis {
  const normalizedQuery = query.normalize("NFKC");
  const tokens = normalizedQuery
    .split(/\s+/)
    .flatMap((part) => part.split(TOKEN_SPLIT_PATTERN))
    .map(normalizeToken)
    .filter(isMeaningfulToken);

  const uniqueTokens = [...new Set(tokens)];
  const ftsQuery = buildFtsQuery(uniqueTokens);

  return {
    ftsQuery,
    hasIdentifierLikeSegments: hasIdentifierLikeSegments(normalizedQuery),
    isPathLike: /[/.\\]/.test(normalizedQuery),
    isSymbolLike: uniqueTokens.length === 1 && SYMBOL_TOKEN_PATTERN.test(uniqueTokens[0] ?? ""),
    rawQuery: normalizedQuery,
    semanticTerms: buildSemanticTerms(normalizedQuery),
    tokens: uniqueTokens,
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

  if (isSimpleLookup) {
    return Math.min(defaultTopK, 5);
  }

  if (isComplexQuestion || isReviewQuestion) {
    return Math.min(Math.max(defaultTopK, 15), 20);
  }

  return defaultTopK;
}

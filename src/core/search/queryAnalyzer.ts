import type { QueryAnalysis } from "../common/types.js";
import { buildSemanticTerms } from "./semanticText.js";

const TOKEN_SPLIT_PATTERN = /[^\p{L}\p{N}_.$/\\#-]+/u;
const FTS_TERM_SPLIT_PATTERN = /[.$/\\#-]+/u;
const NON_ASCII_PATTERN = /[^\x00-\x7F]/;
const SYMBOL_TOKEN_PATTERN = /^[\p{L}_$][\p{L}\p{N}_$.#-]*$/u;

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
    isPathLike: /[/.\\]/.test(normalizedQuery),
    isSymbolLike: uniqueTokens.length === 1 && SYMBOL_TOKEN_PATTERN.test(uniqueTokens[0] ?? ""),
    rawQuery: normalizedQuery,
    semanticTerms: buildSemanticTerms(normalizedQuery),
    tokens: uniqueTokens,
  };
}

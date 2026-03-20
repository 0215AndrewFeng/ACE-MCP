import type { QueryAnalysis } from "../common/types.js";

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9_.$/-]/g, "").trim();
}

export function analyzeQuery(query: string): QueryAnalysis {
  const tokens = query
    .split(/\s+/)
    .flatMap((part) => part.split(/[^A-Za-z0-9_.$/-]+/))
    .map(normalizeToken)
    .filter((token) => token.length >= 2);

  const uniqueTokens = [...new Set(tokens)];
  const ftsQuery = uniqueTokens.length > 0 ? uniqueTokens.map((token) => `${token.replaceAll(".", " ")}*`).join(" OR ") : null;

  return {
    ftsQuery,
    isPathLike: /[/.\\]/.test(query),
    isSymbolLike: uniqueTokens.length === 1 && /[A-Za-z_][\w$.#-]*/.test(uniqueTokens[0] ?? ""),
    rawQuery: query,
    tokens: uniqueTokens,
  };
}

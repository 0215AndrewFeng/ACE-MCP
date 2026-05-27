/**
 * v4.3.4: Call chain extractor for QA context enrichment
 * Extracts caller/callee relationships for symbols found in search results,
 * providing deeper code understanding context to the LLM.
 */

import type { SearchResult, CallGraphSearchResponse } from "../common/types.js";
import type { SearchService } from "./searchService.js";

export interface CallChainContext {
  symbol: string;
  filePath: string;
  callers: CallChainEntry[];
  callees: CallChainEntry[];
}

export interface CallChainEntry {
  symbol: string;
  filePath: string;
  line: number;
  snippet: string;
}

export interface CallChainResult {
  chains: CallChainContext[];
  extractedSymbols: string[];
  durationMs: number;
}

/**
 * Extract symbol names from search results that are likely to benefit from call chain analysis.
 * Focuses on functions, methods, and classes.
 */
export function extractSymbolsFromResults(results: SearchResult[]): string[] {
  const symbols = new Set<string>();

  for (const result of results) {
    // Extract from explicit symbol field
    if (result.symbol) {
      // Get the last part of qualified names (e.g., "com.example.Service#process" -> "process")
      const parts = result.symbol.split(/[.#$]/);
      const name = parts[parts.length - 1];
      if (name && name.length >= 3 && !isCommonWord(name)) {
        symbols.add(name);
      }
    }

    // Extract from snippet using common patterns
    const snippetSymbols = extractSymbolsFromSnippet(result.snippet, result.language);
    for (const sym of snippetSymbols) {
      symbols.add(sym);
    }
  }

  // Return top 3 most relevant symbols (prioritize those appearing in multiple results)
  return [...symbols].slice(0, 3);
}

/**
 * Extract function/method names from code snippet
 */
function extractSymbolsFromSnippet(snippet: string, language: string): string[] {
  const symbols: string[] = [];

  // Common patterns for function/method definitions
  const patterns: RegExp[] = [];

  if (language === "java" || language === "dotnet") {
    // Java/C#: public void methodName(
    patterns.push(/(?:public|private|protected|static|async|override)?\s+(?:\w+\s+)?(\w+)\s*\(/g);
  } else if (language === "javascript" || language === "typescript") {
    // JS/TS: function name(, async name(, const name = (
    patterns.push(/(?:function|async function)\s+(\w+)\s*\(/g);
    patterns.push(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g);
    patterns.push(/(\w+)\s*\([^)]*\)\s*{/g);
  } else if (language === "python") {
    // Python: def name(, async def name(
    patterns.push(/(?:async\s+)?def\s+(\w+)\s*\(/g);
    patterns.push(/class\s+(\w+)\s*[:(]/g);
  }

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(snippet)) !== null) {
      const name = match[1];
      if (name && name.length >= 3 && !isCommonWord(name)) {
        symbols.push(name);
      }
    }
  }

  return symbols;
}

/**
 * Filter out common words that are unlikely to be meaningful symbol names
 */
function isCommonWord(word: string): boolean {
  const commonWords = new Set([
    "get", "set", "add", "new", "var", "let", "const", "for", "if", "else",
    "return", "void", "int", "string", "bool", "true", "false", "null",
    "this", "self", "super", "class", "function", "def", "async", "await",
    "try", "catch", "throw", "import", "export", "from", "public", "private",
    "static", "final", "override", "abstract", "interface", "extends", "implements",
  ]);
  return commonWords.has(word.toLowerCase());
}

/**
 * Extract call chains for symbols found in search results.
 * This enriches the QA context with caller/callee relationships.
 */
export async function extractCallChains(
  searchService: SearchService,
  projectRootPath: string,
  results: SearchResult[],
  maxSymbols = 2,
  maxCallersPerSymbol = 3,
  maxCalleesPerSymbol = 3,
): Promise<CallChainResult> {
  const startMs = Date.now();
  const symbols = extractSymbolsFromResults(results).slice(0, maxSymbols);
  const chains: CallChainContext[] = [];

  for (const symbol of symbols) {
    try {
      // Query callers and callees in parallel
      const [callersResponse, calleesResponse] = await Promise.all([
        searchService.findCallers(projectRootPath, symbol, maxCallersPerSymbol, 0, undefined, "metadata", 1)
          .catch(() => null),
        searchService.findCallees(projectRootPath, symbol, maxCalleesPerSymbol, 0, undefined, "metadata", 1)
          .catch(() => null),
      ]);

      const callers = extractCallEntries(callersResponse, maxCallersPerSymbol);
      const callees = extractCallEntries(calleesResponse, maxCalleesPerSymbol);

      // Only add if we found meaningful relationships
      if (callers.length > 0 || callees.length > 0) {
        // Find the file where this symbol is defined
        const definitionFile = results.find(r => r.symbol?.includes(symbol))?.filePath
          ?? calleesResponse?.definition?.filePath
          ?? callersResponse?.definition?.filePath
          ?? "";

        chains.push({
          symbol,
          filePath: definitionFile,
          callers,
          callees,
        });
      }
    } catch {
      // Skip symbols that fail to resolve
    }
  }

  return {
    chains,
    extractedSymbols: symbols,
    durationMs: Date.now() - startMs,
  };
}

function extractCallEntries(
  response: CallGraphSearchResponse | null,
  limit: number,
): CallChainEntry[] {
  if (!response || !response.results) {
    return [];
  }

  return response.results.slice(0, limit).map(r => ({
    symbol: r.ownerSymbol ?? r.resolvedSymbol ?? r.rawName ?? "unknown",
    filePath: r.filePath,
    line: r.startLine,
    snippet: r.snippet?.slice(0, 200) ?? "",
  }));
}

/**
 * Format call chains as context string for LLM
 */
export function formatCallChainsForLLM(chains: CallChainContext[]): string {
  if (chains.length === 0) {
    return "";
  }

  const sections: string[] = ["## Call Relationships\n"];

  for (const chain of chains) {
    sections.push(`### \`${chain.symbol}\` (${chain.filePath})`);

    if (chain.callers.length > 0) {
      sections.push("\n**Called by:**");
      for (const caller of chain.callers) {
        sections.push(`- \`${caller.symbol}\` at ${caller.filePath}:${caller.line}`);
      }
    }

    if (chain.callees.length > 0) {
      sections.push("\n**Calls:**");
      for (const callee of chain.callees) {
        sections.push(`- \`${callee.symbol}\` at ${callee.filePath}:${callee.line}`);
      }
    }

    sections.push("");
  }

  return sections.join("\n");
}

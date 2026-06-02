/**
 * v4.4.2: Call chain extractor for QA context enrichment
 * Extracts caller/callee relationships for symbols found in search results,
 * providing deeper code understanding context to the LLM.
 *
 * v4.4.2: Added configurable depth for multi-hop call chain extraction
 * v4.4.3: Added collectCallChainFilePaths for source code enrichment
 */

import type { SearchResult, CallGraphSearchResponse } from "../common/types.js";
import { readFileSnippet } from "../project/fileSnippet.js";
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
  upstream?: CallChainEntry[];   // v4.4.2: Recursive upstream callers
  downstream?: CallChainEntry[]; // v4.4.2: Recursive downstream callees
}

export interface CallChainResult {
  chains: CallChainContext[];
  extractedSymbols: string[];
  durationMs: number;
  depth: number;  // v4.4.2: Actual depth used
}

/**
 * v4.4.3: Collect all unique file paths and line numbers from call chain results.
 * Used to read source code for each call chain node for LLM context enrichment.
 */
export interface CallChainLocation {
  filePath: string;
  startLine: number;
  symbol: string;
}

export function collectCallChainLocations(chains: CallChainContext[]): CallChainLocation[] {
  const seen = new Set<string>();
  const locations: CallChainLocation[] = [];

  function addLocation(filePath: string, line: number, symbol: string) {
    const key = `${filePath}:${line}`;
    if (!seen.has(key) && filePath) {
      seen.add(key);
      locations.push({ filePath, startLine: line, symbol });
    }
  }

  function processEntries(entries: CallChainEntry[]) {
    for (const entry of entries) {
      addLocation(entry.filePath, entry.line, entry.symbol);
      if (entry.upstream) processEntries(entry.upstream);
      if (entry.downstream) processEntries(entry.downstream);
    }
  }

  for (const chain of chains) {
    if (chain.filePath) {
      addLocation(chain.filePath, 0, chain.symbol);
    }
    processEntries(chain.callers);
    processEntries(chain.callees);
  }

  return locations;
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
 * v4.4.8: Extract method CALL names from a code snippet (not just definitions).
 * For a method body like matchForShow() that calls orderTgqService.queryForShowBySerialNo(),
 * this extracts "queryForShowBySerialNo" so we can search for downstream implementations.
 */
export function extractMethodCallsFromSnippet(snippet: string, language: string): string[] {
  const calls = new Set<string>();

  if (language === "java" || language === "dotnet") {
    // Java/C#: .methodName( or methodName( (but not keywords)
    // Match both obj.method() and static ClassName.method()
    const callPattern = /(?:\.\s*|^|\s)([a-z_]\w*)\s*\(/gm;
    let match;
    while ((match = callPattern.exec(snippet)) !== null) {
      const name = match[1];
      if (name && name.length >= 3 && !isCommonWord(name) && !isControlFlowKeyword(name)) {
        calls.add(name);
      }
    }
  } else if (language === "javascript" || language === "typescript") {
    // JS/TS: .methodName(, methodName(, await methodName(
    const callPattern = /(?:\.\s*|await\s+)?([a-z_$][\w$]*)\s*\(/gm;
    let match;
    while ((match = callPattern.exec(snippet)) !== null) {
      const name = match[1];
      if (name && name.length >= 3 && !isCommonWord(name) && !isControlFlowKeyword(name)) {
        calls.add(name);
      }
    }
  } else if (language === "python") {
    // Python: .method_name( or method_name(
    const callPattern = /(?:\.\s*)?([a-z_]\w*)\s*\(/gm;
    let match;
    while ((match = callPattern.exec(snippet)) !== null) {
      const name = match[1];
      if (name && name.length >= 3 && !isCommonWord(name) && !isControlFlowKeyword(name)) {
        calls.add(name);
      }
    }
  }

  return [...calls];
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
 * Filter out control flow keywords that look like method calls but aren't
 */
function isControlFlowKeyword(word: string): boolean {
  const keywords = new Set([
    "if", "for", "while", "switch", "catch", "try", "throw", "return",
    "synchronized", "assert", "instanceof", "typeof", "yield", "with",
    "break", "continue", "case", "default", "finally", "do",
  ]);
  return keywords.has(word.toLowerCase());
}

/**
 * v4.5.0: Extract type/class reference names from a code snippet.
 * Complements extractMethodCallsFromSnippet — captures PascalCase identifiers
 * used as parameter types, return types, generic type arguments, and
 * direct class references (DTO, VO, Param, Query, etc.).
 */
export function extractTypeReferencesFromSnippet(snippet: string, language: string): string[] {
  const names = new Set<string>();

  const builtins = new Set([
    "String", "Integer", "Long", "Boolean", "Double", "Float",
    "Byte", "Short", "Character", "Object", "Class", "Enum", "Void",
    "List", "Map", "Set", "Optional", "Stream", "Collection",
    "Override", "Deprecated", "SuppressWarnings", "SafeVarargs",
    "IOException", "RuntimeException", "Exception", "Error", "Throwable",
  ]);

  const isNoiseName = (name: string): boolean =>
    builtins.has(name) ||
    name.endsWith("Exception") ||
    name.endsWith("Error") ||
    name.length < 3;

  if (language === "java" || language === "dotnet") {
    const patterns = [
      // Parameter type declarations: TypeName paramName
      /\b([A-Z][A-Za-z0-9_]{2,})\s+[a-z_]\w*\s*[,;)]/gm,
      // Return types: ) TypeName methodName( or static TypeName methodName(
      /(?:\)|static)\s+([A-Z][A-Za-z0-9_]{2,})\s+[a-z_]\w*\s*\(/gm,
      // Generic type arguments: <TypeName, TypeName>
      /<([A-Z][A-Za-z0-9_]{2,})>/gm,
      // PascalCase identifiers >= 4 chars (catches DTOs, VOs, etc.)
      /\b([A-Z][A-Za-z0-9_]{3,})\b/gm,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(snippet)) !== null) {
        const name = match[1];
        if (name && !isNoiseName(name)) {
          names.add(name);
        }
      }
    }
  } else if (language === "typescript" || language === "javascript") {
    const patterns = [
      /:\s*([A-Z][A-Za-z0-9_]{2,})\b/gm,
      /\b([A-Z][A-Za-z0-9_]{3,})\b/gm,
    ];
    const tsBuiltins = new Set([
      "String", "Number", "Boolean", "Array", "Object", "Function",
      "Promise", "Map", "Set", "Date", "Error", "RegExp",
    ]);
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(snippet)) !== null) {
        const name = match[1];
        if (name && !tsBuiltins.has(name) && name.length >= 3) {
          names.add(name);
        }
      }
    }
  }

  return [...names];
}

/**
 * v4.4.8: Find downstream implementations for methods called from top search results.
 * Uses the indexed call graph (findCallees) to discover methods called by top-result
 * symbols, then runs supplementary searches for their definitions. Falls back to
 * source-level method call extraction if the call graph returns no results.
 */
export async function findDownstreamImplementations(
  searchService: SearchService,
  projectRootPath: string,
  results: SearchResult[],
  maxDownstream: number = 5,
): Promise<SearchResult[]> {
  const topResults = results.slice(0, 3);
  if (topResults.length === 0) return [];

  // Collect callee names from the indexed call graph
  const calleeNames = new Set<string>();

  for (const result of topResults) {
    if (!result.symbol) continue;
    // Extract the simple name from qualified symbol (e.g., "Foo.bar" or "Foo#bar" → "bar")
    const simpleName = result.symbol.split(/[.#$]/).pop() ?? result.symbol;
    if (!simpleName || simpleName.length < 3) continue;

    try {
      const calleeResp = await searchService.findCallees(
        projectRootPath,
        simpleName,
        5,
        0,
        undefined,
        "metadata",
        1,
      );
      if (calleeResp?.results) {
        for (const callee of calleeResp.results) {
          const name = callee.resolvedSymbol ?? callee.ownerSymbol ?? callee.rawName;
          if (name && name.length >= 3 && !isCommonWord(name) && !isControlFlowKeyword(name)) {
            calleeNames.add(name);
          }
        }
      }
    } catch {
      // findCallees may fail for symbols without call graph data — skip
    }
  }

  // Always run source-level method call extraction alongside call graph.
  // Call graph can return false positives (text-matched symbols) or nothing at all
  // for unindexed methods (symbolId=None), so we always extract from source too.
  const SOURCE_PAD = 15;
  for (const result of topResults) {
    try {
      const fileSnippet = await readFileSnippet(
        projectRootPath,
        result.filePath,
        Math.max(1, result.startLine - SOURCE_PAD),
        result.endLine + SOURCE_PAD,
      );
      const methodCalls = extractMethodCallsFromSnippet(fileSnippet.snippet, result.language);
      for (const name of methodCalls) {
        if (name.length >= 8) calleeNames.add(name);
      }
      // v4.5.0: Also extract type/class references to find DTO/VO/Param definitions
      const typeRefs = extractTypeReferencesFromSnippet(fileSnippet.snippet, result.language);
      for (const name of typeRefs) {
        if (name.length >= 4) calleeNames.add(name);
      }
    } catch {
      if (result.snippet) {
        const methodCalls = extractMethodCallsFromSnippet(result.snippet, result.language);
        for (const name of methodCalls) {
          if (name.length >= 8) calleeNames.add(name);
        }
        const typeRefs = extractTypeReferencesFromSnippet(result.snippet, result.language);
        for (const name of typeRefs) {
          if (name.length >= 4) calleeNames.add(name);
        }
      }
    }
  }

  if (calleeNames.size === 0) return [];

  // Run parallel searches for each callee name
  const searchPromises = [...calleeNames].slice(0, 8).map(async (methodName) => {
    try {
      const resp = await searchService.search(
        projectRootPath,
        methodName,
        "auto",
        maxDownstream,
        15, // v4.5.0: expand snippets with ±15 lines context (was 0)
        {},
        "full",
      );
      return resp.results;
    } catch {
      return [];
    }
  });

  const allResults = await Promise.all(searchPromises);
  const seen = new Set(results.map(r => `${r.filePath}:${r.startLine}:${r.endLine}`));
  const downstream: SearchResult[] = [];

  for (const batch of allResults) {
    for (const r of batch) {
      const key = `${r.filePath}:${r.startLine}:${r.endLine}`;
      if (!seen.has(key)) {
        seen.add(key);
        // Mark as downstream source (lower priority than direct matches)
        downstream.push({ ...r, score: r.score * 0.85 });
      }
    }
  }

  // Sort by score descending, take top results
  downstream.sort((a, b) => b.score - a.score);
  return downstream.slice(0, maxDownstream * 2);
}

/**
 * Extract call chains for symbols found in search results.
 * This enriches the QA context with caller/callee relationships.
 *
 * v4.4.2: Added depth parameter for multi-hop call chain extraction
 * @param depth - Depth of call chain to extract (1 = direct callers/callees, 2 = two-hop, etc.)
 */
export async function extractCallChains(
  searchService: SearchService,
  projectRootPath: string,
  results: SearchResult[],
  maxSymbols = 2,
  maxCallersPerSymbol = 3,
  maxCalleesPerSymbol = 3,
  depth = 1,
): Promise<CallChainResult> {
  const startMs = Date.now();
  const symbols = extractSymbolsFromResults(results).slice(0, maxSymbols);
  const chains: CallChainContext[] = [];

  // Clamp depth to avoid excessive recursion
  const effectiveDepth = Math.min(Math.max(depth, 1), 3);

  const chainResults = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        // Query callers and callees in parallel
        const [callersResponse, calleesResponse] = await Promise.all([
          searchService.findCallers(projectRootPath, symbol, maxCallersPerSymbol, 0, undefined, "metadata", effectiveDepth)
            .catch(() => null),
          searchService.findCallees(projectRootPath, symbol, maxCalleesPerSymbol, 0, undefined, "metadata", effectiveDepth)
            .catch(() => null),
        ]);

        const callers = await extractCallEntriesWithDepth(
          searchService,
          projectRootPath,
          callersResponse,
          maxCallersPerSymbol,
          effectiveDepth - 1,
          "callers",
        );
        const callees = await extractCallEntriesWithDepth(
          searchService,
          projectRootPath,
          calleesResponse,
          maxCalleesPerSymbol,
          effectiveDepth - 1,
          "callees",
        );

        // Only add if we found meaningful relationships
        if (callers.length > 0 || callees.length > 0) {
          // Find the file where this symbol is defined
          const definitionFile = results.find(r => r.symbol?.includes(symbol))?.filePath
            ?? calleesResponse?.definition?.filePath
            ?? callersResponse?.definition?.filePath
            ?? "";

          return {
            symbol,
            filePath: definitionFile,
            callers,
            callees,
          } as CallChainContext;
        }
        return null;
      } catch {
        // Skip symbols that fail to resolve
        return null;
      }
    })
  );
  chains.push(...chainResults.filter((c): c is CallChainContext => c !== null));

  return {
    chains,
    extractedSymbols: symbols,
    durationMs: Date.now() - startMs,
    depth: effectiveDepth,
  };
}

/**
 * Extract call entries with recursive depth support
 */
async function extractCallEntriesWithDepth(
  searchService: SearchService,
  projectRootPath: string,
  response: CallGraphSearchResponse | null,
  limit: number,
  remainingDepth: number,
  direction: "callers" | "callees",
): Promise<CallChainEntry[]> {
  if (!response || !response.results) {
    return [];
  }

  const entries = await Promise.all(
    response.results.slice(0, limit).map(async (r) => {
      const entry: CallChainEntry = {
        symbol: r.ownerSymbol ?? r.resolvedSymbol ?? r.rawName ?? "unknown",
        filePath: r.filePath,
        line: r.startLine,
        snippet: r.snippet?.slice(0, 600) ?? "", // v4.5.0: was 200, too small for call chain context
      };

      // Recursively fetch deeper levels
      if (remainingDepth > 0 && entry.symbol !== "unknown") {
        try {
          if (direction === "callers") {
            const upstreamResponse = await searchService.findCallers(
              projectRootPath,
              entry.symbol,
              Math.min(limit, 2),  // Reduce limit for deeper levels
              0,
              undefined,
              "metadata",
              1,
            ).catch(() => null);

            if (upstreamResponse && upstreamResponse.results.length > 0) {
              entry.upstream = await extractCallEntriesWithDepth(
                searchService,
                projectRootPath,
                upstreamResponse,
                Math.min(limit, 2),
                remainingDepth - 1,
                direction,
              );
            }
          } else {
            const downstreamResponse = await searchService.findCallees(
              projectRootPath,
              entry.symbol,
              Math.min(limit, 2),
              0,
              undefined,
              "metadata",
              1,
            ).catch(() => null);

            if (downstreamResponse && downstreamResponse.results.length > 0) {
              entry.downstream = await extractCallEntriesWithDepth(
                searchService,
                projectRootPath,
                downstreamResponse,
                Math.min(limit, 2),
                remainingDepth - 1,
                direction,
              );
            }
          }
        } catch {
          // Ignore failures in recursive calls
        }
      }

      return entry;
    })
  );

  return entries;
}

/**
 * Format call chains as context string for LLM
 * v4.4.2: Updated to support recursive upstream/downstream chains
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
      formatCallEntriesRecursive(chain.callers, sections, 0, "upstream");
    }

    if (chain.callees.length > 0) {
      sections.push("\n**Calls:**");
      formatCallEntriesRecursive(chain.callees, sections, 0, "downstream");
    }

    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Format call entries recursively with indentation
 */
function formatCallEntriesRecursive(
  entries: CallChainEntry[],
  sections: string[],
  depth: number,
  direction: "upstream" | "downstream",
): void {
  const indent = "  ".repeat(depth);
  for (const entry of entries) {
    sections.push(`${indent}- \`${entry.symbol}\` at ${entry.filePath}:${entry.line}`);

    // Format nested entries
    const nested = direction === "upstream" ? entry.upstream : entry.downstream;
    if (nested && nested.length > 0) {
      formatCallEntriesRecursive(nested, sections, depth + 1, direction);
    }
  }
}

/**
 * Generate Mermaid diagram for call chains
 * v4.4.2: Updated to support multi-level call chains
 */
export function generateCallChainMermaid(chains: CallChainContext[]): string {
  if (chains.length === 0) {
    return "";
  }

  const lines: string[] = ["flowchart LR"];
  const nodes = new Set<string>();
  const edges: string[] = [];

  function sanitizeId(s: string): string {
    return s.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  function addNode(symbol: string): string {
    const id = sanitizeId(symbol);
    if (!nodes.has(id)) {
      nodes.add(id);
      lines.push(`  ${id}["${symbol}"]`);
    }
    return id;
  }

  function processCallersRecursive(entries: CallChainEntry[], targetId: string): void {
    for (const entry of entries) {
      const sourceId = addNode(entry.symbol);
      const edge = `${sourceId} --> ${targetId}`;
      if (!edges.includes(edge)) {
        edges.push(edge);
      }
      if (entry.upstream) {
        processCallersRecursive(entry.upstream, sourceId);
      }
    }
  }

  function processCalleesRecursive(entries: CallChainEntry[], sourceId: string): void {
    for (const entry of entries) {
      const targetId = addNode(entry.symbol);
      const edge = `${sourceId} --> ${targetId}`;
      if (!edges.includes(edge)) {
        edges.push(edge);
      }
      if (entry.downstream) {
        processCalleesRecursive(entry.downstream, targetId);
      }
    }
  }

  for (const chain of chains) {
    const centerId = addNode(chain.symbol);
    lines.push(`  style ${centerId} fill:#f9f,stroke:#333,stroke-width:2px`);

    processCallersRecursive(chain.callers, centerId);
    processCalleesRecursive(chain.callees, centerId);
  }

  // Add edges after all nodes
  for (const edge of edges) {
    lines.push(`  ${edge}`);
  }

  return lines.join("\n");
}

/**
 * v4.3.7: Unified QA pipeline shared between MCP ask_codebase and Web QA endpoints.
 * Consolidates: index → search → reranker → callchain → context assembly → compress → cache → summary → LLM
 */

import type { ToolDependencies } from "../../server/toolRegistry.js";
import type { ContextMode, SupportedLanguage } from "../common/types.js";
import { AppError } from "../common/errors.js";
import type { CallChainContext, CallChainLocation } from "../search/callChainExtractor.js";
import { extractCallChains, formatCallChainsForLLM, collectCallChainLocations, findDownstreamImplementations } from "../search/callChainExtractor.js";
import { rerankWithLlm } from "../search/llmReranker.js";
import { expandQueryWithLlm } from "./queryExpander.js";
import { qaCache, QaCache } from "./qaCache.js";
import {
  assembleFullFileContext,
  buildQaMessagesWithHistory,
  buildQaUserPrompt,
  compressContext,
  generateRelatedQuestions,
  QA_SYSTEM_PROMPT,
  type QaConversationTurn,
  type QaSource,
} from "./qaPrompt.js";
import { readFileSnippet } from "../project/fileSnippet.js";

export interface QaPipelineOptions {
  question: string;
  projectRootPath: string;
  maxSources?: number;
  maxTokens?: number;
  includeSummary?: boolean;
  languages?: SupportedLanguage[];
  contextMode?: ContextMode;
  enableReranker?: boolean;
  enableCallChain?: boolean;
  callChainDepth?: number;  // v4.4.2: Configurable call chain depth (1-3)
  enableCache?: boolean;
  history?: QaConversationTurn[];
  timeoutMs?: number;
}

export interface QaPipelineResult {
  answer: string;
  sources: QaSource[];
  usage?: { promptTokens: number; completionTokens: number };
  cached?: boolean;
  hadSummary?: boolean;
  hadCallChain?: boolean;
  callChains?: CallChainContext[];
  relatedQuestions?: string[];
  expandedQuery?: string;
  fallback?: boolean;
  fallbackReason?: string;
  timing: {
    indexMs: number;
    queryExpansionMs: number;
    searchMs: number;
    rerankerMs: number;
    callChainMs: number;
    llmMs: number;
    totalMs: number;
  };
}

/**
 * Run the full QA pipeline: index → search → rerank → callchain → context → compress → cache → summary → LLM → cache write
 */
export async function runQaPipeline(
  deps: ToolDependencies,
  options: QaPipelineOptions,
): Promise<QaPipelineResult> {
  const startMs = Date.now();
  const timeout = options.timeoutMs ?? 120_000;
  const contextMode = options.contextMode ?? "merged-file";
  const enableReranker = options.enableReranker ?? deps.settings.enableLlmReranker;
  const enableCallChain = options.enableCallChain ?? true;
  const enableCache = options.enableCache ?? true;
  const history = options.history ?? [];

  const checkTimeout = (phase: string) => {
    if (Date.now() - startMs > timeout) {
      throw new AppError("TIMEOUT", `Timeout at ${phase}: exceeded ${timeout / 1000}s limit`);
    }
  };

  // 1. Ensure fresh index
  const indexStart = Date.now();
  const indexResult = await deps.indexCoordinator.ensureFreshIndex(options.projectRootPath);
  const indexMs = Date.now() - indexStart;
  checkTimeout("index");

  // 1.5 + 2. Run query expansion and Round 1 search in parallel (v4.4.6)
  const topK = Math.min(Math.max(1, options.maxSources ?? deps.settings.qaMaxSourcesDefault), deps.settings.qaMaxSourcesMax);
  const searchFilters = { languages: options.languages };

  const needsExpansion = deps.llmClient.isConfigured() && /[^\x00-\x7F]/.test(options.question);

  const qeStart = Date.now();
  const searchStart = Date.now();

  const expansionPromise = needsExpansion
    ? expandQueryWithLlm(deps.llmClient, options.question, 8_000).catch(() => ({ expandedQuery: options.question, keywords: [] as string[] }))
    : Promise.resolve({ expandedQuery: options.question, keywords: [] as string[] });

  const round1Promise = deps.searchService.search(
    indexResult.projectRootPath,
    options.question,
    "auto",
    topK,
    0,
    searchFilters,
    "full",
  );

  const [expansionResult, round1Result] = await Promise.all([expansionPromise, round1Promise]);

  const expandedKeywords = expansionResult.keywords;
  const queryExpansionMs = needsExpansion ? Date.now() - qeStart : 0;

  let searchResult = round1Result;

  // Round 2: Search with expanded English keywords (if available)
  if (expandedKeywords.length > 0) {
    try {
      const round2Query = expandedKeywords.join(" ");
      const round2 = await deps.searchService.search(
        indexResult.projectRootPath,
        round2Query,
        "auto",
        topK,
        0,
        searchFilters,
        "full",
      );
      // Merge round 2 results into round 1, dedup by filePath:startLine:endLine
      if (round2.results.length > 0) {
        const seen = new Set(
          searchResult.results.map(r => `${r.filePath}:${r.startLine}:${r.endLine}`),
        );
        const newResults = round2.results.filter(
          r => !seen.has(`${r.filePath}:${r.startLine}:${r.endLine}`),
        );
        searchResult = {
          ...searchResult,
          results: [...searchResult.results, ...newResults].slice(0, topK),
        };
      }
    } catch (err) {
      deps.logger.debug("round-2 search failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const searchMs = Date.now() - searchStart;
  checkTimeout("search");

  // 2.5. v4.4.8: Find downstream implementations via indexed call graph.
  // Uses the symbol index to find callees of top-result methods, then searches for
  // their definitions so that service/utility implementations are included in context.
  let downstreamSearchMs = 0;
  if (searchResult.results.length > 0) {
    try {
      const dsStart = Date.now();
      const downstreamResults = await findDownstreamImplementations(
        deps.searchService,
        indexResult.projectRootPath,
        searchResult.results,
        Math.min(topK, 5),
      );
      downstreamSearchMs = Date.now() - dsStart;
      if (downstreamResults.length > 0) {
        const existingKeys = new Set(
          searchResult.results.map(r => `${r.filePath}:${r.startLine}:${r.endLine}`),
        );
        const newResults = downstreamResults.filter(
          r => !existingKeys.has(`${r.filePath}:${r.startLine}:${r.endLine}`),
        );
        if (newResults.length > 0) {
          searchResult = {
            ...searchResult,
            results: [...searchResult.results, ...newResults],
          };
        }
      }
    } catch (err) {
      deps.logger.debug("downstream search failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 3. Optional LLM reranker
  let rerankerMs = 0;
  if (enableReranker && deps.llmClient.isConfigured() && searchResult.results.length > 3) {
    try {
      const rerankerStart = Date.now();
      const rerankerResult = await rerankWithLlm(
        deps.llmClient,
        options.question,
        searchResult.results,
        topK,
        deps.settings.llmRerankerMaxCandidates,
      );
      if (rerankerResult.usedLlm) {
        searchResult = { ...searchResult, results: rerankerResult.rerankedResults };
      }
      rerankerMs = Date.now() - rerankerStart;
    } catch (err) {
      deps.logger.debug("reranker failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  checkTimeout("reranker");

  // 4. Optional call chain extraction
  // v4.4.2: Added configurable depth (default 1, max 3)
  const callChainDepth = Math.min(Math.max(options.callChainDepth ?? 1, 1), 3);
  let callChainContext = "";
  let callChains: CallChainContext[] = [];
  let callChainMs = 0;
  if (enableCallChain && searchResult.results.length > 0) {
    try {
      const ccStart = Date.now();
      const ccResult = await extractCallChains(
        deps.searchService,
        indexResult.projectRootPath,
        searchResult.results,
        2, 3, 3, callChainDepth,
      );
      callChainMs = Date.now() - ccStart;
      callChainContext = formatCallChainsForLLM(ccResult.chains);
      callChains = ccResult.chains;
    } catch (err) {
      deps.logger.debug("call chain extraction failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  checkTimeout("callchain");

  // 4.5. v4.4.3: Call chain source code enrichment
  // Read source code for each caller/callee node and add as extra sources
  let callChainSources: QaSource[] = [];
  if (enableCallChain && callChains.length > 0) {
    try {
      const locations = collectCallChainLocations(callChains);
      // Deduplicate against search results
      const searchResultKeys = new Set(
        searchResult.results.map(r => `${r.filePath}:${r.startLine}`),
      );
      const dedupedLocations = locations.filter(
        loc => !searchResultKeys.has(`${loc.filePath}:${loc.startLine}`),
      );

      // Read source snippets for each call chain node (±15 lines context)
      const CONTEXT_PAD = 15;
      const snippetPromises = dedupedLocations.map(async (loc): Promise<QaSource | null> => {
        try {
          const snippet = await readFileSnippet(
            indexResult.projectRootPath,
            loc.filePath,
            Math.max(1, loc.startLine - CONTEXT_PAD),
            loc.startLine + CONTEXT_PAD,
          );
          // Infer language from file extension
          const ext = loc.filePath.split(".").pop() ?? "";
          const languageMap: Record<string, string> = {
            java: "java", ts: "typescript", tsx: "typescript",
            js: "javascript", jsx: "javascript", py: "python",
            cs: "dotnet", go: "go", rs: "rust", kt: "kotlin",
          };
          return {
            filePath: loc.filePath,
            startLine: snippet.startLine,
            endLine: snippet.endLine,
            language: languageMap[ext] ?? ext,
            score: -1, // Mark as call chain source (lower priority)
            snippet: snippet.snippet,
          };
        } catch (err) {
          deps.logger.debug("call chain snippet read failed", { filePath: loc.filePath, error: err instanceof Error ? err.message : String(err) });
          return null;
        }
      });
      const results = await Promise.all(snippetPromises);
      callChainSources = results.filter((r): r is QaSource => r !== null);
    } catch (err) {
      deps.logger.debug("call chain enrichment failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 5. Context assembly (chunk / merged-file / full-file)
  let sources: QaSource[] = searchResult.results.map((r) => ({
    filePath: r.filePath,
    startLine: r.startLine,
    endLine: r.endLine,
    language: r.language,
    score: r.score,
    snippet: r.snippet,
  }));

  if (contextMode !== "chunk" && sources.length > 0) {
    sources = await assembleFullFileContext(
      indexResult.projectRootPath,
      sources,
      deps.settings.qaMaxContextTokens,
      contextMode,
    );
  }

  // 6. Context compression
  const compressedSources = compressContext(sources, deps.settings.qaMaxContextTokens);

  // 7. Cache check (only for non-conversation queries)
  const sourceHashes = compressedSources.map(s => QaCache.hashSource(s.filePath, s.startLine, s.endLine, s.snippet));
  if (enableCache && history.length === 0) {
    const cached = qaCache.get(options.question, sourceHashes);
    if (cached) {
      const relatedQuestions = generateRelatedQuestions(options.question, cached.answer, compressedSources);
      return {
        answer: cached.answer,
        sources: compressedSources,
        usage: cached.usage,
        cached: true,
        hadSummary: false,
        hadCallChain: callChainContext.length > 0,
        callChains,
        relatedQuestions,
        expandedQuery: expandedKeywords.length > 0 ? expandedKeywords.join(" ") : undefined,
        timing: { indexMs, queryExpansionMs, searchMs, rerankerMs, callChainMs, llmMs: 0, totalMs: Date.now() - startMs },
      };
    }
  }

  // 8. Summary loading
  let summaryArchitecture: string | undefined;
  if (options.includeSummary !== false) {
    const summary = await deps.summaryGenerator.loadSummary(indexResult.projectRootPath);
    if (summary) {
      summaryArchitecture = summary.architecture;
    }
  }
  checkTimeout("summary");

  // 9. Prompt building
  const messages = history.length > 0
    ? buildQaMessagesWithHistory(options.question, compressedSources, summaryArchitecture, history)
    : [
        { role: "system" as const, content: QA_SYSTEM_PROMPT },
        { role: "user" as const, content: buildQaUserPrompt(options.question, compressedSources, summaryArchitecture, callChainContext, callChainSources) },
      ];

  // 10. LLM call
  const llmStart = Date.now();
  const result = await deps.llmClient.complete({
    messages,
    maxTokens: options.maxTokens || undefined,
    timeoutMs: Math.max(timeout - (Date.now() - startMs), 5000),
    fallbackOnTimeout: true,
  });
  const llmMs = Date.now() - llmStart;

  // Handle fallback
  if (result.fallback) {
    return {
      answer: "",
      sources: compressedSources,
      usage: result.usage,
      fallback: true,
      fallbackReason: result.fallbackReason,
      hadSummary: Boolean(summaryArchitecture),
      hadCallChain: callChainContext.length > 0,
      callChains,
      expandedQuery: expandedKeywords.length > 0 ? expandedKeywords.join(" ") : undefined,
      timing: { indexMs, queryExpansionMs, searchMs, rerankerMs, callChainMs, llmMs, totalMs: Date.now() - startMs },
    };
  }

  // 11. Cache write
  if (enableCache && history.length === 0 && result.content) {
    qaCache.set(options.question, sourceHashes, result.content, result.usage ?? { promptTokens: 0, completionTokens: 0 });
  }

  const relatedQuestions = generateRelatedQuestions(options.question, result.content ?? "", compressedSources);

  return {
    answer: result.content ?? "",
    sources: compressedSources,
    usage: result.usage,
    cached: false,
    hadSummary: Boolean(summaryArchitecture),
    hadCallChain: callChainContext.length > 0,
    callChains,
    relatedQuestions,
    expandedQuery: expandedKeywords.length > 0 ? expandedKeywords.join(" ") : undefined,
    timing: { indexMs, queryExpansionMs, searchMs, rerankerMs, callChainMs, llmMs, totalMs: Date.now() - startMs },
  };
}

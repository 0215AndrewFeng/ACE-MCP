/**
 * v4.3.7: Unified QA pipeline shared between MCP ask_codebase and Web QA endpoints.
 * Consolidates: index → search → reranker → callchain → context assembly → compress → cache → summary → LLM
 */

import type { ToolDependencies } from "../../server/toolRegistry.js";
import type { ContextMode, SupportedLanguage } from "../common/types.js";
import { AppError } from "../common/errors.js";
import type { CallChainContext } from "../search/callChainExtractor.js";
import { extractCallChains, formatCallChainsForLLM } from "../search/callChainExtractor.js";
import { rerankWithLlm } from "../search/llmReranker.js";
import { estimateOptimalSources } from "../search/queryAnalyzer.js";
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

export interface QaPipelineOptions {
  question: string;
  projectRootPath: string;
  maxSources?: number;
  includeSummary?: boolean;
  languages?: SupportedLanguage[];
  contextMode?: ContextMode;
  enableReranker?: boolean;
  enableCallChain?: boolean;
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

  // 1.5. Query expansion (non-ASCII → English code keywords)
  let searchQuery = options.question;
  let queryExpansionMs = 0;
  if (deps.llmClient.isConfigured() && /[^\x00-\x7F]/.test(options.question)) {
    try {
      const qeStart = Date.now();
      const { expandedQuery } = await expandQueryWithLlm(deps.llmClient, options.question, 8_000);
      searchQuery = expandedQuery;
      queryExpansionMs = Date.now() - qeStart;
    } catch {
      // Query expansion is optional — silently skip
    }
  }

  // 2. Search with smart topK
  const defaultTopK = deps.settings.qaMaxSourcesDefault;
  const smartTopK = (options.maxSources === undefined || options.maxSources === defaultTopK)
    ? estimateOptimalSources(options.question, defaultTopK)
    : (options.maxSources ?? defaultTopK);
  const topK = Math.min(Math.max(1, smartTopK), deps.settings.qaMaxSourcesMax);

  const searchStart = Date.now();
  let searchResult = await deps.searchService.search(
    indexResult.projectRootPath,
    searchQuery,
    "auto",
    topK,
    0,
    { languages: options.languages },
    "full",
  );
  const searchMs = Date.now() - searchStart;
  checkTimeout("search");

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
    } catch {
      // Reranker is optional — silently fall back to original order
    }
  }
  checkTimeout("reranker");

  // 4. Optional call chain extraction
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
        2, 3, 3,
      );
      callChainMs = Date.now() - ccStart;
      callChainContext = formatCallChainsForLLM(ccResult.chains);
      callChains = ccResult.chains;
    } catch {
      // Optional — silently skip
    }
  }
  checkTimeout("callchain");

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
  const sourceHashes = compressedSources.map(s => QaCache.hashSource(s.filePath, s.startLine, s.endLine));
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
        expandedQuery: searchQuery !== options.question ? searchQuery : undefined,
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
        { role: "user" as const, content: buildQaUserPrompt(options.question, compressedSources, summaryArchitecture, callChainContext) },
      ];

  // 10. LLM call
  const llmStart = Date.now();
  const result = await deps.llmClient.complete({
    messages,
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
      expandedQuery: searchQuery !== options.question ? searchQuery : undefined,
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
    expandedQuery: searchQuery !== options.question ? searchQuery : undefined,
    timing: { indexMs, queryExpansionMs, searchMs, rerankerMs, callChainMs, llmMs, totalMs: Date.now() - startMs },
  };
}

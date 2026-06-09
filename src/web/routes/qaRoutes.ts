import type { Express, Request, Response } from "express";

import { AppError } from "../../core/common/errors.js";
import { buildQaUserPrompt, buildQaMessagesWithHistory, compressContext, generateRelatedQuestions, assembleFullFileContext, QA_SYSTEM_PROMPT, type QaConversationTurn } from "../../core/llm/qaPrompt.js";
import { qaCache, QaCache } from "../../core/llm/qaCache.js";
import { runQaPipeline } from "../../core/llm/qaPipeline.js";
import { expandQueryWithLlm } from "../../core/llm/queryExpander.js";
import { readFileSnippet } from "../../core/project/fileSnippet.js";
import { extractCallChains, formatCallChainsForLLM, collectCallChainLocations, type CallChainContext } from "../../core/search/callChainExtractor.js";
import { rerankWithLlm } from "../../core/search/llmReranker.js";
import { parseAskRequest } from "../requestValidation.js";
import type { WebAppDependencies } from "../types.js";

export function registerQaRoutes(app: Express, dependencies: WebAppDependencies): void {
  // ── QA cache ──────────────────────────────
  app.post("/api/qa/cache/clear", (_req, res) => {
    qaCache.clear();
    res.json({ success: true });
  });

  // ── QA endpoint (v4.3.7: unified pipeline) ────────────────────────────────────────
  app.post("/api/qa/ask", async (req: Request, res: Response) => {
    try {
      const parsed = parseAskRequest(req.body, dependencies.settings);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: "VALIDATION_ERROR" });
        return;
      }
      const { projectRootPath, question, maxSources, maxContextTokens, includeSummary, languages, contextMode, callChainDepth, timeoutSeconds } = parsed.value;
      const { maxTokens, history } = req.body ?? {};
      if (!dependencies.llmClient.isConfigured()) {
        res.status(400).json({ error: "LLM API not configured" });
        return;
      }

      const pipelineResult = await runQaPipeline(
        {
          embeddingProvider: dependencies.embeddingProvider,
          indexCoordinator: dependencies.indexCoordinator,
          llmClient: dependencies.llmClient,
          logger: dependencies.logger,
          searchService: dependencies.searchService,
          settings: dependencies.settings,
          store: dependencies.store,
          summaryGenerator: dependencies.summaryGenerator,
        },
        {
          question,
          projectRootPath,
          maxSources,
          maxContextTokens,
          maxTokens: Number(maxTokens) || undefined,
          includeSummary,
          languages,
          contextMode,
          callChainDepth,  // v4.4.2
          history: Array.isArray(history) ? history : [],
          timeoutMs: timeoutSeconds * 1000,
        },
      );

      if (pipelineResult.fallback) {
        res.json({
          answer: null,
          fallback: true,
          fallbackReason: pipelineResult.fallbackReason,
          message: "LLM 服务暂时不可用，以下是检索到的相关代码片段，您可以直接参考。",
          sources: pipelineResult.sources.map((s, i) => ({
            index: i + 1,
            filePath: s.filePath,
            startLine: s.startLine,
            endLine: s.endLine,
            language: s.language,
            score: s.score,
            snippet: s.snippet.slice(0, 2000), // v4.5.0: was 200, too small for QA context
          })),
          usage: pipelineResult.usage,
          hadSummary: pipelineResult.hadSummary,
          timing: pipelineResult.timing,
        });
        return;
      }

      res.json({
        answer: pipelineResult.answer,
        sources: pipelineResult.sources.map((s, i) => ({
          index: i + 1,
          filePath: s.filePath,
          startLine: s.startLine,
          endLine: s.endLine,
          language: s.language,
          score: s.score,
          snippet: s.snippet.slice(0, 2000), // v4.5.0: was 200, too small for QA context
        })),
        usage: pipelineResult.usage,
        hadSummary: pipelineResult.hadSummary,
        hadCallChain: pipelineResult.hadCallChain,
        cached: pipelineResult.cached,
        relatedQuestions: pipelineResult.relatedQuestions,
        timing: pipelineResult.timing,
      });
    } catch (error: unknown) {
      const message = error instanceof AppError ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  // ── QA streaming endpoint (SSE) - supports both GET and POST ────────────────────────────────────
  const handleQaStream = async (req: Request, res: Response) => {
    // Set up SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

    const sendEvent = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      // Flush immediately for real-time streaming
      if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
        (res as unknown as { flush: () => void }).flush();
      }
    };

    // Handle client disconnect - check socket state for reliable detection
    let clientDisconnected = false;
    const checkDisconnected = () => {
      // Check if socket is still writable (client still connected)
      if (res.writableEnded || res.destroyed || !res.socket || res.socket.destroyed) {
        return true;
      }
      return clientDisconnected;
    };

    // Only mark disconnected when socket actually closes
    res.on("close", () => {
      clientDisconnected = true;
      dependencies.logger.info("SSE client disconnected");
    });

    try {
      // Support both GET (query params) and POST (body)
      const isPost = req.method === "POST";
      const source = isPost ? (req.body ?? {}) : req.query;
      const parsed = parseAskRequest(source, dependencies.settings);
      if (!parsed.ok) {
        sendEvent({ type: "error", error: parsed.error });
        res.end();
        return;
      }
      const { projectRootPath, question, maxSources, maxContextTokens, includeSummary, languages: parsedLanguages, contextMode, callChainDepth, timeoutSeconds } = parsed.value;
      const maxTokens = Number(isPost ? req.body?.maxTokens : req.query.maxTokens) || 0;
      const historyData = isPost ? req.body?.history : req.query.history as string | undefined;
      // v4.5.12: per-request context token budget, clamped to the configured max.
      const sseContextBudget = Math.min(
        Math.max(1000, maxContextTokens ?? dependencies.settings.qaMaxContextTokens),
        dependencies.settings.qaMaxContextTokensMax,
      );

      dependencies.logger.info("SSE stream started", { projectRootPath, question: question.slice(0, 50) });

      if (!dependencies.llmClient.isConfigured()) {
        sendEvent({ type: "error", error: "LLM API not configured" });
        res.end();
        return;
      }

      const timeout = timeoutSeconds * 1000;
      const startMs = Date.now();

      // Phase 1: Index
      dependencies.logger.info("SSE phase: index start");
      sendEvent({ type: "phase", phase: "index", status: "start" });
      const indexStart = Date.now();
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(projectRootPath);
      const indexMs = Date.now() - indexStart;
      sendEvent({ type: "phase", phase: "index", status: "done", ms: indexMs });
      dependencies.logger.info("SSE phase: index done", { indexMs });

      if (Date.now() - startMs > timeout) {
        sendEvent({ type: "error", error: "Timeout at index phase" });
        res.end();
        return;
      }

      // Phase 2: Dual-round search with query expansion
      // v4.4.0: Round 1 with original query (benefits from semantic labels), Round 2 with expanded keywords
      const questionStr = question;
      let expandedKeywords: string[] = [];
      if (dependencies.llmClient.isConfigured() && /[^\x00-\x7F]/.test(questionStr)) {
        try {
          sendEvent({ type: "phase", phase: "query_expansion", status: "start" });
          const { keywords } = await expandQueryWithLlm(dependencies.llmClient, questionStr, 8_000);
          expandedKeywords = keywords;
          if (keywords.length > 0) {
            sendEvent({ type: "phase", phase: "query_expansion", status: "done", keywords });
          }
        } catch {
          dependencies.logger.debug("query expansion failed in SSE");
        }
      }

      dependencies.logger.info("SSE phase: search start");
      sendEvent({ type: "phase", phase: "search", status: "start" });
      // v4.3.0: Use the user-selected maxSources directly; smart estimation only applies when no explicit choice
      const topK = maxSources;
      const searchFilters = { languages: parsedLanguages };
      const searchStart = Date.now();

      // Round 1: Original query
      let searchResult = await dependencies.searchService.search(
        indexResult.projectRootPath,
        questionStr,
        "auto",
        topK,
        0,
        searchFilters,
        "full",
      );

      // Round 2: Expanded English keywords
      if (expandedKeywords.length > 0) {
        try {
          sendEvent({ type: "phase", phase: "search_round2", status: "start" });
          const round2Query = expandedKeywords.join(" ");
          const round2 = await dependencies.searchService.search(
            indexResult.projectRootPath,
            round2Query,
            "auto",
            topK,
            0,
            searchFilters,
            "full",
          );
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
          sendEvent({ type: "phase", phase: "search_round2", status: "done" });
        } catch {
          dependencies.logger.debug("round-2 search failed in SSE");
        }
      }

      let searchMs = Date.now() - searchStart;

      // v4.3.5: Optional LLM reranking
      let rerankerMs = 0;
      let usedLlmReranker = false;
      if (dependencies.settings.enableLlmReranker && searchResult.results.length > 3) {
        try {
          const rerankerStart = Date.now();
          const rerankerResult = await rerankWithLlm(
            dependencies.llmClient,
            String(question ?? ""),
            searchResult.results,
            topK,
            dependencies.settings.llmRerankerMaxCandidates,
          );
          if (rerankerResult.usedLlm) {
            searchResult = { ...searchResult, results: rerankerResult.rerankedResults };
            usedLlmReranker = true;
          }
          rerankerMs = Date.now() - rerankerStart;
          dependencies.logger.info("SSE LLM reranker", { rerankerMs, usedLlm: rerankerResult.usedLlm });
        } catch (error) {
          dependencies.logger.warn("SSE LLM reranker failed", { error: String(error) });
        }
      }

      sendEvent({ type: "phase", phase: "search", status: "done", ms: searchMs + rerankerMs, resultCount: searchResult.results.length, usedLlmReranker });
      dependencies.logger.info("SSE phase: search done", { searchMs, rerankerMs, resultCount: searchResult.results.length, topK });

      // Send sources immediately
      const sources = searchResult.results.map((r, i) => ({
        index: i + 1,
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        language: r.language,
        score: r.score,
        snippet: r.snippet,
      }));
      sendEvent({ type: "sources", sources });

      // v4.3.0: Generate source hashes for caching
      const sourceHashes = sources.map(s => QaCache.hashSource(s.filePath, s.startLine, s.endLine, s.snippet));

      if (Date.now() - startMs > timeout) {
        sendEvent({ type: "error", error: "Timeout at search phase" });
        res.end();
        return;
      }

      // Phase 3: Extract call chains (v4.3.4, v4.4.2: configurable depth)
      dependencies.logger.info("SSE phase: callchain start");
      sendEvent({ type: "phase", phase: "callchain", status: "start" });
      let callChainContext = "";
      let callChainMs = 0;
      let callChains: CallChainContext[] = [];
      try {
        const callChainStart = Date.now();
        const callChainResult = await extractCallChains(
          dependencies.searchService,
          indexResult.projectRootPath,
          searchResult.results,
          2,  // max 2 symbols
          3,  // max 3 callers per symbol
          3,  // max 3 callees per symbol
          callChainDepth,  // v4.4.2: configurable depth
        );
        callChainMs = Date.now() - callChainStart;
        callChainContext = formatCallChainsForLLM(callChainResult.chains);
        callChains = callChainResult.chains;
        sendEvent({
          type: "phase",
          phase: "callchain",
          status: "done",
          ms: callChainMs,
          symbolCount: callChainResult.extractedSymbols.length,
          chainCount: callChainResult.chains.length,
          depth: callChainResult.depth,  // v4.4.2
        });
        dependencies.logger.info("SSE phase: callchain done", {
          callChainMs,
          extractedSymbols: callChainResult.extractedSymbols,
          chainCount: callChainResult.chains.length,
        });
      } catch (error) {
        // Call chain extraction is optional, don't fail the request
        dependencies.logger.warn("SSE call chain extraction failed", { error: String(error) });
        sendEvent({ type: "phase", phase: "callchain", status: "done", ms: 0, error: "skipped" });
      }

      // v4.4.3: Call chain source code enrichment
      let callChainSources: { filePath: string; startLine: number; endLine: number; language: string; score: number; snippet: string }[] = [];
      if (callChains.length > 0) {
        try {
          const locations = collectCallChainLocations(callChains);
          const searchResultKeys = new Set(searchResult.results.map(r => `${r.filePath}:${r.startLine}`));
          const dedupedLocations = locations.filter(loc => !searchResultKeys.has(`${loc.filePath}:${loc.startLine}`));
          const CONTEXT_PAD = 5;
          const snippetPromises = dedupedLocations.map(async (loc) => {
            try {
              const snippet = await readFileSnippet(
                indexResult.projectRootPath,
                loc.filePath,
                Math.max(1, loc.startLine - CONTEXT_PAD),
                loc.startLine + CONTEXT_PAD,
              );
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
                score: -1,
                snippet: snippet.snippet,
              };
            } catch (err) { return null; }
          });
          const results = await Promise.all(snippetPromises);
          callChainSources = results.filter((r): r is NonNullable<typeof r> => r !== null);
        } catch {
          dependencies.logger.debug("call chain enrichment failed in SSE");
        }
      }

      // Phase 4: Load summary
      dependencies.logger.info("SSE phase: summary start");
      sendEvent({ type: "phase", phase: "summary", status: "start" });
      let summaryArchitecture: string | undefined;
      if (includeSummary) {
        const summary = await dependencies.summaryGenerator.loadSummary(indexResult.projectRootPath);
        if (summary) {
          summaryArchitecture = summary.architecture;
        }
      }
      sendEvent({ type: "phase", phase: "summary", status: "done", hadSummary: Boolean(summaryArchitecture) });
      dependencies.logger.info("SSE phase: summary done", { hadSummary: Boolean(summaryArchitecture) });

      // Parse conversation history first (POST sends array directly, GET sends JSON string)
      let conversationHistory: QaConversationTurn[] = [];
      if (historyData) {
        try {
          conversationHistory = typeof historyData === 'string' ? JSON.parse(historyData) : historyData;
        } catch {
          dependencies.logger.debug("conversation history parse failed");
        }
      }

      // v4.3.0: Check LLM response cache (only for non-conversation queries)
      if (conversationHistory.length === 0) {
        const cachedResponse = qaCache.get(questionStr, sourceHashes);
        if (cachedResponse) {
          dependencies.logger.info("SSE cache hit", { questionLength: questionStr.length });
          sendEvent({ type: "phase", phase: "llm", status: "start" });
          // Send cached answer as tokens (simulate streaming for consistent UX)
          const chunks = cachedResponse.answer.match(/.{1,50}/g) || [cachedResponse.answer];
          for (const chunk of chunks) {
            sendEvent({ type: "token", content: chunk });
          }
          const totalMs = Date.now() - startMs;
          // v4.3.2: Generate related questions for cached responses too
          const compressedSourcesForCache = compressContext(sources.map(s => ({
            filePath: s.filePath,
            startLine: s.startLine,
            endLine: s.endLine,
            language: s.language,
            score: s.score,
            snippet: s.snippet,
          })), 6000);
          const relatedQuestions = generateRelatedQuestions(questionStr, cachedResponse.answer, compressedSourcesForCache);
          sendEvent({
            type: "done",
            answer: cachedResponse.answer,
            usage: cachedResponse.usage,
            hadSummary: Boolean(summaryArchitecture),
            timing: { indexMs, searchMs, llmMs: 0, totalMs },
            cached: true,
            relatedQuestions,
          });
          dependencies.logger.info("SSE stream completed (cached)", { totalMs });
          res.end();
          return;
        }
      }

      // Phase 5: Context assembly + LLM streaming
      // v4.3.7: context assembly (full-file / merged-file)
      let contextSources: { filePath: string; startLine: number; endLine: number; language: string; score: number; snippet: string }[] = sources.map(s => ({
        filePath: s.filePath,
        startLine: s.startLine,
        endLine: s.endLine,
        language: s.language as string,
        score: s.score,
        snippet: s.snippet,
      }));
      if (contextMode !== "chunk" && contextSources.length > 0) {
        sendEvent({ type: "phase", phase: "context-assembly", status: "start" });
        contextSources = await assembleFullFileContext(
          indexResult.projectRootPath,
          contextSources,
          sseContextBudget,
          contextMode,
        );
        sendEvent({ type: "phase", phase: "context-assembly", status: "done", mode: contextMode });
      }

      dependencies.logger.info("SSE phase: llm start");
      sendEvent({ type: "phase", phase: "llm", status: "start" });
      const llmStart = Date.now();

      const compressedSources = compressContext(contextSources, sseContextBudget);

      // v4.3.4: Include call chain context in prompt
      const messages = conversationHistory.length > 0
        ? buildQaMessagesWithHistory(questionStr, compressedSources, summaryArchitecture, conversationHistory)
        : [
            { role: "system" as const, content: QA_SYSTEM_PROMPT },
            { role: "user" as const, content: buildQaUserPrompt(questionStr, compressedSources, summaryArchitecture, callChainContext, callChainSources) },
          ];

      let fullContent = "";
      let usage = { promptTokens: 0, completionTokens: 0 };

      dependencies.logger.info("SSE calling LLM streamComplete", { messageCount: messages.length });
      for await (const chunk of dependencies.llmClient.streamComplete({
        messages,
        maxTokens: maxTokens || undefined,
        timeoutMs: Math.max(timeout - (Date.now() - startMs), 5000),
      })) {
        // Check if client disconnected
        if (checkDisconnected()) {
          dependencies.logger.info("SSE client disconnected during LLM streaming, stopping");
          return;
        }
        if (chunk.type === "token" && chunk.content) {
          fullContent += chunk.content;
          sendEvent({ type: "token", content: chunk.content, isThinking: chunk.isThinking });
        } else if (chunk.type === "done") {
          usage = chunk.usage ?? usage;
        } else if (chunk.type === "error") {
          dependencies.logger.error("SSE LLM error", { error: chunk.error });
          sendEvent({ type: "error", error: chunk.error });
          res.end();
          return;
        }
      }

      // v4.3.0: Cache the response for future queries (only non-conversation)
      if (conversationHistory.length === 0 && fullContent) {
        qaCache.set(questionStr, sourceHashes, fullContent, usage);
        dependencies.logger.info("SSE response cached", { questionLength: questionStr.length });
      }

      const llmMs = Date.now() - llmStart;
      const totalMs = Date.now() - startMs;
      dependencies.logger.info("SSE phase: llm done", { llmMs, contentLength: fullContent.length });

      // v4.3.2: Generate related questions for follow-up suggestions
      const relatedQuestions = generateRelatedQuestions(questionStr, fullContent, compressedSources);

      sendEvent({
        type: "done",
        answer: fullContent,
        usage,
        hadSummary: Boolean(summaryArchitecture),
        hadCallChain: callChainContext.length > 0,
        callChains,
        timing: { indexMs, searchMs, callChainMs, llmMs, totalMs },
        relatedQuestions,
      });
      dependencies.logger.info("SSE stream completed", { totalMs });
      res.end();
    } catch (error: unknown) {
      dependencies.logger.error("SSE stream error", { error: error instanceof Error ? error.message : String(error) });
      if (!checkDisconnected()) {
        sendEvent({ type: "error", error: error instanceof Error ? error.message : String(error) });
        res.end();
      }
    }
  };

  // Register both GET and POST handlers
  app.get("/api/qa/ask/stream", handleQaStream);
  app.post("/api/qa/ask/stream", handleQaStream);

  // ── QA Feedback endpoint ───────────────────────────────────────
  app.post("/api/qa/feedback", async (req: Request, res: Response) => {
    try {
      const { projectRootPath, question, answer, sources, rating, correction, usage, timing } = req.body;

      if (!projectRootPath || !question || !answer || !rating) {
        res.status(400).json({ error: "Missing required fields: projectRootPath, question, answer, rating" });
        return;
      }

      if (rating !== "positive" && rating !== "negative") {
        res.status(400).json({ error: "rating must be 'positive' or 'negative'" });
        return;
      }

      const feedbackId = dependencies.store.saveQaFeedback({
        projectRoot: String(projectRootPath),
        question: String(question),
        answer: String(answer),
        sources: Array.isArray(sources) ? sources : undefined,
        rating,
        correction: correction ? String(correction) : undefined,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        searchMs: timing?.searchMs,
        llmMs: timing?.llmMs,
      });

      res.json({ success: true, feedbackId });
    } catch (error: unknown) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ── QA Feedback stats endpoint ─────────────────────────────────
  app.get("/api/qa/feedback/stats", async (req: Request, res: Response) => {
    try {
      const projectRoot = req.query.projectRoot as string | undefined;
      const stats = dependencies.store.getQaFeedbackStats(projectRoot);
      res.json(stats);
    } catch (error: unknown) {
      res.status(500).json({ error: String(error) });
    }
  });
}

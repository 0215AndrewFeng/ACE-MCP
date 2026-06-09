import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { runQaPipeline } from "../../core/llm/qaPipeline.js";
import type { SupportedLanguage } from "../../core/common/types.js";
import { askCodebaseShape } from "../../core/validation/schemas.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerAskCodebaseTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "ask_codebase",
    {
      description:
        "Ask a natural language question about the codebase. Uses RAG: retrieves relevant code and documentation, then synthesizes an answer via LLM. Supports full-file context mode for deeper analysis. Requires LLM API to be configured.",
      inputSchema: askCodebaseShape(dependencies.settings),
      title: "Ask Codebase",
    },
    async ({ projectRootPath, question, maxSources, includeSummary, languages, contextMode }) => {
      if (!dependencies.llmClient.isConfigured()) {
        const payload = buildEnvelope(
          { projectRootPath, question },
          { error: "LLM API not configured. Set ACE_MCP_LLM_API_URL and ACE_MCP_LLM_API_KEY." },
          {},
          ["LLM API not configured"],
        );
        return asStructuredToolResponse(payload);
      }

      const result = await runQaPipeline(dependencies, {
        question,
        projectRootPath,
        maxSources,
        includeSummary,
        languages: languages as SupportedLanguage[] | undefined,
        contextMode,
        enableReranker: true,
        enableCallChain: true,
        enableCache: true,
      });

      const payload = buildEnvelope(
        { projectRootPath, question, contextMode },
        {
          answer: result.fallback ? null : result.answer,
          sources: result.sources.map((s, i) => ({
            index: i + 1,
            type: s.language === "markdown" ? "doc" : "code",
            filePath: s.filePath,
            startLine: s.startLine,
            endLine: s.endLine,
            language: s.language,
            score: s.score,
          })),
          sourceCount: result.sources.length,
          hadSummary: result.hadSummary,
          hadCallChain: result.hadCallChain,
          cached: result.cached,
          relatedQuestions: result.relatedQuestions,
        },
        {
          timing: result.timing,
          tokensUsed: result.usage,
        },
        result.fallback ? [`LLM fallback: ${result.fallbackReason}`] : [],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

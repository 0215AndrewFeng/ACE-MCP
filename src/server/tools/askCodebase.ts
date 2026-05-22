import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

const SEARCH_FILTER_LANGUAGES = ["java", "javascript", "dotnet", "python", "markdown"] as const;

export function registerAskCodebaseTool(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "ask_codebase",
    {
      description:
        "Ask a natural language question about the codebase. Uses RAG: retrieves relevant code and documentation, then synthesizes an answer via LLM. Requires LLM API to be configured.",
      inputSchema: {
        projectRootPath: z.string().min(1),
        question: z.string().min(1).describe("Natural language question about the codebase"),
        maxSources: z.number().int().min(1).max(20).default(10).describe("Max code snippets to retrieve as context"),
        includeSummary: z.boolean().default(true).describe("Include project summary as additional context"),
        languages: z.array(z.enum(SEARCH_FILTER_LANGUAGES)).min(1).optional(),
      },
      title: "Ask Codebase",
    },
    async ({ projectRootPath, question, maxSources, includeSummary, languages }) => {
      if (!dependencies.llmClient.isConfigured()) {
        const payload = buildEnvelope(
          { projectRootPath, question },
          { error: "LLM API not configured. Set ACE_MCP_LLM_API_URL and ACE_MCP_LLM_API_KEY." },
          {},
          ["LLM API not configured"],
        );
        return asStructuredToolResponse(payload);
      }

      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(projectRootPath);

      // Retrieve relevant code
      const searchResult = await dependencies.searchService.search(
        indexResult.projectRootPath,
        question,
        "auto",
        maxSources,
        0,
        { languages: languages as any },
        "full",
      );

      // Load summary if requested
      let summaryContext = "";
      if (includeSummary) {
        const summary = await dependencies.summaryGenerator.loadSummary(indexResult.projectRootPath);
        if (summary) {
          summaryContext = `## Project Architecture\n\n${summary.architecture}\n\n`;
        }
      }

      // Build RAG prompt
      const sourcesText = searchResult.results
        .map((r, i) => `[${i + 1}] ${r.filePath}:${r.startLine}-${r.endLine} (${r.language})\n\`\`\`\n${r.snippet}\n\`\`\``)
        .join("\n\n");

      const startMs = Date.now();
      const result = await dependencies.llmClient.complete({
        messages: [
          {
            role: "system",
            content: "You are a code expert. Answer questions based on the provided source code and project context. Cite sources using [N] notation referring to the numbered code snippets. Be concise, accurate, and specific.",
          },
          {
            role: "user",
            content: `${summaryContext}## Relevant Source Code\n\n${sourcesText}\n\n## Question\n\n${question}`,
          },
        ],
      });
      const qaMs = Date.now() - startMs;

      const payload = buildEnvelope(
        { projectRootPath: indexResult.projectRootPath, question },
        {
          answer: result.content,
          sources: searchResult.results.map((r, i) => ({
            index: i + 1,
            type: r.language === "markdown" ? "doc" : "code",
            filePath: r.filePath,
            startLine: r.startLine,
            endLine: r.endLine,
            language: r.language,
            score: r.score,
          })),
          sourceCount: searchResult.results.length,
          hadSummary: summaryContext.length > 0,
        },
        {
          searchMs: searchResult.stats.searchMs,
          qaMs,
          tokensUsed: result.usage,
        },
        [],
      );
      return asStructuredToolResponse(payload);
    },
  );
}

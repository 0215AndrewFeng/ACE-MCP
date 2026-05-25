import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDependencies } from "../toolRegistry.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

const SEARCH_FILTER_LANGUAGES = ["java", "javascript", "dotnet", "python", "markdown"] as const;

const QA_SYSTEM_PROMPT = `You are a precise code assistant. Your task is to answer questions about a codebase based ONLY on the provided source code snippets and project summary.

## Rules
1. **Cite sources**: Use [N] notation to cite specific code snippets. Every factual claim MUST have a citation.
2. **Stay grounded**: Only make claims that are directly supported by the provided code. If the answer is not in the provided context, say "I don't have enough information in the provided code to answer this."
3. **Be specific**: Reference exact function names, class names, variable names, and line numbers when relevant.
4. **Structure your answer**:
   - Start with a direct answer to the question
   - Provide supporting details with citations
   - If there are caveats or limitations, mention them

## Output Format
- Use markdown formatting
- Code references should use inline code: \`functionName()\`, \`ClassName\`
- For code examples, use fenced code blocks with language specifier

## What NOT to do
- Do not invent code that isn't in the sources
- Do not cite source numbers that don't exist
- Do not make assumptions about code behavior without evidence
- Do not include generic programming advice unrelated to this specific codebase`;

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
          summaryContext = `## Project Context\n\n${summary.architecture}\n\n`;
        }
      }

      // Build RAG prompt with enhanced structure
      const sourcesText = searchResult.results
        .map((r, i) => `[${i + 1}] ${r.filePath}:${r.startLine}-${r.endLine} (${r.language})\n\`\`\`${r.language}\n${r.snippet}\n\`\`\``)
        .join("\n\n");

      const userPrompt = `${summaryContext}## Source Code Snippets\n\n${sourcesText}\n\n## Question\n\n${question}\n\n## Important\n- Only use information from the source code snippets above\n- Cite sources using [N] notation\n- If unsure, say so rather than guessing`;

      const startMs = Date.now();
      const result = await dependencies.llmClient.complete({
        messages: [
          { role: "system", content: QA_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
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

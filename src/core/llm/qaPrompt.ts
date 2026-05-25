/**
 * Shared QA prompt templates for RAG (used by both MCP tool and Web API)
 */

export const QA_SYSTEM_PROMPT = `You are a precise code assistant. Your task is to answer questions about a codebase based ONLY on the provided source code snippets and project summary.

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

export interface QaSource {
  endLine: number;
  filePath: string;
  language: string;
  score: number;
  snippet: string;
  startLine: number;
}

/**
 * Build the user prompt for QA with optional summary context
 */
export function buildQaUserPrompt(
  question: string,
  sources: QaSource[],
  summaryArchitecture?: string,
): string {
  const summaryContext = summaryArchitecture
    ? `## Project Context\n\n${summaryArchitecture}\n\n`
    : "";

  const sourcesText = sources
    .map(
      (r, i) =>
        `[${i + 1}] ${r.filePath}:${r.startLine}-${r.endLine} (${r.language})\n\`\`\`${r.language}\n${r.snippet}\n\`\`\``,
    )
    .join("\n\n");

  return `${summaryContext}## Source Code Snippets

${sourcesText}

## Question

${question}

## Important
- Only use information from the source code snippets above
- Cite sources using [N] notation
- If unsure, say so rather than guessing`;
}

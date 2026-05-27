/**
 * Shared QA prompt templates for RAG (used by both MCP tool and Web API)
 */

import type { LlmMessage } from "./llmClient.js";

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

export interface QaConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Estimate token count for a text string (rough approximation)
 */
export function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English/code
  return Math.ceil(text.length / 4);
}

/**
 * Compress sources to fit within token budget
 * Prioritizes higher-score sources and truncates snippets if needed
 */
export function compressContext(sources: QaSource[], maxTokens: number): QaSource[] {
  if (sources.length === 0) return sources;

  // Sort by score descending
  const sorted = [...sources].sort((a, b) => b.score - a.score);

  // Calculate total tokens
  let totalTokens = sorted.reduce((sum, s) => sum + estimateTokens(s.snippet), 0);

  if (totalTokens <= maxTokens) {
    return sorted;
  }

  // Truncate snippets starting from lowest-score sources
  const result = [...sorted];
  const tokensPerSource = Math.floor(maxTokens / result.length);
  const minSnippetChars = 200; // Keep at least this many chars

  for (let i = result.length - 1; i >= 0 && totalTokens > maxTokens; i--) {
    const source = result[i];
    const currentTokens = estimateTokens(source.snippet);
    const targetTokens = Math.max(tokensPerSource, Math.ceil(minSnippetChars / 4));

    if (currentTokens > targetTokens) {
      const targetChars = targetTokens * 4;
      result[i] = {
        ...source,
        snippet: source.snippet.slice(0, targetChars) + "\n// ... (truncated)",
      };
      totalTokens -= currentTokens - targetTokens;
    }
  }

  return result;
}

/**
 * Build the user prompt for QA with optional summary and call chain context
 * v4.3.4: Added callChainContext parameter for deeper code understanding
 */
export function buildQaUserPrompt(
  question: string,
  sources: QaSource[],
  summaryArchitecture?: string,
  callChainContext?: string,
): string {
  const summaryContext = summaryArchitecture
    ? `## Project Context\n\n${summaryArchitecture}\n\n`
    : "";

  // v4.3.4: Add call chain context if available
  const callChainSection = callChainContext
    ? `${callChainContext}\n\n`
    : "";

  const sourcesText = sources
    .map(
      (r, i) =>
        `[${i + 1}] ${r.filePath}:${r.startLine}-${r.endLine} (${r.language})\n\`\`\`${r.language}\n${r.snippet}\n\`\`\``,
    )
    .join("\n\n");

  return `${summaryContext}${callChainSection}## Source Code Snippets

${sourcesText}

## Question

${question}

## Important
- Only use information from the source code snippets above
- Cite sources using [N] notation
- If unsure, say so rather than guessing`;
}

/**
 * Build LLM messages with conversation history support
 */
export function buildQaMessagesWithHistory(
  question: string,
  sources: QaSource[],
  summaryArchitecture: string | undefined,
  history: QaConversationTurn[],
  maxHistoryTurns = 3,
): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: "system", content: QA_SYSTEM_PROMPT }];

  // Add recent conversation history (simplified, without full context)
  const recentHistory = history.slice(-maxHistoryTurns * 2);
  for (const turn of recentHistory) {
    messages.push({ role: turn.role, content: turn.content });
  }

  // Current question with full context
  messages.push({
    role: "user",
    content: buildQaUserPrompt(question, sources, summaryArchitecture),
  });

  return messages;
}

/**
 * v4.3.2: Generate related questions based on the current question and answer
 * Returns 3 suggested follow-up questions for the user
 */
export function generateRelatedQuestions(
  question: string,
  answer: string,
  sources: QaSource[],
): string[] {
  // Extract key entities from question and answer
  const codeEntities = new Set<string>();
  const fileNames = new Set<string>();

  // Extract code references (backtick-wrapped)
  const codePattern = /`([A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?)`/g;
  let match;
  while ((match = codePattern.exec(answer)) !== null) {
    codeEntities.add(match[1].replace(/\([^)]*\)/, ""));
  }
  while ((match = codePattern.exec(question)) !== null) {
    codeEntities.add(match[1].replace(/\([^)]*\)/, ""));
  }

  // Extract file names from sources
  for (const source of sources.slice(0, 5)) {
    const fileName = source.filePath.split("/").pop()?.replace(/\.[^.]+$/, "");
    if (fileName) fileNames.add(fileName);
  }

  const entities = [...codeEntities].slice(0, 3);
  const files = [...fileNames].slice(0, 2);
  const suggestions: string[] = [];

  // Generate contextual follow-up questions
  if (entities.length > 0) {
    suggestions.push(`${entities[0]} 的调用者有哪些？`);
    if (entities.length > 1) {
      suggestions.push(`${entities[0]} 和 ${entities[1]} 是如何交互的？`);
    }
  }

  if (files.length > 0) {
    suggestions.push(`${files[0]} 的主要职责是什么？`);
  }

  // Add generic follow-ups based on question type
  const questionLower = question.toLowerCase();
  if (questionLower.includes("how") || questionLower.includes("怎么") || questionLower.includes("如何")) {
    suggestions.push("有没有相关的测试用例？");
  } else if (questionLower.includes("where") || questionLower.includes("哪里") || questionLower.includes("在哪")) {
    suggestions.push("这个功能是什么时候添加的？");
  } else if (questionLower.includes("why") || questionLower.includes("为什么")) {
    suggestions.push("有没有相关的设计文档或注释？");
  } else {
    suggestions.push("能展示一个使用示例吗？");
  }

  // Deduplicate and limit to 3
  return [...new Set(suggestions)].slice(0, 3);
}

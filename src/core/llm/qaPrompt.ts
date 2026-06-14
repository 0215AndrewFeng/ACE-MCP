/**
 * Shared QA prompt templates for RAG (used by both MCP tool and Web API)
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LlmMessage } from "./llmClient.js";

export const QA_SYSTEM_PROMPT = `You are a precise code assistant. Your task is to answer questions about a codebase based ONLY on the provided source code snippets and project summary.

## Rules
1. **Cite sources**: Use [N] notation to cite specific code snippets. Every factual claim MUST have a citation. Use the bare form [N] only — do NOT append line numbers inside the brackets (write "[1]", never "[1:L60-L88]"); mention line numbers in the surrounding text instead.
2. **Stay grounded**: Only make claims that are directly supported by the provided code. If the answer is not in the provided context, say "I don't have enough information in the provided code to answer this."
3. **Be specific**: Reference exact function names, class names, variable names, and line numbers when relevant.
4. **Structure your answer**:
   - Start with a direct answer to the question
   - Provide supporting details with citations
   - If there are caveats or limitations, mention them
5. **Business flow diagram**: If the question asks about a business process, workflow, processing logic, scenario handling, or step-by-step behavior (e.g. 流程、逻辑、怎么处理、什么场景、步骤), END your answer with a section titled "## 业务流程图" containing exactly ONE fenced \`\`\`mermaid code block using \`flowchart TD\`. Rules for the diagram:
   - Nodes represent the key steps and decision points you analyzed from the cited code; use concise Chinese labels wrapped in double quotes, e.g. A["提交申请"], decision nodes as B{"是否假确认"}
   - Do NOT use <br/> or any HTML tags in labels; do NOT put citation markers like [1] inside the diagram
   - Skip the diagram entirely for simple lookup questions (where is X / what is constant Y)

## Output Format
- Use markdown formatting
- Code references should use inline code: \`functionName()\`, \`ClassName\`
- For code examples, use fenced code blocks with language specifier
- The business flow diagram (when applicable) must be the LAST section, as a single \`\`\`mermaid fenced block

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
 * v4.5.1: When truncating, center the snippet around the matched line range
 * instead of always starting from line 1 of the file.
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
  const minSnippetChars = 200;

  for (let i = result.length - 1; i >= 0 && totalTokens > maxTokens; i--) {
    const source = result[i];
    const currentTokens = estimateTokens(source.snippet);
    const targetTokens = Math.max(tokensPerSource, Math.ceil(minSnippetChars / 4));

    if (currentTokens > targetTokens) {
      const targetChars = targetTokens * 4;
      // v4.5.1: Center truncation around matched line range
      // Without this, full-file snippets always start from line 1, and the
      // matched method at line 100+ gets cut off before it appears.
      const truncatedSnippet = centerTruncate(source.snippet, targetChars, source.startLine, source.endLine);
      result[i] = {
        ...source,
        snippet: truncatedSnippet,
      };
      totalTokens -= currentTokens - targetTokens;
    }
  }

  return result;
}

/**
 * v4.5.1: Truncate a snippet by centering it around the matched line range,
 * rather than always taking the first N characters (which are imports/package
 * declarations in Java files).
 */
function centerTruncate(snippet: string, maxChars: number, startLine: number, endLine: number): string {
  if (snippet.length <= maxChars) return snippet;

  const lines = snippet.split("\n");
  const centerLine = Math.floor((startLine + endLine) / 2) - startLine + 1; // relative to snippet start
  const safeCenterLine = Math.min(Math.max(centerLine, 1), lines.length);

  // Find the character offset of the center line
  let charOffset = 0;
  for (let i = 0; i < safeCenterLine - 1; i++) {
    charOffset += lines[i].length + 1; // +1 for the \n
  }

  // Start 1/3 of budget before center, extend 2/3 after
  const start = Math.max(0, charOffset - Math.floor(maxChars / 3));
  const truncated = snippet.slice(start, start + maxChars);
  const prefix = start > 0 ? "// ... (earlier lines omitted)\n" : "";
  const suffix = (start + maxChars) < snippet.length ? "\n// ... (truncated)" : "";
  return prefix + truncated + suffix;
}

/**
 * Build the user prompt for QA with optional summary and call chain context
 * v4.3.4: Added callChainContext parameter for deeper code understanding
 * v4.4.3: Added callChainSources parameter for call chain source code enrichment
 */
export function buildQaUserPrompt(
  question: string,
  sources: QaSource[],
  summaryArchitecture?: string,
  callChainContext?: string,
  callChainSources?: QaSource[],
): string {
  const summaryContext = summaryArchitecture
    ? `## Project Context\n\n${summaryArchitecture}\n\n`
    : "";

  // v4.3.4: Add call chain context if available
  const callChainSection = callChainContext
    ? `${callChainContext}\n\n`
    : "";

  // v4.4.3: Add call chain source code section if available
  const callChainSourceSection = (callChainSources && callChainSources.length > 0)
    ? `## Call Chain Source Code\n\nThe following code snippets are from functions in the call chain of the symbols found above. Use these to understand the implementation details of callers and callees.\n\n${
        callChainSources
          .map((r, i) =>
            `[call-chain-${i + 1}] ${r.filePath}:${r.startLine}-${r.endLine} (${r.language})\n\`\`\`${r.language}\n${r.snippet}\n\`\`\``,
          )
          .join("\n\n")
      }\n\n`
    : "";

  const sourcesText = sources
    .map(
      (r, i) =>
        `[${i + 1}] ${r.filePath}:${r.startLine}-${r.endLine} (${r.language})\n\`\`\`${r.language}\n${r.snippet}\n\`\`\``,
    )
    .join("\n\n");

  return `${summaryContext}${callChainSection}${callChainSourceSection}## Source Code Snippets

${sourcesText}

## Question

${question}

## Important
- Only use information from the source code snippets above
- Cite sources using bare [N] notation (no line numbers inside the brackets)
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

/**
 * v4.3.7: Assemble full-file or merged-file context from search results.
 * Groups sources by file, reads from disk to fill gaps or get entire files,
 * then applies token budget prioritizing higher-scored files.
 */
export async function assembleFullFileContext(
  projectRootPath: string,
  sources: QaSource[],
  maxTokens: number,
  mode: "merged-file" | "full-file",
): Promise<QaSource[]> {
  // Group sources by filePath
  const fileGroups = new Map<string, QaSource[]>();
  for (const source of sources) {
    const group = fileGroups.get(source.filePath) ?? [];
    group.push(source);
    fileGroups.set(source.filePath, group);
  }

  // Sort files by max score (highest first) for token budget priority
  const sortedFiles = [...fileGroups.entries()]
    .map(([filePath, chunks]) => ({
      filePath,
      chunks,
      maxScore: Math.max(...chunks.map(c => c.score)),
    }))
    .sort((a, b) => b.maxScore - a.maxScore);

  const assembled: QaSource[] = [];
  let usedTokens = 0;

  for (const { filePath, chunks, maxScore } of sortedFiles) {
    if (usedTokens >= maxTokens) break;

    const absolutePath = path.resolve(projectRootPath, filePath);
    let fileContent: string;
    try {
      fileContent = await readFile(absolutePath, "utf-8");
    } catch {
      // File not readable — keep original chunks
      for (const chunk of chunks) {
        const tokens = estimateTokens(chunk.snippet);
        if (usedTokens + tokens <= maxTokens) {
          assembled.push(chunk);
          usedTokens += tokens;
        }
      }
      continue;
    }

    const lines = fileContent.split("\n");
    const language = chunks[0].language;

    if (mode === "full-file") {
      const tokens = estimateTokens(fileContent);
      if (usedTokens + tokens <= maxTokens) {
        assembled.push({
          filePath,
          startLine: 1,
          endLine: lines.length,
          language,
          score: maxScore,
          snippet: fileContent,
        });
        usedTokens += tokens;
      } else {
        // File too large — fall back to merged-file for this file
        const merged = buildMergedSnippet(lines, chunks, maxTokens - usedTokens, filePath, language, maxScore);
        if (merged) {
          assembled.push(merged);
          usedTokens += estimateTokens(merged.snippet);
        }
      }
    } else {
      // merged-file: merge chunks into continuous range with gap filling
      const merged = buildMergedSnippet(lines, chunks, maxTokens - usedTokens, filePath, language, maxScore);
      if (merged) {
        assembled.push(merged);
        usedTokens += estimateTokens(merged.snippet);
      }
    }
  }

  return assembled;
}

/**
 * Build a merged snippet covering all chunks in a file, filling gaps between them.
 */
function buildMergedSnippet(
  lines: string[],
  chunks: QaSource[],
  remainingTokenBudget: number,
  filePath: string,
  language: string,
  score: number,
): QaSource | null {
  const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine);
  const minLine = Math.max(1, sorted[0].startLine);
  const maxLine = Math.min(lines.length, sorted[sorted.length - 1].endLine);

  const snippet = lines.slice(minLine - 1, maxLine).join("\n");
  const tokens = estimateTokens(snippet);

  if (tokens <= remainingTokenBudget) {
    return { filePath, startLine: minLine, endLine: maxLine, language, score, snippet };
  }

  // Merged range too large — keep original chunks that fit
  return null;
}

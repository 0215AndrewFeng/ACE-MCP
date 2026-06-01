/**
 * v4.3.5: LLM-based reranker for search results
 * Uses LLM to reorder search results by relevance to the query
 */

import type { LlmClient } from "../llm/llmClient.js";
import type { SearchResult } from "../common/types.js";

export interface RerankerResult {
  rerankedResults: SearchResult[];
  durationMs: number;
  model: string;
  usedLlm: boolean;
}

const RERANKER_SYSTEM_PROMPT = `You are a code search result ranker. Given a query and a list of code snippets, rank them by relevance.

Rules:
1. Return ONLY a JSON array of indices in order of relevance, e.g., [2, 0, 4, 1, 3]
2. Index 0 is the first result, index 1 is the second, etc.
3. Most relevant results should come first
4. Consider: exact matches > partial matches > related concepts
5. For code: function/class name matches are highly relevant
6. Do not include any explanation, just the JSON array`;

/**
 * Rerank search results using LLM
 * Falls back to original order if LLM fails or returns invalid data
 */
export async function rerankWithLlm(
  llmClient: LlmClient,
  query: string,
  results: SearchResult[],
  topK: number,
  maxCandidates = 10,
): Promise<RerankerResult> {
  const startMs = Date.now();

  // Don't rerank if too few results
  if (results.length <= 3) {
    return {
      rerankedResults: results.slice(0, topK),
      durationMs: Date.now() - startMs,
      model: "",
      usedLlm: false,
    };
  }

  // Take top candidates for reranking
  const candidates = results.slice(0, maxCandidates);

  // Build user prompt with snippets
  const snippetsText = candidates
    .map((r, i) => {
      const snippet = r.snippet.slice(0, 300); // Truncate for token efficiency
      return `[${i}] ${r.filePath}:${r.startLine}\n${snippet}`;
    })
    .join("\n\n");

  const userPrompt = `Query: "${query}"

Code snippets to rank:

${snippetsText}

Return the indices in order of relevance as a JSON array:`;

  try {
    const response = await llmClient.complete({
      messages: [
        { role: "system", content: RERANKER_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      maxTokens: 100,
      temperature: 0,
      timeoutMs: 10_000,
      fallbackOnTimeout: true,
    });

    const content = response.content?.trim() ?? "";

    // Parse JSON array from response
    const indices = parseRankingResponse(content, candidates.length);

    if (indices.length === 0) {
      // Fallback to original order
      return {
        rerankedResults: results.slice(0, topK),
        durationMs: Date.now() - startMs,
        model: llmClient.getModelName?.() ?? "unknown",
        usedLlm: false,
      };
    }

    // Reorder results based on LLM ranking
    const reranked: SearchResult[] = [];
    const usedIndices = new Set<number>();

    for (const idx of indices) {
      if (idx >= 0 && idx < candidates.length && !usedIndices.has(idx)) {
        reranked.push({
          ...candidates[idx],
          score: candidates.length - reranked.length, // Assign descending scores
        });
        usedIndices.add(idx);
      }
    }

    // Add any remaining candidates that weren't in the ranking
    for (let i = 0; i < candidates.length; i++) {
      if (!usedIndices.has(i)) {
        reranked.push({
          ...candidates[i],
          score: candidates.length - reranked.length,
        });
      }
    }

    // Add remaining results beyond maxCandidates
    for (let i = maxCandidates; i < results.length; i++) {
      reranked.push(results[i]);
    }

    return {
      rerankedResults: reranked.slice(0, topK),
      durationMs: Date.now() - startMs,
      model: llmClient.getModelName?.() ?? "unknown",
      usedLlm: true,
    };
  } catch {
    // Fallback to original order on error
    return {
      rerankedResults: results.slice(0, topK),
      durationMs: Date.now() - startMs,
      model: llmClient.getModelName(),
      usedLlm: false,
    };
  }
}

/**
 * Parse LLM response to extract ranking indices
 */
function parseRankingResponse(content: string, maxIndex: number): number[] {
  // Try to find JSON array in response
  const arrayMatch = content.match(/\[[\d,\s]+\]/);
  if (!arrayMatch) {
    return [];
  }

  try {
    const parsed = JSON.parse(arrayMatch[0]) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    // Validate and filter indices
    return parsed
      .filter((n): n is number => typeof n === "number" && Number.isInteger(n))
      .filter((n) => n >= 0 && n < maxIndex);
  } catch {
    return [];
  }
}

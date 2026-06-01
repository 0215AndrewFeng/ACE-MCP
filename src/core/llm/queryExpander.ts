/**
 * v4.3.9: LLM-based query expansion for cross-language search.
 * Extracts English code keywords from non-ASCII (e.g. Chinese) natural language questions
 * so that FTS can match English class/method/package names.
 */

import type { LlmClient } from "./llmClient.js";

const NON_ASCII_PATTERN = /[^\x00-\x7F]/;

// v4.4.6: In-memory LRU cache for query expansion (max 100 entries, 5-min TTL)
const CACHE_MAX = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  result: { expandedQuery: string; keywords: string[] };
  ts: number;
}

const expansionCache = new Map<string, CacheEntry>();

function getCached(question: string): { expandedQuery: string; keywords: string[] } | undefined {
  const entry = expansionCache.get(question);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    expansionCache.delete(question);
    return undefined;
  }
  return entry.result;
}

function setCached(question: string, result: { expandedQuery: string; keywords: string[] }): void {
  // Evict oldest entry if at capacity
  if (expansionCache.size >= CACHE_MAX) {
    const firstKey = expansionCache.keys().next().value;
    if (firstKey !== undefined) expansionCache.delete(firstKey);
  }
  expansionCache.set(question, { result, ts: Date.now() });
}

const QUERY_EXPANSION_PROMPT = `You are a code search assistant. The user asks a question about code in natural language (possibly Chinese or other non-English language). Your job is to extract likely English code identifiers (class names, method names, package paths, variable names) that the codebase might contain.

Rules:
1. Return ONLY a JSON array of English strings, e.g. ["OrderService", "processPayment", "handleRefund"]
2. Infer plausible English class/method names from the semantic meaning of the question
3. Include both camelCase and PascalCase variations
4. Include domain-specific terms (e.g. "endorse" for 改签, "refund" for 退票, "ticket" for 出票)
5. Keep the list to 5-15 terms, most likely first
6. Do not include any explanation, just the JSON array`;

/**
 * Use LLM to extract English code keywords from a non-ASCII query.
 * Returns the original question with keywords appended for better FTS matching.
 *
 * @param llmClient - configured LLM client
 * @param question  - user's natural language question (may contain Chinese etc.)
 * @param timeoutMs - max wait time (default 8s)
 * @returns expandedQuery (original + keywords) and extracted keywords array
 */
export async function expandQueryWithLlm(
  llmClient: LlmClient,
  question: string,
  timeoutMs = 8_000,
): Promise<{ expandedQuery: string; keywords: string[] }> {
  // Skip if question is pure ASCII (no expansion needed)
  if (!NON_ASCII_PATTERN.test(question)) {
    return { expandedQuery: question, keywords: [] };
  }

  // v4.4.6: Check cache first
  const cached = getCached(question);
  if (cached) return cached;

  try {
    const result = await llmClient.complete({
      messages: [
        { role: "system", content: QUERY_EXPANSION_PROMPT },
        { role: "user", content: question },
      ],
      maxTokens: 256,
      temperature: 0.0,
      timeoutMs,
      fallbackOnTimeout: true,
    });

    if (result.fallback || !result.content) {
      return { expandedQuery: question, keywords: [] };
    }

    // Parse JSON array from response
    const content = result.content.trim();
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return { expandedQuery: question, keywords: [] };
    }

    const keywords: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(keywords) || keywords.length === 0) {
      return { expandedQuery: question, keywords: [] };
    }

    // Filter to valid strings only
    const validKeywords = keywords
      .filter((k): k is string => typeof k === "string" && k.length > 0)
      .slice(0, 15);

    if (validKeywords.length === 0) {
      return { expandedQuery: question, keywords: [] };
    }

    // Append keywords to the original question for broader FTS matching
    const expandedQuery = `${question} ${validKeywords.join(" ")}`;
    const expansionResult = { expandedQuery, keywords: validKeywords };
    setCached(question, expansionResult);
    return expansionResult;
  } catch {
    // Silently fall back — query expansion is optional
    return { expandedQuery: question, keywords: [] };
  }
}

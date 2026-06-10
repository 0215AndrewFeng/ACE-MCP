import { z } from "zod";

import {
  DEFAULT_CALL_GRAPH_DEPTH,
  DEFAULT_INCLUDE_CONTEXT_LINES,
  MAX_CALL_GRAPH_DEPTH,
  MAX_INCLUDE_CONTEXT_LINES,
  type Settings,
} from "../common/types.js";

/**
 * v4.5.9 (#29): single source of truth for request validation shared by the MCP
 * tool layer (strict zod parse) and the web routes (lenient parse — see
 * src/web/requestValidation.ts). Enum tuples and numeric bounds live here so the
 * two layers can never drift apart.
 */

// ── Shared enum tuples ───────────────────────────────────────────────────────
export const SEARCH_FILTER_LANGUAGES = ["java", "javascript", "dotnet", "python", "markdown"] as const;
export const SEARCH_RESULT_MODES = ["full", "metadata"] as const;
export const SEARCH_MODES = ["auto", "lexical", "symbol", "semantic", "hybrid"] as const;
export const QA_CONTEXT_MODES = ["chunk", "merged-file", "full-file"] as const;
export const INDEX_MODES = ["full", "incremental"] as const;

// ── Shared numeric bounds (reused by MCP schemas and web clamps) ─────────────
export const TOPK_MIN = 1;
export const TOPK_MAX = 50;
export {
  DEFAULT_CALL_GRAPH_DEPTH,
  DEFAULT_INCLUDE_CONTEXT_LINES,
  MAX_CALL_GRAPH_DEPTH,
  MAX_INCLUDE_CONTEXT_LINES,
};

// ── Common filter fields shared by search / lookup / call-graph ──────────────
function filterFields() {
  return {
    excludePathPrefix: z.string().min(1).optional(),
    includeContextLines: z
      .number()
      .int()
      .min(DEFAULT_INCLUDE_CONTEXT_LINES)
      .max(MAX_INCLUDE_CONTEXT_LINES)
      .default(DEFAULT_INCLUDE_CONTEXT_LINES),
    languages: z.array(z.enum(SEARCH_FILTER_LANGUAGES)).min(1).optional(),
    pathContains: z.string().min(1).optional(),
    pathPrefix: z.string().min(1).optional(),
    projectRootPath: z.string().min(1),
    query: z.string().min(1),
    resultMode: z.enum(SEARCH_RESULT_MODES).default("full"),
  };
}

function topKField(settings: Settings) {
  return z.number().int().min(TOPK_MIN).max(TOPK_MAX).default(settings.defaultTopK);
}

// ── Raw shape objects (for MCP `registerTool({ inputSchema })`) ──────────────
// settings is injected because topK / maxSources defaults are settings-derived.

export function searchContextShape(settings: Settings) {
  return {
    ...filterFields(),
    mode: z.enum(SEARCH_MODES).default("auto"),
    topK: topKField(settings),
    enableReranker: z
      .boolean()
      .default(false)
      .describe("Enable LLM reranker for search results (requires LLM API configured and enableLlmReranker=true in settings)"),
  };
}

export function symbolLookupShape(settings: Settings) {
  return {
    ...filterFields(),
    topK: topKField(settings),
  };
}

export function callGraphShape(settings: Settings) {
  return {
    ...filterFields(),
    depth: z
      .number()
      .int()
      .min(DEFAULT_CALL_GRAPH_DEPTH)
      .max(MAX_CALL_GRAPH_DEPTH)
      .default(DEFAULT_CALL_GRAPH_DEPTH),
    topK: topKField(settings),
  };
}

export const fileSnippetShape = {
  endLine: z.number().int().min(1),
  filePath: z.string().min(1),
  projectRootPath: z.string().min(1),
  startLine: z.number().int().min(1),
};

export const indexProjectShape = {
  mode: z.enum(INDEX_MODES).default("incremental"),
  projectRootPath: z.string().min(1),
};

export function askCodebaseShape(settings: Settings) {
  return {
    projectRootPath: z.string().min(1),
    question: z.string().min(1).describe("Natural language question about the codebase"),
    maxSources: z
      .number()
      .int()
      .min(1)
      .max(settings.qaMaxSourcesMax)
      .default(settings.qaMaxSourcesDefault)
      .describe("Max code snippets to retrieve as context"),
    maxContextTokens: z
      .number()
      .int()
      .min(1000)
      .max(settings.qaMaxContextTokensMax)
      .optional()
      .describe("Override the context token budget for assembled reference code (defaults to server config; larger = more complete code for big interfaces, bounded by the LLM context window)"),
    includeSummary: z.boolean().default(true).describe("Include project summary as additional context"),
    languages: z.array(z.enum(SEARCH_FILTER_LANGUAGES)).min(1).optional(),
    contextMode: z
      .enum(QA_CONTEXT_MODES)
      .default("merged-file")
      .describe("Context mode: chunk (snippets), merged-file (fill gaps between chunks), full-file (entire files)"),
    enableReranker: z
      .boolean()
      .optional()
      .describe("Override the LLM reranker for this request (defaults to server setting enableLlmReranker; adds an extra LLM call)"),
  };
}

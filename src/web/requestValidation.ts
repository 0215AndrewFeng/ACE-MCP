import type { Settings, SupportedLanguage } from "../core/common/types.js";
import {
  DEFAULT_CALL_GRAPH_DEPTH,
  DEFAULT_INCLUDE_CONTEXT_LINES,
  INDEX_MODES,
  MAX_CALL_GRAPH_DEPTH,
  MAX_INCLUDE_CONTEXT_LINES,
  QA_CONTEXT_MODES,
  SEARCH_MODES,
  SEARCH_RESULT_MODES,
  TOPK_MAX,
  TOPK_MIN,
} from "../core/validation/schemas.js";
import { clampInteger, normalizePathPrefix, normalizeSupportedLanguages } from "./routeHelpers.js";

/**
 * v4.5.9 (#29): lenient web request parsers. These share the enum tuples and
 * numeric bounds from src/core/validation/schemas.ts with the strict MCP tool
 * layer, but keep the web's historical coerce + clamp behavior — only returning
 * an error when a REQUIRED field is missing/empty.
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ── Local helpers ────────────────────────────────────────────────────────────

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function enumOrDefault<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(String(v)) ? (String(v) as T) : fallback;
}

// ── Shared filter shape ──────────────────────────────────────────────────────

interface SearchFilters {
  excludePathPrefix: string | undefined;
  languages: SupportedLanguage[] | undefined;
  pathContains: string | undefined;
  pathPrefix: string | undefined;
}

function parseFilters(body: any): SearchFilters {
  return {
    excludePathPrefix: normalizePathPrefix(body.excludePathPrefix),
    languages: normalizeSupportedLanguages(body.languages),
    pathContains: normalizePathPrefix(body.pathContains),
    pathPrefix: normalizePathPrefix(body.pathPrefix),
  };
}

// ── Parser value shapes ──────────────────────────────────────────────────────

export interface SearchContextRequest {
  projectRootPath: string;
  query: string;
  mode: (typeof SEARCH_MODES)[number];
  topK: number;
  includeContextLines: number;
  resultMode: (typeof SEARCH_RESULT_MODES)[number];
  filters: SearchFilters;
  enableReranker: boolean;
}

export interface SymbolLookupRequest {
  projectRootPath: string;
  query: string;
  topK: number;
  includeContextLines: number;
  resultMode: (typeof SEARCH_RESULT_MODES)[number];
  filters: SearchFilters;
}

export interface CallGraphRequest extends SymbolLookupRequest {
  depth: number;
}

export interface FileSnippetRequest {
  projectRootPath: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface IndexProjectRequest {
  projectRootPath: string;
  mode: (typeof INDEX_MODES)[number];
}

export interface AskRequest {
  projectRootPath: string;
  question: string;
  maxSources: number;
  maxContextTokens: number | undefined;
  includeSummary: boolean;
  languages: SupportedLanguage[] | undefined;
  contextMode: (typeof QA_CONTEXT_MODES)[number];
  callChainDepth: number;
  timeoutSeconds: number;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

export function parseSearchContextRequest(body: any, settings: Settings): ParseResult<SearchContextRequest> {
  body = body ?? {};
  const projectRootPath = nonEmptyString(body.projectRootPath);
  if (!projectRootPath) return { ok: false, error: "projectRootPath is required" };
  const query = nonEmptyString(body.query);
  if (!query) return { ok: false, error: "query is required" };
  return {
    ok: true,
    value: {
      projectRootPath,
      query,
      mode: enumOrDefault(body.mode, SEARCH_MODES, "auto"),
      topK: clampInteger(body.topK, TOPK_MIN, TOPK_MAX, settings.defaultTopK),
      includeContextLines: clampInteger(body.includeContextLines, DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, DEFAULT_INCLUDE_CONTEXT_LINES),
      resultMode: enumOrDefault(body.resultMode, SEARCH_RESULT_MODES, "full"),
      filters: parseFilters(body),
      enableReranker: body.enableReranker === true,
    },
  };
}

export function parseSymbolLookupRequest(body: any, settings: Settings): ParseResult<SymbolLookupRequest> {
  body = body ?? {};
  const projectRootPath = nonEmptyString(body.projectRootPath);
  if (!projectRootPath) return { ok: false, error: "projectRootPath is required" };
  const query = nonEmptyString(body.query);
  if (!query) return { ok: false, error: "query is required" };
  return {
    ok: true,
    value: {
      projectRootPath,
      query,
      topK: clampInteger(body.topK, TOPK_MIN, TOPK_MAX, settings.defaultTopK),
      includeContextLines: clampInteger(body.includeContextLines, DEFAULT_INCLUDE_CONTEXT_LINES, MAX_INCLUDE_CONTEXT_LINES, DEFAULT_INCLUDE_CONTEXT_LINES),
      resultMode: enumOrDefault(body.resultMode, SEARCH_RESULT_MODES, "full"),
      filters: parseFilters(body),
    },
  };
}

export function parseCallGraphRequest(body: any, settings: Settings): ParseResult<CallGraphRequest> {
  const lookup = parseSymbolLookupRequest(body, settings);
  if (!lookup.ok) return lookup;
  return {
    ok: true,
    value: {
      ...lookup.value,
      depth: clampInteger((body ?? {}).depth, DEFAULT_CALL_GRAPH_DEPTH, MAX_CALL_GRAPH_DEPTH, DEFAULT_CALL_GRAPH_DEPTH),
    },
  };
}

export function parseFileSnippetRequest(body: any): ParseResult<FileSnippetRequest> {
  body = body ?? {};
  const projectRootPath = nonEmptyString(body.projectRootPath);
  if (!projectRootPath) return { ok: false, error: "projectRootPath is required" };
  const filePath = nonEmptyString(body.filePath);
  if (!filePath) return { ok: false, error: "filePath is required" };
  return {
    ok: true,
    value: {
      projectRootPath,
      filePath,
      startLine: clampInteger(body.startLine, 1, Number.MAX_SAFE_INTEGER, 1),
      endLine: clampInteger(body.endLine, 1, Number.MAX_SAFE_INTEGER, 1),
    },
  };
}

export function parseIndexProjectRequest(body: any): ParseResult<IndexProjectRequest> {
  body = body ?? {};
  const projectRootPath = nonEmptyString(body.projectRootPath);
  if (!projectRootPath) return { ok: false, error: "projectRootPath is required" };
  return {
    ok: true,
    value: {
      projectRootPath,
      mode: enumOrDefault(body.mode, INDEX_MODES, "incremental"),
    },
  };
}

export function parseAskRequest(body: any, settings: Settings): ParseResult<AskRequest> {
  body = body ?? {};
  const projectRootPath = nonEmptyString(body.projectRootPath);
  if (!projectRootPath) return { ok: false, error: "projectRootPath is required" };
  const question = nonEmptyString(body.question);
  if (!question) return { ok: false, error: "question is required" };
  return {
    ok: true,
    value: {
      projectRootPath,
      question,
      maxSources: clampInteger(body.maxSources, 1, settings.qaMaxSourcesMax, settings.qaMaxSourcesDefault),
      maxContextTokens: body.maxContextTokens != null
        ? clampInteger(body.maxContextTokens, 1000, settings.qaMaxContextTokensMax, settings.qaMaxContextTokens)
        : undefined,
      includeSummary: body.includeSummary !== false,
      languages: normalizeSupportedLanguages(body.languages),
      contextMode: enumOrDefault(body.contextMode, QA_CONTEXT_MODES, "merged-file"),
      callChainDepth: clampInteger(body.callChainDepth, 1, 3, 1),
      timeoutSeconds: clampInteger(body.timeoutSeconds, 10, 600, 120),
    },
  };
}

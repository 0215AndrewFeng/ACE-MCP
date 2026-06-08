import type { AppRuntimeInfo, SupportedLanguage } from "../core/common/types.js";

const SUPPORTED_SEARCH_LANGUAGES = new Set<SupportedLanguage>(["java", "javascript", "dotnet", "python", "markdown"]);

export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numericValue)));
}

export function normalizePathPrefix(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeSupportedLanguages(value: unknown): SupportedLanguage[] | undefined {
  const rawValues = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const languages = [...new Set(rawValues
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((item): item is SupportedLanguage => SUPPORTED_SEARCH_LANGUAGES.has(item as SupportedLanguage)))];
  return languages.length > 0 ? languages : undefined;
}

export function toolCatalog(): Array<{ description: string; name: string }> {
  return [
    { description: "Scan and index a local project for keyword, symbol, and path search.", name: "index_project" },
    { description: "Pre-build vector embeddings for a project to enable fast semantic search.", name: "warm_index" },
    { description: "Incrementally index the project and return code snippets relevant to a natural language, symbol, path, or semantic query.", name: "search_context" },
    { description: "Incrementally index the project and locate symbol definitions with signatures and snippets.", name: "find_definition" },
    { description: "Incrementally index the project, resolve the best definition, and return likely references.", name: "find_references" },
    { description: "Incrementally index the project, resolve the target symbol, and return indexed caller relationships with optional multi-hop depth.", name: "find_callers" },
    { description: "Incrementally index the project, resolve the target symbol, and return indexed callee relationships with optional multi-hop depth.", name: "find_callees" },
    { description: "Run expected-result search cases to measure retrieval quality on an indexed project.", name: "evaluate_search_quality" },
    { description: "Read a range of lines from a project file.", name: "get_file_snippet" },
    { description: "Return indexing stats for a local project.", name: "project_stats" },
  ];
}

export function buildRuntimeStatus(runtime: AppRuntimeInfo) {
  return { ...runtime, uptimeMs: Math.round(Date.now() - Date.parse(runtime.startedAt)) };
}

import path from "node:path";

import type { Language, SearchFilters, SupportedLanguage, VectorEntry } from "../common/types.js";
import type { Logger } from "../common/logger.js";

/**
 * v4.5.8 (#30): parse a value that may hold corrupt JSON (e.g. a DB column)
 * without crashing. On failure logs a warning and returns the fallback.
 */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T, logger?: Logger, context?: string): T {
  if (raw === null || raw === undefined || raw === "") {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger?.warn("failed to parse JSON column", {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

export function normalizeComparablePath(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function matchesSearchFilters(
  entry: Pick<VectorEntry, "filePath" | "language">,
  filters: SearchFilters | undefined,
): boolean {
  if (!filters) {
    return true;
  }

  const normalizedPath = normalizeComparablePath(entry.filePath);
  if (filters.languages && filters.languages.length > 0 && !filters.languages.includes(entry.language as SupportedLanguage)) {
    return false;
  }

  if (filters.pathPrefix && !normalizedPath.startsWith(normalizeComparablePath(filters.pathPrefix))) {
    return false;
  }

  if (filters.pathContains && !normalizedPath.includes(normalizeComparablePath(filters.pathContains))) {
    return false;
  }

  if (filters.excludePathPrefix && normalizedPath.startsWith(normalizeComparablePath(filters.excludePathPrefix))) {
    return false;
  }

  return true;
}

export function buildSearchFilterClause(filters: SearchFilters | undefined): {
  parameters: Array<string>;
  sql: string;
} {
  if (!filters) {
    return { parameters: [], sql: "" };
  }

  const clauses: string[] = [];
  const parameters: string[] = [];

  if (filters.languages && filters.languages.length > 0) {
    clauses.push(`f.language IN (${filters.languages.map(() => "?").join(", ")})`);
    parameters.push(...filters.languages);
  }

  if (filters.pathPrefix) {
    clauses.push("LOWER(f.relative_path) LIKE ?");
    parameters.push(`${filters.pathPrefix.toLowerCase()}%`);
  }

  if (filters.pathContains) {
    clauses.push("LOWER(f.relative_path) LIKE ?");
    parameters.push(`%${filters.pathContains.toLowerCase()}%`);
  }

  if (filters.excludePathPrefix) {
    clauses.push("LOWER(f.relative_path) NOT LIKE ?");
    parameters.push(`${filters.excludePathPrefix.toLowerCase()}%`);
  }

  return {
    parameters,
    sql: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "",
  };
}

export function normalizeModulePath(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return value
    .replace(/\\/g, "/")
    .replace(/\.[^.]+$/, "")
    .replace(/\/index$/, "")
    .trim()
    .toLowerCase();
}

export function resolveImportSourceModule(filePath: string, sourceModule: string, language: Language): string | null {
  if (!sourceModule) {
    return null;
  }

  if (language === "javascript" && sourceModule.startsWith(".")) {
    const directory = path.posix.dirname(filePath.replace(/\\/g, "/"));
    return normalizeModulePath(path.posix.normalize(path.posix.join(directory, sourceModule)));
  }

  if (language === "python") {
    return sourceModule.toLowerCase();
  }

  return normalizeModulePath(sourceModule);
}

import type { BigIntStats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { MAX_PROJECT_ROUTE_TERM_LENGTH, type ProjectRouteMatch } from "../common/types.js";
import { buildSemanticTerms } from "./semanticText.js";

const SUMMARY_RELATIVE_PATH = ".ace-mcp/summaries/project-summary.json";
const MAX_SUMMARY_FILE_BYTES = 1_048_576;
const MAX_SUMMARY_ROUTE_TEXT_LENGTH = 32_768;
const MAX_SUMMARY_MODULES = 200;
const MAX_MODULE_KEY_SYMBOLS = 20;

interface SummaryModuleInput {
  description?: unknown;
  keySymbols?: unknown;
  path?: unknown;
}

interface ProjectSummaryInput {
  architecture?: unknown;
  modules?: unknown;
}

interface SummaryRouteCacheEntry {
  signature: string;
  terms: Set<string> | null;
}

function appendBounded(parts: string[], value: unknown, remaining: number): number {
  if (typeof value !== "string" || remaining <= 0) {
    return remaining;
  }

  const normalized = value.normalize("NFKC").trim();
  if (!normalized) {
    return remaining;
  }

  const bounded = normalized.slice(0, remaining);
  parts.push(bounded);
  return remaining - bounded.length;
}

function addExactTerm(terms: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value
    .normalize("NFKC")
    .replaceAll("\\", "/")
    .trim()
    .toLowerCase()
    .slice(0, MAX_PROJECT_ROUTE_TERM_LENGTH);
  if (normalized) {
    terms.add(normalized);
  }
}

function buildSummaryRouteTerms(projectRootPath: string, summary: ProjectSummaryInput): Set<string> | null {
  const parts: string[] = [];
  const exactTerms = new Set<string>();
  let remaining = MAX_SUMMARY_ROUTE_TEXT_LENGTH;
  const projectName = path.basename(projectRootPath);
  addExactTerm(exactTerms, projectName);
  remaining = appendBounded(parts, projectName, remaining);
  remaining = appendBounded(parts, summary.architecture, remaining);

  if (Array.isArray(summary.modules)) {
    for (const moduleValue of summary.modules.slice(0, MAX_SUMMARY_MODULES)) {
      if (!moduleValue || typeof moduleValue !== "object" || remaining <= 0) {
        continue;
      }
      const module = moduleValue as SummaryModuleInput;
      addExactTerm(exactTerms, module.path);
      remaining = appendBounded(parts, module.path, remaining);
      remaining = appendBounded(parts, module.description, remaining);
      if (Array.isArray(module.keySymbols)) {
        for (const symbol of module.keySymbols.slice(0, MAX_MODULE_KEY_SYMBOLS)) {
          addExactTerm(exactTerms, symbol);
          remaining = appendBounded(parts, symbol, remaining);
          if (remaining <= 0) {
            break;
          }
        }
      }
    }
  }

  const terms = new Set([...buildSemanticTerms(parts.join("\n")), ...exactTerms]);
  return terms.size > 0 ? terms : null;
}

export class ProjectSummaryRouteCatalog {
  private readonly cache = new Map<string, SummaryRouteCacheEntry>();

  public async findMatches(projectRootPaths: string[], routeTerms: string[]): Promise<ProjectRouteMatch[]> {
    const matches = await Promise.all([...new Set(projectRootPaths)].map(async (
      projectRootPath,
    ): Promise<ProjectRouteMatch | null> => {
      const terms = await this.loadTerms(projectRootPath);
      if (!terms) {
        return null;
      }

      const matchedTerms = routeTerms.filter((term) => terms.has(term));
      if (matchedTerms.length === 0) {
        return null;
      }

      return {
        filePath: SUMMARY_RELATIVE_PATH,
        matchedTerms,
        matchText: matchedTerms.join(" "),
        projectId: projectRootPath,
        projectRootPath,
        rank: 0,
        source: "summary" as const,
      };
    }));

    return matches.filter((match): match is ProjectRouteMatch => match !== null);
  }

  private async loadTerms(projectRootPath: string): Promise<Set<string> | null> {
    const summaryPath = path.join(projectRootPath, SUMMARY_RELATIVE_PATH);
    let fileStat: BigIntStats;
    try {
      fileStat = await stat(summaryPath, { bigint: true });
    } catch {
      this.cache.delete(projectRootPath);
      return null;
    }

    if (!fileStat.isFile() || fileStat.size > BigInt(MAX_SUMMARY_FILE_BYTES)) {
      this.cache.set(projectRootPath, { signature: `${fileStat.mtimeNs}:${fileStat.size}`, terms: null });
      return null;
    }

    const signature = `${fileStat.mtimeNs}:${fileStat.size}`;
    const cached = this.cache.get(projectRootPath);
    if (cached?.signature === signature) {
      return cached.terms;
    }

    try {
      const content = await readFile(summaryPath, "utf8");
      const summary = JSON.parse(content) as ProjectSummaryInput;
      const terms = summary && typeof summary === "object"
        ? buildSummaryRouteTerms(projectRootPath, summary)
        : null;
      this.cache.set(projectRootPath, { signature, terms });
      return terms;
    } catch {
      this.cache.set(projectRootPath, { signature, terms: null });
      return null;
    }
  }
}

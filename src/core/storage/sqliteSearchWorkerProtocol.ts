import type { IndexedFileRecord, ProjectRouteMatch, SearchFilters, SearchResult } from "../common/types.js";

export interface SQLiteSearchCandidatePhaseResult {
  durationMs: number;
  error?: string;
  results: SearchResult[];
}

export interface SQLiteSearchCandidateGroups {
  identifierBoost: SQLiteSearchCandidatePhaseResult;
  lexical: SQLiteSearchCandidatePhaseResult;
  path: SQLiteSearchCandidatePhaseResult;
  semanticFts: SQLiteSearchCandidatePhaseResult;
  symbol: SQLiteSearchCandidatePhaseResult;
  unicodeSubstring: SQLiteSearchCandidatePhaseResult;
}

export interface SQLiteSearchCandidateStrategies {
  identifierBoost?: { ftsQuery: string; limit: number };
  lexical?: { ftsQuery: string; limit: number };
  path?: { limit: number; tokens: string[] };
  semanticFts?: { limit: number; semanticTerms: string[] };
  symbol?: { limit: number; tokens: string[] };
  unicodeSubstring?: { limit: number; tokens: string[] };
}

export type SQLiteSearchWorkerRequest =
  | {
      id: number;
      method: "searchCandidates";
      payload: {
        filters?: SearchFilters;
        projectId: string;
        strategies: SQLiteSearchCandidateStrategies;
      };
    }
  | {
      id: number;
      method: "listProjectFiles";
      payload: { projectId: string };
    }
  | {
      id: number;
      method: "searchProjectRoutes";
      payload: {
        excludedProjectRootPaths: string[];
        exactSymbols: string[];
        ftsQuery: string | null;
        limit: number;
        routeTerms: string[];
      };
    }
  | {
      id: number;
      method: "getFilePreviewResults";
      payload: {
        projectId: string;
        relativePaths: string[];
      };
    }
  | {
      id: number;
      method: "searchByPath";
      payload: {
        filters?: SearchFilters;
        limit: number;
        projectId: string;
        tokens: string[];
      };
    }
  | {
      id: number;
      method: "searchBySemantic";
      payload: {
        filters?: SearchFilters;
        limit: number;
        projectId: string;
        semanticTerms: string[];
      };
    }
  | {
      id: number;
      method: "searchBySymbols";
      payload: {
        filters?: SearchFilters;
        limit: number;
        projectId: string;
        tokens: string[];
      };
    }
  | {
      id: number;
      method: "searchByText";
      payload: {
        filters?: SearchFilters;
        ftsQuery: string;
        limit: number;
        projectId: string;
      };
    }
  | {
      id: number;
      method: "searchByTextSubstrings";
      payload: {
        filters?: SearchFilters;
        limit: number;
        projectId: string;
        tokens: string[];
      };
    };

export type SQLiteSearchWorkerResponse =
  | {
      id: number;
      ok: true;
      result: IndexedFileRecord[] | ProjectRouteMatch[] | SearchResult[] | SQLiteSearchCandidateGroups;
    }
  | {
      error: {
        message: string;
        stack?: string;
      };
      id: number;
      ok: false;
    };

export interface SQLiteSearchWorkerData {
  databasePath: string;
  logFilePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

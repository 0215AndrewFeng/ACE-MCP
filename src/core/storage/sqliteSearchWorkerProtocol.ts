import type { ProjectRouteMatch, SearchFilters, SearchResult } from "../common/types.js";

export type SQLiteSearchWorkerRequest =
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
      result: ProjectRouteMatch[] | SearchResult[];
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

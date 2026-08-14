import { parentPort, workerData } from "node:worker_threads";

import { Logger } from "../common/logger.js";
import type { SearchResult } from "../common/types.js";
import { SQLiteStore } from "./sqliteStore.js";
import type {
  SQLiteSearchCandidateGroups,
  SQLiteSearchCandidatePhaseResult,
  SQLiteSearchWorkerData,
  SQLiteSearchWorkerRequest,
  SQLiteSearchWorkerResponse,
} from "./sqliteSearchWorkerProtocol.js";

const envWorkerData = process.env.ACE_MCP_SQLITE_SEARCH_WORKER_DATA;
const data = parentPort
  ? workerData as SQLiteSearchWorkerData
  : envWorkerData
    ? JSON.parse(envWorkerData) as SQLiteSearchWorkerData
    : null;

if (!data) {
  throw new Error("sqliteSearchWorker must be started with worker data");
}
const logger = new Logger(data.logFilePath, data.logLevel);
const store = new SQLiteStore(data.databasePath, logger);

function toErrorPayload(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
}

function handleRequest(request: SQLiteSearchWorkerRequest): void {
  let response: SQLiteSearchWorkerResponse;

  try {
    switch (request.method) {
      case "searchCandidates": {
        const runCandidatePhase = (operation?: () => SearchResult[]): SQLiteSearchCandidatePhaseResult => {
          if (!operation) {
            return { durationMs: 0, results: [] };
          }
          const startedAt = Date.now();
          try {
            const results = operation();
            return {
              durationMs: Math.max(0, Date.now() - startedAt),
              results,
            };
          } catch (error: unknown) {
            return {
              durationMs: Math.max(0, Date.now() - startedAt),
              error: error instanceof Error ? error.message : String(error),
              results: [],
            };
          }
        };
        const { filters, projectId, strategies } = request.payload;
        const result: SQLiteSearchCandidateGroups = {
          lexical: runCandidatePhase(strategies.lexical
            ? () => store.searchByText(projectId, strategies.lexical!.ftsQuery, strategies.lexical!.limit, filters)
            : undefined),
          semanticFts: runCandidatePhase(strategies.semanticFts
            ? () => store.searchBySemantic(projectId, strategies.semanticFts!.semanticTerms, strategies.semanticFts!.limit, filters)
            : undefined),
          unicodeSubstring: runCandidatePhase(strategies.unicodeSubstring
            ? () => store.searchByTextSubstrings(projectId, strategies.unicodeSubstring!.tokens, strategies.unicodeSubstring!.limit, filters)
            : undefined),
          symbol: runCandidatePhase(strategies.symbol
            ? () => store.searchBySymbols(projectId, strategies.symbol!.tokens, strategies.symbol!.limit, filters)
            : undefined),
          path: runCandidatePhase(strategies.path
            ? () => store.searchByPath(projectId, strategies.path!.tokens, strategies.path!.limit, filters)
            : undefined),
          identifierBoost: runCandidatePhase(strategies.identifierBoost
            ? () => store.searchByText(projectId, strategies.identifierBoost!.ftsQuery, strategies.identifierBoost!.limit, filters)
            : undefined),
        };
        response = { id: request.id, ok: true, result };
        break;
      }
      case "getFilePreviewResults":
        response = {
          id: request.id,
          ok: true,
          result: store.getFilePreviewResults(request.payload.projectId, request.payload.relativePaths),
        };
        break;
      case "listProjectFiles":
        response = {
          id: request.id,
          ok: true,
          result: store.listProjectFiles(request.payload.projectId),
        };
        break;
      case "searchProjectRoutes":
        response = {
          id: request.id,
          ok: true,
          result: store.searchProjectRoutes(
            request.payload.ftsQuery,
            request.payload.exactSymbols,
            request.payload.limit,
            request.payload.excludedProjectRootPaths,
            request.payload.routeTerms,
          ),
        };
        break;
      case "searchByPath":
        response = {
          id: request.id,
          ok: true,
          result: store.searchByPath(
            request.payload.projectId,
            request.payload.tokens,
            request.payload.limit,
            request.payload.filters,
          ),
        };
        break;
      case "searchBySemantic":
        response = {
          id: request.id,
          ok: true,
          result: store.searchBySemantic(
            request.payload.projectId,
            request.payload.semanticTerms,
            request.payload.limit,
            request.payload.filters,
          ),
        };
        break;
      case "searchBySymbols":
        response = {
          id: request.id,
          ok: true,
          result: store.searchBySymbols(
            request.payload.projectId,
            request.payload.tokens,
            request.payload.limit,
            request.payload.filters,
          ),
        };
        break;
      case "searchByText":
        response = {
          id: request.id,
          ok: true,
          result: store.searchByText(
            request.payload.projectId,
            request.payload.ftsQuery,
            request.payload.limit,
            request.payload.filters,
          ),
        };
        break;
      case "searchByTextSubstrings":
        response = {
          id: request.id,
          ok: true,
          result: store.searchByTextSubstrings(
            request.payload.projectId,
            request.payload.tokens,
            request.payload.limit,
            request.payload.filters,
          ),
        };
        break;
    }
  } catch (error: unknown) {
    response = {
      error: toErrorPayload(error),
      id: request.id,
      ok: false,
    };
  }

  if (parentPort) {
    parentPort.postMessage(response);
  } else if (process.send) {
    process.send(response);
  }
}

if (parentPort) {
  parentPort.on("message", handleRequest);
} else {
  process.on("message", (request) => handleRequest(request as SQLiteSearchWorkerRequest));
}

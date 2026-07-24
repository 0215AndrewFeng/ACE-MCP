import { parentPort, workerData } from "node:worker_threads";

import { Logger } from "../common/logger.js";
import { SQLiteStore } from "./sqliteStore.js";
import type {
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
      case "getFilePreviewResults":
        response = {
          id: request.id,
          ok: true,
          result: store.getFilePreviewResults(request.payload.projectId, request.payload.relativePaths),
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
        store.ensureSemanticIndex(request.payload.projectId);
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

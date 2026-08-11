import { parentPort, workerData } from "node:worker_threads";

import { Logger } from "../common/logger.js";
import { SQLiteStore } from "./sqliteStore.js";
import type {
  FinalizeProjectIndexResult,
  PrepareProjectIndexResult,
  SQLiteIndexWorkerData,
  SQLiteIndexWorkerRequest,
  SQLiteIndexWorkerResponse,
} from "./sqliteIndexWorkerProtocol.js";

const envWorkerData = process.env.ACE_MCP_SQLITE_INDEX_WORKER_DATA;
const data = parentPort
  ? workerData as SQLiteIndexWorkerData
  : envWorkerData
    ? JSON.parse(envWorkerData) as SQLiteIndexWorkerData
    : null;

if (!data) {
  throw new Error("sqliteIndexWorker must be started with worker data");
}

const logger = new Logger(data.logFilePath, data.logLevel);
const store = new SQLiteStore(data.databasePath, logger);

function toErrorPayload(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function handleRequest(request: SQLiteIndexWorkerRequest): void {
  let response: SQLiteIndexWorkerResponse;
  try {
    let result: boolean | FinalizeProjectIndexResult | PrepareProjectIndexResult | null = null;
    switch (request.method) {
      case "tryAcquireIndexMaintenanceLease":
        result = store.tryAcquireIndexMaintenanceLease(
          request.payload.ownerId,
          request.payload.expiresAtMs,
          request.payload.nowMs,
        );
        break;
      case "renewIndexMaintenanceLease":
        result = store.renewIndexMaintenanceLease(
          request.payload.ownerId,
          request.payload.expiresAtMs,
          request.payload.nowMs,
        );
        break;
      case "releaseIndexMaintenanceLease":
        result = store.releaseIndexMaintenanceLease(request.payload.ownerId);
        break;
      case "deleteFiles":
        store.deleteFiles(request.payload.projectId, request.payload.relativePaths);
        break;
      case "finalizeProjectIndex":
        result = store.finalizeProjectIndex(
          request.payload.projectId,
          request.payload.finalization,
        );
        break;
      case "ensureSemanticIndex":
        store.ensureSemanticIndex(request.payload.projectId);
        break;
      case "resolveSymbolGraph":
        store.resolveSymbolGraph(request.payload.projectId, new Set(request.payload.changedFileIds));
        break;
      case "prepareProjectIndex":
        result = store.prepareProjectIndex(
          request.payload.projectId,
          request.payload.project,
          request.payload.timestamp,
        );
        break;
      case "writeChunkVectors":
        store.writeChunkVectors(request.payload.entries, request.payload.projectId);
        break;
      case "writeFileIndexBatch":
        store.writeFileIndexBatch(
          request.payload.projectId,
          request.payload.files,
          request.payload.indexedAt,
        );
        break;
    }
    response = { id: request.id, ok: true, result };
  } catch (error: unknown) {
    response = {
      error: toErrorPayload(error),
      id: request.id,
      ok: false,
    };
  }

  if (parentPort) {
    parentPort.postMessage(response);
  } else {
    process.send?.(response);
  }
}

if (parentPort) {
  parentPort.on("message", handleRequest);
} else {
  process.on("message", (request) => handleRequest(request as SQLiteIndexWorkerRequest));
}

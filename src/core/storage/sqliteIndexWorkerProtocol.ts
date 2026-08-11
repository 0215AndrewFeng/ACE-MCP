import type {
  ChunkRecord,
  ImportInfo,
  IndexedFileRecord,
  ProjectInfo,
  SymbolInfo,
  SymbolUsageInfo,
} from "../common/types.js";
import type {
  FinalizeProjectIndexPayload,
  FinalizeProjectIndexResult,
  PrepareProjectIndexResult,
} from "./sqliteStoreTypes.js";

export type {
  FinalizeProjectIndexPayload,
  FinalizeProjectIndexResult,
  PrepareProjectIndexResult,
} from "./sqliteStoreTypes.js";

export interface SQLiteIndexFileBatch {
  chunks: ChunkRecord[];
  imports: ImportInfo[];
  indexedFile: IndexedFileRecord;
  symbols: SymbolInfo[];
  usages: SymbolUsageInfo[];
}

export type SQLiteIndexWorkerRequest =
  | {
      id: number;
      method: "tryAcquireIndexMaintenanceLease";
      payload: { expiresAtMs: number; nowMs: number; ownerId: string };
    }
  | {
      id: number;
      method: "renewIndexMaintenanceLease";
      payload: { expiresAtMs: number; nowMs: number; ownerId: string };
    }
  | {
      id: number;
      method: "releaseIndexMaintenanceLease";
      payload: { ownerId: string };
    }
  | {
      id: number;
      method: "deleteFiles";
      payload: { projectId: string; relativePaths: string[] };
    }
  | {
      id: number;
      method: "finalizeProjectIndex";
      payload: { finalization: FinalizeProjectIndexPayload; projectId: string };
    }
  | {
      id: number;
      method: "ensureSemanticIndex";
      payload: { projectId: string };
    }
  | {
      id: number;
      method: "resolveSymbolGraph";
      payload: { changedFileIds: string[]; projectId: string };
    }
  | {
      id: number;
      method: "prepareProjectIndex";
      payload: { project: ProjectInfo; projectId: string; timestamp: string };
    }
  | {
      id: number;
      method: "writeChunkVectors";
      payload: {
        entries: Array<{ chunkId: string; embedding: number[]; modelName: string }>;
        projectId: string;
      };
    }
  | {
      id: number;
      method: "writeFileIndexBatch";
      payload: { files: SQLiteIndexFileBatch[]; indexedAt: string; projectId: string };
    };

export type SQLiteIndexWorkerResponse =
  | { id: number; ok: true; result: boolean | FinalizeProjectIndexResult | PrepareProjectIndexResult | null }
  | {
      error: { message: string; stack?: string };
      id: number;
      ok: false;
    };

export interface SQLiteIndexWorkerData {
  databasePath: string;
  logFilePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

import type {
  IndexFailure,
  IndexTimingStats,
  IndexVectorStats,
  IndexedFileRecord,
  Language,
  ProjectInfo,
  ProjectStatus,
  SymbolInfo,
  SymbolUsageKind,
} from "../common/types.js";

export interface ProjectRow {
  index_version: number;
  languages: string;
  last_index_at: string | null;
  last_scan_at: string | null;
  project_id: string;
  project_root_path: string;
  project_type: ProjectInfo["projectType"];
  status: ProjectStatus;
}

export interface SearchRow {
  content: string;
  end_line: number;
  language: Language;
  name?: string;
  raw_score: number;
  relative_path: string;
  start_line: number;
}

export interface IndexEventPayload {
  changedFiles: number;
  chunkCount: number;
  createdAt: string;
  deletedFiles: number;
  failedFiles: IndexFailure[];
  indexedFiles: number;
  metadata: {
    timings: IndexTimingStats;
    vectorIndex: IndexVectorStats;
    // v4.3.3: Git optimization tracking
    gitOptimization?: {
      enabled: boolean;
      commit: string | null;
    };
  };
  scannedFiles: number;
}

export interface FinalizeProjectIndexPayload {
  bumpIndexVersion: boolean;
  event: Omit<IndexEventPayload, "metadata"> & {
    metadata: Omit<IndexEventPayload["metadata"], "timings">;
  };
  lastIndexedCommit?: string;
  status: ProjectStatus;
  timestamp: string;
  timing: {
    baseTimings: IndexTimingStats;
    finalizeStartedAtMs: number;
    finalizeWriteStartedAtMs: number;
    indexStartedAtMs: number;
    totalStartedAtMs: number;
  };
}

export interface FinalizeProjectIndexResult {
  indexVersion: number;
  timings: IndexTimingStats;
}

export interface PrepareProjectIndexResult {
  existingFiles: IndexedFileRecord[];
}

export interface IndexEventRow {
  changed_files: number;
  chunk_count: number;
  created_at: string;
  deleted_files: number;
  event_id: string;
  indexed_files: number;
  metadata_json: string;
  scanned_files: number;
}

export interface SymbolRow {
  canonical_name: string | null;
  container_name: string | null;
  file_id: string;
  full_name: string;
  kind: SymbolInfo["kind"];
  line: number;
  module_path: string | null;
  name: string;
  relative_path: string;
  signature: string;
  symbol_id: string;
}

export interface CallGraphRow {
  content: string;
  end_line: number;
  language: Language;
  owner_symbol: string | null;
  owner_symbol_id: string | null;
  raw_name: string;
  relative_path: string;
  resolved_symbol: string | null;
  resolved_symbol_id: string | null;
  start_line: number;
  usage_id: string;
  usage_kind: SymbolUsageKind;
}

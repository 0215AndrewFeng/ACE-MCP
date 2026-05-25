import path from "node:path";

import Database from "better-sqlite3";

import { buildStableId } from "../indexing/fileFingerprint.js";
import { normalizeAbsolutePath } from "../project/pathNormalizer.js";
import { buildSemanticFtsQuery, buildSemanticText } from "../search/semanticText.js";
import type {
  CallGraphMatch,
  ChunkRecord,
  DefinitionMatch,
  ImportInfo,
  IndexEventSummary,
  IndexFailure,
  IndexTimingStats,
  IndexVectorStats,
  IndexedFileRecord,
  Language,
  ProjectListItem,
  ProjectInfo,
  ProjectStats,
  ProjectStatus,
  SearchFilters,
  SearchResult,
  SymbolUsageInfo,
  SymbolUsageKind,
  SupportedLanguage,
  SymbolInfo,
  VectorEntry,
} from "../common/types.js";
import type { Logger } from "../common/logger.js";

/**
 * 计算两个向量的余弦相似度
 */
function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  if (a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * Min-heap for maintaining top-K highest-scoring items.
 * Uses a min-heap so the smallest score is always at the root,
 * making it O(1) to check and O(log K) to replace.
 */
class TopKHeap {
  private readonly heap: Array<{ id: string; score: number }> = [];

  constructor(private readonly k: number) {}

  push(id: string, score: number): void {
    if (this.heap.length < this.k) {
      this.heap.push({ id, score });
      this.bubbleUp(this.heap.length - 1);
    } else if (score > this.heap[0].score) {
      this.heap[0] = { id, score };
      this.sinkDown(0);
    }
  }

  /** Returns items sorted descending by score */
  drain(): Array<{ id: string; score: number }> {
    return this.heap.sort((a, b) => b.score - a.score);
  }

  get size(): number {
    return this.heap.length;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].score <= this.heap[i].score) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.heap[left].score < this.heap[smallest].score) smallest = left;
      if (right < n && this.heap[right].score < this.heap[smallest].score) smallest = right;
      if (smallest === i) break;
      [this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]];
      i = smallest;
    }
  }
}

interface ProjectRow {
  index_version: number;
  languages: string;
  last_index_at: string | null;
  last_scan_at: string | null;
  project_id: string;
  project_root_path: string;
  project_type: ProjectInfo["projectType"];
  status: ProjectStatus;
}

interface SearchRow {
  content: string;
  end_line: number;
  language: Language;
  name?: string;
  raw_score: number;
  relative_path: string;
  start_line: number;
}

interface IndexEventPayload {
  changedFiles: number;
  chunkCount: number;
  createdAt: string;
  deletedFiles: number;
  failedFiles: IndexFailure[];
  indexedFiles: number;
  metadata: {
    timings: IndexTimingStats;
    vectorIndex: IndexVectorStats;
  };
  scannedFiles: number;
}

interface IndexEventRow {
  changed_files: number;
  chunk_count: number;
  created_at: string;
  deleted_files: number;
  event_id: string;
  indexed_files: number;
  metadata_json: string;
  scanned_files: number;
}

interface SymbolRow {
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

interface CallGraphRow {
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

function normalizeComparablePath(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function matchesSearchFilters(
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

function buildSearchFilterClause(filters: SearchFilters | undefined): {
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

function normalizeModulePath(value: string | null | undefined): string | null {
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

function resolveImportSourceModule(filePath: string, sourceModule: string, language: Language): string | null {
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

const VECTOR_CACHE_MAX_PROJECTS = 10;

export class SQLiteStore {
  private readonly db: Database.Database;
  private readonly vectorCache = new Map<string, { indexVersion: number; modelName: string; vectors: VectorEntry[] }>();
  private readonly vectorCacheOrder: string[] = [];
  private vectorCacheMaxProjects = VECTOR_CACHE_MAX_PROJECTS;

  public constructor(databasePath: string, private readonly logger: Logger) {
    this.db = new Database(databasePath);
  }

  /** Allow external configuration of vector cache size */
  public setVectorCacheMaxProjects(max: number): void {
    this.vectorCacheMaxProjects = max;
    this.evictVectorCache();
  }

  private clearVectorCache(projectId?: string): void {
    if (projectId) {
      this.vectorCache.delete(projectId);
      const orderIdx = this.vectorCacheOrder.indexOf(projectId);
      if (orderIdx >= 0) {
        this.vectorCacheOrder.splice(orderIdx, 1);
      }
      return;
    }

    this.vectorCache.clear();
    this.vectorCacheOrder.length = 0;
  }

  private evictVectorCache(): void {
    while (this.vectorCache.size > this.vectorCacheMaxProjects && this.vectorCacheOrder.length > 0) {
      const oldest = this.vectorCacheOrder.shift()!;
      this.vectorCache.delete(oldest);
    }
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  public deleteFiles(projectId: string, relativePaths: string[]): void {
    if (relativePaths.length === 0) {
      return;
    }

    const fileIds = this.db
      .prepare(
        `SELECT file_id
         FROM file
         WHERE project_id = ?
           AND relative_path IN (${relativePaths.map(() => "?").join(", ")})`,
      )
      .all(projectId, ...relativePaths) as Array<{ file_id: string }>;

    const deleteChunkFts = this.db.prepare("DELETE FROM chunk_fts WHERE chunk_id = ?");
    const deleteChunkSemanticFts = this.db.prepare("DELETE FROM chunk_semantic_fts WHERE chunk_id = ?");
    const deleteImports = this.db.prepare("DELETE FROM import_alias WHERE file_id = ?");
    const deleteSymbols = this.db.prepare("DELETE FROM symbol WHERE file_id = ?");
    const deleteUsages = this.db.prepare("DELETE FROM symbol_usage WHERE file_id = ?");
    const deleteFile = this.db.prepare("DELETE FROM file WHERE file_id = ?");
    const selectChunkIds = this.db.prepare("SELECT chunk_id FROM chunk WHERE file_id = ?");
    const deleteChunks = this.db.prepare("DELETE FROM chunk WHERE file_id = ?");

    const tx = this.db.transaction((ids: string[]) => {
      for (const fileId of ids) {
        const chunkIds = selectChunkIds.all(fileId) as Array<{ chunk_id: string }>;
        for (const chunkId of chunkIds) {
          deleteChunkFts.run(chunkId.chunk_id);
          deleteChunkSemanticFts.run(chunkId.chunk_id);
        }

        deleteImports.run(fileId);
        deleteSymbols.run(fileId);
        deleteUsages.run(fileId);
        deleteChunks.run(fileId);
        deleteFile.run(fileId);
      }
    });

    tx(fileIds.map((row) => row.file_id));
    this.clearVectorCache(projectId);
  }

  public getProjectByRoot(projectRootPath: string): ProjectRow | undefined {
    const normalizedProjectRootPath = normalizeAbsolutePath(projectRootPath);
    return this.db
      .prepare(
        `SELECT project_id, project_root_path, project_type, languages, last_scan_at, last_index_at, status, index_version
          FROM project
          WHERE project_root_path = ?`,
      )
      .get(normalizedProjectRootPath) as ProjectRow | undefined;
  }

  public getProjectStats(projectRootPath: string): ProjectStats | null {
    const project = this.getProjectByRoot(projectRootPath);
    if (!project) {
      return null;
    }

    const fileCount = (this.db.prepare("SELECT COUNT(*) AS count FROM file WHERE project_id = ?").get(project.project_id) as {
      count: number;
    }).count;
    const chunkCount = (
      this.db.prepare(
        `SELECT COUNT(*) AS count
         FROM chunk c
         JOIN file f ON f.file_id = c.file_id
         WHERE f.project_id = ?`,
      ).get(project.project_id) as { count: number }
    ).count;
    const symbolCount = (
      this.db.prepare(
        `SELECT COUNT(*) AS count
         FROM symbol s
         JOIN file f ON f.file_id = s.file_id
         WHERE f.project_id = ?`,
      ).get(project.project_id) as { count: number }
    ).count;

    return {
      chunkCount,
      fileCount,
      languages: JSON.parse(project.languages) as Language[],
      lastIndexAt: project.last_index_at,
      latestIndexEvent: this.getLatestIndexEvent(project.project_id),
      lastScanAt: project.last_scan_at,
      projectRootPath: project.project_root_path,
      status: project.status,
      symbolCount,
    };
  }

  public listProjects(): ProjectListItem[] {
    const rows = this.db
      .prepare(
        `SELECT project_root_path, languages, last_scan_at, last_index_at, status
         FROM project
         ORDER BY COALESCE(last_index_at, last_scan_at, '') DESC, project_root_path ASC`,
      )
      .all() as Array<{
      languages: string;
      last_index_at: string | null;
      last_scan_at: string | null;
      project_root_path: string;
      status: ProjectStatus;
    }>;

    return rows.map((row) => ({
      languages: JSON.parse(row.languages) as Language[],
      lastIndexAt: row.last_index_at,
      lastScanAt: row.last_scan_at,
      projectRootPath: row.project_root_path,
      status: row.status,
    }));
  }

  public getProjectByPath(projectRootPath: string): ProjectListItem | null {
    const row = this.db
      .prepare(
        `SELECT project_root_path, languages, last_scan_at, last_index_at, status
         FROM project
         WHERE project_root_path = ?`,
      )
      .get(projectRootPath) as {
        languages: string;
        last_index_at: string | null;
        last_scan_at: string | null;
        project_root_path: string;
        status: ProjectStatus;
      } | undefined;

    if (!row) {
      return null;
    }

    return {
      languages: JSON.parse(row.languages) as Language[],
      lastIndexAt: row.last_index_at,
      lastScanAt: row.last_scan_at,
      projectRootPath: row.project_root_path,
      status: row.status,
    };
  }

  public initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA cache_size = -64000;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;

      CREATE TABLE IF NOT EXISTS project (
        project_id TEXT PRIMARY KEY,
        project_root_path TEXT NOT NULL UNIQUE,
        project_type TEXT NOT NULL,
        languages TEXT NOT NULL,
        last_scan_at TEXT,
        last_index_at TEXT,
        status TEXT NOT NULL,
        index_version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file (
        file_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        language TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        encoding TEXT NOT NULL,
        line_count INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE(project_id, relative_path),
        FOREIGN KEY(project_id) REFERENCES project(project_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chunk (
        chunk_id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        symbol_names TEXT NOT NULL,
        FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS symbol (
        symbol_id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        name TEXT NOT NULL,
        full_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        signature TEXT NOT NULL,
        FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS import_alias (
        import_id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        imported_name TEXT NOT NULL,
        source_module TEXT NOT NULL,
        line INTEGER NOT NULL,
        resolved_symbol_id TEXT,
        FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS symbol_usage (
        usage_id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        owner_symbol_id TEXT,
        owner_symbol_name TEXT,
        raw_name TEXT NOT NULL,
        candidate_names TEXT NOT NULL,
        usage_kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        resolved_symbol_id TEXT,
        FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS index_event (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        indexed_files INTEGER NOT NULL,
        changed_files INTEGER NOT NULL,
        deleted_files INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        scanned_files INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES project(project_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS index_event_failure (
        failure_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        message TEXT NOT NULL,
        FOREIGN KEY(event_id) REFERENCES index_event(event_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_file_project_id ON file(project_id);
      CREATE INDEX IF NOT EXISTS idx_file_relative_path ON file(relative_path);
      CREATE INDEX IF NOT EXISTS idx_index_event_project_created_at ON index_event(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_index_event_failure_event_id ON index_event_failure(event_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_name ON symbol(name);
      CREATE INDEX IF NOT EXISTS idx_symbol_full_name ON symbol(full_name);
      CREATE INDEX IF NOT EXISTS idx_symbol_file_id ON symbol(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_file_line ON symbol(file_id, line);
      CREATE INDEX IF NOT EXISTS idx_chunk_file_id ON chunk(file_id);
      CREATE INDEX IF NOT EXISTS idx_chunk_file_lines ON chunk(file_id, start_line, end_line);
      CREATE INDEX IF NOT EXISTS idx_import_alias_file_id ON import_alias(file_id);
      CREATE INDEX IF NOT EXISTS idx_import_alias_resolved_symbol_id ON import_alias(resolved_symbol_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_usage_file_id ON symbol_usage(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_usage_owner_symbol_id ON symbol_usage(owner_symbol_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_usage_resolved_symbol_id ON symbol_usage(resolved_symbol_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_usage_kind ON symbol_usage(usage_kind);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        chunk_id UNINDEXED,
        relative_path,
        language,
        content,
        symbol_names
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_semantic_fts USING fts5(
        chunk_id UNINDEXED,
        relative_path,
        language,
        semantic_text
      );

      CREATE TABLE IF NOT EXISTS chunk_vector (
        chunk_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        model_name TEXT NOT NULL,
        FOREIGN KEY(chunk_id) REFERENCES chunk(chunk_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chunk_vector_model ON chunk_vector(model_name);

      CREATE TABLE IF NOT EXISTS qa_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        project_root TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        sources_json TEXT,
        rating TEXT NOT NULL,
        correction TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        search_ms INTEGER,
        llm_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_qa_feedback_project_root ON qa_feedback(project_root);
      CREATE INDEX IF NOT EXISTS idx_qa_feedback_rating ON qa_feedback(rating);
    `);
    this.ensureColumn("index_event", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("symbol", "canonical_name", "TEXT");
    this.ensureColumn("symbol", "container_name", "TEXT");
    this.ensureColumn("symbol", "module_path", "TEXT");
    this.db.prepare("DELETE FROM chunk_vector WHERE chunk_id IS NULL").run();

    this.logger.info("sqlite store initialized");
  }

  public listProjectFiles(projectId: string): IndexedFileRecord[] {
    const rows = this.db
      .prepare(
        `SELECT file_id, relative_path, language, size, mtime_ms, sha256, encoding, line_count
         FROM file
         WHERE project_id = ?`,
      )
      .all(projectId) as Array<{
      encoding: string;
      file_id: string;
      language: Language;
      line_count: number;
      mtime_ms: number;
      relative_path: string;
      sha256: string;
      size: number;
    }>;

    return rows.map((row) => ({
      encoding: row.encoding,
      fileId: row.file_id,
      language: row.language,
      lineCount: row.line_count,
      mtimeMs: row.mtime_ms,
      relativePath: row.relative_path,
      sha256: row.sha256,
      size: row.size,
    }));
  }

  public getFilePreviewResults(projectId: string, relativePaths: string[]): SearchResult[] {
    if (relativePaths.length === 0) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT
           f.relative_path,
           f.language,
           COALESCE((SELECT c.start_line FROM chunk c WHERE c.file_id = f.file_id ORDER BY c.start_line LIMIT 1), 1) AS start_line,
           COALESCE((SELECT c.end_line FROM chunk c WHERE c.file_id = f.file_id ORDER BY c.start_line LIMIT 1), 1) AS end_line,
           COALESCE((SELECT c.content FROM chunk c WHERE c.file_id = f.file_id ORDER BY c.start_line LIMIT 1), '') AS content
         FROM file f
         WHERE f.project_id = ?
           AND f.relative_path IN (${relativePaths.map(() => "?").join(", ")})
         ORDER BY LENGTH(f.relative_path) ASC, f.relative_path ASC`,
      )
      .all(projectId, ...relativePaths) as Array<{
      content: string;
      end_line: number;
      language: Language;
      relative_path: string;
      start_line: number;
    }>;

    return rows.map((row, index) => ({
      endLine: row.end_line,
      filePath: row.relative_path,
      language: row.language,
      reason: "path",
      score: 0.3 - index * 0.01,
      snippet: row.content,
      snippetIncluded: true,
      startLine: row.start_line,
    }));
  }

  public recordIndexEvent(projectId: string, payload: IndexEventPayload): void {
    const eventId = buildStableId([
      projectId,
      payload.createdAt,
      String(payload.indexedFiles),
      String(payload.scannedFiles),
      String(payload.failedFiles.length),
    ]);
    const insertEvent = this.db.prepare(
      `INSERT INTO index_event (
         event_id, project_id, indexed_files, changed_files, deleted_files, chunk_count, scanned_files, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFailure = this.db.prepare(
      `INSERT INTO index_event_failure (
         failure_id, event_id, file_path, message
       ) VALUES (?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      insertEvent.run(
        eventId,
        projectId,
        payload.indexedFiles,
        payload.changedFiles,
        payload.deletedFiles,
        payload.chunkCount,
        payload.scannedFiles,
        JSON.stringify(payload.metadata),
        payload.createdAt,
      );

      for (const failure of payload.failedFiles) {
        insertFailure.run(
          buildStableId([eventId, failure.filePath, failure.message]),
          eventId,
          failure.filePath,
          failure.message,
        );
      }
    });

    tx();
    this.clearVectorCache(projectId);
  }

  public getLatestIndexEvent(projectId: string, failureLimit = 20): IndexEventSummary | null {
    const event = this.db
      .prepare(
        `SELECT event_id, indexed_files, changed_files, deleted_files, chunk_count, scanned_files, metadata_json, created_at
         FROM index_event
         WHERE project_id = ?
         ORDER BY created_at DESC, event_id DESC
         LIMIT 1`,
      )
      .get(projectId) as IndexEventRow | undefined;
    if (!event) {
      return null;
    }

    const failedFileCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM index_event_failure
           WHERE event_id = ?`,
        )
        .get(event.event_id) as { count: number }
    ).count;
    const failedFiles = this.db
      .prepare(
        `SELECT file_path, message
         FROM index_event_failure
         WHERE event_id = ?
         ORDER BY file_path ASC
         LIMIT ?`,
       )
       .all(event.event_id, failureLimit) as Array<{ file_path: string; message: string }>;
    const metadata = JSON.parse(event.metadata_json || "{}") as Partial<{
      timings: IndexTimingStats;
      vectorIndex: IndexVectorStats;
    }>;

    return {
      changedFiles: event.changed_files,
      chunkCount: event.chunk_count,
      createdAt: event.created_at,
      deletedFiles: event.deleted_files,
      failedFileCount,
      failedFiles: failedFiles.map((failure) => ({
        filePath: failure.file_path,
        message: failure.message,
      })),
      indexedFiles: event.indexed_files,
      scannedFiles: event.scanned_files,
      timings: metadata.timings ?? {
        collectMs: 0,
        detectMs: 0,
        indexMs: 0,
        totalMs: 0,
        vectorMs: 0,
      },
      vectorIndex: metadata.vectorIndex ?? {
        enabled: false,
        hydratedChunkCount: 0,
        mode: "lazy",
      },
      };
  }

  private listProjectSymbols(projectId: string): SymbolRow[] {
    return this.db
      .prepare(
        `SELECT
           s.symbol_id,
           s.file_id,
           s.name,
           s.full_name,
           s.canonical_name,
           s.container_name,
           s.module_path,
           s.kind,
           s.line,
           s.signature,
           f.relative_path
         FROM symbol s
         JOIN file f ON f.file_id = s.file_id
         WHERE f.project_id = ?`,
      )
      .all(projectId) as SymbolRow[];
  }

  public resolveSymbolGraph(projectId: string, changedFileIds?: Set<string>): void {
    const symbols = this.listProjectSymbols(projectId);
    const byCanonical = new Map<string, SymbolRow[]>();
    const byFullName = new Map<string, SymbolRow[]>();
    const byName = new Map<string, SymbolRow[]>();
    const byModule = new Map<string, SymbolRow[]>();
    const byModuleAndName = new Map<string, SymbolRow[]>();
    const byContainerAndName = new Map<string, SymbolRow[]>();
    const byFile = new Map<string, SymbolRow[]>();

    const pushMap = (map: Map<string, SymbolRow[]>, key: string | null | undefined, row: SymbolRow) => {
      if (!key) {
        return;
      }
      const normalizedKey = key.toLowerCase();
      const current = map.get(normalizedKey) ?? [];
      current.push(row);
      map.set(normalizedKey, current);
    };

    for (const symbol of symbols) {
      pushMap(byCanonical, symbol.canonical_name, symbol);
      pushMap(byFullName, symbol.full_name, symbol);
      pushMap(byName, symbol.name, symbol);
      pushMap(byName, symbol.full_name.split(".").pop(), symbol);
      pushMap(byModule, symbol.module_path, symbol);
      if (symbol.module_path) {
        pushMap(byModuleAndName, `${symbol.module_path}::${symbol.name}`, symbol);
        pushMap(byModuleAndName, `${symbol.module_path}::${symbol.full_name}`, symbol);
      }
      if (symbol.container_name) {
        pushMap(byContainerAndName, `${symbol.container_name}::${symbol.name}`, symbol);
      }
      const fileSymbols = byFile.get(symbol.file_id) ?? [];
      fileSymbols.push(symbol);
      byFile.set(symbol.file_id, fileSymbols);
    }

    // Build suffix index for "X.Y" lookups — keyed by last segment(s) of full_name
    // Replaces O(n) symbols.filter() scan
    const byFullNameSuffix = new Map<string, SymbolRow[]>();
    for (const symbol of symbols) {
      const parts = symbol.full_name.toLowerCase().split(".");
      for (let i = 1; i < parts.length; i++) {
        const suffix = parts.slice(i).join(".");
        const existing = byFullNameSuffix.get(suffix) ?? [];
        existing.push(symbol);
        byFullNameSuffix.set(suffix, existing);
      }
    }

    const importRows = this.db
      .prepare(
        changedFileIds && changedFileIds.size > 0
          ? `SELECT
               ia.import_id,
               ia.file_id,
               ia.alias,
               ia.imported_name,
               ia.source_module,
               f.language,
               f.relative_path
             FROM import_alias ia
             JOIN file f ON f.file_id = ia.file_id
             WHERE f.project_id = ?
               AND ia.file_id IN (${[...changedFileIds].map(() => "?").join(", ")})`
          : `SELECT
               ia.import_id,
               ia.file_id,
               ia.alias,
               ia.imported_name,
               ia.source_module,
               f.language,
               f.relative_path
             FROM import_alias ia
             JOIN file f ON f.file_id = ia.file_id
             WHERE f.project_id = ?`,
      )
      .all(
        ...(changedFileIds && changedFileIds.size > 0
          ? [projectId, ...changedFileIds]
          : [projectId]),
      ) as Array<{
      alias: string;
      file_id: string;
      import_id: string;
      imported_name: string;
      language: Language;
      relative_path: string;
      source_module: string;
    }>;

    const aliasMapByFile = new Map<string, Map<string, SymbolRow[]>>();
    const updateImportResolution = this.db.prepare("UPDATE import_alias SET resolved_symbol_id = ? WHERE import_id = ?");
    const updateUsageResolution = this.db.prepare("UPDATE symbol_usage SET owner_symbol_id = ?, resolved_symbol_id = ? WHERE usage_id = ?");

    const resolveRows = (
      candidateNames: string[],
      fileId: string,
      filePath: string,
      language: Language,
      ownerSymbolName?: string,
    ): SymbolRow[] => {
      const scored = new Map<string, { row: SymbolRow; score: number }>();
      const aliasMap = aliasMapByFile.get(fileId);
      const normalizedFileModule = normalizeModulePath(filePath);
      const ownerSymbol = ownerSymbolName
        ? (byFile.get(fileId) ?? []).find((symbol) => symbol.full_name === ownerSymbolName || symbol.canonical_name === ownerSymbolName)
        : undefined;

      const addCandidate = (row: SymbolRow | undefined, score: number) => {
        if (!row) {
          return;
        }
        const existing = scored.get(row.symbol_id);
        if (!existing || score > existing.score) {
          scored.set(row.symbol_id, { row, score });
        }
      };

      for (const candidate of candidateNames) {
        const normalizedCandidate = candidate.trim().toLowerCase();
        if (!normalizedCandidate) {
          continue;
        }

        for (const row of byCanonical.get(normalizedCandidate) ?? []) {
          addCandidate(row, 1);
        }
        for (const row of byFullName.get(normalizedCandidate) ?? []) {
          addCandidate(row, 0.98);
        }
        for (const row of byName.get(normalizedCandidate) ?? []) {
          addCandidate(row, 0.72);
        }

        const moduleCandidateMatch = normalizedCandidate.match(/^(.+)\.([^.]+)$/);
        if (moduleCandidateMatch) {
          const [, containerOrModule, name] = moduleCandidateMatch;
          for (const row of byFullName.get(normalizedCandidate) ?? []) {
            addCandidate(row, 0.96);
          }
          for (const row of byFullNameSuffix.get(normalizedCandidate) ?? []) {
            addCandidate(row, 0.82);
          }
          for (const row of byModuleAndName.get(`${containerOrModule}::${name}`) ?? []) {
            addCandidate(row, 0.92);
          }
        }

        const bareName = normalizedCandidate.split(".").pop() ?? normalizedCandidate;
        if (ownerSymbol?.module_path) {
          for (const row of byModuleAndName.get(`${ownerSymbol.module_path}::${bareName}`) ?? []) {
            addCandidate(row, 0.94);
          }
        }
        if (normalizedFileModule) {
          for (const row of byModuleAndName.get(`${normalizedFileModule}::${bareName}`) ?? []) {
            addCandidate(row, 0.86);
          }
        }

        if (ownerSymbol?.container_name) {
          for (const row of byContainerAndName.get(`${ownerSymbol.container_name}::${bareName}`) ?? []) {
            addCandidate(row, 0.9);
          }
        }

        const aliasEntry = aliasMap?.get(normalizedCandidate);
        if (aliasEntry) {
          for (const row of aliasEntry) {
            addCandidate(row, 1.04);
          }
        }

        const leftPart = normalizedCandidate.split(".")[0];
        const rightPart = normalizedCandidate.split(".").slice(1).join(".");
        if (leftPart && rightPart && aliasMap?.has(leftPart)) {
          const rightBareName = rightPart.split(".").pop() ?? rightPart;
          for (const importedSymbol of aliasMap.get(leftPart) ?? []) {
            if (
              importedSymbol.name.toLowerCase() === rightPart ||
              importedSymbol.name.toLowerCase() === rightBareName ||
              importedSymbol.full_name.toLowerCase() === rightPart ||
              importedSymbol.full_name.toLowerCase().endsWith(`.${rightPart}`) ||
              importedSymbol.full_name.toLowerCase().endsWith(`.${rightBareName}`)
            ) {
              addCandidate(importedSymbol, 1.12);
            }

            for (const row of byFullName.get(`${importedSymbol.full_name}.${rightPart}`.toLowerCase()) ?? []) {
              addCandidate(row, 1.08);
            }
            for (const row of byFullName.get(`${importedSymbol.name}.${rightPart}`.toLowerCase()) ?? []) {
              addCandidate(row, 1.04);
            }
            if (importedSymbol.module_path) {
              for (const row of byModuleAndName.get(`${importedSymbol.module_path}::${rightBareName}`) ?? []) {
                addCandidate(row, 1.1);
              }
            }
          }
        }
      }

      if (scored.size === 0) {
        return [];
      }

      return [...scored.values()]
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.row.relative_path.localeCompare(right.row.relative_path) ||
            left.row.line - right.row.line,
        )
        .map((entry) => entry.row);
    };

    const importTx = this.db.transaction(() => {
      for (const row of importRows) {
        const resolvedSourceModule = resolveImportSourceModule(row.relative_path, row.source_module, row.language);
        let candidates: SymbolRow[] = [];
        if (row.imported_name === "*") {
          candidates = resolvedSourceModule ? [...(byModule.get(resolvedSourceModule) ?? [])] : [];
        } else {
          candidates = [
            ...(resolvedSourceModule ? byModuleAndName.get(`${resolvedSourceModule}::${row.imported_name.toLowerCase()}`) ?? [] : []),
            ...(resolvedSourceModule ? byFullName.get(`${resolvedSourceModule}.${row.imported_name}`.toLowerCase()) ?? [] : []),
            ...(byName.get(row.imported_name.toLowerCase()) ?? []),
          ];
          if (candidates.length === 0 && resolvedSourceModule && row.language === "javascript" && row.imported_name === "default") {
            candidates = [...(byModule.get(resolvedSourceModule) ?? [])].sort(
              (left, right) =>
                Number(Boolean(left.container_name)) - Number(Boolean(right.container_name)) ||
                left.line - right.line ||
                left.full_name.localeCompare(right.full_name),
            );
          }
        }

        const deduped = [...new Map(candidates.map((candidate) => [candidate.symbol_id, candidate])).values()];
        const best = deduped[0];
        updateImportResolution.run(row.imported_name === "*" ? null : best?.symbol_id ?? null, row.import_id);
        if (deduped.length > 0) {
          const aliases = aliasMapByFile.get(row.file_id) ?? new Map<string, SymbolRow[]>();
          aliases.set(row.alias.toLowerCase(), deduped);
          aliasMapByFile.set(row.file_id, aliases);
        }
      }
    });

    importTx();

    const usageRows = this.db
      .prepare(
        changedFileIds && changedFileIds.size > 0
          ? `SELECT
               su.usage_id,
               su.file_id,
               su.owner_symbol_name,
               su.raw_name,
               su.candidate_names,
               f.language,
               f.relative_path
             FROM symbol_usage su
             JOIN file f ON f.file_id = su.file_id
             WHERE f.project_id = ?
               AND su.file_id IN (${[...changedFileIds].map(() => "?").join(", ")})`
          : `SELECT
               su.usage_id,
               su.file_id,
               su.owner_symbol_name,
               su.raw_name,
               su.candidate_names,
               f.language,
               f.relative_path
             FROM symbol_usage su
             JOIN file f ON f.file_id = su.file_id
             WHERE f.project_id = ?`,
      )
      .all(
        ...(changedFileIds && changedFileIds.size > 0
          ? [projectId, ...changedFileIds]
          : [projectId]),
      ) as Array<{
      candidate_names: string;
      file_id: string;
      language: Language;
      owner_symbol_name: string | null;
      raw_name: string;
      relative_path: string;
      usage_id: string;
    }>;

    const usageTx = this.db.transaction(() => {
      for (const row of usageRows) {
        const ownerSymbol = row.owner_symbol_name
          ? (byFile.get(row.file_id) ?? []).find(
              (symbol) => symbol.full_name === row.owner_symbol_name || symbol.canonical_name === row.owner_symbol_name,
            )
          : undefined;
        const candidateNames = JSON.parse(row.candidate_names) as string[];
        const resolved = resolveRows([row.raw_name, ...candidateNames], row.file_id, row.relative_path, row.language, row.owner_symbol_name ?? undefined);
        updateUsageResolution.run(ownerSymbol?.symbol_id ?? null, resolved[0]?.symbol_id ?? null, row.usage_id);
      }
    });

    usageTx();
  }

  public searchByPath(projectId: string, tokens: string[], limit: number, filters?: SearchFilters): SearchResult[] {
    if (tokens.length === 0) {
      return [];
    }

    const likePatterns = tokens.map((token) => `%${token}%`);
    const whereClause = likePatterns.map(() => "LOWER(f.relative_path) LIKE ?").join(" OR ");
    const filterClause = buildSearchFilterClause(filters);
    const rows = this.db
      .prepare(
        `SELECT
           f.relative_path,
           f.language,
           COALESCE((SELECT c.start_line FROM chunk c WHERE c.file_id = f.file_id ORDER BY c.start_line LIMIT 1), 1) AS start_line,
           COALESCE((SELECT c.end_line FROM chunk c WHERE c.file_id = f.file_id ORDER BY c.start_line LIMIT 1), 1) AS end_line,
           COALESCE((SELECT c.content FROM chunk c WHERE c.file_id = f.file_id ORDER BY c.start_line LIMIT 1), '') AS content
          FROM file f
          WHERE f.project_id = ?
            AND (${whereClause})
            ${filterClause.sql}
          ORDER BY LENGTH(f.relative_path) ASC
          LIMIT ?`,
      )
      .all(projectId, ...likePatterns, ...filterClause.parameters, limit) as Array<{
      content: string;
      end_line: number;
      language: Language;
      relative_path: string;
      start_line: number;
    }>;

    return rows.map((row, index) => ({
      endLine: row.end_line,
      filePath: row.relative_path,
      language: row.language,
      reason: "path",
      score: 0.65 - index * 0.05,
      snippet: row.content,
      snippetIncluded: true,
      startLine: row.start_line,
    }));
  }

  public findDefinitions(projectId: string, query: string, limit: number, filters?: SearchFilters): DefinitionMatch[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return [];
    }

    const filterClause = buildSearchFilterClause(filters);
    const fullNameSuffix = `%.${normalizedQuery}`;
    const partialPattern = `%${normalizedQuery}%`;
    const rows = this.db
      .prepare(
        `SELECT
           f.relative_path,
           f.language,
           s.symbol_id,
            s.name,
            s.full_name,
            s.canonical_name,
           s.module_path,
            s.kind,
            s.line,
            s.signature,
            COALESCE((SELECT c.start_line FROM chunk c WHERE c.file_id = f.file_id AND c.start_line <= s.line AND c.end_line >= s.line LIMIT 1), s.line) AS start_line,
            COALESCE((SELECT c.end_line FROM chunk c WHERE c.file_id = f.file_id AND c.start_line <= s.line AND c.end_line >= s.line LIMIT 1), s.line) AS end_line,
            COALESCE((SELECT c.content FROM chunk c WHERE c.file_id = f.file_id AND c.start_line <= s.line AND c.end_line >= s.line LIMIT 1), s.signature) AS content,
            CASE
             WHEN LOWER(s.canonical_name) = ? THEN 1.05
              WHEN LOWER(s.full_name) = ? THEN 1.0
              WHEN LOWER(s.name) = ? THEN 0.95
              WHEN LOWER(s.canonical_name) LIKE ? THEN 0.9
              WHEN LOWER(s.full_name) LIKE ? THEN 0.88
              WHEN LOWER(s.full_name) LIKE ? THEN 0.8
              WHEN LOWER(s.name) LIKE ? THEN 0.72
              ELSE 0.55
            END AS score
         FROM symbol s
         JOIN file f ON f.file_id = s.file_id
          WHERE f.project_id = ?
            AND (
             LOWER(COALESCE(s.canonical_name, '')) = ?
               OR
               LOWER(s.full_name) = ?
               OR LOWER(s.name) = ?
              OR LOWER(COALESCE(s.canonical_name, '')) LIKE ?
              OR LOWER(s.full_name) LIKE ?
              OR LOWER(s.full_name) LIKE ?
              OR LOWER(s.name) LIKE ?
            )
            ${filterClause.sql}
         ORDER BY score DESC, LENGTH(s.full_name) ASC, s.line ASC
         LIMIT ?`,
      )
      .all(
        normalizedQuery,
        normalizedQuery,
        normalizedQuery,
        partialPattern,
        fullNameSuffix,
        partialPattern,
        partialPattern,
        projectId,
        normalizedQuery,
        normalizedQuery,
        normalizedQuery,
        partialPattern,
        fullNameSuffix,
        partialPattern,
        partialPattern,
        ...filterClause.parameters,
        limit,
      ) as Array<{
      canonical_name: string | null;
      content: string;
      end_line: number;
      full_name: string;
      kind: DefinitionMatch["kind"];
      language: Language;
      line: number;
      module_path: string | null;
      name: string;
      relative_path: string;
      score: number;
      signature: string;
      start_line: number;
      symbol_id: string;
    }>;

    return rows.map((row) => ({
      canonicalName: row.canonical_name ?? undefined,
      endLine: row.end_line,
      filePath: row.relative_path,
      fullName: row.full_name,
      kind: row.kind,
      language: row.language,
      line: row.line,
      modulePath: row.module_path ?? undefined,
      name: row.name,
      score: row.score,
      signature: row.signature,
      snippet: row.content,
      snippetIncluded: true,
      startLine: row.start_line,
      symbolId: row.symbol_id,
    }));
  }

  public findResolvedReferences(projectId: string, symbolIds: string[], limit: number, filters?: SearchFilters): SearchResult[] {
    if (symbolIds.length === 0) {
      return [];
    }

    const placeholders = symbolIds.map(() => "?").join(", ");
    const filterClause = buildSearchFilterClause(filters);
    const rows = this.db
      .prepare(
        `SELECT
           f.relative_path,
           f.language,
           su.raw_name,
           su.line AS start_line,
           COALESCE((SELECT c.end_line FROM chunk c WHERE c.file_id = f.file_id AND c.start_line <= su.line AND c.end_line >= su.line LIMIT 1), su.line) AS end_line,
           COALESCE((SELECT c.content FROM chunk c WHERE c.file_id = f.file_id AND c.start_line <= su.line AND c.end_line >= su.line LIMIT 1), su.raw_name) AS content,
           su.usage_kind,
           su.owner_symbol_name
         FROM symbol_usage su
         JOIN file f ON f.file_id = su.file_id
         WHERE f.project_id = ?
           AND su.resolved_symbol_id IN (${placeholders})
           ${filterClause.sql}
         ORDER BY su.line ASC, f.relative_path ASC
         LIMIT ?`,
      )
      .all(projectId, ...symbolIds, ...filterClause.parameters, limit) as Array<{
      content: string;
      end_line: number;
      language: Language;
      owner_symbol_name: string | null;
      raw_name: string;
      relative_path: string;
      start_line: number;
      usage_kind: SymbolUsageKind;
    }>;

    return rows.map((row, index) => ({
      endLine: row.end_line,
      filePath: row.relative_path,
      language: row.language,
      reason: "symbol",
      score: (row.owner_symbol_name ? 0.98 : 0.9) - index * 0.01,
      snippet: row.content,
      snippetIncluded: true,
      startLine: row.start_line,
      symbol: row.raw_name,
    }));
  }

  public findCallGraph(
    projectId: string,
    symbolIds: string[],
    direction: "callers" | "callees",
    depth: number,
    limit: number,
    filters?: SearchFilters,
  ): CallGraphMatch[] {
    if (symbolIds.length === 0 || depth <= 0) {
      return [];
    }

    const filterClause = buildSearchFilterClause(filters);
    const perHopLimit = Math.max(limit * 2, 50);
    const rootPlaceholders = symbolIds.map(() => "?").join(", ");
    const rootSymbols = this.db
      .prepare(`SELECT symbol_id, full_name FROM symbol WHERE symbol_id IN (${rootPlaceholders})`)
      .all(...symbolIds) as Array<{ full_name: string; symbol_id: string }>;
    const symbolPathById = new Map(rootSymbols.map((row) => [row.symbol_id, [row.full_name]]));
    const visitedSymbols = new Set(symbolIds);
    const seenUsageIds = new Set<string>();
    const matches: CallGraphMatch[] = [];
    let frontier = [...symbolIds];
    let hopCount = 0;

    const queryRows = (frontierIds: string[]): CallGraphRow[] => {
      const placeholders = frontierIds.map(() => "?").join(", ");
      return this.db
        .prepare(
          `SELECT
             su.usage_id,
             f.relative_path,
             f.language,
             su.line AS start_line,
             COALESCE((SELECT c.end_line FROM chunk c WHERE c.file_id = f.file_id AND c.start_line <= su.line AND c.end_line >= su.line LIMIT 1), su.line) AS end_line,
             COALESCE((SELECT c.content FROM chunk c WHERE c.file_id = f.file_id AND c.start_line <= su.line AND c.end_line >= su.line LIMIT 1), su.raw_name) AS content,
             su.raw_name,
             su.usage_kind,
             owner.symbol_id AS owner_symbol_id,
             owner.full_name AS owner_symbol,
             resolved.symbol_id AS resolved_symbol_id,
             resolved.full_name AS resolved_symbol
           FROM symbol_usage su
           JOIN file f ON f.file_id = su.file_id
           LEFT JOIN symbol owner ON owner.symbol_id = su.owner_symbol_id
           LEFT JOIN symbol resolved ON resolved.symbol_id = su.resolved_symbol_id
           WHERE f.project_id = ?
             AND ${
               direction === "callers"
                 ? `su.resolved_symbol_id IN (${placeholders}) AND su.owner_symbol_id IS NOT NULL`
                 : `su.owner_symbol_id IN (${placeholders}) AND su.resolved_symbol_id IS NOT NULL`
             }
             ${filterClause.sql}
           ORDER BY
             CASE su.usage_kind
               WHEN 'call' THEN 0
               WHEN 'instantiation' THEN 1
               WHEN 'type' THEN 2
               WHEN 'usage' THEN 3
               ELSE 4
             END,
             f.relative_path ASC,
             su.line ASC
           LIMIT ?`,
        )
        .all(projectId, ...frontierIds, ...filterClause.parameters, perHopLimit) as CallGraphRow[];
    };

    while (frontier.length > 0 && hopCount < depth && matches.length < limit) {
      hopCount += 1;
      const rows = queryRows(frontier);
      const nextFrontier: string[] = [];

      for (const row of rows) {
        const previousSymbolId = direction === "callers" ? row.resolved_symbol_id : row.owner_symbol_id;
        const nextSymbolId = direction === "callers" ? row.owner_symbol_id : row.resolved_symbol_id;
        const nextSymbolName = direction === "callers" ? row.owner_symbol : row.resolved_symbol;
        if (!previousSymbolId || !nextSymbolId || !nextSymbolName) {
          continue;
        }

        const basePath = symbolPathById.get(previousSymbolId) ?? [nextSymbolName];
        const symbolPath = [...basePath, nextSymbolName];
        if (!seenUsageIds.has(row.usage_id)) {
          matches.push({
            callKind: row.usage_kind,
            endLine: row.end_line,
            filePath: row.relative_path,
            hopCount,
            language: row.language,
            line: row.start_line,
            ownerSymbol: row.owner_symbol ?? undefined,
            rawName: row.raw_name,
            resolvedSymbol: row.resolved_symbol ?? undefined,
            score: Math.max(0.2, 1 - (hopCount - 1) * 0.12 - matches.length * 0.005),
            snippet: row.content,
            snippetIncluded: true,
            startLine: row.start_line,
            symbolPath,
          });
          seenUsageIds.add(row.usage_id);
        }

        if (!visitedSymbols.has(nextSymbolId)) {
          visitedSymbols.add(nextSymbolId);
          symbolPathById.set(nextSymbolId, symbolPath);
          nextFrontier.push(nextSymbolId);
        }
      }

      frontier = [...new Set(nextFrontier)].slice(0, perHopLimit);
    }

    return matches
      .sort(
        (left, right) =>
          left.hopCount - right.hopCount ||
          right.score - left.score ||
          left.filePath.localeCompare(right.filePath) ||
          left.startLine - right.startLine,
      )
      .slice(0, limit);
  }

  public ensureSemanticIndex(projectId: string): void {
    const rows = this.db
      .prepare(
        `SELECT
           c.chunk_id,
           c.content,
           c.symbol_names,
           f.language,
           f.relative_path
         FROM chunk c
         JOIN file f ON f.file_id = c.file_id
         LEFT JOIN chunk_semantic_fts sf ON sf.chunk_id = c.chunk_id
         WHERE f.project_id = ?
           AND sf.chunk_id IS NULL`,
      )
      .all(projectId) as Array<{
      chunk_id: string;
      content: string;
      language: Language;
      relative_path: string;
      symbol_names: string;
    }>;

    if (rows.length === 0) {
      return;
    }

    const insertSemanticChunk = this.db.prepare(
      `INSERT INTO chunk_semantic_fts (chunk_id, relative_path, language, semantic_text)
       VALUES (?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((missingRows: typeof rows) => {
      for (const row of missingRows) {
        const symbolNames = JSON.parse(row.symbol_names) as string[];
        insertSemanticChunk.run(
          row.chunk_id,
          row.relative_path,
          row.language,
          buildSemanticText(row.relative_path, row.content, symbolNames),
        );
      }
    });

    tx(rows);
  }

  public searchBySemantic(projectId: string, semanticTerms: string[], limit: number, filters?: SearchFilters): SearchResult[] {
    const semanticQuery = buildSemanticFtsQuery(semanticTerms);
    if (!semanticQuery) {
      return [];
    }

    const filterClause = buildSearchFilterClause(filters);
    const rows = this.db
      .prepare(
        `SELECT
           f.relative_path,
           f.language,
           c.start_line,
           c.end_line,
           c.content,
           sf.semantic_text,
           bm25(chunk_semantic_fts) AS raw_score
         FROM chunk_semantic_fts sf
         JOIN chunk c ON c.chunk_id = sf.chunk_id
         JOIN file f ON f.file_id = c.file_id
         WHERE f.project_id = ?
           AND chunk_semantic_fts MATCH ?
           ${filterClause.sql}
         ORDER BY raw_score
         LIMIT ?`,
      )
      .all(projectId, semanticQuery, ...filterClause.parameters, limit) as Array<{
      content: string;
      end_line: number;
      language: Language;
      raw_score: number;
      relative_path: string;
      semantic_text: string;
      start_line: number;
    }>;

    return rows.map((row) => {
      const overlap = semanticTerms.filter((term) => row.semantic_text.includes(term)).length;
      const overlapScore = semanticTerms.length > 0 ? overlap / semanticTerms.length : 0;
      return {
        endLine: row.end_line,
        filePath: row.relative_path,
        language: row.language,
        reason: "semantic",
        score: 0.35 + overlapScore * 0.45 + 0.2 * (1 / (1 + Math.abs(row.raw_score))),
        snippet: row.content,
        snippetIncluded: true,
        startLine: row.start_line,
      };
    });
  }

  /**
   * 向量搜索
   * 使用余弦相似度 + Top-K 堆，避免全量排序
   */
  public searchByVector(
    projectId: string,
    queryEmbedding: number[],
    limit: number,
    modelName: string,
    filters?: SearchFilters,
    indexVersion = Number.NaN,
  ): { cacheHit: boolean; candidateCount: number; results: SearchResult[] } {
    const { cacheHit, vectors } = this.getProjectVectors(projectId, modelName, indexVersion);
    const filteredVectors = filters ? vectors.filter((vector) => matchesSearchFilters(vector, filters)) : vectors;

    if (filteredVectors.length === 0) {
      return {
        cacheHit,
        candidateCount: 0,
        results: [],
      };
    }

    // Convert query to Float32Array once for faster cosine similarity
    const queryVec = queryEmbedding instanceof Float32Array ? queryEmbedding : new Float32Array(queryEmbedding);

    // Use min-heap to find top-K without sorting all candidates
    const heap = new TopKHeap(limit);
    for (const v of filteredVectors) {
      const score = cosineSimilarity(queryVec, v.embedding);
      heap.push(v.chunkId, score);
    }

    const topChunkIds = heap.drain();

    if (topChunkIds.length === 0) {
      return {
        cacheHit,
        candidateCount: filteredVectors.length,
        results: [],
      };
    }

    const chunkIds = topChunkIds.map((t) => t.id);
    const scoreMap = new Map(topChunkIds.map((t) => [t.id, t.score]));

    const placeholders = chunkIds.map(() => "?").join(", ");

    const rows = this.db
      .prepare(
        `SELECT
           c.chunk_id,
           c.start_line,
           c.end_line,
           c.content,
           f.relative_path,
           f.language
         FROM chunk c
         JOIN file f ON f.file_id = c.file_id
         WHERE c.chunk_id IN (${placeholders})
            AND f.project_id = ?`,
      )
      .all(...chunkIds, projectId) as Array<{
      chunk_id: string;
      content: string;
      end_line: number;
      language: Language;
      relative_path: string;
      start_line: number;
    }>;

    return {
      cacheHit,
      candidateCount: filteredVectors.length,
      results: rows.map((row) => ({
        endLine: row.end_line,
        filePath: row.relative_path,
        language: row.language,
        reason: "semantic",
        score: scoreMap.get(row.chunk_id) ?? 0,
        snippet: row.content,
        snippetIncluded: true,
        startLine: row.start_line,
      })),
    };
  }

  public searchByTextSubstrings(projectId: string, tokens: string[], limit: number, filters?: SearchFilters): SearchResult[] {
    if (tokens.length === 0) {
      return [];
    }

    const whereClause = tokens.map(() => "instr(c.content, ?) > 0").join(" OR ");
    const filterClause = buildSearchFilterClause(filters);
    const rows = this.db
      .prepare(
        `SELECT
           f.relative_path,
           f.language,
           c.start_line,
           c.end_line,
           c.content
         FROM chunk c
         JOIN file f ON f.file_id = c.file_id
         WHERE f.project_id = ?
           AND (${whereClause})
           ${filterClause.sql}
         ORDER BY c.start_line ASC, LENGTH(f.relative_path) ASC
         LIMIT ?`,
      )
      .all(projectId, ...tokens, ...filterClause.parameters, limit) as Array<{
      content: string;
      end_line: number;
      language: Language;
      relative_path: string;
      start_line: number;
    }>;

    return rows.map((row, index) => ({
      endLine: row.end_line,
      filePath: row.relative_path,
      language: row.language,
      reason: "lexical",
      score: 0.72 - index * 0.04,
      snippet: row.content,
      snippetIncluded: true,
      startLine: row.start_line,
    }));
  }

  public searchBySymbols(projectId: string, tokens: string[], limit: number, filters?: SearchFilters): SearchResult[] {
    if (tokens.length === 0) {
      return [];
    }

    const likePatterns = tokens.map((token) => `%${token}%`);
    const whereClause = likePatterns.map(() => "LOWER(s.name) LIKE ? OR LOWER(s.full_name) LIKE ?").join(" OR ");
    const parameters = likePatterns.flatMap((pattern) => [pattern, pattern]);
    const filterClause = buildSearchFilterClause(filters);

    const rows = this.db
      .prepare(
        `SELECT
           f.relative_path,
           f.language,
           s.name,
           s.line AS start_line,
           COALESCE((SELECT c.end_line FROM chunk c WHERE c.file_id = f.file_id AND c.start_line <= s.line AND c.end_line >= s.line LIMIT 1), s.line) AS end_line,
           COALESCE((SELECT c.content FROM chunk c WHERE c.file_id = f.file_id AND c.start_line <= s.line AND c.end_line >= s.line LIMIT 1), s.signature) AS content
          FROM symbol s
          JOIN file f ON f.file_id = s.file_id
          WHERE f.project_id = ?
            AND (${whereClause})
            ${filterClause.sql}
          ORDER BY s.line ASC
          LIMIT ?`,
      )
      .all(projectId, ...parameters, ...filterClause.parameters, limit) as Array<{
      content: string;
      end_line: number;
      language: Language;
      name: string;
      relative_path: string;
      start_line: number;
    }>;

    return rows.map((row, index) => ({
      endLine: row.end_line,
      filePath: row.relative_path,
      language: row.language,
      reason: "symbol",
      score: 0.8 - index * 0.05,
      snippet: row.content,
      snippetIncluded: true,
      startLine: row.start_line,
      symbol: row.name,
    }));
  }

  public searchByText(projectId: string, ftsQuery: string, limit: number, filters?: SearchFilters): SearchResult[] {
    const filterClause = buildSearchFilterClause(filters);
    const rows = this.db
      .prepare(
        `SELECT
           f.relative_path,
           f.language,
           c.start_line,
           c.end_line,
           c.content,
           bm25(chunk_fts) AS raw_score
         FROM chunk_fts
         JOIN chunk c ON c.chunk_id = chunk_fts.chunk_id
          JOIN file f ON f.file_id = c.file_id
          WHERE f.project_id = ?
            AND chunk_fts MATCH ?
            ${filterClause.sql}
          ORDER BY raw_score
          LIMIT ?`,
      )
      .all(projectId, ftsQuery, ...filterClause.parameters, limit) as SearchRow[];

    return rows.map((row) => ({
      endLine: row.end_line,
      filePath: row.relative_path,
      language: row.language,
      reason: "lexical",
      score: 1 / (1 + Math.abs(row.raw_score)),
      snippet: row.content,
      snippetIncluded: true,
      startLine: row.start_line,
    }));
  }

  public upsertProject(projectId: string, project: ProjectInfo, status: ProjectStatus, timestamp: string): void {
    const existing = this.getProjectByRoot(project.rootPath);
    const version = existing?.index_version ?? 1;

    this.db
      .prepare(
        `INSERT INTO project (
          project_id, project_root_path, project_type, languages, last_scan_at, last_index_at, status, index_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           project_type = excluded.project_type,
           languages = excluded.languages,
           last_scan_at = excluded.last_scan_at,
           status = excluded.status,
           index_version = excluded.index_version`,
      )
      .run(
        projectId,
        project.rootPath,
        project.projectType,
        JSON.stringify(project.languages),
        timestamp,
        existing?.last_index_at ?? null,
        status,
        version,
      );
  }

  public updateProjectAfterIndex(projectId: string, timestamp: string, status: ProjectStatus, bumpIndexVersion: boolean): void {
    if (bumpIndexVersion) {
      this.db
        .prepare(
          `UPDATE project
           SET last_scan_at = ?, last_index_at = ?, status = ?, index_version = index_version + 1
           WHERE project_id = ?`,
        )
        .run(timestamp, timestamp, status, projectId);
      return;
    }

    this.db
      .prepare(
        `UPDATE project
         SET last_scan_at = ?, last_index_at = ?, status = ?
         WHERE project_id = ?`,
      )
      .run(timestamp, timestamp, status, projectId);
  }

  public writeFileIndex(
    projectId: string,
    indexedFile: IndexedFileRecord,
    chunks: ChunkRecord[],
    symbols: SymbolInfo[],
    imports: ImportInfo[],
    usages: SymbolUsageInfo[],
    indexedAt: string,
  ): void {
    const deleteChunkFts = this.db.prepare("DELETE FROM chunk_fts WHERE chunk_id = ?");
    const deleteChunkSemanticFts = this.db.prepare("DELETE FROM chunk_semantic_fts WHERE chunk_id = ?");
    const deleteImports = this.db.prepare("DELETE FROM import_alias WHERE file_id = ?");
    const deleteSymbols = this.db.prepare("DELETE FROM symbol WHERE file_id = ?");
    const deleteUsages = this.db.prepare("DELETE FROM symbol_usage WHERE file_id = ?");
    const selectChunkIds = this.db.prepare("SELECT chunk_id FROM chunk WHERE file_id = ?");
    const deleteChunks = this.db.prepare("DELETE FROM chunk WHERE file_id = ?");
    const upsertFile = this.db.prepare(
      `INSERT INTO file (
        file_id, project_id, relative_path, language, size, mtime_ms, sha256, encoding, line_count, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        language = excluded.language,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        sha256 = excluded.sha256,
        encoding = excluded.encoding,
        line_count = excluded.line_count,
        indexed_at = excluded.indexed_at`,
    );
    const insertChunk = this.db.prepare(
      `INSERT INTO chunk (chunk_id, file_id, start_line, end_line, content, symbol_names)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertChunkFts = this.db.prepare(
      `INSERT INTO chunk_fts (chunk_id, relative_path, language, content, symbol_names)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertChunkSemanticFts = this.db.prepare(
      `INSERT INTO chunk_semantic_fts (chunk_id, relative_path, language, semantic_text)
       VALUES (?, ?, ?, ?)`,
    );
    const insertSymbol = this.db.prepare(
      `INSERT INTO symbol (symbol_id, file_id, name, full_name, canonical_name, container_name, module_path, kind, line, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertImport = this.db.prepare(
      `INSERT INTO import_alias (import_id, file_id, alias, imported_name, source_module, line, resolved_symbol_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    );
    const insertUsage = this.db.prepare(
      `INSERT INTO symbol_usage (usage_id, file_id, owner_symbol_id, owner_symbol_name, raw_name, candidate_names, usage_kind, line, resolved_symbol_id)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL)`,
    );

    const tx = this.db.transaction(() => {
      const oldChunkIds = selectChunkIds.all(indexedFile.fileId) as Array<{ chunk_id: string }>;
      for (const chunkId of oldChunkIds) {
        deleteChunkFts.run(chunkId.chunk_id);
        deleteChunkSemanticFts.run(chunkId.chunk_id);
      }

      deleteImports.run(indexedFile.fileId);
      deleteSymbols.run(indexedFile.fileId);
      deleteUsages.run(indexedFile.fileId);
      deleteChunks.run(indexedFile.fileId);

      upsertFile.run(
        indexedFile.fileId,
        projectId,
        indexedFile.relativePath,
        indexedFile.language,
        indexedFile.size,
        indexedFile.mtimeMs,
        indexedFile.sha256,
        indexedFile.encoding,
        indexedFile.lineCount,
        indexedAt,
      );

      for (const chunk of chunks) {
        insertChunk.run(
          chunk.chunkId,
          chunk.fileId,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          JSON.stringify(chunk.symbolNames),
        );
        insertChunkFts.run(
          chunk.chunkId,
          indexedFile.relativePath,
          indexedFile.language,
          chunk.content,
          chunk.symbolNames.join(" "),
        );
        insertChunkSemanticFts.run(
          chunk.chunkId,
          indexedFile.relativePath,
          indexedFile.language,
          buildSemanticText(indexedFile.relativePath, chunk.content, chunk.symbolNames),
        );
      }

      for (const symbol of symbols) {
        insertSymbol.run(
          symbol.symbolId,
          symbol.fileId,
          symbol.name,
          symbol.fullName,
          symbol.canonicalName ?? null,
          symbol.containerName ?? null,
          symbol.modulePath ?? null,
          symbol.kind,
          symbol.line,
          symbol.signature,
        );
      }

      for (const [index, imported] of imports.entries()) {
        insertImport.run(
          buildStableId([indexedFile.fileId, String(index), imported.alias, imported.importedName, imported.sourceModule, String(imported.line)]),
          indexedFile.fileId,
          imported.alias,
          imported.importedName,
          imported.sourceModule,
          imported.line,
        );
      }

      for (const [index, usage] of usages.entries()) {
        insertUsage.run(
          buildStableId([
            indexedFile.fileId,
            String(index),
            usage.ownerSymbol ?? "",
            usage.rawName,
            usage.kind,
            String(usage.line),
            JSON.stringify(usage.candidateNames),
          ]),
          indexedFile.fileId,
          usage.ownerSymbol ?? null,
          usage.rawName,
          JSON.stringify(usage.candidateNames),
          usage.kind,
          usage.line,
        );
      }
    });

    tx();
  }

  public writeChunkVectors(
    entries: Array<{ chunkId: string; embedding: number[]; modelName: string }>,
    projectId?: string,
  ): void {
    if (entries.length === 0) {
      return;
    }

    const insertOrUpdate = this.db.prepare(`
      INSERT INTO chunk_vector (chunk_id, embedding, model_name)
      VALUES (?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        embedding = excluded.embedding,
        model_name = excluded.model_name
    `);
    const tx = this.db.transaction((vectorEntries: typeof entries) => {
      for (const entry of vectorEntries) {
        const blob = Buffer.from(new Float32Array(entry.embedding).buffer);
        insertOrUpdate.run(entry.chunkId, blob, entry.modelName);
      }
    });

    tx(entries);
    this.clearVectorCache(projectId);
  }

  public getChunkVector(chunkId: string): VectorEntry | null {
    const row = this.db
      .prepare(
        `SELECT cv.chunk_id, cv.embedding, cv.model_name, f.relative_path, f.language
         FROM chunk_vector cv
         JOIN chunk c ON c.chunk_id = cv.chunk_id
         JOIN file f ON f.file_id = c.file_id
         WHERE cv.chunk_id = ?`,
      )
      .get(chunkId) as { chunk_id: string; embedding: Buffer; language: Language; model_name: string; relative_path: string } | undefined;

    if (!row) {
      return null;
    }

    return {
      chunkId: row.chunk_id,
      embedding: new Float32Array(row.embedding.buffer),
      filePath: row.relative_path,
      language: row.language,
      modelName: row.model_name,
    };
  }

  public getProjectVectors(
    projectId: string,
    modelName: string,
    indexVersion = Number.NaN,
  ): { cacheHit: boolean; vectors: VectorEntry[] } {
    const cached = this.vectorCache.get(projectId);
    if (
      cached &&
      cached.modelName === modelName &&
      (!Number.isFinite(indexVersion) || cached.indexVersion === indexVersion)
    ) {
      // LRU: 将访问的条目移到末尾
      const orderIdx = this.vectorCacheOrder.indexOf(projectId);
      if (orderIdx >= 0) {
        this.vectorCacheOrder.splice(orderIdx, 1);
        this.vectorCacheOrder.push(projectId);
      }
      return {
        cacheHit: true,
        vectors: cached.vectors,
      };
    }

    const rows = this.db
      .prepare(`
        SELECT cv.chunk_id, cv.embedding, cv.model_name, f.relative_path, f.language
        FROM chunk_vector cv
        JOIN chunk c ON c.chunk_id = cv.chunk_id
        JOIN file f ON f.file_id = c.file_id
        WHERE f.project_id = ?
          AND cv.model_name = ?
      `)
      .all(projectId, modelName) as Array<{
      chunk_id: string;
      embedding: Buffer;
      language: Language;
      model_name: string;
      relative_path: string;
    }>;

    const vectors = rows.map((row) => ({
      chunkId: row.chunk_id,
      embedding: new Float32Array(row.embedding.buffer),
      filePath: row.relative_path,
      language: row.language,
      modelName: row.model_name,
    }));
    if (Number.isFinite(indexVersion)) {
      this.vectorCache.set(projectId, {
        indexVersion,
        modelName,
        vectors,
      });
      // LRU: 更新访问顺序并淘汰
      const orderIdx = this.vectorCacheOrder.indexOf(projectId);
      if (orderIdx >= 0) {
        this.vectorCacheOrder.splice(orderIdx, 1);
      }
      this.vectorCacheOrder.push(projectId);
      this.evictVectorCache();
    }

    return {
      cacheHit: false,
      vectors,
    };
  }

  public hasVectorIndex(projectId: string, modelName?: string): boolean {
    const modelClause = modelName ? "AND cv.model_name = ?" : "";
    const count = this.db
      .prepare(`
        SELECT COUNT(*) as cnt
        FROM chunk_vector cv
        JOIN chunk c ON c.chunk_id = cv.chunk_id
        JOIN file f ON f.file_id = c.file_id
        WHERE f.project_id = ?
          ${modelClause}
      `)
      .get(...(modelName ? [projectId, modelName] : [projectId])) as { cnt: number };

    return count.cnt > 0;
  }

  public getVectorCoverage(projectId: string, modelName: string): {
    indexedChunkCount: number;
    missingChunkCount: number;
    totalChunkCount: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_chunk_count,
           SUM(CASE WHEN cv.chunk_id IS NOT NULL AND cv.model_name = ? THEN 1 ELSE 0 END) AS indexed_chunk_count
         FROM chunk c
         JOIN file f ON f.file_id = c.file_id
         LEFT JOIN chunk_vector cv ON cv.chunk_id = c.chunk_id
         WHERE f.project_id = ?`,
      )
      .get(modelName, projectId) as {
      indexed_chunk_count: number | null;
      total_chunk_count: number;
    };

    const indexedChunkCount = row.indexed_chunk_count ?? 0;
    return {
      indexedChunkCount,
      missingChunkCount: Math.max(0, row.total_chunk_count - indexedChunkCount),
      totalChunkCount: row.total_chunk_count,
    };
  }

  public listChunksMissingVectors(projectId: string, modelName: string): Array<{ chunkId: string; content: string }> {
    return this.db
      .prepare(
        `SELECT c.chunk_id AS chunkId, c.content
         FROM chunk c
         JOIN file f ON f.file_id = c.file_id
         LEFT JOIN chunk_vector cv ON cv.chunk_id = c.chunk_id AND cv.model_name = ?
         WHERE f.project_id = ?
           AND cv.chunk_id IS NULL
         ORDER BY f.relative_path ASC, c.start_line ASC`,
      )
      .all(modelName, projectId) as Array<{ chunkId: string; content: string }>;
  }

  // ─── QA Feedback ───────────────────────────────────────────────────────────

  public saveQaFeedback(feedback: {
    answer: string;
    completionTokens?: number;
    correction?: string;
    llmMs?: number;
    projectRoot: string;
    promptTokens?: number;
    question: string;
    rating: "positive" | "negative";
    searchMs?: number;
    sources?: Array<{ filePath: string; startLine: number; endLine: number; language: string; score: number }>;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO qa_feedback (
           project_root, question, answer, sources_json, rating, correction,
           prompt_tokens, completion_tokens, search_ms, llm_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        feedback.projectRoot,
        feedback.question,
        feedback.answer,
        feedback.sources ? JSON.stringify(feedback.sources) : null,
        feedback.rating,
        feedback.correction ?? null,
        feedback.promptTokens ?? null,
        feedback.completionTokens ?? null,
        feedback.searchMs ?? null,
        feedback.llmMs ?? null,
      );
    return result.lastInsertRowid as number;
  }

  public getQaFeedbackStats(projectRoot?: string): {
    negativeCount: number;
    positiveCount: number;
    totalCount: number;
    withCorrectionCount: number;
  } {
    const whereClause = projectRoot ? "WHERE project_root = ?" : "";
    const params = projectRoot ? [projectRoot] : [];
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_count,
           SUM(CASE WHEN rating = 'positive' THEN 1 ELSE 0 END) AS positive_count,
           SUM(CASE WHEN rating = 'negative' THEN 1 ELSE 0 END) AS negative_count,
           SUM(CASE WHEN correction IS NOT NULL AND correction != '' THEN 1 ELSE 0 END) AS with_correction_count
         FROM qa_feedback
         ${whereClause}`,
      )
      .get(...params) as {
      negative_count: number | null;
      positive_count: number | null;
      total_count: number;
      with_correction_count: number | null;
    };

    return {
      negativeCount: row.negative_count ?? 0,
      positiveCount: row.positive_count ?? 0,
      totalCount: row.total_count,
      withCorrectionCount: row.with_correction_count ?? 0,
    };
  }
}

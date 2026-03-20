import Database from "better-sqlite3";

import { buildStableId } from "../indexing/fileFingerprint.js";
import type {
  ChunkRecord,
  IndexedFileRecord,
  Language,
  ProjectListItem,
  ProjectInfo,
  ProjectStats,
  ProjectStatus,
  SearchResult,
  SymbolInfo,
} from "../common/types.js";
import type { Logger } from "../common/logger.js";

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
  indexedFiles: number;
  scannedFiles: number;
}

export class SQLiteStore {
  private readonly db: Database.Database;

  public constructor(databasePath: string, private readonly logger: Logger) {
    this.db = new Database(databasePath);
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
    const deleteSymbols = this.db.prepare("DELETE FROM symbol WHERE file_id = ?");
    const deleteFile = this.db.prepare("DELETE FROM file WHERE file_id = ?");
    const selectChunkIds = this.db.prepare("SELECT chunk_id FROM chunk WHERE file_id = ?");
    const deleteChunks = this.db.prepare("DELETE FROM chunk WHERE file_id = ?");

    const tx = this.db.transaction((ids: string[]) => {
      for (const fileId of ids) {
        const chunkIds = selectChunkIds.all(fileId) as Array<{ chunk_id: string }>;
        for (const chunkId of chunkIds) {
          deleteChunkFts.run(chunkId.chunk_id);
        }

        deleteSymbols.run(fileId);
        deleteChunks.run(fileId);
        deleteFile.run(fileId);
      }
    });

    tx(fileIds.map((row) => row.file_id));
  }

  public getProjectByRoot(projectRootPath: string): ProjectRow | undefined {
    return this.db
      .prepare(
        `SELECT project_id, project_root_path, project_type, languages, last_scan_at, last_index_at, status, index_version
         FROM project
         WHERE project_root_path = ?`,
      )
      .get(projectRootPath) as ProjectRow | undefined;
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

  public initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

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

      CREATE TABLE IF NOT EXISTS index_event (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        indexed_files INTEGER NOT NULL,
        changed_files INTEGER NOT NULL,
        deleted_files INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        scanned_files INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES project(project_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_file_project_id ON file(project_id);
      CREATE INDEX IF NOT EXISTS idx_file_relative_path ON file(relative_path);
      CREATE INDEX IF NOT EXISTS idx_symbol_name ON symbol(name);
      CREATE INDEX IF NOT EXISTS idx_symbol_full_name ON symbol(full_name);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        chunk_id UNINDEXED,
        relative_path,
        language,
        content,
        symbol_names
      );
    `);

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

  public recordIndexEvent(projectId: string, payload: IndexEventPayload): void {
    const statement = this.db.prepare(
      `INSERT INTO index_event (
        event_id, project_id, indexed_files, changed_files, deleted_files, chunk_count, scanned_files, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    statement.run(
      buildStableId([projectId, payload.createdAt, String(payload.indexedFiles), String(payload.scannedFiles)]),
      projectId,
      payload.indexedFiles,
      payload.changedFiles,
      payload.deletedFiles,
      payload.chunkCount,
      payload.scannedFiles,
      payload.createdAt,
    );
  }

  public searchByPath(projectId: string, tokens: string[], limit: number): SearchResult[] {
    if (tokens.length === 0) {
      return [];
    }

    const likePatterns = tokens.map((token) => `%${token}%`);
    const whereClause = likePatterns.map(() => "LOWER(f.relative_path) LIKE ?").join(" OR ");
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
         ORDER BY LENGTH(f.relative_path) ASC
         LIMIT ?`,
      )
      .all(projectId, ...likePatterns, limit) as Array<{
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
      startLine: row.start_line,
    }));
  }

  public searchBySymbols(projectId: string, tokens: string[], limit: number): SearchResult[] {
    if (tokens.length === 0) {
      return [];
    }

    const likePatterns = tokens.map((token) => `%${token}%`);
    const whereClause = likePatterns.map(() => "LOWER(s.name) LIKE ? OR LOWER(s.full_name) LIKE ?").join(" OR ");
    const parameters = likePatterns.flatMap((pattern) => [pattern, pattern]);

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
         ORDER BY s.line ASC
         LIMIT ?`,
      )
      .all(projectId, ...parameters, limit) as Array<{
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
      startLine: row.start_line,
      symbol: row.name,
    }));
  }

  public searchByText(projectId: string, ftsQuery: string, limit: number): SearchResult[] {
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
         ORDER BY raw_score
         LIMIT ?`,
      )
      .all(projectId, ftsQuery, limit) as SearchRow[];

    return rows.map((row) => ({
      endLine: row.end_line,
      filePath: row.relative_path,
      language: row.language,
      reason: "lexical",
      score: 1 / (1 + Math.abs(row.raw_score)),
      snippet: row.content,
      startLine: row.start_line,
    }));
  }

  public upsertProject(projectId: string, project: ProjectInfo, status: ProjectStatus, timestamp: string): void {
    const existing = this.getProjectByRoot(project.rootPath);
    const version = (existing?.index_version ?? 0) + 1;

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

  public updateProjectAfterIndex(projectId: string, timestamp: string, status: ProjectStatus): void {
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
    indexedAt: string,
  ): void {
    const deleteChunkFts = this.db.prepare("DELETE FROM chunk_fts WHERE chunk_id = ?");
    const deleteSymbols = this.db.prepare("DELETE FROM symbol WHERE file_id = ?");
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
    const insertSymbol = this.db.prepare(
      `INSERT INTO symbol (symbol_id, file_id, name, full_name, kind, line, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      const oldChunkIds = selectChunkIds.all(indexedFile.fileId) as Array<{ chunk_id: string }>;
      for (const chunkId of oldChunkIds) {
        deleteChunkFts.run(chunkId.chunk_id);
      }

      deleteSymbols.run(indexedFile.fileId);
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
      }

      for (const symbol of symbols) {
        insertSymbol.run(
          symbol.symbolId,
          symbol.fileId,
          symbol.name,
          symbol.fullName,
          symbol.kind,
          symbol.line,
          symbol.signature,
        );
      }
    });

    tx();
  }
}

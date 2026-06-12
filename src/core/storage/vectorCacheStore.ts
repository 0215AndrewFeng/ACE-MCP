import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";

import Database from "better-sqlite3";

import { HnswIndex } from "../search/hnswIndex.js";
import { cosineSimilarity } from "../search/embedding.js";
import type { Language, SearchFilters, SearchResult, VectorEntry } from "../common/types.js";
import type { Logger } from "../common/logger.js";
import { matchesSearchFilters } from "./sqliteStoreHelpers.js";

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

export const VECTOR_CACHE_MAX_PROJECTS = 10;
const HNSW_CACHE_DIR = ".ace-mcp/data/hnsw";
// v4.5.7: above this many affected files, reconcile falls back to a full cache
// clear (full reindex / large change) — also keeps SQL IN under SQLite's 999 limit.
const MAX_RECONCILE_PATHS = 400;

interface VectorCacheEntry {
  indexVersion: number;
  modelName: string;
  vectors: VectorEntry[];
  hnswIndex: HnswIndex | null;
  hnswBuilding: boolean;
}

export class VectorCacheStore {
  private readonly vectorCache = new Map<string, VectorCacheEntry>();
  private readonly vectorCacheOrder: string[] = [];
  private vectorCacheMaxProjects: number;

  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger,
    private readonly hnswCacheDir: string,
    maxProjects: number,
  ) {
    this.vectorCacheMaxProjects = maxProjects;
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

  public searchByVector(
    projectId: string,
    queryEmbedding: number[],
    limit: number,
    modelName: string,
    filters?: SearchFilters,
    indexVersion = Number.NaN,
    candidateChunkIds?: Set<string>,
  ): { cacheHit: boolean; candidateCount: number; results: SearchResult[]; prefiltered: boolean; hnswUsed: boolean } {
    const { cacheHit, vectors, hnswIndex } = this.getProjectVectors(projectId, modelName, indexVersion);

    // v4.2.3: 如果提供了候选集，只在候选集中搜索
    const prefiltered = candidateChunkIds !== undefined && candidateChunkIds.size > 0;
    const hasFilters = filters !== undefined;

    // v4.5.4: If vectors were released after HNSW build, lazily reload from SQLite when brute-force search is needed.
    let effectiveVectors = vectors;
    if (vectors.length === 0 && hnswIndex && (prefiltered || hasFilters)) {
      effectiveVectors = this.reloadVectorsFromDb(projectId, modelName);
    }

    // v4.4.2: Use HNSW when no pre-filtering or filters (HNSW doesn't support filtered search)
    const canUseHnsw = hnswIndex && !prefiltered && !hasFilters;

    let topChunkIds: Array<{ id: string; score: number }>;
    let candidateCount: number;
    let hnswUsed = false;

    if (canUseHnsw) {
      // HNSW approximate nearest neighbor search
      const hnswResults = hnswIndex.search(queryEmbedding, limit * 2);  // Over-fetch for safety
      topChunkIds = hnswResults.map(r => ({
        id: r.id,
        score: 1 - r.distance,  // Convert distance back to similarity
      })).slice(0, limit);
      candidateCount = hnswIndex.size();
      hnswUsed = true;
    } else {
      // Brute-force search with filters
      let filteredVectors = effectiveVectors;

      if (prefiltered) {
        filteredVectors = effectiveVectors.filter((v) => candidateChunkIds.has(v.chunkId));
      }

      if (hasFilters) {
        filteredVectors = filteredVectors.filter((vector) => matchesSearchFilters(vector, filters));
      }

      if (filteredVectors.length === 0) {
        return {
          cacheHit,
          candidateCount: 0,
          prefiltered,
          results: [],
          hnswUsed: false,
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

      topChunkIds = heap.drain();
      candidateCount = filteredVectors.length;
    }

    if (topChunkIds.length === 0) {
      return {
        cacheHit,
        candidateCount,
        prefiltered,
        results: [],
        hnswUsed,
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
      candidateCount,
      prefiltered,
      hnswUsed,
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
    // v4.5.7: surgically upsert only the written chunks into the cache instead of
    // wiping it. Without a projectId we can't target a project, so keep the old
    // full-clear fallback (no current caller omits projectId).
    if (projectId) {
      this.upsertVectorCacheByChunkIds(projectId, entries.map((e) => e.chunkId));
    } else {
      this.clearVectorCache();
    }
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
  ): { cacheHit: boolean; vectors: VectorEntry[]; hnswIndex: HnswIndex | null } {
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

      // Try to build HNSW index if not already building
      if (!cached.hnswIndex && !cached.hnswBuilding && cached.vectors.length > 0) {
        this.buildHnswIndexAsync(projectId, cached);
      }

      return {
        cacheHit: true,
        vectors: cached.vectors,
        hnswIndex: cached.hnswIndex,
      };
    }

    // SQLite query is synchronous by design (better-sqlite3 is inherently sync).
    // This is acceptable as the query runs in-process without event loop blocking beyond the I/O.
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
      const cacheEntry: VectorCacheEntry = {
        indexVersion,
        modelName,
        vectors,
        hnswIndex: null,
        hnswBuilding: false,
      };
      this.vectorCache.set(projectId, cacheEntry);

      // LRU: 更新访问顺序并淘汰
      const orderIdx = this.vectorCacheOrder.indexOf(projectId);
      if (orderIdx >= 0) {
        this.vectorCacheOrder.splice(orderIdx, 1);
      }
      this.vectorCacheOrder.push(projectId);
      this.evictVectorCache();

      // Try to load HNSW from disk cache asynchronously, then fall back to building
      this.loadHnswFromDisk(projectId, modelName, vectors.length).then((hnswIndex) => {
        cacheEntry.hnswIndex = hnswIndex;
        if (hnswIndex) {
          // v4.5.4: Release vectors after successful HNSW load from disk
          cacheEntry.vectors = [];
          this.logger.info(`HNSW loaded from disk for ${projectId}, vectors array released`);
        } else if (vectors.length > 0) {
          this.buildHnswIndexAsync(projectId, cacheEntry);
        }
      });
    }

    return {
      cacheHit: false,
      vectors,
      hnswIndex: null,
    };
  }

  /**
   * v4.5.4: Reload vectors from SQLite when brute-force search is needed
   * after vectors were released to save memory (HNSW available).
   */
  private reloadVectorsFromDb(projectId: string, modelName: string): VectorEntry[] {
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

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      embedding: new Float32Array(row.embedding.buffer),
      filePath: row.relative_path,
      language: row.language,
      modelName: row.model_name,
    }));
  }

  /**
   * v4.5.7: Materialize the in-memory vectors array if it was released after an
   * HNSW build (v4.5.4 memory optimization). Needed before any surgical cache
   * patch so brute-force search stays correct and the HNSW rebuild can fire.
   */
  private ensureVectorsMaterialized(projectId: string, entry: VectorCacheEntry): void {
    if (entry.vectors.length === 0 && entry.hnswIndex) {
      entry.vectors = this.reloadVectorsFromDb(projectId, entry.modelName);
    }
  }

  /**
   * v4.5.7: Mark the HNSW index stale so it is rebuilt on the next vector search.
   * Brute-force over the patched vectors array serves correct results meanwhile.
   */
  private markHnswStale(entry: VectorCacheEntry): void {
    entry.hnswIndex = null;
    entry.hnswBuilding = false;
  }

  /**
   * v4.5.7: Remove cached vectors for the given files (no-op if project not
   * cached). Used by deleteFiles so deleting/clearing files no longer wipes the
   * whole project's vector cache.
   */
  public removeVectorCacheByPaths(projectId: string, paths: string[]): void {
    if (paths.length === 0) {
      return;
    }
    const entry = this.vectorCache.get(projectId);
    if (!entry) {
      return;
    }
    this.ensureVectorsMaterialized(projectId, entry);
    const drop = new Set(paths);
    const before = entry.vectors.length;
    entry.vectors = entry.vectors.filter((v) => !drop.has(v.filePath));
    if (entry.vectors.length !== before) {
      this.markHnswStale(entry);
    }
  }

  /**
   * v4.5.7: Upsert cached vectors for the given chunk ids by re-querying the DB
   * (no-op if project not cached). Used by writeChunkVectors so warming / eager
   * indexing updates the cache surgically instead of clearing it.
   */
  private upsertVectorCacheByChunkIds(projectId: string, chunkIds: string[]): void {
    if (chunkIds.length === 0) {
      return;
    }
    const entry = this.vectorCache.get(projectId);
    if (!entry) {
      return;
    }
    this.ensureVectorsMaterialized(projectId, entry);

    const placeholders = chunkIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT cv.chunk_id, cv.embedding, cv.model_name, f.relative_path, f.language
        FROM chunk_vector cv
        JOIN chunk c ON c.chunk_id = cv.chunk_id
        JOIN file f ON f.file_id = c.file_id
        WHERE cv.chunk_id IN (${placeholders})
          AND cv.model_name = ?
      `)
      .all(...chunkIds, entry.modelName) as Array<{
      chunk_id: string;
      embedding: Buffer;
      language: Language;
      model_name: string;
      relative_path: string;
    }>;

    if (rows.length === 0) {
      return;
    }

    const refreshed = new Set(rows.map((row) => row.chunk_id));
    entry.vectors = entry.vectors.filter((v) => !refreshed.has(v.chunkId));
    for (const row of rows) {
      entry.vectors.push({
        chunkId: row.chunk_id,
        embedding: new Float32Array(row.embedding.buffer),
        filePath: row.relative_path,
        language: row.language,
        modelName: row.model_name,
      });
    }
    this.markHnswStale(entry);
  }

  /**
   * v4.5.7: Reconcile the vector cache after an incremental index instead of
   * clearing it wholesale. Removes affected files' stale vectors, re-reads their
   * current vectors, and syncs the cache index version so getProjectVectors keeps
   * hitting the cache (avoids a full re-SELECT of all project vectors).
   */
  public reconcileVectorCacheAfterIndex(projectId: string, affectedPaths: string[], newIndexVersion: number): void {
    const entry = this.vectorCache.get(projectId);
    if (!entry) {
      return;
    }

    // Large change set (or full reindex): fall back to a full clear; the next
    // search reloads with the new version. Also keeps SQL IN under the 999 limit.
    if (affectedPaths.length > MAX_RECONCILE_PATHS) {
      this.clearVectorCache(projectId);
      return;
    }

    this.ensureVectorsMaterialized(projectId, entry);

    let changed = false;
    if (affectedPaths.length > 0) {
      const drop = new Set(affectedPaths);
      const before = entry.vectors.length;
      entry.vectors = entry.vectors.filter((v) => !drop.has(v.filePath));
      const removedCount = before - entry.vectors.length;

      const placeholders = affectedPaths.map(() => "?").join(", ");
      const rows = this.db
        .prepare(`
          SELECT cv.chunk_id, cv.embedding, cv.model_name, f.relative_path, f.language
          FROM chunk_vector cv
          JOIN chunk c ON c.chunk_id = cv.chunk_id
          JOIN file f ON f.file_id = c.file_id
          WHERE f.project_id = ?
            AND f.relative_path IN (${placeholders})
            AND cv.model_name = ?
        `)
        .all(projectId, ...affectedPaths, entry.modelName) as Array<{
        chunk_id: string;
        embedding: Buffer;
        language: Language;
        model_name: string;
        relative_path: string;
      }>;

      for (const row of rows) {
        entry.vectors.push({
          chunkId: row.chunk_id,
          embedding: new Float32Array(row.embedding.buffer),
          filePath: row.relative_path,
          language: row.language,
          modelName: row.model_name,
        });
      }

      changed = removedCount > 0 || rows.length > 0;
    }

    // Always sync the version so the cache key matches after the index_version bump.
    entry.indexVersion = newIndexVersion;

    if (changed) {
      this.markHnswStale(entry);
    }
  }

  /**
   * Build HNSW index asynchronously in the background
   */
  private buildHnswIndexAsync(projectId: string, cacheEntry: VectorCacheEntry): void {
    if (cacheEntry.hnswBuilding || cacheEntry.hnswIndex || cacheEntry.vectors.length === 0) {
      return;
    }

    cacheEntry.hnswBuilding = true;
    const vectors = cacheEntry.vectors;
    const dimension = vectors[0].embedding.length;

    // Use setImmediate to avoid blocking the main thread
    setImmediate(async () => {
      try {
        const startMs = Date.now();
        const hnswIndex = new HnswIndex({
          dimension,
          maxElements: Math.max(vectors.length * 2, 10000),  // Allow growth
          efConstruction: 200,
          efSearch: 50,
          m: 16,
        });

        // Batch add vectors, yielding to the event loop periodically so the
        // pure-CPU graph build does not block concurrent requests for tens of seconds.
        await hnswIndex.addBatchAsync(vectors.map(v => ({
          id: v.chunkId,
          vector: [...v.embedding],
        })));

        cacheEntry.hnswIndex = hnswIndex;
        cacheEntry.hnswBuilding = false;

        // v4.5.4: Release vectors array when HNSW is available — saves ~600MB for 10 projects.
        // Vectors will be lazily reloaded from SQLite if brute-force search is needed (with filters).
        cacheEntry.vectors = [];

        const durationMs = Date.now() - startMs;
        this.logger.info(`HNSW index built for project ${projectId}: ${vectors.length} vectors in ${durationMs}ms, vectors array released`);

        // Save to disk for next startup
        this.saveHnswToDisk(projectId, cacheEntry.modelName, hnswIndex);
      } catch (error) {
        cacheEntry.hnswBuilding = false;
        this.logger.warn(`Failed to build HNSW index for ${projectId}: ${error}`);
      }
    });
  }

  /**
   * Load HNSW index from disk cache if valid (async I/O to avoid blocking event loop)
   */
  private async loadHnswFromDisk(projectId: string, modelName: string, expectedSize: number): Promise<HnswIndex | null> {
    try {
      const cachePath = this.getHnswCachePath(projectId, modelName);
      if (!fs.existsSync(cachePath)) {
        return null;
      }

      const data = await fsPromises.readFile(cachePath);
      const hnswIndex = HnswIndex.deserialize(data);

      // Validate size matches (index may be stale)
      if (hnswIndex.size() !== expectedSize) {
        this.logger.info(`HNSW cache size mismatch for ${projectId}: ${hnswIndex.size()} vs ${expectedSize}, rebuilding`);
        fsPromises.unlink(cachePath).catch(() => {}); // fire-and-forget cleanup
        return null;
      }

      this.logger.info(`HNSW index loaded from disk for ${projectId}: ${hnswIndex.size()} vectors`);
      return hnswIndex;
    } catch (error) {
      this.logger.warn(`Failed to load HNSW cache for ${projectId}: ${error}`);
      return null;
    }
  }

  /**
   * Save HNSW index to disk for persistence (fire-and-forget async write)
   */
  private saveHnswToDisk(projectId: string, modelName: string, hnswIndex: HnswIndex): void {
    try {
      const cachePath = this.getHnswCachePath(projectId, modelName);
      const cacheDir = path.dirname(cachePath);

      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const data = hnswIndex.serialize();
      // Fire-and-forget: don't block on disk write
      fsPromises.writeFile(cachePath, data).then(() => {
        this.logger.info(`HNSW index saved to disk for ${projectId}: ${hnswIndex.size()} vectors`);
      }).catch((error) => {
        this.logger.warn(`Failed to save HNSW cache for ${projectId}: ${error}`);
      });
    } catch (error) {
      this.logger.warn(`Failed to save HNSW cache for ${projectId}: ${error}`);
    }
  }

  /**
   * Get HNSW cache file path
   */
  private getHnswCachePath(projectId: string, modelName: string): string {
    // Sanitize projectId for filename
    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeModelName = modelName.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.hnswCacheDir, `${safeProjectId}_${safeModelName}.hnsw`);
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
}

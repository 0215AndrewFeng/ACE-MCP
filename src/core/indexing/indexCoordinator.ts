import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import iconv from "iconv-lite";

import { mapInBatches } from "../common/batch.js";
import type { Logger } from "../common/logger.js";
import type {
  ChunkRecord,
  CollectedFile,
  ImportInfo,
  IndexFailure,
  IndexProjectResult,
  IndexedFileRecord,
  ProjectInfo,
  Settings,
  SymbolInfo,
  SymbolUsageInfo,
} from "../common/types.js";
import { buildChunks } from "./chunker.js";
import { buildStableId, computeSha256, hasFileChanged } from "./fileFingerprint.js";
import { analyzeSource } from "./symbolExtractor.js";
import { AppError } from "../common/errors.js";
import { collectSourceFiles } from "../project/fileCollector.js";
import { getGitChangedFiles, getHeadCommit } from "../project/gitHelper.js";
import { IgnoreManager } from "../project/ignoreManager.js";
import { normalizeAbsolutePath } from "../project/pathNormalizer.js";
import { detectProject } from "../project/projectDetector.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { SQLiteStore } from "../storage/sqliteStore.js";

interface DecodedSource {
  content: string;
  encoding: string;
}

/**
 * v4.3.6: Index progress event types for SSE streaming
 */
export type IndexProgressPhase = "collect" | "parse" | "index" | "vector" | "semantic" | "complete";
export type IndexProgressStatus = "start" | "progress" | "done";

export interface IndexProgressEvent {
  phase: IndexProgressPhase;
  status: IndexProgressStatus;
  /** Current progress (for 'progress' status) */
  current?: number;
  /** Total items (for 'progress' status) */
  total?: number;
  /** Duration in ms (for 'done' status) */
  ms?: number;
  /** Additional details */
  detail?: string;
}

export type IndexProgressCallback = (event: IndexProgressEvent) => void;

/**
 * v4.3.1: Extended result type for batch processing
 */
type IndexedFileResult =
  | {
      chunkCount: number;
      indexed: true;
      vectorChunkCount: number;
      // v4.3.1: Include data for batch write
      indexedFile: IndexedFileRecord;
      chunks: ChunkRecord[];
      symbols: SymbolInfo[];
      imports: ImportInfo[];
      usages: SymbolUsageInfo[];
    }
  | {
      filePath: string;
      indexed: false;
      message: string;
    };

/**
 * v4.3.1: Batch size for database writes
 * Balances transaction overhead vs memory usage
 */
const DB_WRITE_BATCH_SIZE = 50;

function scoreDecodedContent(content: string): number {
  const replacementCount = (content.match(/\uFFFD/g) ?? []).length;
  const printableCount = [...content].filter((character) => character === "\n" || character === "\r" || character === "\t" || character >= " ").length;
  return printableCount - replacementCount * 10;
}

function isValidUtf8(buffer: Buffer): boolean {
  const decoded = buffer.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(buffer);
}

function decodeSourceBuffer(buffer: Buffer): DecodedSource {
  if (isValidUtf8(buffer)) {
    return { content: buffer.toString("utf8"), encoding: "utf8" };
  }

  const encodings = ["utf8", "utf16le", "gbk", "latin1"] as const;
  let best: DecodedSource = { content: buffer.toString("utf8"), encoding: "utf8" };
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const encoding of encodings) {
    try {
      const content = iconv.decode(buffer, encoding);
      const score = scoreDecodedContent(content);
      if (score > bestScore) {
        best = { content, encoding };
        bestScore = score;
      }
    } catch {
      continue;
    }
  }

  return best;
}

export class IndexCoordinator {
  private watching = false;
  private watchAbortController?: AbortController;
  private indexingLock = false;
  private debounceTimer?: NodeJS.Timeout;

  /** Per-project last successful index timestamp (epoch ms) */
  private lastIndexedAtMs = new Map<string, number>();
  /** Per-project dirty flag set by watcher events */
  private watcherDirty = new Map<string, boolean>();
  /** Per-project cached last IndexProjectResult for skipped index calls */
  private lastIndexResult = new Map<string, IndexProjectResult>();

  /**
   * v4.3.6: Per-project index queue - serializes index requests for the same project
   * Prevents "database is locked" errors from concurrent indexing
   */
  private projectQueue = new Map<string, Promise<unknown>>();
  /**
   * v4.3.6: In-flight index promises - allows deduplication of concurrent requests
   * If an index is already running for a project, new requests will wait for it
   */
  private inFlightIndex = new Map<string, Promise<IndexProjectResult>>();

  public constructor(
    private readonly settings: Settings,
    private readonly store: SQLiteStore,
    private readonly logger: Logger,
    private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  public isWatching(): boolean {
    return this.watching;
  }

  /**
   * Ensure the project index is fresh enough according to the configured freshness policy.
   * Returns a cached or real IndexProjectResult.
   *
   * - "always": always run incremental index (v3.7.0 behavior)
   * - "stale": skip if last index was within `indexFreshnessSeconds` and no watcher events fired
   * - "manual": never auto-index; return cached result or a minimal stub
   */
  public async ensureFreshIndex(projectRootPath: string, timeoutMs = 30_000): Promise<IndexProjectResult> {
    const normalizedRoot = normalizeAbsolutePath(projectRootPath);
    const policy = this.settings.indexFreshness;

    if (policy === "always") {
      return this.indexProjectWithTimeout(normalizedRoot, "incremental", timeoutMs);
    }

    if (policy === "manual") {
      const cached = this.lastIndexResult.get(normalizedRoot);
      if (cached) {
        return cached;
      }
      return this.indexProjectWithTimeout(normalizedRoot, "incremental", timeoutMs);
    }

    // policy === "stale"
    const lastMs = this.lastIndexedAtMs.get(normalizedRoot);
    const dirty = this.watcherDirty.get(normalizedRoot) ?? false;
    const freshnessMs = this.settings.indexFreshnessSeconds * 1000;
    const now = performance.now();

    if (lastMs !== undefined && !dirty && (now - lastMs) < freshnessMs) {
      const cached = this.lastIndexResult.get(normalizedRoot);
      if (cached) {
        this.logger.debug("index fresh, skipping incremental scan", {
          ageMs: Math.round(now - lastMs),
          freshnessMs,
          projectRootPath: normalizedRoot,
        });
        return cached;
      }
    }

    return this.indexProjectWithTimeout(normalizedRoot, "incremental", timeoutMs);
  }

  /**
   * v4.3.9: Wrapper around indexProject that adds timeout protection.
   * On timeout, returns cached result or a minimal fallback so search is not blocked.
   */
  private async indexProjectWithTimeout(
    normalizedRoot: string,
    mode: "full" | "incremental",
    timeoutMs: number,
  ): Promise<IndexProjectResult> {
    try {
      const result = await Promise.race([
        this.indexProject(normalizedRoot, mode),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`index timeout after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
      return result;
    } catch (error) {
      this.logger.warn("ensureFreshIndex timeout, using fallback", {
        projectRootPath: normalizedRoot,
        timeoutMs,
        error: String(error),
      });
      // Return cached result if available
      const cached = this.lastIndexResult.get(normalizedRoot);
      if (cached) {
        return cached;
      }
      // Minimal fallback stub
      return {
        projectRootPath: normalizedRoot,
        projectId: "",
        project: { rootPath: normalizedRoot, projectType: "single-language" as const, languages: [], markers: [] },
        scannedFiles: 0,
        indexedFiles: 0,
        changedFiles: 0,
        deletedFiles: 0,
        chunkCount: 0,
        failedFileCount: 0,
        failedFiles: [],
        createdAt: new Date().toISOString(),
        timings: { collectMs: 0, detectMs: 0, indexMs: 0, vectorMs: 0, totalMs: timeoutMs },
        vectorIndex: { enabled: false, hydratedChunkCount: 0, mode: "lazy" as const },
      };
    }
  }

  public startWatching(projectRootPath: string): void {
    if (this.watching) {
      this.logger.warn("file watch already active", { projectRootPath });
      return;
    }

    const normalizedRoot = normalizeAbsolutePath(projectRootPath);
    const abortController = new AbortController();
    this.watchAbortController = abortController;

    const watcher = watch(normalizedRoot, { recursive: true }, (_event, _filename) => {
      if (abortController.signal.aborted) {
        return;
      }

      // Mark project dirty so ensureFreshIndex knows the cache is stale
      this.watcherDirty.set(normalizedRoot, true);

      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        if (abortController.signal.aborted) {
          return;
        }

        // v4.3.6: Use queue-based indexProject - no need for indexingLock
        // The queue will serialize concurrent requests automatically
        this.indexProject(normalizedRoot, "incremental")
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn("watch-triggered index failed", {
              error: message,
              projectRootPath: normalizedRoot,
            });
          });
      }, 2500);
    });

    abortController.signal.addEventListener("abort", () => watcher.close());
    this.watching = true;
    this.logger.info("file watch started", { projectRootPath: normalizedRoot });
  }

  public stopWatching(): void {
    if (!this.watching) {
      return;
    }

    clearTimeout(this.debounceTimer);
    this.watchAbortController?.abort();
    this.watching = false;
    this.logger.info("file watch stopped");
  }

  /**
   * v4.3.6: Enqueue and deduplicate index requests
   * - If an index is already in-flight for this project, reuse that promise
   * - Otherwise, queue behind any previous request and start a new index
   * @param onProgress Optional callback for progress events (SSE streaming)
   */
  public async indexProject(
    projectRootPath: string,
    mode: "full" | "incremental" = "incremental",
    onProgress?: IndexProgressCallback,
  ): Promise<IndexProjectResult> {
    const normalizedRoot = normalizeAbsolutePath(projectRootPath);

    // Check if there's already an in-flight index for this project
    // Note: If onProgress is provided, we still need to run a new index to provide progress
    // But we'll wait for the in-flight one to complete first
    const inFlight = this.inFlightIndex.get(normalizedRoot);
    if (inFlight && !onProgress) {
      this.logger.debug("reusing in-flight index", { projectRootPath: normalizedRoot, mode });
      // v4.3.9: Add timeout when reusing in-flight promise to avoid blocking forever
      try {
        return await Promise.race([
          inFlight,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("in-flight index reuse timeout")), 60_000),
          ),
        ]);
      } catch {
        // Stuck in-flight promise — clear it and start fresh
        this.logger.warn("in-flight index stuck, clearing and restarting", { projectRootPath: normalizedRoot });
        this.inFlightIndex.delete(normalizedRoot);
      }
    }

    // Queue behind any previous request
    const prev = this.projectQueue.get(normalizedRoot) ?? Promise.resolve();
    const indexPromise = prev.then(() => this.runIndexProject(normalizedRoot, mode, onProgress));

    // Track both queue and in-flight state
    const queuePromise = indexPromise.catch(() => {}); // Swallow errors in queue chain
    this.projectQueue.set(normalizedRoot, queuePromise);
    this.inFlightIndex.set(normalizedRoot, indexPromise);

    // Clean up when done
    indexPromise.finally(() => {
      this.inFlightIndex.delete(normalizedRoot);
      // Only delete from queue if this is still the latest promise
      if (this.projectQueue.get(normalizedRoot) === queuePromise) {
        this.projectQueue.delete(normalizedRoot);
      }
    });

    return indexPromise;
  }

  /**
   * v4.3.6: Internal method that performs the actual indexing
   * Called by indexProject after queue management
   * @param onProgress Optional callback for progress events
   */
  private async runIndexProject(
    normalizedRoot: string,
    mode: "full" | "incremental",
    onProgress?: IndexProgressCallback,
  ): Promise<IndexProjectResult> {
    const startedAtMs = performance.now();
    const rootStats = await stat(normalizedRoot).catch(() => null);
    if (!rootStats?.isDirectory()) {
      throw new AppError("INVALID_PROJECT_ROOT", `Project root does not exist or is not a directory: ${normalizedRoot}`);
    }

    const projectId = buildStableId([normalizedRoot]);
    const timestamp = new Date().toISOString();

    /**
     * v4.3.3: Git-based incremental indexing optimization
     * For git repositories in incremental mode:
     * 1. Check last indexed commit from database
     * 2. Use git diff to find changed files
     * 3. Only scan those files instead of full filesystem traversal
     * Falls back to full scan for non-git repos or when git diff fails.
     */
    let gitCommit: string | null = null;
    let gitOptimized = false;
    let gitChangedPaths: Set<string> | null = null;

    if (mode === "incremental") {
      const lastIndexedCommit = this.store.getLastIndexedCommit(projectId);
      const gitStatus = await getGitChangedFiles(normalizedRoot, lastIndexedCommit ?? undefined);

      if (gitStatus.isGitRepo && gitStatus.currentCommit) {
        gitCommit = gitStatus.currentCommit;

        // If we have a previous index and git tells us what changed
        if (lastIndexedCommit && gitStatus.changedFiles && gitStatus.untrackedFiles) {
          gitChangedPaths = new Set([
            ...gitStatus.changedFiles,
            ...gitStatus.untrackedFiles,
          ]);
          gitOptimized = true;
          this.logger.debug("using git diff for incremental index", {
            changedFiles: gitStatus.changedFiles.length,
            lastIndexedCommit: lastIndexedCommit.slice(0, 8),
            currentCommit: gitCommit.slice(0, 8),
            untrackedFiles: gitStatus.untrackedFiles.length,
          });
        }
      }
    }

    // v4.3.6: Emit collect phase events
    onProgress?.({ phase: "collect", status: "start" });
    const collectStartedAtMs = performance.now();
    const ignoreManager = await IgnoreManager.create(normalizedRoot, this.settings.excludePatterns);
    const sourceFiles = await collectSourceFiles(normalizedRoot, this.settings, ignoreManager);
    const collectMs = Math.round(performance.now() - collectStartedAtMs);
    onProgress?.({ phase: "collect", status: "done", ms: collectMs, detail: `${sourceFiles.length} files scanned` });

    const detectStartedAtMs = performance.now();
    const project = await detectProject(normalizedRoot, sourceFiles);
    const detectMs = Math.round(performance.now() - detectStartedAtMs);

    this.store.upsertProject(projectId, project, "indexing", timestamp);

    const existingFiles = new Map(
      this.store.listProjectFiles(projectId).map((file) => [file.relativePath, file]),
    );
    const currentPaths = new Set(sourceFiles.map((file) => file.relativePath));
    const deletedFiles = [...existingFiles.keys()].filter((relativePath) => !currentPaths.has(relativePath));
    this.store.deleteFiles(projectId, deletedFiles);

    /**
     * v4.3.3: Smart file filtering
     * - Full mode: index all files
     * - Incremental + git optimized: only files in git diff + files with changed mtime
     * - Incremental fallback: files with changed mtime/sha256
     */
    const filesToIndex = sourceFiles.filter((file) => {
      if (mode === "full") {
        return true;
      }

      // v4.3.3: If git tells us this file changed, always re-index
      if (gitOptimized && gitChangedPaths?.has(file.relativePath)) {
        return true;
      }

      // Fall back to mtime/sha256 check
      const existing = existingFiles.get(file.relativePath);
      return hasFileChanged(existing, file);
    });

    const changedFiles = filesToIndex.length;
    const indexingStartedAtMs = performance.now();
    let vectorMs = 0;

    // v4.3.6: Emit parse phase events
    onProgress?.({ phase: "parse", status: "start", total: changedFiles });
    let parsedCount = 0;

    /**
     * v4.3.1: Optimized indexing with batch database writes
     * 1. Parallel file read and parse (mapInBatches)
     * 2. Batch database writes (writeFileIndexBatch)
     * 3. Eliminates database lock contention
     */
    const fileResults = await mapInBatches<CollectedFile, IndexedFileResult>(filesToIndex, this.settings.batchSize, async (file) => {
      try {
        const buffer = await readFile(file.absolutePath);
        const { content, encoding } = decodeSourceBuffer(buffer);
        const fileId = buildStableId([projectId, file.relativePath]);
        const analysis = analyzeSource(fileId, file.relativePath, file.language, content);
        const chunks = buildChunks(fileId, file.relativePath, content, analysis.symbols, this.settings.maxLinesPerChunk);
        const indexedFile: IndexedFileRecord = {
          encoding,
          fileId,
          language: file.language,
          lineCount: content.split(/\r?\n/).length,
          mtimeMs: file.mtimeMs,
          relativePath: file.relativePath,
          sha256: computeSha256(buffer),
          size: file.size,
        };

        // v4.3.6: Emit parse progress (every batch)
        parsedCount++;
        if (parsedCount % this.settings.batchSize === 0 || parsedCount === changedFiles) {
          onProgress?.({ phase: "parse", status: "progress", current: parsedCount, total: changedFiles });
        }

        // v4.3.1: Return data for batch write instead of writing immediately
        return {
          chunkCount: chunks.length,
          indexed: true as const,
          vectorChunkCount: 0, // Will be updated after vector indexing
          indexedFile,
          chunks,
          symbols: analysis.symbols,
          imports: analysis.imports,
          usages: analysis.usages,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("file indexing failed", {
          error: message,
          filePath: file.relativePath,
          projectRootPath: normalizedRoot,
        });
        parsedCount++;
        return {
          filePath: file.relativePath,
          indexed: false as const,
          message,
        };
      }
    });
    const parseMs = Math.round(performance.now() - indexingStartedAtMs);
    onProgress?.({ phase: "parse", status: "done", ms: parseMs, detail: `${parsedCount} files parsed` });

    // v4.3.1: Batch write to database - dramatically reduces transaction overhead
    const successResults = fileResults.filter((r): r is Extract<IndexedFileResult, { indexed: true }> => r.indexed);

    // v4.3.6: Emit index (database write) phase events
    onProgress?.({ phase: "index", status: "start", total: successResults.length });
    const indexWriteStartMs = performance.now();

    const totalBatches = Math.ceil(successResults.length / DB_WRITE_BATCH_SIZE);
    for (let i = 0; i < successResults.length; i += DB_WRITE_BATCH_SIZE) {
      const batch = successResults.slice(i, i + DB_WRITE_BATCH_SIZE);
      this.store.writeFileIndexBatch(
        projectId,
        batch.map((r) => ({
          indexedFile: r.indexedFile,
          chunks: r.chunks,
          symbols: r.symbols,
          imports: r.imports,
          usages: r.usages,
        })),
        timestamp,
      );
      // v4.3.6: Emit index progress per batch
      const batchNum = Math.floor(i / DB_WRITE_BATCH_SIZE) + 1;
      onProgress?.({ phase: "index", status: "progress", current: batchNum, total: totalBatches });
    }
    const indexWriteMs = Math.round(performance.now() - indexWriteStartMs);
    onProgress?.({ phase: "index", status: "done", ms: indexWriteMs, detail: `${successResults.length} files indexed` });

    // v4.3.1: Vector indexing (still per-file for now, but after batch write)
    if (this.settings.enableVectorSearch && this.settings.vectorIndexingMode === "eager") {
      onProgress?.({ phase: "vector", status: "start", total: successResults.length });
      let vectoredCount = 0;
      for (const result of successResults) {
        if (result.chunks.length > 0) {
          const provider = this.embeddingProvider;
          const vectorStartedAtMs = performance.now();
          const embeddings = await provider.embedBatch(result.chunks.map((chunk) => chunk.content));
          vectorMs += Math.round(performance.now() - vectorStartedAtMs);
          result.vectorChunkCount = result.chunks.length;
          this.store.writeChunkVectors(
            result.chunks.map((chunk, index) => ({
              chunkId: chunk.chunkId,
              embedding: embeddings[index],
              modelName: provider.getModelName(),
            })),
            projectId,
          );
        }
        vectoredCount++;
        if (vectoredCount % 10 === 0 || vectoredCount === successResults.length) {
          onProgress?.({ phase: "vector", status: "progress", current: vectoredCount, total: successResults.length });
        }
      }
      onProgress?.({ phase: "vector", status: "done", ms: vectorMs });
    }

    const indexMs = Math.round(performance.now() - indexingStartedAtMs);
    const failedFiles: IndexFailure[] = [];
    let chunkCount = 0;
    let indexedFiles = 0;
    let hydratedChunkCount = 0;
    for (const result of fileResults) {
      if (result.indexed) {
        indexedFiles += 1;
        chunkCount += result.chunkCount;
        hydratedChunkCount += result.vectorChunkCount;
        continue;
      }

      failedFiles.push({
        filePath: result.filePath,
        message: result.message,
      });
    }

    const totalMs = Math.round(performance.now() - startedAtMs);
    if (changedFiles > 0 || deletedFiles.length > 0) {
      // Collect fileIds of changed files for incremental symbol graph resolution
      const changedFileIds = new Set(filesToIndex.map((file) => buildStableId([projectId, file.relativePath])));
      // Also include deleted file IDs (their usages/imports were already removed by deleteFiles)
      for (const deletedPath of deletedFiles) {
        changedFileIds.add(buildStableId([projectId, deletedPath]));
      }
      this.store.resolveSymbolGraph(projectId, changedFileIds);
    }

    // v4.3.6: Emit semantic phase events
    // Pre-build semantic FTS index during indexing so first search doesn't block
    if (changedFiles > 0 || deletedFiles.length > 0) {
      onProgress?.({ phase: "semantic", status: "start" });
      const semanticStart = performance.now();
      this.store.ensureSemanticIndex(projectId);
      const semanticMs = Math.round(performance.now() - semanticStart);
      onProgress?.({ phase: "semantic", status: "done", ms: semanticMs });
      if (semanticMs > 100) {
        this.logger.info("semantic index built", { projectRootPath: normalizedRoot, semanticMs });
      }
    }

    const bumpIndexVersion = changedFiles > 0 || deletedFiles.length > 0;
    // v4.3.3: Save git commit for future incremental indexing
    this.store.updateProjectAfterIndex(projectId, timestamp, "ready", bumpIndexVersion, gitCommit ?? undefined);
    this.store.recordIndexEvent(projectId, {
      changedFiles,
      chunkCount,
      createdAt: timestamp,
      deletedFiles: deletedFiles.length,
      failedFiles,
      indexedFiles,
      metadata: {
        timings: {
          collectMs,
          detectMs,
          indexMs,
          totalMs,
          vectorMs,
        },
        vectorIndex: {
          enabled: this.settings.enableVectorSearch,
          hydratedChunkCount,
          mode: this.settings.vectorIndexingMode,
        },
        // v4.3.3: Track git optimization stats
        gitOptimization: {
          enabled: gitOptimized,
          commit: gitCommit?.slice(0, 8) ?? null,
        },
      },
      scannedFiles: sourceFiles.length,
    });

    this.logger.info("project indexed", {
      batchSize: this.settings.batchSize,
      changedFiles,
      collectMs,
      chunkCount,
      detectMs,
      deletedFiles: deletedFiles.length,
      failedFileCount: failedFiles.length,
      gitOptimized,
      indexMs,
      indexedFiles,
      projectRootPath: normalizedRoot,
      scannedFiles: sourceFiles.length,
      totalMs,
      vectorIndexingMode: this.settings.vectorIndexingMode,
      vectorMs,
      vectorSearchEnabled: this.settings.enableVectorSearch,
    });

    if (this.settings.autoWatch && !this.watching) {
      this.startWatching(normalizedRoot);
    }

    // Update freshness tracking
    this.lastIndexedAtMs.set(normalizedRoot, performance.now());
    this.watcherDirty.set(normalizedRoot, false);

    const result: IndexProjectResult = {
      changedFiles,
      chunkCount,
      createdAt: timestamp,
      deletedFiles: deletedFiles.length,
      failedFileCount: failedFiles.length,
      failedFiles,
      indexedFiles,
      project,
      projectId,
      projectRootPath: normalizedRoot,
      scannedFiles: sourceFiles.length,
      timings: {
        collectMs,
        detectMs,
        indexMs,
        totalMs,
        vectorMs,
      },
      vectorIndex: {
        enabled: this.settings.enableVectorSearch,
        hydratedChunkCount,
        mode: this.settings.vectorIndexingMode,
      },
    };

    // v4.3.6: Emit complete event
    onProgress?.({
      phase: "complete",
      status: "done",
      ms: totalMs,
      detail: `${indexedFiles} files indexed, ${chunkCount} chunks created`,
    });

    this.lastIndexResult.set(normalizedRoot, result);
    return result;
  }
}

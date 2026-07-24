import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
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
import { getGitChangedFiles, type GitStatus } from "../project/gitHelper.js";
import { IgnoreManager } from "../project/ignoreManager.js";
import { normalizeAbsolutePath } from "../project/pathNormalizer.js";
import { detectProject } from "../project/projectDetector.js";
import { findAggregateProjectRoots } from "../project/projectHierarchy.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { SQLiteIndexWorkerClient } from "../storage/sqliteIndexWorkerClient.js";
import type {
  FinalizeProjectIndexPayload,
  FinalizeProjectIndexResult,
  PrepareProjectIndexResult,
  SQLiteIndexFileBatch,
} from "../storage/sqliteIndexWorkerProtocol.js";
import { SQLiteStore } from "../storage/sqliteStore.js";

interface DecodedSource {
  content: string;
  encoding: string;
}

/**
 * v4.3.6: Index progress event types for SSE streaming
 */
export type IndexProgressPhase =
  | "queued"
  | "prepare"
  | "collect"
  | "detect"
  | "parse"
  | "index"
  | "vector"
  | "symbolGraph"
  | "semantic"
  | "finalize"
  | "complete";
export type IndexProgressStatus = "start" | "progress" | "done";
export type IndexOrigin = "automatic" | "explicit";

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

export interface InFlightIndexInfo {
  current: number;
  dedupedRequests: number;
  elapsedMs: number;
  lastProgressAt: string;
  origin: IndexOrigin;
  phase: IndexProgressPhase;
  phaseElapsedMs: number;
  projectRootPath: string;
  queueMs: number;
  queuedRequests: number;
  status: "running";
  total: number;
}

interface IndexProgressState {
  current: number;
  dedupedRequests: number;
  lastProgressAtMs: number;
  origin: IndexOrigin;
  phase: IndexProgressPhase;
  phaseStartedAtMs: number;
  projectRootPath: string;
  requestedAtMs: number;
  runStartedAtMs?: number;
  total: number;
}

export interface ProjectWatchStatus {
  dirty: boolean;
  failureCount: number;
  generation: number;
  lastError: string | null;
  lastEventAt: string | null;
  lastSuccessAt: string | null;
  projectRootPath: string;
  watching: boolean;
}

interface ProjectWatchState {
  active: boolean;
  abortController: AbortController;
  debounceTimer?: NodeJS.Timeout;
  dirty: boolean;
  failureCount: number;
  generation: number;
  lastError?: string;
  lastEventAt?: string;
  lastSuccessAt?: string;
  maxWaitTimer?: NodeJS.Timeout;
  processing: boolean;
  rerunRequested: boolean;
  retryTimer?: NodeJS.Timeout;
  watcher?: WatchHandle;
}

interface AutomaticProjectOwnershipSnapshot {
  applied: boolean;
  generation: number;
  projectRootPaths: string[];
  sequence: number;
}

interface AutomaticProjectRefresh {
  generation: number;
  promise: Promise<AutomaticProjectOwnershipSnapshot>;
  sequence: number;
}

interface PeriodicFastSkipCandidate {
  generation: number;
  watchState: ProjectWatchState;
}

type PeriodicIndexDecision = "full" | "incremental" | "skip";

interface IncrementalIndexModeResolution {
  effectiveMode: "full" | "incremental";
  latestIndexEventKnown: boolean;
}

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;
interface WatchHandle {
  close(): void;
  on?: (event: "error", listener: (error: Error) => void) => unknown;
}
export type WatchFactory = (
  projectRootPath: string,
  listener: WatchListener,
) => WatchHandle;
export type ProjectDirectoryInspector = (
  projectRootPath: string,
) => Promise<{ isDirectory(): boolean } | null>;
export type GitStatusReader = (
  projectRootPath: string,
  lastIndexedCommit?: string,
) => Promise<GitStatus>;

export interface IndexStorageWorker {
  acquireLease(): void;
  /** Force-close the transport after the coordinator has drained active index work. */
  close(): Promise<void>;
  deleteFiles(projectId: string, relativePaths: string[]): Promise<void>;
  ensureSemanticIndex(projectId: string): Promise<void>;
  finalizeProjectIndex(
    projectId: string,
    finalization: FinalizeProjectIndexPayload,
  ): Promise<FinalizeProjectIndexResult>;
  prepareProjectIndex(
    projectId: string,
    project: ProjectInfo,
    timestamp: string,
  ): Promise<PrepareProjectIndexResult>;
  releaseLease(): void;
  resolveSymbolGraph(projectId: string, changedFileIds: string[]): Promise<void>;
  writeChunkVectors(
    entries: Array<{ chunkId: string; embedding: number[]; modelName: string }>,
    projectId: string,
  ): Promise<void>;
  writeFileIndexBatch(projectId: string, files: SQLiteIndexFileBatch[], indexedAt: string): Promise<void>;
}

export function createSynchronousIndexStorageWorker(
  store: Pick<
    SQLiteStore,
    | "deleteFiles"
    | "ensureSemanticIndex"
    | "finalizeProjectIndex"
    | "prepareProjectIndex"
    | "resolveSymbolGraph"
    | "writeChunkVectors"
    | "writeFileIndexBatch"
  >,
): IndexStorageWorker {
  return {
    acquireLease() {},
    async close() {},
    async deleteFiles(projectId, relativePaths) {
      store.deleteFiles(projectId, relativePaths);
    },
    async ensureSemanticIndex(projectId) {
      store.ensureSemanticIndex(projectId);
    },
    async finalizeProjectIndex(projectId, finalization) {
      return store.finalizeProjectIndex(projectId, finalization);
    },
    async prepareProjectIndex(projectId, project, timestamp) {
      return store.prepareProjectIndex(projectId, project, timestamp);
    },
    releaseLease() {},
    async resolveSymbolGraph(projectId, changedFileIds) {
      store.resolveSymbolGraph(projectId, new Set(changedFileIds));
    },
    async writeChunkVectors(entries, projectId) {
      store.writeChunkVectors(entries, projectId);
    },
    async writeFileIndexBatch(projectId, files, indexedAt) {
      store.writeFileIndexBatch(projectId, files, indexedAt);
    },
  };
}

const defaultWatchFactory: WatchFactory = (projectRootPath, listener) => {
  const watcher = watch(projectRootPath, { recursive: true }, listener);
  return {
    close: () => watcher.close(),
    on: (event, errorListener) => watcher.on(event, errorListener),
  };
};
const defaultProjectDirectoryInspector: ProjectDirectoryInspector = (projectRootPath) =>
  stat(projectRootPath).catch(() => null);

const PROJECT_CONTROL_FILES = new Set([
  ".gitignore",
  "build.gradle",
  "build.gradle.kts",
  "package.json",
  "pom.xml",
  "pyproject.toml",
  "requirements.txt",
  "settings.gradle",
  "settings.gradle.kts",
]);
const PROJECT_CONTROL_EXTENSIONS = new Set([".csproj", ".sln"]);

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
const INDEX_CLOSE_DRAIN_TIMEOUT_MS = 30_000;
const CJK_DECODE_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function scoreDecodedContent(content: string): number {
  const replacementCount = (content.match(/\uFFFD/g) ?? []).length;
  const printableCount = [...content].filter((character) => character === "\n" || character === "\r" || character === "\t" || character >= " ").length;
  const cjkCount = [...content].filter((character) => CJK_DECODE_PATTERN.test(character)).length;
  return printableCount + cjkCount * 4 - replacementCount * 10;
}

export function isValidUtf8(buffer: Buffer): boolean {
  const decoded = buffer.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(buffer);
}

export function decodeSourceBuffer(buffer: Buffer): DecodedSource {
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
  private activeIndexRuns = 0;
  private readonly activeStorageOperations = new Set<Promise<unknown>>();
  private readonly aggregateProjectRoots = new Set<string>();
  private readonly automaticProjectRoots = new Set<string>();
  private latestAutomaticRefresh?: AutomaticProjectRefresh;
  private automaticRefreshSequence = 0;
  private automaticUpdatesGeneration = 0;
  private automaticWatchAllowed = true;
  private automaticUpdatesStarted = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private closeDrainTimeoutMs = INDEX_CLOSE_DRAIN_TIMEOUT_MS;
  private readonly pendingIndexSlots: Array<() => void> = [];
  private readonly pendingAutomaticOwnershipRefreshRoots = new Set<string>();
  private readonly pausedProjectRoots = new Set<string>();
  private reconcileRequested = false;
  private reconciliationPromise?: Promise<void>;
  private reconciliationTimer?: NodeJS.Timeout;
  private readonly suppressedProjectRoots = new Set<string>();
  private readonly watchIntentRevisions = new Map<string, number>();
  private readonly watchers = new Map<string, ProjectWatchState>();

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
  private inFlightProgress = new Map<Promise<IndexProjectResult>, IndexProgressState>();
  private indexStorageWorker?: IndexStorageWorker;

  /**
   * v4.5.2: Return info about currently in-flight index operations
   */
  public getInFlightIndexInfo(): InFlightIndexInfo[] {
    const result: InFlightIndexInfo[] = [];
    const now = Date.now();
    const queuedRequestsByProject = new Map<string, number>();
    for (const progress of this.inFlightProgress.values()) {
      if (progress.runStartedAtMs === undefined) {
        queuedRequestsByProject.set(
          progress.projectRootPath,
          (queuedRequestsByProject.get(progress.projectRootPath) ?? 0) + 1,
        );
      }
    }
    for (const progress of this.inFlightProgress.values()) {
      result.push({
        current: progress.current,
        dedupedRequests: progress.dedupedRequests,
        projectRootPath: progress.projectRootPath,
        elapsedMs: Math.max(0, now - progress.requestedAtMs),
        lastProgressAt: new Date(progress.lastProgressAtMs).toISOString(),
        origin: progress.origin,
        phase: progress.phase,
        phaseElapsedMs: Math.max(0, now - progress.phaseStartedAtMs),
        queueMs: Math.max(0, (progress.runStartedAtMs ?? now) - progress.requestedAtMs),
        queuedRequests: queuedRequestsByProject.get(progress.projectRootPath) ?? 0,
        status: "running",
        total: progress.total,
      });
    }
    return result;
  }

  private reportIndexProgress(
    progress: IndexProgressState,
    event: IndexProgressEvent,
    onProgress?: IndexProgressCallback,
  ): void {
    const now = Date.now();
    if (event.status === "start" || progress.phase !== event.phase) {
      progress.phase = event.phase;
      progress.phaseStartedAtMs = now;
      progress.current = event.current ?? 0;
      progress.total = event.total ?? 0;
    } else {
      if (event.current !== undefined) {
        progress.current = event.current;
      } else if (event.status === "done" && progress.total > 0) {
        progress.current = progress.total;
      }
      if (event.total !== undefined) {
        progress.total = event.total;
      }
    }
    progress.lastProgressAtMs = now;
    onProgress?.(event);
  }

  public constructor(
    private readonly settings: Settings,
    private readonly store: SQLiteStore,
    private readonly logger: Logger,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly watchFactory: WatchFactory = defaultWatchFactory,
    private readonly projectDirectoryInspector: ProjectDirectoryInspector = defaultProjectDirectoryInspector,
    private readonly gitStatusReader: GitStatusReader = getGitChangedFiles,
    indexStorageWorker?: IndexStorageWorker,
  ) {
    this.indexStorageWorker = indexStorageWorker;
  }

  private getIndexStorageWorker(): IndexStorageWorker {
    this.indexStorageWorker ??= new SQLiteIndexWorkerClient(
      {
        databasePath: this.settings.databasePath,
        logFilePath: this.settings.logFilePath,
        logLevel: this.settings.logLevel,
      },
      this.logger,
    );
    return this.indexStorageWorker;
  }

  public isWatching(projectRootPath?: string): boolean {
    if (projectRootPath === undefined) {
      return [...this.watchers.values()].some((state) => state.active);
    }
    return this.watchers.get(normalizeAbsolutePath(projectRootPath))?.active ?? false;
  }

  public getWatchStatuses(): ProjectWatchStatus[] {
    return [...this.watchers.entries()]
      .map(([projectRootPath, state]) => ({
        dirty: state.dirty,
        failureCount: state.failureCount,
        generation: state.generation,
        lastError: state.lastError ?? null,
        lastEventAt: state.lastEventAt ?? null,
        lastSuccessAt: state.lastSuccessAt ?? null,
        projectRootPath,
        watching: state.active,
      }))
      .sort((left, right) => left.projectRootPath.localeCompare(right.projectRootPath));
  }

  private isAutomaticUpdateGenerationCurrent(generation: number): boolean {
    return this.automaticUpdatesStarted && this.automaticUpdatesGeneration === generation;
  }

  private isAutomaticallyOwned(projectRootPath: string): boolean {
    return (
      this.automaticProjectRoots.has(projectRootPath) &&
      !this.pausedProjectRoots.has(projectRootPath) &&
      !this.suppressedProjectRoots.has(projectRootPath)
    );
  }

  private getWatchIntentRevision(projectRootPath: string): number {
    return this.watchIntentRevisions.get(projectRootPath) ?? 0;
  }

  private advanceWatchIntentRevision(projectRootPath: string): void {
    this.watchIntentRevisions.set(projectRootPath, this.getWatchIntentRevision(projectRootPath) + 1);
  }

  private refreshAutomaticProjectRoots(generation: number): Promise<AutomaticProjectOwnershipSnapshot> {
    if (!this.isAutomaticUpdateGenerationCurrent(generation)) {
      return Promise.resolve({ applied: false, generation, projectRootPaths: [], sequence: this.automaticRefreshSequence });
    }

    const refreshSequence = ++this.automaticRefreshSequence;
    const promise = this.applyAutomaticProjectRefresh(generation, refreshSequence);
    this.latestAutomaticRefresh = { generation, promise, sequence: refreshSequence };
    return this.waitForLatestAutomaticProjectRefresh(generation, refreshSequence, promise);
  }

  private async applyAutomaticProjectRefresh(
    generation: number,
    refreshSequence: number,
  ): Promise<AutomaticProjectOwnershipSnapshot> {
    const registeredRoots = [...new Set(
      this.store.listProjects().map((project) => normalizeAbsolutePath(project.projectRootPath)),
    )];
    const aggregateRoots = findAggregateProjectRoots(registeredRoots);
    const candidates = registeredRoots.filter(
      (projectRootPath) =>
        !aggregateRoots.has(projectRootPath) &&
        !this.pausedProjectRoots.has(projectRootPath) &&
        !this.suppressedProjectRoots.has(projectRootPath),
    );
    const inspections = await Promise.all(
      candidates.map(async (projectRootPath) => ({
        projectRootPath,
        stats: await this.projectDirectoryInspector(projectRootPath),
      })),
    );

    if (
      !this.isAutomaticUpdateGenerationCurrent(generation) ||
      refreshSequence !== this.automaticRefreshSequence
    ) {
      return { applied: false, generation, projectRootPaths: [], sequence: refreshSequence };
    }

    const nextAutomaticRoots = new Set<string>();
    for (const inspection of inspections) {
      if (
        inspection.stats?.isDirectory() &&
        !this.pausedProjectRoots.has(inspection.projectRootPath) &&
        !this.suppressedProjectRoots.has(inspection.projectRootPath)
      ) {
        nextAutomaticRoots.add(inspection.projectRootPath);
      } else if (!inspection.stats?.isDirectory()) {
        this.logger.warn("automatic index watch skipped", {
          projectRootPath: inspection.projectRootPath,
          reason: "project root is missing",
        });
      }
    }

    this.aggregateProjectRoots.clear();
    for (const projectRootPath of aggregateRoots) {
      this.aggregateProjectRoots.add(projectRootPath);
    }

    for (const projectRootPath of [...this.automaticProjectRoots]) {
      if (nextAutomaticRoots.has(projectRootPath)) {
        continue;
      }
      this.automaticProjectRoots.delete(projectRootPath);
      this.closeWatcher(projectRootPath);
    }

    for (const projectRootPath of nextAutomaticRoots) {
      this.automaticProjectRoots.add(projectRootPath);
      if (!this.isWatching(projectRootPath)) {
        this.startWatchingSafely(projectRootPath, "startup");
      }
    }
    this.pendingAutomaticOwnershipRefreshRoots.clear();

    return {
      applied: true,
      generation,
      projectRootPaths: [...this.automaticProjectRoots].sort(),
      sequence: refreshSequence,
    };
  }

  private async waitForLatestAutomaticProjectRefresh(
    generation: number,
    initialSequence: number,
    initialPromise: Promise<AutomaticProjectOwnershipSnapshot>,
  ): Promise<AutomaticProjectOwnershipSnapshot> {
    let observedSequence = initialSequence;
    let snapshot = await initialPromise;
    while (this.isAutomaticUpdateGenerationCurrent(generation)) {
      const latestRefresh = this.latestAutomaticRefresh;
      if (
        !latestRefresh ||
        latestRefresh.generation !== generation ||
        latestRefresh.sequence <= observedSequence
      ) {
        return snapshot;
      }
      observedSequence = latestRefresh.sequence;
      snapshot = await latestRefresh.promise;
    }
    return { applied: false, generation, projectRootPaths: [], sequence: observedSequence };
  }

  private restoreAutomaticProjectAfterExplicitIndex(projectRootPath: string): void {
    if (
      !this.automaticUpdatesStarted ||
      !this.automaticWatchAllowed ||
      this.aggregateProjectRoots.has(projectRootPath) ||
      this.pausedProjectRoots.has(projectRootPath) ||
      this.suppressedProjectRoots.has(projectRootPath)
    ) {
      return;
    }
    this.automaticProjectRoots.add(projectRootPath);
    if (!this.isWatching(projectRootPath)) {
      this.startWatchingSafely(projectRootPath, "index");
    }
  }

  private async refreshPendingAutomaticProjectOwnership(reason = "index"): Promise<void> {
    if (!this.automaticUpdatesStarted) {
      return;
    }
    try {
      await this.refreshAutomaticProjectRoots(this.automaticUpdatesGeneration);
    } catch (error) {
      this.logger.warn("automatic project refresh failed", {
        error: error instanceof Error ? error.message : String(error),
        reason,
      });
    }
  }

  public async refreshAutomaticProjectOwnership(projectRootPath: string): Promise<void> {
    if (!this.automaticUpdatesStarted) {
      return;
    }
    this.pendingAutomaticOwnershipRefreshRoots.add(normalizeAbsolutePath(projectRootPath));
    await this.refreshPendingAutomaticProjectOwnership("topology");
  }

  private async readGitStatus(
    projectRootPath: string,
    lastIndexedCommit?: string,
  ): Promise<GitStatus> {
    try {
      return await this.gitStatusReader(projectRootPath, lastIndexedCommit);
    } catch (error) {
      this.logger.warn("git status read failed", {
        error: error instanceof Error ? error.message : String(error),
        projectRootPath,
      });
      return { isGitRepo: false, reliable: false };
    }
  }

  private isPeriodicFastSkipState(projectRootPath: string, state: ProjectWatchState | undefined): boolean {
    return Boolean(
      state?.active &&
      !state.dirty &&
      state.failureCount === 0 &&
      !state.processing &&
      !this.inFlightIndex.has(projectRootPath) &&
      this.automaticProjectRoots.has(projectRootPath) &&
      !this.pausedProjectRoots.has(projectRootPath) &&
      !this.suppressedProjectRoots.has(projectRootPath),
    );
  }

  private capturePeriodicFastSkipCandidates(): Map<string, PeriodicFastSkipCandidate> {
    const candidates = new Map<string, PeriodicFastSkipCandidate>();
    for (const projectRootPath of this.automaticProjectRoots) {
      const watchState = this.watchers.get(projectRootPath);
      if (watchState && this.isPeriodicFastSkipState(projectRootPath, watchState)) {
        candidates.set(projectRootPath, { generation: watchState.generation, watchState });
      }
    }
    return candidates;
  }

  private resolveIncrementalIndexMode(projectRootPath: string): IncrementalIndexModeResolution {
    const projectId = buildStableId([projectRootPath]);
    try {
      const persistedProject = this.store.getProjectByRoot(projectRootPath);
      if (persistedProject && persistedProject.status !== "ready") {
        return { effectiveMode: "full", latestIndexEventKnown: true };
      }
    } catch {
      // Fake stores and legacy databases may not expose project status; retain the event fallback.
    }
    try {
      const latestIndexEventHasFailures = this.store.latestIndexEventHasFailures(projectId);
      return {
        effectiveMode: latestIndexEventHasFailures ? "full" : "incremental",
        latestIndexEventKnown: latestIndexEventHasFailures !== null,
      };
    } catch {
      return { effectiveMode: "incremental", latestIndexEventKnown: false };
    }
  }

  private async getPeriodicIndexDecision(
    projectRootPath: string,
    candidate: PeriodicFastSkipCandidate | undefined,
  ): Promise<PeriodicIndexDecision> {
    const watchState = this.watchers.get(projectRootPath);
    if (
      !candidate ||
      watchState !== candidate.watchState ||
      watchState.generation !== candidate.generation ||
      !this.isPeriodicFastSkipState(projectRootPath, watchState)
    ) {
      return "incremental";
    }
    const modeResolution = this.resolveIncrementalIndexMode(projectRootPath);
    if (modeResolution.effectiveMode === "full") {
      return "full";
    }
    if (!modeResolution.latestIndexEventKnown) {
      return "incremental";
    }

    const projectId = buildStableId([projectRootPath]);
    let lastIndexedCommit: string | null;
    try {
      lastIndexedCommit = this.store.getLastIndexedCommit(projectId);
    } catch {
      return "incremental";
    }
    if (!lastIndexedCommit) {
      return "incremental";
    }

    const gitStatus = await this.readGitStatus(projectRootPath, lastIndexedCommit);
    const currentWatchState = this.watchers.get(projectRootPath);
    if (
      currentWatchState !== watchState ||
      currentWatchState?.generation !== candidate.generation ||
      !this.isPeriodicFastSkipState(projectRootPath, currentWatchState)
    ) {
      return "incremental";
    }

    return (
      gitStatus.isGitRepo &&
      gitStatus.reliable &&
      gitStatus.currentCommit &&
      gitStatus.changedFiles?.length === 0 &&
      gitStatus.untrackedFiles?.length === 0
    ) ? "skip" : "incremental";
  }

  public async startAutomaticUpdates(): Promise<void> {
    if (this.closing) {
      throw new AppError(
        "INDEX_COORDINATOR_CLOSED",
        "Index coordinator is closing and cannot start automatic updates",
        { retryable: false, statusCode: 503 },
      );
    }
    if (!this.settings.autoWatch || this.automaticUpdatesStarted) {
      return;
    }

    this.automaticWatchAllowed = true;
    this.automaticUpdatesStarted = true;
    const generation = ++this.automaticUpdatesGeneration;
    try {
      await this.refreshAutomaticProjectRoots(generation);
    } catch (error) {
      if (this.automaticUpdatesGeneration === generation) {
        this.automaticWatchAllowed = false;
        this.automaticUpdatesStarted = false;
      }
      throw error;
    }
    if (!this.isAutomaticUpdateGenerationCurrent(generation)) {
      return;
    }

    void this.reconcileWatchedProjects("startup");

    const reconcileMs = Math.max(0, this.settings.watchReconcileSeconds ?? 600) * 1000;
    if (reconcileMs > 0) {
      this.reconciliationTimer = setInterval(() => {
        void this.reconcileWatchedProjects("periodic");
      }, reconcileMs);
      this.reconciliationTimer.unref();
    }
  }

  public stopAutomaticUpdates(): void {
    this.automaticWatchAllowed = false;
    this.automaticUpdatesStarted = false;
    this.automaticUpdatesGeneration += 1;
    this.automaticRefreshSequence += 1;
    this.latestAutomaticRefresh = undefined;
    this.reconcileRequested = false;
    this.reconciliationPromise = undefined;
    clearInterval(this.reconciliationTimer);
    this.reconciliationTimer = undefined;
    for (const projectRootPath of [...this.watchers.keys()]) {
      this.closeWatcher(projectRootPath);
    }
    this.automaticProjectRoots.clear();
    this.aggregateProjectRoots.clear();
  }

  public close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closing = true;
    this.stopAutomaticUpdates();
    this.closePromise = (async () => {
      const drained = await this.drainIndexWork(this.closeDrainTimeoutMs);
      if (!drained) {
        this.logger.warn("index drain timed out during shutdown", {
          activeStorageOperations: this.activeStorageOperations.size,
          inFlightProjects: this.inFlightIndex.size,
          queuedProjects: this.projectQueue.size,
          reason: "drain-timeout",
          timeoutMs: this.closeDrainTimeoutMs,
        });
      }
      await this.indexStorageWorker?.close();
    })();
    return this.closePromise;
  }

  private async drainIndexWork(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (
      this.activeStorageOperations.size > 0 ||
      this.inFlightIndex.size > 0 ||
      this.projectQueue.size > 0
    ) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return false;
      }
      const active = new Set<Promise<unknown>>([
        ...this.activeStorageOperations,
        ...this.inFlightIndex.values(),
        ...this.projectQueue.values(),
      ]);
      try {
        await this.withTimeout(
          Promise.allSettled(active),
          remainingMs,
          "index drain timeout",
        );
      } catch {
        return false;
      }
    }
    return true;
  }

  public ensureSemanticIndex(projectId: string): Promise<void> {
    if (this.closing) {
      return Promise.reject(new AppError(
        "INDEX_COORDINATOR_CLOSED",
        "Index coordinator is closing and cannot accept semantic warmup requests",
        { retryable: false, statusCode: 503 },
      ));
    }
    const worker = this.getIndexStorageWorker();
    worker.acquireLease();
    const operation = (async () => {
      try {
        await worker.ensureSemanticIndex(projectId);
      } finally {
        worker.releaseLease();
      }
    })();
    this.activeStorageOperations.add(operation);
    void operation.finally(() => {
      this.activeStorageOperations.delete(operation);
    }).catch(() => {});
    return operation;
  }

  public reconcileWatchedProjects(reason = "manual"): Promise<void> {
    if (this.reconciliationPromise) {
      if (reason === "manual") {
        this.reconcileRequested = true;
      }
      return this.reconciliationPromise;
    }

    const generation = this.automaticUpdatesGeneration;
    const run = async (): Promise<void> => {
      do {
        this.reconcileRequested = false;
        let refreshedSnapshot: AutomaticProjectOwnershipSnapshot | undefined;
        let periodicFastSkipCandidates: Map<string, PeriodicFastSkipCandidate> | undefined;
        if (reason === "periodic") {
          periodicFastSkipCandidates = this.capturePeriodicFastSkipCandidates();
          try {
            refreshedSnapshot = await this.refreshAutomaticProjectRoots(generation);
          } catch (error) {
            this.logger.warn("automatic project refresh failed", {
              error: error instanceof Error ? error.message : String(error),
              reason,
            });
            return;
          }
        }
        if (
          reason !== "manual" &&
          (!this.isAutomaticUpdateGenerationCurrent(generation) || refreshedSnapshot?.applied === false)
        ) {
          return;
        }
        const projectRoots = reason === "manual"
          ? this.getWatchStatuses().map((status) => status.projectRootPath)
          : refreshedSnapshot?.projectRootPaths ?? [...this.automaticProjectRoots].sort();
        for (const projectRootPath of projectRoots) {
          if (reason !== "manual" && !this.isAutomaticUpdateGenerationCurrent(generation)) {
            return;
          }
          if (
            reason !== "manual" &&
            !this.isAutomaticallyOwned(projectRootPath)
          ) {
            continue;
          }
          try {
            const periodicDecision = reason === "periodic"
              ? await this.getPeriodicIndexDecision(
                projectRootPath,
                periodicFastSkipCandidates?.get(projectRootPath),
              )
              : "incremental";
            if (reason !== "manual" && !this.isAutomaticUpdateGenerationCurrent(generation)) {
              return;
            }
            if (reason !== "manual" && !this.isAutomaticallyOwned(projectRootPath)) {
              continue;
            }
            if (periodicDecision === "skip") {
              this.logger.debug("periodic index skipped for clean Git project", { projectRootPath });
              continue;
            }
            await this.indexProject(projectRootPath, periodicDecision, undefined, "automatic");
          } catch (error) {
            const state = this.watchers.get(projectRootPath);
            const message = error instanceof Error ? error.message : String(error);
            if (state) {
              state.dirty = true;
              state.failureCount += 1;
              state.lastError = message;
              this.watcherDirty.set(projectRootPath, true);
            }
            this.logger.warn("automatic index reconciliation failed", {
              error: message,
              projectRootPath,
              reason,
            });
          }
        }
      } while (
        this.reconcileRequested &&
        (reason === "manual" || this.isAutomaticUpdateGenerationCurrent(generation))
      );
    };

    const promise = run().finally(() => {
      if (this.reconciliationPromise === promise) {
        this.reconciliationPromise = undefined;
      }
    });
    this.reconciliationPromise = promise;
    return promise;
  }

  public async withProjectIndexPaused<T>(
    projectRootPath: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const normalizedRoot = normalizeAbsolutePath(projectRootPath);
    const wasAutomatic = this.automaticProjectRoots.has(normalizedRoot);
    const wasSuppressed = this.suppressedProjectRoots.has(normalizedRoot);
    const wasWatching = this.isWatching(normalizedRoot);
    const automaticUpdatesGeneration = this.automaticUpdatesGeneration;
    const automaticRefreshSequence = this.automaticRefreshSequence;
    const watchIntentRevision = this.getWatchIntentRevision(normalizedRoot);
    let completed = false;
    this.pausedProjectRoots.add(normalizedRoot);
    this.automaticProjectRoots.delete(normalizedRoot);
    this.closeWatcher(normalizedRoot);

    try {
      while (true) {
        const queueTail = this.projectQueue.get(normalizedRoot);
        if (!queueTail) {
          break;
        }
        await this.withTimeout(
          queueTail,
          60_000,
          "timed out waiting for project indexing to stop",
        );
      }
      const result = await operation();
      completed = true;
      return result;
    } finally {
      this.pausedProjectRoots.delete(normalizedRoot);
      if (!completed) {
        const canRestorePreviousState =
          this.automaticUpdatesGeneration === automaticUpdatesGeneration &&
          this.automaticRefreshSequence === automaticRefreshSequence &&
          this.getWatchIntentRevision(normalizedRoot) === watchIntentRevision;
        if (canRestorePreviousState) {
          if (!wasSuppressed) {
            this.suppressedProjectRoots.delete(normalizedRoot);
          }
          if (wasAutomatic) {
            this.automaticProjectRoots.add(normalizedRoot);
          }
          if (wasWatching) {
            this.startWatching(normalizedRoot, true);
          }
        } else if (this.automaticUpdatesStarted) {
          try {
            await this.refreshAutomaticProjectRoots(this.automaticUpdatesGeneration);
          } catch (error) {
            this.logger.warn("automatic project refresh failed", {
              error: error instanceof Error ? error.message : String(error),
              reason: "pause",
            });
          }
        }
      }
    }
  }

  /**
   * v4.6.4: Pre-populate in-memory freshness tracking from database records.
   * On restart, lastIndexedAtMs is empty, causing ensureFreshIndex("stale")
   * to always trigger a full incremental scan even when the DB is current.
   * This method sets the maps so the staleness check passes and the scan is skipped.
   */
  public restoreFreshnessState(
    projectRootPath: string,
    indexResult: IndexProjectResult,
  ): void {
    const normalizedRoot = normalizeAbsolutePath(projectRootPath);
    if (indexResult.failedFileCount > 0 || indexResult.failedFiles.length > 0) {
      this.lastIndexedAtMs.delete(normalizedRoot);
      this.lastIndexResult.delete(normalizedRoot);
      this.watcherDirty.set(normalizedRoot, true);
      const watchState = this.watchers.get(normalizedRoot);
      if (watchState) {
        watchState.dirty = true;
      }
      return;
    }
    this.lastIndexedAtMs.set(normalizedRoot, performance.now());
    this.watcherDirty.set(normalizedRoot, false);
    this.lastIndexResult.set(normalizedRoot, indexResult);
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
      const result = await this.withTimeout(this.indexProject(normalizedRoot, mode), timeoutMs, `index timeout after ${timeoutMs}ms`);
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

  public startWatching(projectRootPath: string, automatic = false): void {
    if (this.closing) {
      throw new AppError(
        "INDEX_COORDINATOR_CLOSED",
        "Index coordinator is closing and cannot start file watchers",
        { retryable: false, statusCode: 503 },
      );
    }
    const normalizedRoot = normalizeAbsolutePath(projectRootPath);
    if (this.pausedProjectRoots.has(normalizedRoot)) {
      throw new AppError(
        "PROJECT_INDEX_PAUSED",
        `Project indexing is temporarily paused: ${normalizedRoot}`,
        { retryable: true, statusCode: 409 },
      );
    }
    if (automatic && this.suppressedProjectRoots.has(normalizedRoot)) {
      return;
    }
    if (!automatic) {
      this.advanceWatchIntentRevision(normalizedRoot);
      this.suppressedProjectRoots.delete(normalizedRoot);
    }
    const existingState = this.watchers.get(normalizedRoot);
    if (existingState?.active) {
      this.logger.warn("file watch already active", { projectRootPath });
      return;
    }
    if (existingState) {
      this.clearWatchTimers(existingState);
      this.watchers.delete(normalizedRoot);
    }

    const abortController = new AbortController();
    const state: ProjectWatchState = {
      active: true,
      abortController,
      dirty: false,
      failureCount: 0,
      generation: 0,
      processing: false,
      rerunRequested: false,
    };

    const watcher = this.watchFactory(normalizedRoot, (_event, _filename) => {
      if (abortController.signal.aborted) {
        return;
      }
      if (!this.shouldProcessWatchEvent(_event, _filename)) {
        return;
      }

      // Mark project dirty so ensureFreshIndex knows the cache is stale
      state.dirty = true;
      state.generation += 1;
      state.lastEventAt = new Date().toISOString();
      this.watcherDirty.set(normalizedRoot, true);
      this.scheduleWatchedIndex(normalizedRoot, state);
    });

    abortController.signal.addEventListener("abort", () => watcher.close());
    state.watcher = watcher;
    this.watchers.set(normalizedRoot, state);
    watcher.on?.("error", (error) => {
      if (abortController.signal.aborted || this.watchers.get(normalizedRoot) !== state) {
        return;
      }
      state.active = false;
      state.dirty = true;
      state.failureCount += 1;
      state.generation += 1;
      state.lastError = error.message;
      this.watcherDirty.set(normalizedRoot, true);
      this.logger.warn("file watch failed", {
        error: error.message,
        projectRootPath: normalizedRoot,
      });
      this.clearWatchTimers(state);
      state.abortController.abort();
      void this.recoverFailedWatcher(normalizedRoot, state);
    });
    if (this.automaticUpdatesStarted && !this.aggregateProjectRoots.has(normalizedRoot)) {
      this.automaticProjectRoots.add(normalizedRoot);
    }
    this.logger.info("file watch started", { projectRootPath: normalizedRoot });
  }

  private shouldProcessWatchEvent(eventType: string, filename: string | Buffer | null): boolean {
    if (filename === null) {
      return true;
    }

    const relativePath = String(filename).replaceAll("\\", "/").replace(/^\.\/+/, "");
    if (!relativePath) {
      return true;
    }
    if (
      relativePath === ".git/HEAD" ||
      relativePath === ".git/index" ||
      relativePath.startsWith(".git/refs/")
    ) {
      return true;
    }

    const simpleExcludedDirectories = new Set(
      (this.settings.excludePatterns ?? []).filter((pattern) => !/[!*?[\]\\/]/.test(pattern)),
    );
    const pathSegments = relativePath.split("/");
    if (pathSegments.some((segment) => simpleExcludedDirectories.has(segment))) {
      return false;
    }

    if (eventType === "rename") {
      return true;
    }

    const basename = path.posix.basename(relativePath).toLowerCase();
    const extension = path.posix.extname(basename);
    if (!extension || PROJECT_CONTROL_FILES.has(basename) || PROJECT_CONTROL_EXTENSIONS.has(extension)) {
      return true;
    }
    return (
      !this.settings.textExtensions ||
      this.settings.textExtensions.some((candidate) => candidate.toLowerCase() === extension)
    );
  }

  private startWatchingSafely(projectRootPath: string, reason: "index" | "recovery" | "startup"): void {
    try {
      this.startWatching(projectRootPath, true);
    } catch (error) {
      this.logger.warn("automatic index watch failed", {
        error: error instanceof Error ? error.message : String(error),
        projectRootPath,
        reason,
      });
    }
  }

  private async recoverFailedWatcher(projectRootPath: string, state: ProjectWatchState): Promise<void> {
    const queueTail = this.projectQueue.get(projectRootPath);
    if (queueTail) {
      await queueTail;
    }
    if (
      this.watchers.get(projectRootPath) !== state ||
      this.pausedProjectRoots.has(projectRootPath) ||
      this.suppressedProjectRoots.has(projectRootPath) ||
      !this.automaticWatchAllowed
    ) {
      return;
    }

    try {
      await this.indexProject(projectRootPath, "incremental", undefined, "automatic");
      if (this.watchers.get(projectRootPath) === state && !state.active) {
        this.startWatchingSafely(projectRootPath, "recovery");
      }
    } catch (error) {
      state.failureCount += 1;
      state.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn("file watch recovery failed", {
        error: state.lastError,
        projectRootPath,
      });
    }
  }

  private closeWatcher(projectRootPath: string): void {
    const state = this.watchers.get(projectRootPath);
    if (!state) {
      return;
    }
    this.clearWatchTimers(state);
    state.abortController.abort();
    this.watchers.delete(projectRootPath);
    this.logger.info("file watch stopped", { projectRootPath });
  }

  public stopWatching(projectRootPath?: string): void {
    const roots = projectRootPath === undefined
      ? [...new Set([...this.watchers.keys(), ...this.automaticProjectRoots, ...this.pausedProjectRoots])]
      : [normalizeAbsolutePath(projectRootPath)];

    for (const root of roots) {
      this.advanceWatchIntentRevision(root);
      this.suppressedProjectRoots.add(root);
      this.automaticProjectRoots.delete(root);
      this.closeWatcher(root);
    }
  }

  private scheduleWatchedIndex(
    projectRootPath: string,
    state: ProjectWatchState,
    delayMs = Math.max(0, this.settings.watchDebounceMs ?? 2500),
  ): void {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = undefined;
      this.triggerWatchedIndex(projectRootPath, state);
    }, delayMs);

    if (!state.maxWaitTimer) {
      const maxWaitMs = Math.max(delayMs, this.settings.watchMaxWaitMs ?? 10_000);
      state.maxWaitTimer = setTimeout(() => {
        state.maxWaitTimer = undefined;
        clearTimeout(state.debounceTimer);
        state.debounceTimer = undefined;
        this.triggerWatchedIndex(projectRootPath, state);
      }, maxWaitMs);
    }
  }

  private triggerWatchedIndex(projectRootPath: string, state: ProjectWatchState): void {
    if (state.abortController.signal.aborted || this.watchers.get(projectRootPath) !== state) {
      return;
    }

    clearTimeout(state.maxWaitTimer);
    state.maxWaitTimer = undefined;
    if (state.processing) {
      state.rerunRequested = true;
      return;
    }

    state.processing = true;
    void this.processWatchedChanges(projectRootPath, state);
  }

  private async processWatchedChanges(projectRootPath: string, state: ProjectWatchState): Promise<void> {
    try {
      while (!state.abortController.signal.aborted && this.watchers.get(projectRootPath) === state && state.dirty) {
        state.rerunRequested = false;

        const existingIndex = this.inFlightIndex.get(projectRootPath);
        if (existingIndex) {
          await existingIndex.catch(() => undefined);
        }
        if (state.abortController.signal.aborted || this.watchers.get(projectRootPath) !== state) {
          return;
        }

        const generation = state.generation;
        try {
          await this.indexProject(projectRootPath, "incremental", undefined, "automatic");
          state.failureCount = 0;
          state.lastError = undefined;
          state.lastSuccessAt = new Date().toISOString();
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          state.failureCount += 1;
          state.lastError = message;
          this.logger.warn("watch-triggered index failed", {
            error: message,
            projectRootPath,
          });
          this.scheduleWatchRetry(projectRootPath, state);
          return;
        }

        if (state.generation === generation && !state.rerunRequested) {
          state.dirty = false;
          this.watcherDirty.set(projectRootPath, false);
        } else {
          state.dirty = true;
          this.watcherDirty.set(projectRootPath, true);
          clearTimeout(state.debounceTimer);
          state.debounceTimer = undefined;
          clearTimeout(state.maxWaitTimer);
          state.maxWaitTimer = undefined;
        }
      }
    } finally {
      state.processing = false;
      if (
        state.dirty &&
        !state.retryTimer &&
        !state.abortController.signal.aborted &&
        this.watchers.get(projectRootPath) === state
      ) {
        this.scheduleWatchedIndex(projectRootPath, state, 0);
      }
    }
  }

  private scheduleWatchRetry(projectRootPath: string, state: ProjectWatchState): void {
    if (state.retryTimer || state.abortController.signal.aborted) {
      return;
    }
    const retryDelayMs = Math.min(60_000, 1_000 * 2 ** Math.min(state.failureCount - 1, 6));
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      this.triggerWatchedIndex(projectRootPath, state);
    }, retryDelayMs);
  }

  private clearWatchTimers(state: ProjectWatchState): void {
    clearTimeout(state.debounceTimer);
    clearTimeout(state.maxWaitTimer);
    clearTimeout(state.retryTimer);
    state.debounceTimer = undefined;
    state.maxWaitTimer = undefined;
    state.retryTimer = undefined;
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
    origin: IndexOrigin = "explicit",
  ): Promise<IndexProjectResult> {
    if (this.closing) {
      throw new AppError(
        "INDEX_COORDINATOR_CLOSED",
        "Index coordinator is closing and cannot accept new index requests",
        { retryable: false, statusCode: 503 },
      );
    }
    const normalizedRoot = normalizeAbsolutePath(projectRootPath);
    if (this.pausedProjectRoots.has(normalizedRoot)) {
      throw new AppError(
        "PROJECT_INDEX_PAUSED",
        `Project indexing is temporarily paused: ${normalizedRoot}`,
        { retryable: true, statusCode: 409 },
      );
    }
    if (origin === "explicit") {
      this.suppressedProjectRoots.delete(normalizedRoot);
    } else if (this.suppressedProjectRoots.has(normalizedRoot)) {
      throw new AppError(
        "PROJECT_INDEX_SUPPRESSED",
        `Automatic project indexing is stopped: ${normalizedRoot}`,
        { retryable: false, statusCode: 409 },
      );
    }

    // Check if there's already an in-flight index for this project
    // Note: If onProgress is provided, we still need to run a new index to provide progress
    // But we'll wait for the in-flight one to complete first
    const inFlight = this.inFlightIndex.get(normalizedRoot);
    if (inFlight && !onProgress) {
      const inFlightProgress = this.inFlightProgress.get(inFlight);
      const inFlightOrigin = inFlightProgress?.origin;
      if (inFlightProgress) {
        inFlightProgress.dedupedRequests += 1;
      }
      this.logger.debug("reusing in-flight index", { projectRootPath: normalizedRoot, mode });
      // v4.3.9: Add timeout when reusing in-flight promise to avoid blocking forever
      try {
        const result = await this.withTimeout(inFlight, 60_000, "in-flight index reuse timeout");
        if (origin === "explicit" && inFlightOrigin === "automatic") {
          if (this.pendingAutomaticOwnershipRefreshRoots.size > 0) {
            await this.refreshPendingAutomaticProjectOwnership();
          } else {
            this.restoreAutomaticProjectAfterExplicitIndex(normalizedRoot);
          }
        }
        return result;
      } catch {
        // Stuck in-flight promise — clear it and start fresh
        this.logger.warn("in-flight index stuck, clearing and restarting", { projectRootPath: normalizedRoot });
        if (this.inFlightIndex.get(normalizedRoot) === inFlight) {
          this.inFlightIndex.delete(normalizedRoot);
        }
      }
    }

    // Queue behind any previous request
    const prev = this.projectQueue.get(normalizedRoot) ?? Promise.resolve();
    const requestedAtMs = Date.now();
    const progress: IndexProgressState = {
      current: 0,
      dedupedRequests: 0,
      lastProgressAtMs: requestedAtMs,
      origin,
      phase: "queued",
      phaseStartedAtMs: requestedAtMs,
      projectRootPath: normalizedRoot,
      requestedAtMs,
      total: 0,
    };
    const indexPromise = prev.then(() =>
      this.withGlobalIndexSlot(() => {
        progress.runStartedAtMs = Date.now();
        return this.runIndexProject(normalizedRoot, mode, onProgress, origin, progress);
      }),
    );

    // Track both queue and in-flight state
    const queuePromise = indexPromise.catch((err) => {
          this.logger.warn("queued index failed", { projectRootPath, error: err instanceof Error ? err.message : String(err) });
        }); // Swallow errors in queue chain
    this.projectQueue.set(normalizedRoot, queuePromise);
    this.inFlightIndex.set(normalizedRoot, indexPromise);
    this.inFlightProgress.set(indexPromise, progress);

    // Clean up when done
    void indexPromise.finally(() => {
      if (this.inFlightIndex.get(normalizedRoot) === indexPromise) {
        this.inFlightIndex.delete(normalizedRoot);
      }
      this.inFlightProgress.delete(indexPromise);
      // Only delete from queue if this is still the latest promise
      if (this.projectQueue.get(normalizedRoot) === queuePromise) {
        this.projectQueue.delete(normalizedRoot);
      }
    }).catch(() => {});

    return indexPromise;
  }

  private async withGlobalIndexSlot<T>(operation: () => Promise<T>): Promise<T> {
    const concurrency = Math.max(1, Math.floor(this.settings.indexConcurrency ?? 1));
    if (this.activeIndexRuns >= concurrency) {
      await new Promise<void>((resolve) => {
        this.pendingIndexSlots.push(resolve);
      });
    } else {
      this.activeIndexRuns += 1;
    }

    try {
      return await operation();
    } finally {
      const next = this.pendingIndexSlots.shift();
      if (next) {
        next();
      } else {
        this.activeIndexRuns -= 1;
      }
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
    origin: IndexOrigin = "explicit",
    progress: IndexProgressState = {
      current: 0,
      dedupedRequests: 0,
      lastProgressAtMs: Date.now(),
      origin,
      phase: "prepare",
      phaseStartedAtMs: Date.now(),
      projectRootPath: normalizedRoot,
      requestedAtMs: Date.now(),
      runStartedAtMs: Date.now(),
      total: 0,
    },
  ): Promise<IndexProjectResult> {
    const indexStorageWorker = this.getIndexStorageWorker();
    indexStorageWorker.acquireLease();
    try {
      return await this.runLeasedIndexProject(
        normalizedRoot,
        mode,
        onProgress,
        origin,
        progress,
        indexStorageWorker,
      );
    } finally {
      indexStorageWorker.releaseLease();
    }
  }

  private async runLeasedIndexProject(
    normalizedRoot: string,
    mode: "full" | "incremental",
    onProgress: IndexProgressCallback | undefined,
    origin: IndexOrigin,
    progress: IndexProgressState,
    indexStorageWorker: IndexStorageWorker,
  ): Promise<IndexProjectResult> {
    const startedAtMs = performance.now();
    const totalStartedAtEpochMs = Date.now();
    const preflightStartedAtMs = performance.now();
    this.reportIndexProgress(progress, { phase: "prepare", status: "start" }, onProgress);
    const watchStateAtStart = this.watchers.get(normalizedRoot);
    const watchGenerationAtStart = watchStateAtStart?.generation;
    const rootStats = await stat(normalizedRoot).catch(() => null);
    if (!rootStats?.isDirectory()) {
      throw new AppError("INVALID_PROJECT_ROOT", `Project root does not exist or is not a directory: ${normalizedRoot}`);
    }

    const projectId = buildStableId([normalizedRoot]);
    if (mode === "incremental") {
      mode = this.resolveIncrementalIndexMode(normalizedRoot).effectiveMode;
    }
    const wasRegisteredBeforeIndex = origin !== "explicit" || this.store.getProjectByRoot(normalizedRoot) !== undefined;
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
      const gitStatus = await this.readGitStatus(normalizedRoot, lastIndexedCommit ?? undefined);

      if (gitStatus.isGitRepo && gitStatus.reliable && gitStatus.currentCommit) {
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

    this.reportIndexProgress(progress, {
      phase: "prepare",
      status: "done",
      ms: Math.round(performance.now() - preflightStartedAtMs),
    }, onProgress);

    // v4.3.6: Emit collect phase events
    this.reportIndexProgress(progress, { phase: "collect", status: "start" }, onProgress);
    const collectStartedAtMs = performance.now();
    const ignoreManager = await IgnoreManager.create(normalizedRoot, this.settings.excludePatterns);
    const sourceFiles = await collectSourceFiles(normalizedRoot, this.settings, ignoreManager);
    const collectMs = Math.round(performance.now() - collectStartedAtMs);
    this.reportIndexProgress(progress, {
      phase: "collect",
      status: "done",
      ms: collectMs,
      detail: `${sourceFiles.length} files scanned`,
    }, onProgress);

    this.reportIndexProgress(progress, { phase: "detect", status: "start" }, onProgress);
    const detectStartedAtMs = performance.now();
    const project = await detectProject(normalizedRoot, sourceFiles);
    const detectMs = Math.round(performance.now() - detectStartedAtMs);
    this.reportIndexProgress(progress, { phase: "detect", status: "done", ms: detectMs }, onProgress);

    const indexingStartedAtMs = performance.now();
    const indexingStartedAtEpochMs = Date.now();
    this.reportIndexProgress(progress, { phase: "prepare", status: "start", total: sourceFiles.length }, onProgress);
    const prepareStartedAtMs = performance.now();
    const preparation = await indexStorageWorker.prepareProjectIndex(projectId, project, timestamp);

    const existingFiles = new Map(
      preparation.existingFiles.map((file) => [file.relativePath, file]),
    );
    const currentPaths = new Set(sourceFiles.map((file) => file.relativePath));
    const deletedFiles = [...existingFiles.keys()].filter((relativePath) => !currentPaths.has(relativePath));
    await indexStorageWorker.deleteFiles(projectId, deletedFiles);

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
    const prepareMs = Math.round(performance.now() - prepareStartedAtMs);
    this.reportIndexProgress(progress, {
      phase: "prepare",
      status: "done",
      ms: prepareMs,
      detail: `${changedFiles} files changed, ${deletedFiles.length} files deleted`,
    }, onProgress);
    let vectorMs = 0;

    // v4.3.6: Emit parse phase events
    this.reportIndexProgress(progress, { phase: "parse", status: "start", total: changedFiles }, onProgress);
    const parseStartedAtMs = performance.now();
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
          this.reportIndexProgress(progress, {
            phase: "parse",
            status: "progress",
            current: parsedCount,
            total: changedFiles,
          }, onProgress);
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
    const parseMs = Math.round(performance.now() - parseStartedAtMs);
    this.reportIndexProgress(progress, {
      phase: "parse",
      status: "done",
      ms: parseMs,
      detail: `${parsedCount} files parsed`,
    }, onProgress);

    // v4.3.1: Batch write to database - dramatically reduces transaction overhead
    const successResults = fileResults.filter((r): r is Extract<IndexedFileResult, { indexed: true }> => r.indexed);

    // v4.3.6: Emit index (database write) phase events
    this.reportIndexProgress(progress, { phase: "index", status: "start", total: successResults.length }, onProgress);
    let writeMs = 0;
    let maxWriteBatchMs = 0;

    const totalBatches = Math.ceil(successResults.length / DB_WRITE_BATCH_SIZE);
    for (let i = 0; i < successResults.length; i += DB_WRITE_BATCH_SIZE) {
      const batch = successResults.slice(i, i + DB_WRITE_BATCH_SIZE);
      const batchStartedAtMs = performance.now();
      await indexStorageWorker.writeFileIndexBatch(
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
      const batchWriteMs = Math.round(performance.now() - batchStartedAtMs);
      writeMs += batchWriteMs;
      maxWriteBatchMs = Math.max(maxWriteBatchMs, batchWriteMs);
      // v4.3.6: Emit index progress per batch
      const batchNum = Math.floor(i / DB_WRITE_BATCH_SIZE) + 1;
      this.reportIndexProgress(progress, {
        phase: "index",
        status: "progress",
        current: batchNum,
        total: totalBatches,
      }, onProgress);
    }
    this.reportIndexProgress(progress, {
      phase: "index",
      status: "done",
      ms: writeMs,
      detail: `${successResults.length} files indexed`,
    }, onProgress);

    // v4.3.1: Vector indexing (still per-file for now, but after batch write)
    if (this.settings.enableVectorSearch && this.settings.vectorIndexingMode === "eager") {
      this.reportIndexProgress(progress, { phase: "vector", status: "start", total: successResults.length }, onProgress);
      let vectoredCount = 0;
      for (const result of successResults) {
        if (result.chunks.length > 0) {
          const provider = this.embeddingProvider;
          const vectorStartedAtMs = performance.now();
          const embeddings = await provider.embedBatch(result.chunks.map((chunk) => chunk.content));
          result.vectorChunkCount = result.chunks.length;
          const vectorWriteStartedAtMs = performance.now();
          await indexStorageWorker.writeChunkVectors(
            result.chunks.map((chunk, index) => ({
              chunkId: chunk.chunkId,
              embedding: embeddings[index],
              modelName: provider.getModelName(),
            })),
            projectId,
          );
          const vectorWriteMs = Math.round(performance.now() - vectorWriteStartedAtMs);
          writeMs += vectorWriteMs;
          maxWriteBatchMs = Math.max(maxWriteBatchMs, vectorWriteMs);
          vectorMs += Math.round(performance.now() - vectorStartedAtMs);
        }
        vectoredCount++;
        if (vectoredCount % 10 === 0 || vectoredCount === successResults.length) {
          this.reportIndexProgress(progress, {
            phase: "vector",
            status: "progress",
            current: vectoredCount,
            total: successResults.length,
          }, onProgress);
        }
      }
      this.reportIndexProgress(progress, { phase: "vector", status: "done", ms: vectorMs }, onProgress);
    }
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

    const hasIndexChanges = changedFiles > 0 || deletedFiles.length > 0;
    this.reportIndexProgress(progress, {
      phase: "symbolGraph",
      status: "start",
      total: changedFiles + deletedFiles.length,
    }, onProgress);
    const symbolGraphStartedAtMs = performance.now();
    if (hasIndexChanges) {
      // Collect fileIds of changed files for incremental symbol graph resolution
      const changedFileIds = new Set(filesToIndex.map((file) => buildStableId([projectId, file.relativePath])));
      // Also include deleted file IDs (their usages/imports were already removed by deleteFiles)
      for (const deletedPath of deletedFiles) {
        changedFileIds.add(buildStableId([projectId, deletedPath]));
      }
      await indexStorageWorker.resolveSymbolGraph(projectId, [...changedFileIds]);
    }
    const symbolGraphMs = Math.round(performance.now() - symbolGraphStartedAtMs);
    this.reportIndexProgress(progress, {
      phase: "symbolGraph",
      status: "done",
      ms: symbolGraphMs,
    }, onProgress);

    // v4.3.6: Emit semantic phase events
    // Pre-build semantic FTS index during indexing so first search doesn't block
    this.reportIndexProgress(progress, { phase: "semantic", status: "start" }, onProgress);
    const semanticStartedAtMs = performance.now();
    if (hasIndexChanges) {
      await indexStorageWorker.ensureSemanticIndex(projectId);
    }
    const semanticMs = Math.round(performance.now() - semanticStartedAtMs);
    this.reportIndexProgress(progress, { phase: "semantic", status: "done", ms: semanticMs }, onProgress);
    if (semanticMs > 100) {
      this.logger.info("semantic index built", { projectRootPath: normalizedRoot, semanticMs });
    }

    this.reportIndexProgress(progress, { phase: "finalize", status: "start" }, onProgress);
    const finalizeStartedAtMs = performance.now();
    const finalizeStartedAtEpochMs = Date.now();
    const bumpIndexVersion = hasIndexChanges;

    if (origin === "explicit") {
      if (!wasRegisteredBeforeIndex && this.automaticUpdatesStarted) {
        this.pendingAutomaticOwnershipRefreshRoots.add(normalizedRoot);
      }
      if (this.pendingAutomaticOwnershipRefreshRoots.size > 0) {
        await this.refreshPendingAutomaticProjectOwnership();
      } else {
        this.restoreAutomaticProjectAfterExplicitIndex(normalizedRoot);
      }
    }

    const baseTimings = {
      collectMs,
      detectMs,
      finalizeMs: Math.round(performance.now() - finalizeStartedAtMs),
      indexMs: Math.round(performance.now() - indexingStartedAtMs),
      maxWriteBatchMs,
      parseMs,
      prepareMs,
      semanticMs,
      symbolGraphMs,
      totalMs: Math.round(performance.now() - startedAtMs),
      vectorMs,
      writeMs,
    };
    const finalizeWriteStartedAtMs = Date.now();
    const finalization = await indexStorageWorker.finalizeProjectIndex(projectId, {
      bumpIndexVersion,
      event: {
        changedFiles,
        chunkCount,
        createdAt: timestamp,
        deletedFiles: deletedFiles.length,
        failedFiles,
        indexedFiles,
        metadata: {
          vectorIndex: {
            enabled: this.settings.enableVectorSearch,
            hydratedChunkCount,
            mode: this.settings.vectorIndexingMode,
          },
          gitOptimization: {
            enabled: gitOptimized,
            commit: gitCommit?.slice(0, 8) ?? null,
          },
        },
        scannedFiles: sourceFiles.length,
      },
      lastIndexedCommit: gitCommit ?? undefined,
      status: failedFiles.length > 0 ? "error" : "ready",
      timestamp,
      timing: {
        baseTimings,
        finalizeStartedAtMs: finalizeStartedAtEpochMs,
        finalizeWriteStartedAtMs,
        indexStartedAtMs: indexingStartedAtEpochMs,
        totalStartedAtMs: totalStartedAtEpochMs,
      },
    });
    if (bumpIndexVersion) {
      // Overall invalidation is SQLite-free and avoids materializing vectors on the main thread.
      this.store.clearProjectVectorCache(projectId, finalization.indexVersion);
    }

    const timings = finalization.timings;
    const finalizeMs = timings.finalizeMs ?? Math.round(performance.now() - finalizeStartedAtMs);
    const indexMs = timings.indexMs;
    const totalMs = timings.totalMs;
    writeMs = timings.writeMs ?? writeMs;
    maxWriteBatchMs = timings.maxWriteBatchMs ?? maxWriteBatchMs;
    this.reportIndexProgress(progress, { phase: "finalize", status: "done", ms: finalizeMs }, onProgress);

    const indexSucceeded = failedFiles.length === 0;
    const currentWatchState = this.watchers.get(normalizedRoot);
    if (indexSucceeded) {
      this.lastIndexedAtMs.set(normalizedRoot, performance.now());
    } else {
      this.lastIndexedAtMs.delete(normalizedRoot);
    }
    if (currentWatchState) {
      const caughtUp = watchStateAtStart
        ? currentWatchState === watchStateAtStart && currentWatchState.generation === watchGenerationAtStart
        : currentWatchState.generation === 0;
      currentWatchState.failureCount = indexSucceeded ? 0 : currentWatchState.failureCount + 1;
      currentWatchState.lastError = indexSucceeded
        ? undefined
        : `${failedFiles.length} file(s) failed to index`;
      if (indexSucceeded) {
        currentWatchState.lastSuccessAt = new Date().toISOString();
      }
      currentWatchState.dirty = !indexSucceeded || !caughtUp;
      this.watcherDirty.set(normalizedRoot, currentWatchState.dirty);
      if (indexSucceeded && caughtUp) {
        this.clearWatchTimers(currentWatchState);
      }
    } else {
      this.watcherDirty.set(normalizedRoot, !indexSucceeded);
    }

    this.logger.info("project indexed", {
      batchSize: this.settings.batchSize,
      changedFiles,
      collectMs,
      chunkCount,
      detectMs,
      deletedFiles: deletedFiles.length,
      failedFileCount: failedFiles.length,
      gitOptimized,
      finalizeMs,
      indexMs,
      indexedFiles,
      maxWriteBatchMs,
      parseMs,
      prepareMs,
      projectRootPath: normalizedRoot,
      scannedFiles: sourceFiles.length,
      semanticMs,
      symbolGraphMs,
      totalMs,
      vectorIndexingMode: this.settings.vectorIndexingMode,
      vectorMs,
      vectorSearchEnabled: this.settings.enableVectorSearch,
      writeMs,
    });

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
      timings,
      vectorIndex: {
        enabled: this.settings.enableVectorSearch,
        hydratedChunkCount,
        mode: this.settings.vectorIndexingMode,
      },
    };

    // v4.3.6: Emit complete event
    this.reportIndexProgress(progress, {
      phase: "complete",
      status: "done",
      ms: totalMs,
      detail: `${indexedFiles} files indexed, ${chunkCount} chunks created`,
    }, onProgress);

    if (indexSucceeded) {
      this.lastIndexResult.set(normalizedRoot, result);
    } else {
      this.lastIndexResult.delete(normalizedRoot);
    }
    return result;
  }
}

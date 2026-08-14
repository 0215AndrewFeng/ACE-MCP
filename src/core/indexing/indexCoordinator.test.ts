import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { mapInBatches } from "../common/batch.js";
import type { IndexProjectResult, Settings } from "../common/types.js";
import { InMemoryEmbeddingProvider } from "../search/embedding.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { SQLiteStore } from "../storage/sqliteStore.js";
import { createTestProjectEnvironment } from "../../test/helpers.js";
import {
  createSynchronousIndexStorageWorker,
  IndexCoordinator,
  type IndexStorageWorker,
} from "./indexCoordinator.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function blockFor(durationMs: number): void {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    // Intentionally block to make synchronous phase attribution observable.
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const noOpWatchFactory = () => ({ close() {} });

async function holdDatabaseWriteLock(databasePath: string, durationMs: number): Promise<Worker> {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const Database = require("better-sqlite3");
    const db = new Database(workerData.databasePath);
    try {
      db.exec("BEGIN IMMEDIATE");
      parentPort.postMessage({ status: "locked" });
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
        parentPort.postMessage({ status: "released" });
      }, workerData.durationMs);
    } catch (error) {
      parentPort.postMessage({ status: "error", message: String(error) });
    }
  `, {
    eval: true,
    workerData: { databasePath, durationMs },
  });
  await new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.on("message", (message: { message?: string; status: string }) => {
      if (message.status === "locked") {
        resolve();
      } else if (message.status === "error") {
        reject(new Error(message.message ?? "failed to acquire test database lock"));
      }
    });
  });
  return worker;
}

function cachedResult(projectRootPath: string): IndexProjectResult {
  return {
    changedFiles: 0,
    chunkCount: 1,
    createdAt: "2026-06-22T00:00:00.000Z",
    deletedFiles: 0,
    failedFileCount: 0,
    failedFiles: [],
    indexedFiles: 1,
    project: { languages: ["javascript"], markers: [], projectType: "single-language", rootPath: projectRootPath },
    projectId: "project",
    projectRootPath,
    scannedFiles: 1,
    timings: { collectMs: 1, detectMs: 1, indexMs: 1, totalMs: 3, vectorMs: 0 },
    vectorIndex: { enabled: false, hydratedChunkCount: 0, mode: "lazy" },
  };
}

async function recordPersistedIndexFailure(
  environment: Awaited<ReturnType<typeof createTestProjectEnvironment>>,
  projectId: string,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  environment.store.recordIndexEvent(projectId, {
    changedFiles: 1,
    chunkCount: 0,
    createdAt: new Date().toISOString(),
    deletedFiles: 0,
    failedFiles: [{ filePath: "source.ts", message: "parse failed" }],
    indexedFiles: 0,
    metadata: {
      timings: { collectMs: 0, detectMs: 0, indexMs: 0, totalMs: 0, vectorMs: 0 },
      vectorIndex: { enabled: false, hydratedChunkCount: 0, mode: "lazy" },
    },
    scannedFiles: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
}

interface PeriodicGitStatus {
  changedFiles?: string[];
  currentCommit?: string;
  isGitRepo: boolean;
  reliable: boolean;
  untrackedFiles?: string[];
}

const cleanPeriodicGitStatus: PeriodicGitStatus = {
  changedFiles: [],
  currentCommit: "current-commit",
  isGitRepo: true,
  reliable: true,
  untrackedFiles: [],
};

async function createPeriodicReconcileFixture(options: {
  gitStatus?: PeriodicGitStatus;
  gitStatusError?: Error;
  gitStatusReader?: () => Promise<PeriodicGitStatus>;
  lastIndexedCommit?: string | null;
} = {}) {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-periodic-preflight-"));
  let failWatcherRestarts = false;
  let gitReads = 0;
  let indexRuns = 0;

  class RecordingCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      indexRuns += 1;
      return cachedResult(root);
    }
  }

  const coordinator = new RecordingCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      getLastIndexedCommit: () => options.lastIndexedCommit === undefined ? "indexed-commit" : options.lastIndexedCommit,
      latestIndexEventHasFailures: () => false,
      listProjects: () => [{ projectRootPath }],
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    () => {
      if (failWatcherRestarts) {
        throw new Error("recursive watch is unavailable");
      }
      return { close() {} };
    },
    async () => ({ isDirectory: () => true }),
    async () => {
      gitReads += 1;
      if (options.gitStatusReader) {
        return options.gitStatusReader();
      }
      if (options.gitStatusError) {
        throw options.gitStatusError;
      }
      return options.gitStatus ?? cleanPeriodicGitStatus;
    },
  );

  await coordinator.startAutomaticUpdates();
  await coordinator.reconcileWatchedProjects("startup");
  const startupGitReads = gitReads;
  const startupIndexRuns = indexRuns;
  gitReads = 0;
  indexRuns = 0;

  const internals = coordinator as unknown as {
    inFlightIndex: Map<string, Promise<IndexProjectResult>>;
    watchers: Map<string, {
      active: boolean;
      dirty: boolean;
      failureCount: number;
      processing: boolean;
    }>;
  };

  return {
    cleanup: async () => {
      coordinator.stopAutomaticUpdates();
      await rm(projectRootPath, { force: true, recursive: true });
    },
    coordinator,
    failWatcherRestarts: () => {
      failWatcherRestarts = true;
    },
    get gitReads() {
      return gitReads;
    },
    get indexRuns() {
      return indexRuns;
    },
    projectRootPath,
    setInFlight: () => {
      internals.inFlightIndex.set(projectRootPath, Promise.resolve(cachedResult(projectRootPath)));
    },
    setWatchState: (patch: Partial<{
      active: boolean;
      dirty: boolean;
      failureCount: number;
      processing: boolean;
    }>) => {
      const state = internals.watchers.get(projectRootPath);
      assert.ok(state);
      Object.assign(state, patch);
    },
    startupGitReads,
    startupIndexRuns,
  };
}

test("restoreFreshnessState lets stale freshness reuse the cached index result", async () => {
  const settings = {
    indexFreshness: "stale",
    indexFreshnessSeconds: 60,
  } as unknown as Settings;
  const logger = {
    debug() {},
    info() {},
    warn() {},
  };
  const coordinator = new IndexCoordinator(settings, {} as never, logger as never, {} as EmbeddingProvider);
  const result = cachedResult(process.cwd());

  coordinator.restoreFreshnessState(process.cwd(), result);

  assert.equal(await coordinator.ensureFreshIndex(process.cwd(), 1), result);
  assert.deepEqual(coordinator.getInFlightIndexInfo(), []);
});

test("manual freshness also reuses a restored cached result", async () => {
  const settings = {
    indexFreshness: "manual",
    indexFreshnessSeconds: 60,
  } as unknown as Settings;
  const coordinator = new IndexCoordinator(settings, {} as never, { debug() {}, info() {}, warn() {} } as never, {} as EmbeddingProvider);
  const result = cachedResult(process.cwd());

  coordinator.restoreFreshnessState(process.cwd(), result);

  assert.equal(await coordinator.ensureFreshIndex(process.cwd(), 1), result);
});

test("stdio freshness reuses the last successful index during Web startup catch-up", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  const initial = await environment.indexCoordinator.indexProject(environment.projectRootPath, "full");
  environment.settings.autoWatch = true;
  environment.settings.indexFreshness = "always";
  const releaseWebPrepare = deferred<void>();
  const webPrepareStarted = deferred<void>();
  const webWorker = createSynchronousIndexStorageWorker(environment.store);
  const originalWebPrepare = webWorker.prepareProjectIndex.bind(webWorker);
  webWorker.prepareProjectIndex = async (...args) => {
    webPrepareStarted.resolve();
    await releaseWebPrepare.promise;
    return originalWebPrepare(...args);
  };
  const webCoordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    webWorker,
  );
  const stdioStore = new SQLiteStore(
    environment.settings.databasePath,
    { debug() {}, info() {}, warn() {} } as never,
  );
  stdioStore.initialize();
  const stdioWorker = createSynchronousIndexStorageWorker(stdioStore);
  const originalStdioPrepare = stdioWorker.prepareProjectIndex.bind(stdioWorker);
  let stdioPrepareCalls = 0;
  stdioWorker.prepareProjectIndex = async (...args) => {
    stdioPrepareCalls += 1;
    return originalStdioPrepare(...args);
  };
  const stdioCoordinator = new IndexCoordinator(
    environment.settings,
    stdioStore,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    stdioWorker,
  );

  try {
    await webCoordinator.startAutomaticUpdates();
    await webPrepareStarted.promise;

    assert.ok(stdioStore.getActiveIndexMaintenanceLease());
    const fallback = await stdioCoordinator.ensureFreshIndex(environment.projectRootPath);

    assert.equal(stdioPrepareCalls, 0);
    assert.equal(fallback.projectId, initial.projectId);
    assert.equal(fallback.createdAt, initial.createdAt);
  } finally {
    releaseWebPrepare.resolve();
    await Promise.allSettled([webCoordinator.close(), stdioCoordinator.close()]);
    await environment.cleanup();
  }
});

test("expired Web maintenance lease does not suppress stdio freshness indexing", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  const ownerId = "crashed-web-owner";
  const nowMs = Date.now();
  environment.store.tryAcquireIndexMaintenanceLease(ownerId, nowMs - 1, nowMs - 2);
  const worker = createSynchronousIndexStorageWorker(environment.store);
  const originalPrepare = worker.prepareProjectIndex.bind(worker);
  let prepareCalls = 0;
  worker.prepareProjectIndex = async (...args) => {
    prepareCalls += 1;
    return originalPrepare(...args);
  };
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    worker,
  );

  try {
    await coordinator.ensureFreshIndex(environment.projectRootPath);
    assert.equal(prepareCalls, 1);
  } finally {
    await coordinator.close();
    await environment.cleanup();
  }
});

test("watches multiple projects and stops one project independently", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-multi-watch-"));
  const firstProject = path.join(tempDir, "first");
  const secondProject = path.join(tempDir, "second");
  const settings = {
    autoWatch: false,
  } as unknown as Settings;
  const coordinator = new IndexCoordinator(
    settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    noOpWatchFactory,
  );

  try {
    await Promise.all([
      import("node:fs/promises").then(({ mkdir }) => mkdir(firstProject)),
      import("node:fs/promises").then(({ mkdir }) => mkdir(secondProject)),
    ]);

    coordinator.startWatching(firstProject);
    coordinator.startWatching(secondProject);

    assert.deepEqual(
      coordinator.getWatchStatuses().map((status) => status.projectRootPath).sort(),
      [firstProject, secondProject],
    );

    coordinator.stopWatching(firstProject);

    assert.equal(coordinator.isWatching(firstProject), false);
    assert.equal(coordinator.isWatching(secondProject), true);
    assert.deepEqual(
      coordinator.getWatchStatuses().map((status) => status.projectRootPath),
      [secondProject],
    );
  } finally {
    coordinator.stopWatching();
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("runs a follow-up index when a change arrives during watch indexing", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-generation-"));
  const listeners = new Map<string, (_eventType: string, _filename: string | Buffer | null) => void>();
  const runs: Array<ReturnType<typeof deferred<IndexProjectResult>>> = [];
  const settings = {
    autoWatch: false,
    watchDebounceMs: 5,
    watchMaxWaitMs: 20,
  } as unknown as Settings;
  const watchFactory = (root: string, listener: (_eventType: string, _filename: string | Buffer | null) => void) => {
    listeners.set(root, listener);
    return { close: () => { listeners.delete(root); } };
  };

  class ControlledIndexCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      const run = deferred<IndexProjectResult>();
      runs.push(run);
      return run.promise;
    }
  }

  const coordinator = new ControlledIndexCoordinator(
    settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    watchFactory,
  );

  try {
    coordinator.startWatching(projectRootPath);
    listeners.get(projectRootPath)?.("change", "source.ts");
    await waitFor(() => runs.length === 1);

    listeners.get(projectRootPath)?.("change", "source.ts");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(runs.length, 1, "a second index must not overlap the active project index");

    runs[0].resolve(cachedResult(projectRootPath));
    await waitFor(() => runs.length === 2);
    assert.equal(coordinator.getWatchStatuses()[0].dirty, true);

    runs[1].resolve(cachedResult(projectRootPath));
    await waitFor(() => coordinator.getWatchStatuses()[0].dirty === false);
  } finally {
    coordinator.stopWatching();
    for (const run of runs) {
      run.resolve(cachedResult(projectRootPath));
    }
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("ignores watch changes outside indexed source paths", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-filter-"));
  let listener: ((_eventType: string, _filename: string | Buffer | null) => void) | undefined;
  let indexRuns = 0;

  class FilteredIndexCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      indexRuns += 1;
      return cachedResult(root);
    }
  }

  const coordinator = new FilteredIndexCoordinator(
    {
      autoWatch: false,
      excludePatterns: [".git", "node_modules", "dist"],
      textExtensions: [".ts"],
      watchDebounceMs: 5,
      watchMaxWaitMs: 20,
    } as unknown as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (_root, watchListener) => {
      listener = watchListener;
      return { close() {} };
    },
  );

  try {
    coordinator.startWatching(projectRootPath);
    listener?.("change", "node_modules/pkg/index.ts");
    listener?.("change", "dist/bundle.ts");
    listener?.("change", "notes.txt");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(indexRuns, 0);

    listener?.("change", "src/index.ts");
    await waitFor(() => indexRuns === 1);
  } finally {
    coordinator.stopWatching();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("watch registration requests root-only non-recursive coverage", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-coverage-"));
  let requestedOptions: { coverage: string; recursive: boolean } | undefined;
  const coordinator = new IndexCoordinator(
    { autoWatch: false } as unknown as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (_root, _listener, options?: { coverage: string; recursive: boolean }) => {
      requestedOptions = options;
      return { close() {} };
    },
  );

  try {
    coordinator.startWatching(projectRootPath);

    assert.deepEqual(requestedOptions, { coverage: "root-only", recursive: false });
    assert.equal(
      (coordinator.getWatchStatuses()[0] as unknown as { coverage?: string }).coverage,
      "root-only",
    );
  } finally {
    coordinator.stopWatching();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("automatic watcher budget keeps excess projects on healthy periodic-only coverage", async () => {
  const projectRoots = Array.from(
    { length: 12 },
    (_, index) => path.join(os.tmpdir(), `ace-mcp-watch-budget-${process.pid}-${index}`),
  );
  const indexedRoots: string[] = [];
  const watchedRoots: string[] = [];

  class BudgetedWatchCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      indexedRoots.push(root);
      return cachedResult(root);
    }
  }

  const coordinator = new BudgetedWatchCoordinator(
    {
      autoWatch: true,
      indexConcurrency: 1,
      watchReconcileSeconds: 0,
    } as unknown as Settings,
    {
      listProjects: () => projectRoots.map((projectRootPath) => ({ projectRootPath })),
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => {
      watchedRoots.push(root);
      return { close() {} };
    },
    async () => ({ isDirectory: () => true }),
    undefined,
    undefined,
    { maxActiveWatchers: 3 } as never,
  );

  try {
    await coordinator.startAutomaticUpdates();
    await waitFor(() => coordinator.getAutomaticMaintenanceQueueStatus().active === false);

    assert.equal(watchedRoots.length, 3);
    const statuses = coordinator.getWatchStatuses();
    assert.equal(statuses.filter((status) => status.coverage === "root-only" && status.watching).length, 3);
    assert.equal(statuses.filter((status) => (status.coverage as string) === "periodic-only").length, 9);
    assert.deepEqual(coordinator.getWatchHealthSummary(), {
      active: 3,
      circuitOpen: false,
      expected: 12,
      exhausted: 0,
      periodicOnly: 9,
      retrying: 0,
      status: "healthy",
    });
    assert.deepEqual([...indexedRoots].sort(), [...projectRoots].sort());

    indexedRoots.length = 0;
    await coordinator.reconcileWatchedProjects("periodic");

    assert.equal(watchedRoots.length, 3, "periodic refresh must not retry projects outside the watcher budget");
    assert.deepEqual([...indexedRoots].sort(), [...projectRoots].sort());
  } finally {
    coordinator.stopAutomaticUpdates();
  }
});

test("a successful index clears watch dirtiness only for its captured generation", async () => {
  const listeners = new Map<string, (_eventType: string, _filename: string | Buffer | null) => void>();
  const environment = await createTestProjectEnvironment({
    "source.ts": "export const value = 1;",
  });
  environment.settings.watchDebounceMs = 10_000;
  environment.settings.watchMaxWaitMs = 20_000;
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    (root, listener) => {
      listeners.set(root, listener);
      return { close: () => { listeners.delete(root); } };
    },
  );

  try {
    coordinator.startWatching(environment.projectRootPath);
    listeners.get(environment.projectRootPath)?.("change", "source.ts");
    assert.equal(coordinator.getWatchStatuses()[0].dirty, true);

    await coordinator.indexProject(environment.projectRootPath, "incremental");

    const status = coordinator.getWatchStatuses()[0];
    assert.equal(status.dirty, false);
    assert.notEqual(status.lastSuccessAt, null);
  } finally {
    coordinator.stopWatching();
    await environment.cleanup();
  }
});

for (const gitChange of [
  { changedFiles: ["source.ts"], name: "a tracked dirty file", untrackedFiles: [] },
  { changedFiles: [], name: "an untracked file", untrackedFiles: ["source.ts"] },
]) {
  test(`incremental Git indexing does not rebuild unchanged content for ${gitChange.name}`, async () => {
    const environment = await createTestProjectEnvironment({
      "source.ts": "export const value = 1;",
    });
    let coordinator: IndexCoordinator | undefined;

    try {
      const initial = await environment.indexCoordinator.indexProject(
        environment.projectRootPath,
        "full",
      );
      environment.store.updateProjectAfterIndex(
        initial.projectId,
        initial.createdAt,
        "ready",
        false,
        "indexed-commit",
      );
      coordinator = new IndexCoordinator(
        environment.settings,
        environment.store,
        { debug() {}, info() {}, warn() {} } as never,
        environment.embeddingProvider,
        noOpWatchFactory,
        async () => ({ isDirectory: () => true }),
        async () => ({
          changedFiles: gitChange.changedFiles,
          currentCommit: "current-commit",
          isGitRepo: true,
          reliable: true,
          untrackedFiles: gitChange.untrackedFiles,
        }),
        createSynchronousIndexStorageWorker(environment.store),
      );

      const result = await coordinator.indexProject(
        environment.projectRootPath,
        "incremental",
      );

      assert.equal(result.changedFiles, 0);
      assert.equal(result.indexedFiles, 0);
    } finally {
      await coordinator?.close();
      await environment.cleanup();
    }
  });
}

test("limits indexing concurrency across projects", async () => {
  const releaseEmbeddings = deferred<void>();

  class BlockingEmbeddingProvider extends InMemoryEmbeddingProvider {
    public activeCalls = 0;
    public maxActiveCalls = 0;

    public override async embedBatch(texts: string[]): Promise<number[][]> {
      this.activeCalls += 1;
      this.maxActiveCalls = Math.max(this.maxActiveCalls, this.activeCalls);
      try {
        await releaseEmbeddings.promise;
        return await super.embedBatch(texts);
      } finally {
        this.activeCalls -= 1;
      }
    }
  }

  const provider = new BlockingEmbeddingProvider();
  const environment = await createTestProjectEnvironment(
    { "first.ts": "export const first = true;" },
    provider,
  );
  const secondProject = path.join(environment.tempDir, "second-project");
  environment.settings.vectorIndexingMode = "eager";
  environment.settings.indexConcurrency = 1;

  try {
    await mkdir(secondProject);
    await writeFile(path.join(secondProject, "second.ts"), "export const second = true;", "utf8");

    const first = environment.indexCoordinator.indexProject(environment.projectRootPath, "incremental");
    const second = environment.indexCoordinator.indexProject(secondProject, "incremental");
    await waitFor(() => provider.activeCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(provider.maxActiveCalls, 1);

    releaseEmbeddings.resolve();
    await Promise.all([first, second]);
  } finally {
    releaseEmbeddings.resolve();
    environment.indexCoordinator.stopWatching();
    await environment.cleanup();
  }
});

test("global index slots prefer explicit work over queued automatic maintenance", async () => {
  const releaseFirst = deferred<void>();
  const starts: string[] = [];
  const coordinator = new IndexCoordinator(
    { indexConcurrency: 1 } as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    noOpWatchFactory,
  );
  const internals = coordinator as unknown as {
    getIndexSchedulerStatus: () => {
      active: number;
      concurrency: number;
      oldestQueueMs: number;
      pending: number;
      pendingAutomatic: number;
      pendingExplicit: number;
    };
    withGlobalIndexSlot: <T>(origin: "automatic" | "explicit", operation: () => Promise<T>) => Promise<T>;
  };

  try {
    const first = internals.withGlobalIndexSlot("automatic", async () => {
      starts.push("automatic-active");
      await releaseFirst.promise;
    });
    await waitFor(() => starts.length === 1);
    const automatic = internals.withGlobalIndexSlot("automatic", async () => {
      starts.push("automatic-queued");
    });
    const explicit = internals.withGlobalIndexSlot("explicit", async () => {
      starts.push("explicit-queued");
    });

    const queuedStatus = internals.getIndexSchedulerStatus();
    assert.equal(queuedStatus.active, 1);
    assert.equal(queuedStatus.concurrency, 1);
    assert.equal(queuedStatus.pending, 2);
    assert.equal(queuedStatus.pendingAutomatic, 1);
    assert.equal(queuedStatus.pendingExplicit, 1);
    assert.ok(queuedStatus.oldestQueueMs >= 0);

    releaseFirst.resolve();
    await Promise.all([first, automatic, explicit]);

    assert.deepEqual(starts, ["automatic-active", "explicit-queued", "automatic-queued"]);
  } finally {
    releaseFirst.resolve();
    await coordinator.close();
  }
});

test("automatic updates watch registered projects before startup catch-up", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-auto-updates-"));
  const existingProject = path.join(tempDir, "existing");
  const missingProject = path.join(tempDir, "missing");
  const watchedRoots = new Set<string>();
  const indexedRoots: string[] = [];
  const settings = {
    autoWatch: true,
    indexConcurrency: 1,
    watchDebounceMs: 5,
    watchMaxWaitMs: 20,
    watchReconcileSeconds: 0,
  } as unknown as Settings;
  const watchFactory = (root: string, _listener: (_eventType: string, _filename: string | Buffer | null) => void) => {
    watchedRoots.add(root);
    return { close: () => { watchedRoots.delete(root); } };
  };

  class StartupIndexCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      assert.equal(this.isWatching(root), true, "catch-up must run after the watcher is active");
      indexedRoots.push(root);
      return cachedResult(root);
    }
  }

  const coordinator = new StartupIndexCoordinator(
    settings,
    {
      listProjects: () => [
        { projectRootPath: existingProject },
        { projectRootPath: missingProject },
      ],
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    watchFactory,
  );

  try {
    await mkdir(existingProject);

    await coordinator.startAutomaticUpdates();
    await waitFor(() => indexedRoots.length === 1);

    assert.deepEqual([...watchedRoots], [existingProject]);
    assert.deepEqual(indexedRoots, [existingProject]);
  } finally {
    coordinator.stopAutomaticUpdates?.();
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("startup reconciliation yields between projects for foreground work", async () => {
  const roots = ["first", "second", "third"].map((name) => path.join(os.tmpdir(), `ace-mcp-startup-yield-${name}`));
  let foregroundTurnRan = false;
  let indexRuns = 0;

  class YieldingStartupCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      indexRuns += 1;
      if (indexRuns === 1) {
        setImmediate(() => {
          foregroundTurnRan = true;
        });
      } else {
        assert.equal(foregroundTurnRan, true, `foreground turn did not run before indexing ${root}`);
      }
      return cachedResult(root);
    }
  }

  const coordinator = new YieldingStartupCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    noOpWatchFactory,
  );
  const internals = coordinator as unknown as {
    automaticProjectRoots: Set<string>;
    automaticUpdatesGeneration: number;
    automaticUpdatesStarted: boolean;
  };
  internals.automaticUpdatesStarted = true;
  internals.automaticUpdatesGeneration = 1;
  for (const root of roots) internals.automaticProjectRoots.add(root);

  try {
    await coordinator.reconcileWatchedProjects("startup");
    assert.equal(indexRuns, roots.length);
  } finally {
    coordinator.stopAutomaticUpdates();
    await coordinator.close();
  }
});

test("startup reconciliation exposes one active project and a bounded 50-project backlog", async () => {
  const roots = Array.from({ length: 50 }, (_, index) => path.join(os.tmpdir(), `ace-mcp-startup-queue-${index}`));
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  let indexRuns = 0;

  class BoundedStartupCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      indexRuns += 1;
      if (indexRuns === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return cachedResult(root);
    }
  }

  const coordinator = new BoundedStartupCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    noOpWatchFactory,
  );
  const internals = coordinator as unknown as {
    automaticProjectRoots: Set<string>;
    automaticUpdatesGeneration: number;
    automaticUpdatesStarted: boolean;
  };
  internals.automaticUpdatesStarted = true;
  internals.automaticUpdatesGeneration = 1;
  for (const root of roots) internals.automaticProjectRoots.add(root);

  try {
    const reconciliation = coordinator.reconcileWatchedProjects("startup");
    await firstStarted.promise;

    const active = coordinator.getAutomaticMaintenanceQueueStatus();
    assert.equal(active.active, true);
    assert.equal(active.completed, 0);
    assert.notEqual(active.currentProjectRootPath, null);
    assert.equal(active.pending, 49);
    assert.equal(active.reason, "startup");
    assert.equal(active.total, 50);

    releaseFirst.resolve();
    await reconciliation;
    const completed = coordinator.getAutomaticMaintenanceQueueStatus();
    assert.equal(completed.active, false);
    assert.equal(completed.completed, 50);
    assert.equal(completed.currentProjectRootPath, null);
    assert.equal(completed.pending, 0);
  } finally {
    releaseFirst.resolve();
    coordinator.stopAutomaticUpdates();
    await coordinator.close();
  }
});

test("automatic updates watch and reconcile concrete children instead of an aggregate parent", async () => {
  const parentProject = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-aggregate-parent-"));
  const firstChild = path.join(parentProject, "first-child");
  const secondChild = path.join(parentProject, "second-child");
  const watchedRoots = new Set<string>();
  const indexedRoots: string[] = [];

  class AggregateStartupCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      indexedRoots.push(root);
      return cachedResult(root);
    }
  }

  const coordinator = new AggregateStartupCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      listProjects: () => [parentProject, firstChild, secondChild].map((projectRootPath) => ({ projectRootPath })),
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return { close: () => { watchedRoots.delete(root); } };
    },
  );

  try {
    await Promise.all([mkdir(firstChild), mkdir(secondChild)]);
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");

    assert.deepEqual([...watchedRoots].sort(), [firstChild, secondChild].sort());
    assert.deepEqual([...new Set(indexedRoots)].sort(), [firstChild, secondChild].sort());
    assert.equal(coordinator.isWatching(parentProject), false);
  } finally {
    coordinator.stopAutomaticUpdates();
    await rm(parentProject, { force: true, recursive: true });
  }
});

test("automatic updates keep a parent with only one nested registered project", async () => {
  const parentProject = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-single-child-parent-"));
  const childProject = path.join(parentProject, "child");
  const watchedRoots = new Set<string>();
  const indexedRoots: string[] = [];

  class SingleChildStartupCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      indexedRoots.push(root);
      return cachedResult(root);
    }
  }

  const coordinator = new SingleChildStartupCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      listProjects: () => [parentProject, childProject].map((projectRootPath) => ({ projectRootPath })),
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return { close: () => { watchedRoots.delete(root); } };
    },
  );

  try {
    await mkdir(childProject);
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");

    assert.deepEqual([...watchedRoots].sort(), [parentProject, childProject].sort());
    assert.deepEqual([...new Set(indexedRoots)].sort(), [parentProject, childProject].sort());
  } finally {
    coordinator.stopAutomaticUpdates();
    await rm(parentProject, { force: true, recursive: true });
  }
});

test("registering a second child at runtime transfers automatic maintenance away from the parent", async () => {
  const environment = await createTestProjectEnvironment({
    "parent.ts": "export const parent = true;",
  });
  const firstChild = path.join(environment.projectRootPath, "first-child");
  const secondChild = path.join(environment.projectRootPath, "second-child");
  const watchedRoots = new Set<string>();
  const closedRoots: string[] = [];
  environment.settings.autoWatch = true;
  environment.settings.watchReconcileSeconds = 0;
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return {
        close: () => {
          closedRoots.push(root);
          watchedRoots.delete(root);
        },
      };
    },
  );

  try {
    await mkdir(firstChild);
    await writeFile(path.join(firstChild, "first.ts"), "export const first = true;", "utf8");
    await coordinator.indexProject(environment.projectRootPath, "full");
    await coordinator.indexProject(firstChild, "full");
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");
    assert.deepEqual([...watchedRoots].sort(), [environment.projectRootPath, firstChild].sort());

    await mkdir(secondChild);
    await writeFile(path.join(secondChild, "second.ts"), "export const second = true;", "utf8");
    await coordinator.indexProject(secondChild, "full");

    assert.equal(coordinator.isWatching(environment.projectRootPath), false);
    assert.equal(coordinator.isWatching(firstChild), true);
    assert.equal(coordinator.isWatching(secondChild), true);
    assert.ok(closedRoots.includes(environment.projectRootPath));
  } finally {
    coordinator.stopAutomaticUpdates();
    await environment.cleanup();
  }
});

test("deleting a second child immediately restores automatic maintenance for its parent", async () => {
  const parentProject = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-delete-child-ownership-"));
  const firstChild = path.join(parentProject, "first-child");
  const secondChild = path.join(parentProject, "second-child");
  const watchedRoots = new Set<string>();
  let registeredRoots = [parentProject, firstChild, secondChild];

  class DeleteChildCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new DeleteChildCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      listProjects: () => registeredRoots.map((projectRootPath) => ({ projectRootPath })),
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return { close: () => { watchedRoots.delete(root); } };
    },
  );

  try {
    await Promise.all([mkdir(firstChild), mkdir(secondChild)]);
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");
    assert.deepEqual([...watchedRoots].sort(), [firstChild, secondChild].sort());

    await coordinator.withProjectIndexPaused(secondChild, () => {
      registeredRoots = [parentProject, firstChild];
    });
    await coordinator.refreshAutomaticProjectOwnership(secondChild);

    assert.deepEqual([...watchedRoots].sort(), [parentProject, firstChild].sort());
    assert.equal(coordinator.isWatching(secondChild), false);
  } finally {
    coordinator.stopAutomaticUpdates();
    await rm(parentProject, { force: true, recursive: true });
  }
});

test("a failed child deletion preserves the aggregate child watchers", async () => {
  const parentProject = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-delete-child-rollback-"));
  const firstChild = path.join(parentProject, "first-child");
  const secondChild = path.join(parentProject, "second-child");
  const watchedRoots = new Set<string>();

  class FailedDeleteCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new FailedDeleteCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      listProjects: () => [parentProject, firstChild, secondChild].map((projectRootPath) => ({ projectRootPath })),
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return { close: () => { watchedRoots.delete(root); } };
    },
  );

  try {
    await Promise.all([mkdir(firstChild), mkdir(secondChild)]);
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");

    await assert.rejects(
      coordinator.withProjectIndexPaused(secondChild, () => {
        throw new Error("delete failed");
      }),
      /delete failed/,
    );

    assert.deepEqual([...watchedRoots].sort(), [firstChild, secondChild].sort());
    assert.equal(coordinator.isWatching(parentProject), false);
  } finally {
    coordinator.stopAutomaticUpdates();
    await rm(parentProject, { force: true, recursive: true });
  }
});

test("failed topology refresh stays pending and can be retried", async () => {
  const parentProject = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-delete-child-refresh-retry-"));
  const firstChild = path.join(parentProject, "first-child");
  const secondChild = path.join(parentProject, "second-child");
  const watchedRoots = new Set<string>();
  const warnings: Array<Record<string, unknown> | undefined> = [];
  let failProjectList = false;
  let registeredRoots = [parentProject, firstChild, secondChild];

  class RetryDeleteRefreshCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new RetryDeleteRefreshCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      listProjects: () => {
        if (failProjectList) {
          throw new Error("project list unavailable");
        }
        return registeredRoots.map((projectRootPath) => ({ projectRootPath }));
      },
    } as never,
    {
      debug() {},
      info() {},
      warn(_message: string, context?: Record<string, unknown>) {
        warnings.push(context);
      },
    } as never,
    {} as EmbeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return { close: () => { watchedRoots.delete(root); } };
    },
  );

  try {
    await Promise.all([mkdir(firstChild), mkdir(secondChild)]);
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");

    await coordinator.withProjectIndexPaused(secondChild, () => {
      registeredRoots = [parentProject, firstChild];
    });
    failProjectList = true;
    await coordinator.refreshAutomaticProjectOwnership(secondChild);

    const pendingRoots = (
      coordinator as unknown as { pendingAutomaticOwnershipRefreshRoots: Set<string> }
    ).pendingAutomaticOwnershipRefreshRoots;
    assert.equal(pendingRoots.has(secondChild), true);
    assert.deepEqual([...watchedRoots], [firstChild]);
    assert.ok(warnings.some((warning) => warning?.reason === "topology"));

    failProjectList = false;
    await coordinator.refreshAutomaticProjectOwnership(secondChild);

    assert.equal(pendingRoots.size, 0);
    assert.deepEqual([...watchedRoots].sort(), [parentProject, firstChild].sort());
  } finally {
    coordinator.stopAutomaticUpdates();
    await rm(parentProject, { force: true, recursive: true });
  }
});

test("an older topology refresh cannot overwrite a newer concurrent registration", async () => {
  const parentProject = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-delete-child-refresh-order-"));
  const firstChild = path.join(parentProject, "first-child");
  const secondChild = path.join(parentProject, "second-child");
  const thirdChild = path.join(parentProject, "third-child");
  const oldRefreshStarted = deferred<void>();
  const releaseOldRefresh = deferred<void>();
  const watchedRoots = new Set<string>();
  let blockInspection = false;
  let registeredRoots = [parentProject, firstChild, secondChild];

  class ConcurrentTopologyCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new ConcurrentTopologyCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      listProjects: () => registeredRoots.map((projectRootPath) => ({ projectRootPath })),
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return { close: () => { watchedRoots.delete(root); } };
    },
    async () => {
      if (blockInspection) {
        oldRefreshStarted.resolve();
        await releaseOldRefresh.promise;
      }
      return { isDirectory: () => true };
    },
  );

  try {
    await Promise.all([mkdir(firstChild), mkdir(secondChild), mkdir(thirdChild)]);
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");

    await coordinator.withProjectIndexPaused(secondChild, () => {
      registeredRoots = [parentProject, firstChild];
    });
    blockInspection = true;
    const olderRefresh = coordinator.refreshAutomaticProjectOwnership(secondChild);
    await oldRefreshStarted.promise;

    blockInspection = false;
    registeredRoots = [parentProject, firstChild, thirdChild];
    const newerRefresh = coordinator.refreshAutomaticProjectOwnership(thirdChild);
    await newerRefresh;
    releaseOldRefresh.resolve();
    await olderRefresh;

    assert.deepEqual([...watchedRoots].sort(), [firstChild, thirdChild].sort());
    assert.equal(coordinator.isWatching(parentProject), false);
    assert.equal(coordinator.isWatching(secondChild), false);
  } finally {
    releaseOldRefresh.resolve();
    coordinator.stopAutomaticUpdates();
    await rm(parentProject, { force: true, recursive: true });
  }
});

test("a topology refresh from an old generation cannot revive watchers after restart", async () => {
  const parentProject = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-delete-child-refresh-generation-"));
  const firstChild = path.join(parentProject, "first-child");
  const secondChild = path.join(parentProject, "second-child");
  const oldRefreshStarted = deferred<void>();
  const releaseOldRefresh = deferred<void>();
  const watchedRoots = new Set<string>();
  let blockInspection = false;
  let registeredRoots = [parentProject, firstChild, secondChild];

  class RestartTopologyCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new RestartTopologyCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      listProjects: () => registeredRoots.map((projectRootPath) => ({ projectRootPath })),
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return { close: () => { watchedRoots.delete(root); } };
    },
    async () => {
      if (blockInspection) {
        oldRefreshStarted.resolve();
        await releaseOldRefresh.promise;
      }
      return { isDirectory: () => true };
    },
  );

  try {
    await Promise.all([mkdir(firstChild), mkdir(secondChild)]);
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");

    await coordinator.withProjectIndexPaused(secondChild, () => {
      registeredRoots = [parentProject, firstChild];
    });
    blockInspection = true;
    const oldRefresh = coordinator.refreshAutomaticProjectOwnership(secondChild);
    await oldRefreshStarted.promise;

    coordinator.stopAutomaticUpdates();
    blockInspection = false;
    registeredRoots = [firstChild];
    await coordinator.startAutomaticUpdates();
    releaseOldRefresh.resolve();
    await oldRefresh;

    assert.deepEqual([...watchedRoots], [firstChild]);
    assert.equal(coordinator.isWatching(parentProject), false);
    assert.equal(coordinator.isWatching(secondChild), false);
  } finally {
    releaseOldRefresh.resolve();
    coordinator.stopAutomaticUpdates();
    await rm(parentProject, { force: true, recursive: true });
  }
});

for (const autoWatch of [false, true]) {
  test(`new explicit registrations do not queue ownership refresh while automatic updates are inactive (autoWatch=${autoWatch})`, async () => {
    const environment = await createTestProjectEnvironment({
      "source.ts": "export const value = 1;",
    });
    environment.settings.autoWatch = autoWatch;
    const coordinator = new IndexCoordinator(
      environment.settings,
      environment.store,
      { debug() {}, info() {}, warn() {} } as never,
      environment.embeddingProvider,
      noOpWatchFactory,
    );

    try {
      await coordinator.indexProject(environment.projectRootPath, "full");

      const pendingRoots = (
        coordinator as unknown as { pendingAutomaticOwnershipRefreshRoots: Set<string> }
      ).pendingAutomaticOwnershipRefreshRoots;
      assert.equal(pendingRoots.size, 0);
    } finally {
      coordinator.stopAutomaticUpdates();
      await environment.cleanup();
    }
  });
}

test("an existing project retries a failed ownership refresh from its registration", async () => {
  const environment = await createTestProjectEnvironment({
    "parent.ts": "export const parent = true;",
  });
  const firstChild = path.join(environment.projectRootPath, "first-child");
  const secondChild = path.join(environment.projectRootPath, "second-child");
  const watchedRoots = new Set<string>();
  let failNextProjectList = false;
  let listProjectCalls = 0;
  environment.settings.autoWatch = true;
  environment.settings.watchReconcileSeconds = 0;
  const store = new Proxy(environment.store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "listProjects") {
        return (...args: unknown[]) => {
          listProjectCalls += 1;
          if (failNextProjectList) {
            failNextProjectList = false;
            throw new Error("project list unavailable");
          }
          return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const coordinator = new IndexCoordinator(
    environment.settings,
    store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return { close: () => { watchedRoots.delete(root); } };
    },
  );

  try {
    await mkdir(firstChild);
    await writeFile(path.join(firstChild, "first.ts"), "export const first = true;", "utf8");
    await coordinator.indexProject(environment.projectRootPath, "full");
    await coordinator.indexProject(firstChild, "full");
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");
    assert.deepEqual([...watchedRoots].sort(), [environment.projectRootPath, firstChild].sort());

    await mkdir(secondChild);
    await writeFile(path.join(secondChild, "second.ts"), "export const second = true;", "utf8");
    failNextProjectList = true;
    await coordinator.indexProject(secondChild, "full");
    const listCallsAfterFailure = listProjectCalls;
    const pendingRoots = (
      coordinator as unknown as { pendingAutomaticOwnershipRefreshRoots: Set<string> }
    ).pendingAutomaticOwnershipRefreshRoots;
    assert.equal(pendingRoots.has(secondChild), true);
    assert.equal(coordinator.isWatching(environment.projectRootPath), true);

    await coordinator.indexProject(secondChild, "full");

    assert.equal(listProjectCalls, listCallsAfterFailure + 1);
    assert.equal(pendingRoots.size, 0);
    assert.deepEqual([...watchedRoots].sort(), [firstChild, secondChild].sort());
    assert.equal(coordinator.isWatching(environment.projectRootPath), false);
  } finally {
    coordinator.stopAutomaticUpdates();
    await environment.cleanup();
  }
});

test("re-indexing an existing project does not refresh all automatic ownership", async () => {
  const environment = await createTestProjectEnvironment({
    "source.ts": "export const value = 1;",
  });
  environment.settings.autoWatch = true;
  environment.settings.watchReconcileSeconds = 0;
  let inspectionCalls = 0;
  let listProjectCalls = 0;
  const store = new Proxy(environment.store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "listProjects") {
        return (...args: unknown[]) => {
          listProjectCalls += 1;
          return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const coordinator = new IndexCoordinator(
    environment.settings,
    store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    async () => {
      inspectionCalls += 1;
      return { isDirectory: () => true };
    },
  );

  try {
    await coordinator.indexProject(environment.projectRootPath, "full");
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");
    inspectionCalls = 0;
    listProjectCalls = 0;

    await coordinator.indexProject(environment.projectRootPath, "full");

    assert.equal(listProjectCalls, 0);
    assert.equal(inspectionCalls, 0);
  } finally {
    coordinator.stopAutomaticUpdates();
    await environment.cleanup();
  }
});

test("periodic reconciliation refreshes aggregate ownership before indexing", async () => {
  const parentProject = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-periodic-hierarchy-"));
  const firstChild = path.join(parentProject, "first-child");
  const secondChild = path.join(parentProject, "second-child");
  const watchedRoots = new Set<string>();
  const indexedRoots: string[] = [];
  let registeredRoots = [parentProject, firstChild];

  class PeriodicHierarchyCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      indexedRoots.push(root);
      return cachedResult(root);
    }
  }

  const coordinator = new PeriodicHierarchyCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      listProjects: () => registeredRoots.map((projectRootPath) => ({ projectRootPath })),
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return { close: () => { watchedRoots.delete(root); } };
    },
  );

  try {
    await Promise.all([mkdir(firstChild), mkdir(secondChild)]);
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");
    assert.deepEqual([...watchedRoots].sort(), [parentProject, firstChild].sort());

    indexedRoots.length = 0;
    registeredRoots = [parentProject, firstChild, secondChild];
    await coordinator.reconcileWatchedProjects("periodic");

    assert.deepEqual([...watchedRoots].sort(), [firstChild, secondChild].sort());
    assert.deepEqual([...new Set(indexedRoots)].sort(), [firstChild, secondChild].sort());
  } finally {
    coordinator.stopAutomaticUpdates();
    await rm(parentProject, { force: true, recursive: true });
  }
});

test("startup reconciliation still indexes a clean unchanged Git project", async () => {
  const fixture = await createPeriodicReconcileFixture();
  try {
    assert.ok(fixture.startupIndexRuns >= 1);
    assert.equal(fixture.startupGitReads, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("startup reconciliation fully retries a persisted file failure", async () => {
  const environment = await createTestProjectEnvironment({
    "source.ts": "export const value = 1;",
  });
  environment.settings.autoWatch = true;
  environment.settings.watchReconcileSeconds = 0;
  const initialIndex = await environment.indexCoordinator.indexProject(
    environment.projectRootPath,
    "full",
  );
  await recordPersistedIndexFailure(environment, initialIndex.projectId);
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
  );

  try {
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");

    const latestEvent = environment.store.getLatestIndexEvent(initialIndex.projectId);
    assert.equal(latestEvent?.failedFileCount, 0);
    assert.equal(latestEvent?.indexedFiles, 1);
  } finally {
    coordinator.stopAutomaticUpdates();
    await environment.cleanup();
  }
});

test("explicit incremental indexing fully retries a persisted file failure", async () => {
  const environment = await createTestProjectEnvironment({
    "source.ts": "export const value = 1;",
  });

  try {
    const initialIndex = await environment.indexCoordinator.indexProject(
      environment.projectRootPath,
      "full",
    );
    await recordPersistedIndexFailure(environment, initialIndex.projectId);

    const result = await environment.indexCoordinator.indexProject(
      environment.projectRootPath,
      "incremental",
    );

    assert.equal(result.failedFileCount, 0);
    assert.equal(result.indexedFiles, 1);
  } finally {
    await environment.cleanup();
  }
});

test("incremental indexing forces a full retry while the persisted project is not ready", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });

  try {
    const initial = await environment.indexCoordinator.indexProject(environment.projectRootPath, "full");
    for (const status of ["indexing", "error"] as const) {
      environment.store.upsertProject(
        initial.projectId,
        initial.project,
        status,
        new Date().toISOString(),
      );

      const recovered = await environment.indexCoordinator.indexProject(
        environment.projectRootPath,
        "incremental",
      );
      assert.equal(recovered.changedFiles, 1, `${status} did not force a full retry`);
      assert.equal(environment.store.getProjectByRoot(environment.projectRootPath)?.status, "ready");
    }
  } finally {
    await environment.cleanup();
  }
});

test("a failed file index stays non-ready and freshness retries it after the file recovers", async () => {
  const source = "export const value = 1;\n";
  const environment = await createTestProjectEnvironment({ "src/index.ts": source });
  environment.settings.indexFreshness = "stale";
  environment.settings.indexFreshnessSeconds = 60;
  let removed = false;

  try {
    const failed = await environment.indexCoordinator.indexProject(
      environment.projectRootPath,
      "full",
      (event) => {
        if (!removed && event.phase === "detect" && event.status === "done") {
          removed = true;
          unlinkSync(path.join(environment.projectRootPath, "src/index.ts"));
        }
      },
    );
    const failedProject = environment.store.getProjectByRoot(environment.projectRootPath);
    const failedEvent = environment.store.getLatestIndexEvent(failed.projectId);

    assert.equal(failed.failedFileCount, 1);
    assert.equal(failedProject?.status, "error");
    assert.equal(failedEvent?.failedFileCount, 1);

    await writeFile(path.join(environment.projectRootPath, "src/index.ts"), source, "utf8");
    const recovered = await environment.indexCoordinator.ensureFreshIndex(environment.projectRootPath);
    assert.equal(recovered.failedFileCount, 0);
    assert.equal(recovered.indexedFiles, 1);
    assert.equal(environment.store.getProjectByRoot(environment.projectRootPath)?.status, "ready");
  } finally {
    await environment.cleanup();
  }
});

test("restart warmup cannot restore a persisted failed index event as fresh", async () => {
  const source = "export const value = 1;\n";
  const environment = await createTestProjectEnvironment({ "src/index.ts": source });
  environment.settings.indexFreshness = "manual";
  let removed = false;
  let restartedCoordinator: IndexCoordinator | undefined;

  try {
    const failed = await environment.indexCoordinator.indexProject(
      environment.projectRootPath,
      "full",
      (event) => {
        if (!removed && event.phase === "detect" && event.status === "done") {
          removed = true;
          unlinkSync(path.join(environment.projectRootPath, "src/index.ts"));
        }
      },
    );
    const persistedStats = environment.store.getProjectStats(environment.projectRootPath);
    assert.equal(persistedStats?.status, "error");
    assert.equal(persistedStats?.latestIndexEvent?.failedFileCount, 1);

    await environment.indexCoordinator.close();
    await writeFile(path.join(environment.projectRootPath, "src/index.ts"), source, "utf8");
    restartedCoordinator = new IndexCoordinator(
      environment.settings,
      environment.store,
      { debug() {}, info() {}, warn() {} } as never,
      environment.embeddingProvider,
      noOpWatchFactory,
      undefined,
      undefined,
      createSynchronousIndexStorageWorker(environment.store),
    );
    restartedCoordinator.restoreFreshnessState(environment.projectRootPath, {
      ...persistedStats!.latestIndexEvent!,
      project: failed.project,
      projectId: failed.projectId,
      projectRootPath: failed.projectRootPath,
    });

    const recovered = await restartedCoordinator.ensureFreshIndex(environment.projectRootPath);
    assert.equal(recovered.failedFileCount, 0);
    assert.equal(recovered.indexedFiles, 1);
    assert.equal(environment.store.getProjectByRoot(environment.projectRootPath)?.status, "ready");
  } finally {
    await restartedCoordinator?.close();
    await environment.cleanup();
  }
});

test("periodic reconciliation skips a clean unchanged Git project before indexing", async () => {
  const fixture = await createPeriodicReconcileFixture();
  try {
    await fixture.coordinator.reconcileWatchedProjects("periodic");

    assert.equal(fixture.indexRuns, 0);
    assert.equal(fixture.gitReads, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("periodic reconciliation retries persisted file failures before allowing a clean Git skip", async () => {
  const environment = await createTestProjectEnvironment({
    "source.ts": "export const value = 1;",
  });
  environment.settings.autoWatch = true;
  environment.settings.watchReconcileSeconds = 0;
  const initialIndex = await environment.indexCoordinator.indexProject(environment.projectRootPath, "full");
  environment.store.updateProjectAfterIndex(
    initialIndex.projectId,
    new Date().toISOString(),
    "ready",
    false,
    "indexed-commit",
  );

  const indexModes: Array<"full" | "incremental"> = [];
  let gitReads = 0;
  const recordEvent = (createdAt: string, failedFiles: Array<{ filePath: string; message: string }>) => {
    environment.store.recordIndexEvent(initialIndex.projectId, {
      changedFiles: 0,
      chunkCount: 0,
      createdAt,
      deletedFiles: 0,
      failedFiles,
      indexedFiles: 0,
      metadata: {
        timings: { collectMs: 0, detectMs: 0, indexMs: 0, totalMs: 0, vectorMs: 0 },
        vectorIndex: { enabled: false, hydratedChunkCount: 0, mode: "lazy" },
      },
      scannedFiles: 1,
    });
  };

  class PersistentFailureCoordinator extends IndexCoordinator {
    public override async indexProject(
      root: string,
      mode: "full" | "incremental" = "incremental",
      onProgress?: Parameters<IndexCoordinator["indexProject"]>[2],
      origin: "automatic" | "explicit" = "explicit",
    ): Promise<IndexProjectResult> {
      indexModes.push(mode);
      return super.indexProject(root, mode, onProgress, origin);
    }
  }

  const coordinator = new PersistentFailureCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    async () => ({ isDirectory: () => true }),
    async () => {
      gitReads += 1;
      return cleanPeriodicGitStatus;
    },
  );

  try {
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");
    indexModes.length = 0;
    gitReads = 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    recordEvent(new Date().toISOString(), [
      { filePath: "source.ts", message: "parse failed" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const watchStatus = coordinator.getWatchStatuses()[0];
    assert.equal(watchStatus.dirty, false);
    assert.equal(watchStatus.failureCount, 0);

    await coordinator.reconcileWatchedProjects("periodic");
    assert.deepEqual(indexModes, ["full"]);
    assert.equal(gitReads, 0);
    const latestEvent = environment.store.getLatestIndexEvent(initialIndex.projectId);
    assert.equal(latestEvent?.failedFileCount, 0);
    assert.equal(latestEvent?.indexedFiles, 1);

    await coordinator.reconcileWatchedProjects("periodic");
    assert.deepEqual(indexModes, ["full"]);
    assert.equal(gitReads, 1);
  } finally {
    coordinator.stopAutomaticUpdates();
    await environment.cleanup();
  }
});

test("periodic reconciliation does not index after automatic updates stop during Git preflight", async () => {
  const gitReadStarted = deferred<void>();
  const releaseGitStatus = deferred<PeriodicGitStatus>();
  const fixture = await createPeriodicReconcileFixture({
    gitStatusReader: async () => {
      gitReadStarted.resolve();
      return releaseGitStatus.promise;
    },
  });
  try {
    const periodic = fixture.coordinator.reconcileWatchedProjects("periodic");
    await gitReadStarted.promise;

    fixture.coordinator.stopAutomaticUpdates();
    releaseGitStatus.resolve(cleanPeriodicGitStatus);
    await periodic;

    assert.equal(fixture.indexRuns, 0);
  } finally {
    releaseGitStatus.resolve(cleanPeriodicGitStatus);
    await fixture.cleanup();
  }
});

const periodicFallbackCases: Array<{
  expectedGitReads: number;
  gitStatus?: PeriodicGitStatus;
  gitStatusError?: Error;
  lastIndexedCommit?: string | null;
  name: string;
  prepare?: (fixture: Awaited<ReturnType<typeof createPeriodicReconcileFixture>>) => void;
}> = [
  {
    expectedGitReads: 0,
    name: "a dirty watcher",
    prepare: (fixture) => fixture.setWatchState({ dirty: true }),
  },
  {
    expectedGitReads: 0,
    name: "an inactive watcher that restarts",
    prepare: (fixture) => fixture.setWatchState({ active: false }),
  },
  {
    expectedGitReads: 0,
    name: "an inactive watcher that cannot restart",
    prepare: (fixture) => {
      fixture.setWatchState({ active: false });
      fixture.failWatcherRestarts();
    },
  },
  {
    expectedGitReads: 0,
    name: "a watcher with prior failures",
    prepare: (fixture) => fixture.setWatchState({ failureCount: 1 }),
  },
  {
    expectedGitReads: 0,
    name: "a watcher already processing changes",
    prepare: (fixture) => fixture.setWatchState({ processing: true }),
  },
  {
    expectedGitReads: 0,
    name: "an in-flight project index",
    prepare: (fixture) => fixture.setInFlight(),
  },
  {
    expectedGitReads: 0,
    lastIndexedCommit: null,
    name: "missing persisted commit metadata",
  },
  {
    expectedGitReads: 1,
    gitStatus: {
      changedFiles: [],
      currentCommit: "current-commit",
      isGitRepo: true,
      reliable: false,
      untrackedFiles: [],
    },
    name: "an unreliable Git status",
  },
  {
    expectedGitReads: 1,
    gitStatus: {
      ...cleanPeriodicGitStatus,
      changedFiles: ["source.ts"],
    },
    name: "a tracked Git change",
  },
  {
    expectedGitReads: 1,
    gitStatus: {
      ...cleanPeriodicGitStatus,
      untrackedFiles: ["new.ts"],
    },
    name: "an untracked Git file",
  },
  {
    expectedGitReads: 1,
    gitStatusError: new Error("git unavailable"),
    name: "a Git status read failure",
  },
];

for (const scenario of periodicFallbackCases) {
  test(`periodic reconciliation keeps the normal index path for ${scenario.name}`, async () => {
    const fixture = await createPeriodicReconcileFixture({
      gitStatus: scenario.gitStatus,
      gitStatusError: scenario.gitStatusError,
      lastIndexedCommit: scenario.lastIndexedCommit,
    });
    try {
      scenario.prepare?.(fixture);
      await fixture.coordinator.reconcileWatchedProjects("periodic");

      assert.equal(fixture.indexRuns, 1);
      assert.equal(fixture.gitReads, scenario.expectedGitReads);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("a superseded periodic refresh waits for the newer aggregate ownership snapshot", async () => {
  const environment = await createTestProjectEnvironment({
    "parent.ts": "export const parent = true;",
  });
  const firstChild = path.join(environment.projectRootPath, "first-child");
  const secondChild = path.join(environment.projectRootPath, "second-child");
  const oldInspection = deferred<{ isDirectory(): boolean } | null>();
  const newInspection = deferred<{ isDirectory(): boolean } | null>();
  const automaticRuns: string[] = [];
  let blockOldRefresh = false;
  let blockNewRefresh = false;
  let oldInspectionStarted = false;
  let newInspectionStarted = false;

  class ConcurrentHierarchyCoordinator extends IndexCoordinator {
    public override async indexProject(
      root: string,
      mode: "full" | "incremental" = "incremental",
      onProgress?: Parameters<IndexCoordinator["indexProject"]>[2],
      origin: "automatic" | "explicit" = "explicit",
    ): Promise<IndexProjectResult> {
      if (origin === "automatic") {
        automaticRuns.push(root);
        return cachedResult(root);
      }
      return super.indexProject(root, mode, onProgress, origin);
    }
  }

  environment.settings.autoWatch = true;
  environment.settings.watchReconcileSeconds = 0;
  const coordinator = new ConcurrentHierarchyCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    async (root) => {
      if (blockOldRefresh && root === environment.projectRootPath && !oldInspectionStarted) {
        oldInspectionStarted = true;
        return oldInspection.promise;
      }
      if (blockNewRefresh && root === firstChild && !newInspectionStarted) {
        newInspectionStarted = true;
        return newInspection.promise;
      }
      return { isDirectory: () => true };
    },
  );
  let periodic: Promise<void> | undefined;
  let registration: Promise<IndexProjectResult> | undefined;

  try {
    await mkdir(firstChild);
    await writeFile(path.join(firstChild, "first.ts"), "export const first = true;", "utf8");
    await coordinator.indexProject(environment.projectRootPath, "full");
    await coordinator.indexProject(firstChild, "full");
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");
    automaticRuns.length = 0;

    blockOldRefresh = true;
    periodic = coordinator.reconcileWatchedProjects("periodic");
    await waitFor(() => oldInspectionStarted);

    await mkdir(secondChild);
    await writeFile(path.join(secondChild, "second.ts"), "export const second = true;", "utf8");
    blockNewRefresh = true;
    registration = coordinator.indexProject(secondChild, "full");
    await waitFor(() => newInspectionStarted);

    oldInspection.resolve({ isDirectory: () => true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(automaticRuns, [], "periodic reconcile must wait for the newer ownership snapshot");

    newInspection.resolve({ isDirectory: () => true });
    await Promise.all([periodic, registration]);
    assert.deepEqual([...new Set(automaticRuns)].sort(), [firstChild, secondChild].sort());
    assert.equal(coordinator.isWatching(environment.projectRootPath), false);
  } finally {
    oldInspection.resolve(null);
    newInspection.resolve(null);
    const pending: Promise<unknown>[] = [];
    if (periodic) pending.push(periodic);
    if (registration) pending.push(registration);
    await Promise.allSettled(pending);
    coordinator.stopAutomaticUpdates();
    await environment.cleanup();
  }
});

test("stopping a project during inspection keeps it out of automatic ownership", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-stop-during-refresh-"));
  const inspection = deferred<{ isDirectory(): boolean } | null>();
  let blockInspection = false;
  let inspectionStarted = false;

  class StopDuringRefreshCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new StopDuringRefreshCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    { listProjects: () => [{ projectRootPath }] } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    noOpWatchFactory,
    async () => {
      if (blockInspection && !inspectionStarted) {
        inspectionStarted = true;
        return inspection.promise;
      }
      return { isDirectory: () => true };
    },
  );

  try {
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");
    blockInspection = true;
    const periodic = coordinator.reconcileWatchedProjects("periodic");
    await waitFor(() => inspectionStarted);

    coordinator.stopWatching(projectRootPath);
    inspection.resolve({ isDirectory: () => true });
    await periodic;

    const automaticProjectRoots = (coordinator as unknown as { automaticProjectRoots: Set<string> }).automaticProjectRoots;
    assert.equal(automaticProjectRoots.has(projectRootPath), false);
    assert.equal(coordinator.isWatching(projectRootPath), false);
  } finally {
    inspection.resolve(null);
    coordinator.stopAutomaticUpdates();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("a stale startup refresh cannot revive old watchers after automatic updates restart", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-hierarchy-restart-"));
  const oldProject = path.join(tempDir, "old-project");
  const newProject = path.join(tempDir, "new-project");
  const oldInspection = deferred<{ isDirectory(): boolean } | null>();
  const watchedRoots = new Set<string>();
  let oldInspectionStarted = false;
  let registeredRoots = [oldProject];

  class RestartHierarchyCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new RestartHierarchyCoordinator(
    { autoWatch: true, indexConcurrency: 1, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      listProjects: () => registeredRoots.map((projectRootPath) => ({ projectRootPath })),
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return { close: () => { watchedRoots.delete(root); } };
    },
    async (root) => {
      if (root === oldProject) {
        oldInspectionStarted = true;
        return oldInspection.promise;
      }
      return { isDirectory: () => true };
    },
  );

  try {
    await Promise.all([mkdir(oldProject), mkdir(newProject)]);
    const firstStart = coordinator.startAutomaticUpdates();
    await waitFor(() => oldInspectionStarted);

    coordinator.stopAutomaticUpdates();
    registeredRoots = [newProject];
    await coordinator.startAutomaticUpdates();
    assert.deepEqual([...watchedRoots], [newProject]);

    oldInspection.resolve({ isDirectory: () => true });
    await firstStart;

    assert.deepEqual([...watchedRoots], [newProject]);
    assert.equal(coordinator.isWatching(oldProject), false);
  } finally {
    oldInspection.resolve(null);
    coordinator.stopAutomaticUpdates();
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("explicit indexing remains allowed for an automatically suppressed aggregate parent", async () => {
  const environment = await createTestProjectEnvironment({
    "parent.ts": "export const parent = true;",
  });
  const firstChild = path.join(environment.projectRootPath, "first-child");
  const secondChild = path.join(environment.projectRootPath, "second-child");
  environment.settings.autoWatch = true;
  environment.settings.watchReconcileSeconds = 0;
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
  );

  try {
    await Promise.all([mkdir(firstChild), mkdir(secondChild)]);
    await Promise.all([
      writeFile(path.join(firstChild, "first.ts"), "export const first = true;", "utf8"),
      writeFile(path.join(secondChild, "second.ts"), "export const second = true;", "utf8"),
    ]);
    await coordinator.indexProject(environment.projectRootPath, "full");
    await coordinator.indexProject(firstChild, "full");
    await coordinator.indexProject(secondChild, "full");
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");
    assert.equal(coordinator.isWatching(environment.projectRootPath), false);

    const result = await coordinator.indexProject(environment.projectRootPath, "incremental");

    assert.equal(result.projectRootPath, environment.projectRootPath);
    assert.equal(coordinator.isWatching(environment.projectRootPath), false);
  } finally {
    coordinator.stopAutomaticUpdates();
    await environment.cleanup();
  }
});

test("explicit indexing restores automatic ownership after reusing an automatic in-flight index", async () => {
  const embeddingStarted = deferred<void>();
  const releaseEmbedding = deferred<void>();

  class BlockingEmbeddingProvider extends InMemoryEmbeddingProvider {
    public blocked = false;

    public override async embedBatch(texts: string[]): Promise<number[][]> {
      if (this.blocked) {
        embeddingStarted.resolve();
        await releaseEmbedding.promise;
      }
      return super.embedBatch(texts);
    }
  }

  const provider = new BlockingEmbeddingProvider();
  const environment = await createTestProjectEnvironment(
    { "source.ts": "export const value = 1;" },
    provider,
  );
  environment.settings.autoWatch = true;
  environment.settings.vectorIndexingMode = "eager";
  environment.settings.watchReconcileSeconds = 0;
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    provider,
    noOpWatchFactory,
  );

  try {
    await coordinator.indexProject(environment.projectRootPath, "full");
    provider.blocked = true;
    await writeFile(
      path.join(environment.projectRootPath, "source.ts"),
      "export const value = 2;",
      "utf8",
    );
    await coordinator.startAutomaticUpdates();
    await embeddingStarted.promise;

    coordinator.stopWatching(environment.projectRootPath);
    const explicitIndex = coordinator.indexProject(environment.projectRootPath, "incremental");
    releaseEmbedding.resolve();
    await explicitIndex;

    const internal = coordinator as unknown as {
      automaticProjectRoots: Set<string>;
      suppressedProjectRoots: Set<string>;
    };
    assert.equal(coordinator.isWatching(environment.projectRootPath), true);
    assert.equal(internal.automaticProjectRoots.has(environment.projectRootPath), true);
    assert.equal(internal.suppressedProjectRoots.has(environment.projectRootPath), false);
  } finally {
    releaseEmbedding.resolve();
    coordinator.stopAutomaticUpdates();
    await environment.cleanup();
  }
});

test("automatic catch-up continues when recursive file watching is unavailable", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-unavailable-"));
  const indexedRoots: string[] = [];
  const settings = {
    autoWatch: true,
    indexConcurrency: 1,
    watchReconcileSeconds: 0,
  } as unknown as Settings;

  class CatchUpIndexCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      indexedRoots.push(root);
      return cachedResult(root);
    }
  }

  const coordinator = new CatchUpIndexCoordinator(
    settings,
    { listProjects: () => [{ projectRootPath }] } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    () => {
      throw new Error("recursive watch is unavailable");
    },
  );

  try {
    await coordinator.startAutomaticUpdates();
    await waitFor(() => indexedRoots.length === 1);

    assert.equal(coordinator.isWatching(projectRootPath), false);
    assert.deepEqual(indexedRoots, [projectRootPath]);
  } finally {
    coordinator.stopAutomaticUpdates?.();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("explicit indexing does not start a watcher before automatic updates are started", async () => {
  const environment = await createTestProjectEnvironment({
    "source.ts": "export const value = 1;",
  });
  environment.settings.autoWatch = true;
  let watchStarts = 0;
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    () => {
      watchStarts += 1;
      return { close() {} };
    },
  );

  try {
    await coordinator.indexProject(environment.projectRootPath, "incremental");

    assert.equal(watchStarts, 0);
    assert.equal(coordinator.isWatching(environment.projectRootPath), false);
  } finally {
    coordinator.stopAutomaticUpdates?.();
    await environment.cleanup();
  }
});

test("successful indexing is not failed when automatic watching is unavailable", async () => {
  const environment = await createTestProjectEnvironment({
    "source.ts": "export const value = 1;",
  });
  environment.settings.autoWatch = true;
  environment.settings.watchReconcileSeconds = 0;
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    () => {
      throw new Error("recursive watch is unavailable");
    },
  );

  try {
    await coordinator.startAutomaticUpdates();
    const result = await coordinator.indexProject(environment.projectRootPath, "incremental");

    assert.equal(result.indexedFiles, 1);
    assert.equal(environment.store.getProjectStats(environment.projectRootPath)?.status, "ready");
  } finally {
    coordinator.stopAutomaticUpdates?.();
    await environment.cleanup();
  }
});

test("periodic reconciliation includes projects first indexed after startup", async () => {
  const environment = await createTestProjectEnvironment({
    "source.ts": "export const firstVersion = 1;",
  });
  environment.settings.autoWatch = true;
  environment.settings.watchReconcileSeconds = 0;
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    () => {
      throw new Error("recursive watch is unavailable");
    },
  );

  try {
    await coordinator.startAutomaticUpdates();
    await coordinator.indexProject(environment.projectRootPath, "incremental");
    await writeFile(
      path.join(environment.projectRootPath, "source.ts"),
      "export const secondVersion = 2;",
      "utf8",
    );

    await coordinator.reconcileWatchedProjects("periodic");
    const search = await environment.searchService.search(
      environment.projectRootPath,
      "secondVersion",
      "lexical",
      5,
    );

    assert.ok(search.results.some((result) => result.filePath === "source.ts"));
  } finally {
    coordinator.stopAutomaticUpdates?.();
    await environment.cleanup();
  }
});

test("records runtime watcher errors without crashing the coordinator", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-error-"));
  let errorListener: ((error: Error) => void) | undefined;
  const coordinator = new IndexCoordinator(
    { autoWatch: false } as unknown as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    () => ({
      close() {},
      on: (event: string, listener: (error: Error) => void) => {
        if (event === "error") errorListener = listener;
      },
    }),
  );

  try {
    coordinator.startWatching(projectRootPath);
    assert.notEqual(errorListener, undefined);

    errorListener?.(new Error("watch handle failed"));

    const status = coordinator.getWatchStatuses()[0];
    assert.equal(status.dirty, true);
    assert.equal(status.failureCount, 1);
    assert.equal(status.lastError, "watch handle failed");
  } finally {
    coordinator.stopWatching();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("watch health summary reports exhausted projects as degraded", async () => {
  const activeRoot = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-health-active-"));
  const exhaustedRoot = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-health-exhausted-"));
  const errorListeners = new Map<string, (error: Error) => void>();
  const coordinator = new IndexCoordinator(
    { autoWatch: false } as unknown as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => ({
      close() {},
      on: (event: string, listener: (error: Error) => void) => {
        if (event === "error") errorListeners.set(root, listener);
      },
    }),
    undefined,
    undefined,
    undefined,
    { circuitFailureThreshold: 20, maxAttempts: 1 },
  );

  try {
    coordinator.startWatching(activeRoot);
    coordinator.startWatching(exhaustedRoot);
    errorListeners.get(exhaustedRoot)?.(Object.assign(new Error("too many open files"), { code: "EMFILE" }));

    assert.deepEqual(coordinator.getWatchHealthSummary(), {
      active: 1,
      circuitOpen: false,
      expected: 2,
      exhausted: 1,
      periodicOnly: 0,
      retrying: 0,
      status: "degraded",
    });
  } finally {
    coordinator.stopWatching();
    await Promise.all([
      rm(activeRoot, { force: true, recursive: true }),
      rm(exhaustedRoot, { force: true, recursive: true }),
    ]);
  }
});

test("retries repeated watcher failures then resets recovery budgets after a stable window", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-recover-"));
  const errorListeners: Array<(error: Error) => void> = [];
  let indexRuns = 0;
  let watchCount = 0;

  class RecoveringIndexCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      indexRuns += 1;
      return cachedResult(root);
    }
  }

  const recoveryOptions = {
    baseDelayMs: 20,
    circuitFailureThreshold: 20,
    jitterRatio: 0,
    maxAttempts: 4,
    maxDelayMs: 40,
    stableResetMs: 30,
  };
  const coordinator = new RecoveringIndexCoordinator(
    { autoWatch: true, watchDebounceMs: 5, watchMaxWaitMs: 20 } as unknown as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    () => {
      watchCount += 1;
      return {
        close() {},
        on: (event: string, listener: (error: Error) => void) => {
          if (event === "error") errorListeners.push(listener);
        },
      };
    },
    undefined,
    undefined,
    undefined,
    recoveryOptions,
  );

  try {
    coordinator.startWatching(projectRootPath);
    errorListeners[0]?.(Object.assign(new Error("watch handle failed"), { code: "EMFILE" }));
    errorListeners[0]?.(Object.assign(new Error("duplicate watch handle failure"), { code: "EMFILE" }));

    assert.equal(coordinator.isWatching(projectRootPath), false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(watchCount, 1, "watcher recreation must not run in the same failure turn");
    assert.equal(indexRuns, 0, "watcher recovery must not trigger an incremental index");
    assert.equal(coordinator.getWatchStatuses()[0]?.retryDelayMs, 20);
    assert.equal(coordinator.getWatchStatuses()[0]?.retrying, true);

    await waitFor(() => watchCount === 2);
    assert.equal(coordinator.isWatching(projectRootPath), true);
    assert.equal(indexRuns, 0);

    errorListeners[1]?.(Object.assign(new Error("watch handle failed again"), { code: "EMFILE" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(watchCount, 2, "a second EMFILE must use the next backoff interval");
    assert.equal(coordinator.getWatchStatuses()[0]?.retryDelayMs, 40);
    await waitFor(() => watchCount === 3);
    assert.equal(indexRuns, 0);
    assert.equal(coordinator.getWatchStatuses()[0]?.retryAttempts, 2);
    await waitFor(() => coordinator.getWatchStatuses()[0]?.retryAttempts === 0);
    const stableStatus = coordinator.getWatchStatuses()[0] as unknown as {
      circuitFailureCount?: number;
      stabilizing?: boolean;
    };
    assert.equal(stableStatus.circuitFailureCount, 0);
    assert.equal(stableStatus.stabilizing, false);
  } finally {
    coordinator.stopWatching();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("stop and close clear recovered watcher stability timers", async (t) => {
  for (const action of ["stop", "close"] as const) {
    await t.test(action, async () => {
      const projectRootPath = await mkdtemp(path.join(os.tmpdir(), `ace-mcp-watch-stable-${action}-`));
      let errorListener: ((error: Error) => void) | undefined;
      let watchCount = 0;
      const recoveryOptions = {
        baseDelayMs: 5,
        circuitFailureThreshold: 20,
        jitterRatio: 0,
        stableResetMs: 1_000,
      };
      const coordinator = new IndexCoordinator(
        { autoWatch: false } as unknown as Settings,
        {} as never,
        { debug() {}, info() {}, warn() {} } as never,
        {} as EmbeddingProvider,
        () => {
          watchCount += 1;
          return {
            close() {},
            on: (event: string, listener: (error: Error) => void) => {
              if (event === "error" && watchCount === 1) errorListener = listener;
            },
          };
        },
        undefined,
        undefined,
        undefined,
        recoveryOptions,
      );

      try {
        coordinator.startWatching(projectRootPath);
        errorListener?.(Object.assign(new Error("too many open files"), { code: "EMFILE" }));
        await waitFor(() => watchCount === 2);

        const state = (coordinator as unknown as {
          watchers: Map<string, { watchStabilityTimer?: NodeJS.Timeout }>;
        }).watchers.get(projectRootPath);
        const stabilityTimer = state?.watchStabilityTimer;
        assert.ok(stabilityTimer, "recovered watcher must have a pending stability timer");

        if (action === "close") {
          await coordinator.close();
        } else {
          coordinator.stopWatching(projectRootPath);
        }
        assert.equal(
          (stabilityTimer as unknown as { _destroyed?: boolean })._destroyed,
          true,
          `${action} must destroy the pending stability timer`,
        );
      } finally {
        await coordinator.close();
        await rm(projectRootPath, { force: true, recursive: true });
      }
    });
  }
});

test("synchronous watcher construction failures retain bounded retry diagnostics", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-sync-failure-"));
  let watchCount = 0;

  class NoReconcileCoordinator extends IndexCoordinator {
    public override reconcileWatchedProjects(): Promise<void> {
      return Promise.resolve();
    }
  }

  const coordinator = new NoReconcileCoordinator(
    { autoWatch: true, watchReconcileSeconds: 0 } as unknown as Settings,
    { listProjects: () => [{ projectRootPath }] } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    () => {
      watchCount += 1;
      throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
    },
    undefined,
    undefined,
    undefined,
    {
      baseDelayMs: 10,
      circuitFailureThreshold: 20,
      jitterRatio: 0,
      maxAttempts: 3,
      maxDelayMs: 20,
    },
  );

  try {
    await coordinator.startAutomaticUpdates();

    assert.equal(watchCount, 1);
    assert.equal(coordinator.getWatchStatuses()[0]?.retryDelayMs, 10);
    await waitFor(() => watchCount === 2);
    assert.equal(coordinator.getWatchStatuses()[0]?.retryDelayMs, 20);
    await waitFor(() => watchCount === 3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(watchCount, 3, "the retry cap must stop autonomous watcher recreation");
    assert.equal(coordinator.getWatchStatuses()[0]?.retrying, false);
    assert.equal(coordinator.getWatchStatuses()[0]?.retryAttempts, 3);
  } finally {
    coordinator.stopAutomaticUpdates();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("global watcher circuit defers new watch registrations until cooldown", async () => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-circuit-first-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-circuit-second-"));
  const attemptedRoots: string[] = [];

  class NoReconcileCoordinator extends IndexCoordinator {
    public override reconcileWatchedProjects(): Promise<void> {
      return Promise.resolve();
    }
  }

  const coordinator = new NoReconcileCoordinator(
    { autoWatch: true, watchReconcileSeconds: 0 } as unknown as Settings,
    { listProjects: () => [{ projectRootPath: firstRoot }, { projectRootPath: secondRoot }] } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => {
      attemptedRoots.push(root);
      throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
    },
    undefined,
    undefined,
    undefined,
    {
      baseDelayMs: 100,
      circuitFailureThreshold: 1,
      circuitResetMs: 100,
      jitterRatio: 0,
      maxAttempts: 3,
      maxDelayMs: 100,
    },
  );

  try {
    await coordinator.startAutomaticUpdates();

    assert.deepEqual(attemptedRoots, [firstRoot]);
    const statuses = coordinator.getWatchStatuses();
    assert.equal(statuses.length, 2);
    assert.ok(statuses.every((status) => status.circuitOpen));
    assert.ok(statuses.every((status) => status.retrying));
  } finally {
    coordinator.stopAutomaticUpdates();
    await Promise.all([
      rm(firstRoot, { force: true, recursive: true }),
      rm(secondRoot, { force: true, recursive: true }),
    ]);
  }
});

test("global watcher circuit logs only one transition for concurrent runtime failures", async () => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-circuit-log-first-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-circuit-log-second-"));
  const errorListeners = new Map<string, (error: Error) => void>();
  const warnings: string[] = [];
  const coordinator = new IndexCoordinator(
    { autoWatch: false } as unknown as Settings,
    {} as never,
    {
      debug() {},
      info() {},
      warn(message: string) {
        warnings.push(message);
      },
    } as never,
    {} as EmbeddingProvider,
    (root) => ({
      close() {},
      on: (event: string, listener: (error: Error) => void) => {
        if (event === "error") errorListeners.set(root, listener);
      },
    }),
    undefined,
    undefined,
    undefined,
    {
      baseDelayMs: 100,
      circuitFailureThreshold: 1,
      circuitResetMs: 100,
      jitterRatio: 0,
      maxDelayMs: 100,
    },
  );

  try {
    coordinator.startWatching(firstRoot);
    coordinator.startWatching(secondRoot);
    errorListeners.get(firstRoot)?.(Object.assign(new Error("first EMFILE"), { code: "EMFILE" }));
    errorListeners.get(secondRoot)?.(Object.assign(new Error("second EMFILE"), { code: "EMFILE" }));

    assert.equal(warnings.filter((message) => message === "file watch recovery circuit opened").length, 1);
  } finally {
    coordinator.stopWatching();
    await Promise.all([
      rm(firstRoot, { force: true, recursive: true }),
      rm(secondRoot, { force: true, recursive: true }),
    ]);
  }
});

test("an expired watcher circuit starts a fresh failure budget without a pending retry", async () => {
  const roots = await Promise.all(
    ["first", "second", "third"].map((name) =>
      mkdtemp(path.join(os.tmpdir(), `ace-mcp-watch-circuit-reset-${name}-`)),
    ),
  );
  const errorListeners = new Map<string, (error: Error) => void>();
  const coordinator = new IndexCoordinator(
    { autoWatch: false } as unknown as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => ({
      close() {},
      on: (event: string, listener: (error: Error) => void) => {
        if (event === "error") errorListeners.set(root, listener);
      },
    }),
    undefined,
    undefined,
    undefined,
    {
      baseDelayMs: 100,
      circuitFailureThreshold: 2,
      circuitResetMs: 20,
      jitterRatio: 0,
      maxAttempts: 1,
      maxDelayMs: 100,
    },
  );

  try {
    for (const root of roots) coordinator.startWatching(root);
    errorListeners.get(roots[0])?.(Object.assign(new Error("first EMFILE"), { code: "EMFILE" }));
    errorListeners.get(roots[1])?.(Object.assign(new Error("second EMFILE"), { code: "EMFILE" }));
    assert.ok(coordinator.getWatchStatuses().every((status) => status.circuitOpen));

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(coordinator.getWatchStatuses().every((status) => !status.circuitOpen));
    errorListeners.get(roots[2])?.(Object.assign(new Error("new-cycle EMFILE"), { code: "EMFILE" }));

    const statuses = coordinator.getWatchStatuses();
    assert.ok(statuses.every((status) => !status.circuitOpen));
    assert.ok(statuses.every((status) => status.circuitFailureCount === 1));
  } finally {
    coordinator.stopWatching();
    await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
  }
});

test("stopping automatic updates cancels pending watcher construction retries", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-stop-retry-"));
  let watchCount = 0;

  class NoReconcileCoordinator extends IndexCoordinator {
    public override reconcileWatchedProjects(): Promise<void> {
      return Promise.resolve();
    }
  }

  const coordinator = new NoReconcileCoordinator(
    { autoWatch: true, watchReconcileSeconds: 0 } as unknown as Settings,
    { listProjects: () => [{ projectRootPath }] } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    () => {
      watchCount += 1;
      throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
    },
    undefined,
    undefined,
    undefined,
    { baseDelayMs: 30, circuitFailureThreshold: 20, jitterRatio: 0 },
  );

  try {
    await coordinator.startAutomaticUpdates();
    assert.equal(coordinator.getWatchStatuses()[0]?.retrying, true);
    coordinator.stopAutomaticUpdates();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(watchCount, 1);
    assert.deepEqual(coordinator.getWatchStatuses(), []);
  } finally {
    coordinator.stopAutomaticUpdates();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("closing the coordinator cancels pending asynchronous watcher retries", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-close-retry-"));
  let errorListener: ((error: Error) => void) | undefined;
  let watchCount = 0;
  const coordinator = new IndexCoordinator(
    { autoWatch: false } as unknown as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    () => {
      watchCount += 1;
      return {
        close() {},
        on: (event: string, listener: (error: Error) => void) => {
          if (event === "error") errorListener = listener;
        },
      };
    },
    undefined,
    undefined,
    undefined,
    { baseDelayMs: 30, circuitFailureThreshold: 20, jitterRatio: 0 },
  );

  try {
    coordinator.startWatching(projectRootPath);
    errorListener?.(Object.assign(new Error("too many open files"), { code: "EMFILE" }));
    assert.equal(coordinator.getWatchStatuses()[0]?.retrying, true);
    await coordinator.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(watchCount, 1);
    assert.deepEqual(coordinator.getWatchStatuses(), []);
  } finally {
    await coordinator.close();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("a recovered watcher stays dirty for reconciliation fallback", async () => {
  const environment = await createTestProjectEnvironment({
    "source.ts": "export const value = 1;",
  });
  environment.settings.autoWatch = true;
  let errorListener: ((error: Error) => void) | undefined;
  let watchCount = 0;
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    () => {
      watchCount += 1;
      return {
        close() {},
        on: (event: string, listener: (error: Error) => void) => {
          if (event === "error" && watchCount === 1) errorListener = listener;
        },
      };
    },
    undefined,
    undefined,
    undefined,
    { baseDelayMs: 5, circuitFailureThreshold: 20, jitterRatio: 0 },
  );

  try {
    coordinator.startWatching(environment.projectRootPath);
    errorListener?.(new Error("watch handle failed"));
    await waitFor(() => watchCount === 2);

    const status = coordinator.getWatchStatuses()[0];
    assert.equal(status.watching, true);
    assert.equal(status.dirty, true);
    assert.equal(status.lastError, null);
  } finally {
    coordinator.stopWatching();
    await environment.cleanup();
  }
});

test("stopping automatic updates prevents an in-flight index from reviving watchers", async () => {
  const embeddingStarted = deferred<void>();
  const releaseEmbedding = deferred<void>();

  class PausedEmbeddingProvider extends InMemoryEmbeddingProvider {
    public override async embedBatch(texts: string[]): Promise<number[][]> {
      embeddingStarted.resolve();
      await releaseEmbedding.promise;
      return super.embedBatch(texts);
    }
  }

  const provider = new PausedEmbeddingProvider();
  const environment = await createTestProjectEnvironment(
    { "source.ts": "export const value = 1;" },
    provider,
  );
  environment.settings.autoWatch = true;
  environment.settings.vectorIndexingMode = "eager";
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    provider,
  );

  try {
    const indexing = coordinator.indexProject(environment.projectRootPath, "incremental");
    await embeddingStarted.promise;

    coordinator.stopAutomaticUpdates();
    releaseEmbedding.resolve();
    await indexing;

    assert.equal(coordinator.isWatching(), false);
  } finally {
    releaseEmbedding.resolve();
    coordinator.stopAutomaticUpdates?.();
    await environment.cleanup();
  }
});

test("failed paused project operations restore the previous watcher", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-pause-restore-"));
  const coordinator = new IndexCoordinator(
    { autoWatch: false } as unknown as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    noOpWatchFactory,
  );

  try {
    coordinator.startWatching(projectRootPath);

    await assert.rejects(
      coordinator.withProjectIndexPaused(projectRootPath, () => {
        throw new Error("delete failed");
      }),
      /delete failed/,
    );

    assert.equal(coordinator.isWatching(projectRootPath), true);
  } finally {
    coordinator.stopWatching();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("failed paused deletion does not restore a parent superseded by a newer ownership refresh", async () => {
  const parentProject = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-pause-refresh-superseded-"));
  const firstChild = path.join(parentProject, "first-child");
  const secondChild = path.join(parentProject, "second-child");
  const operationStarted = deferred<void>();
  const releaseOperation = deferred<void>();
  const watchedRoots = new Set<string>();
  let registeredRoots = [parentProject];

  class SupersededPauseCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new SupersededPauseCoordinator(
    { autoWatch: true, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      listProjects: () => registeredRoots.map((projectRootPath) => ({ projectRootPath })),
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return { close: () => { watchedRoots.delete(root); } };
    },
  );

  try {
    await Promise.all([mkdir(firstChild), mkdir(secondChild)]);
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");
    assert.deepEqual([...watchedRoots], [parentProject]);

    const pausedDeletion = coordinator.withProjectIndexPaused(parentProject, async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
      throw new Error("delete failed");
    });
    await operationStarted.promise;

    registeredRoots = [parentProject, firstChild, secondChild];
    await coordinator.refreshAutomaticProjectOwnership(secondChild);
    assert.deepEqual([...watchedRoots].sort(), [firstChild, secondChild].sort());

    releaseOperation.resolve();
    await assert.rejects(pausedDeletion, /delete failed/);

    assert.deepEqual([...watchedRoots].sort(), [firstChild, secondChild].sort());
    assert.equal(coordinator.isWatching(parentProject), false);
  } finally {
    releaseOperation.resolve();
    coordinator.stopAutomaticUpdates();
    await rm(parentProject, { force: true, recursive: true });
  }
});

test("failed paused deletion adopts aggregate ownership from a restarted generation", async () => {
  const parentProject = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-pause-refresh-restart-"));
  const firstChild = path.join(parentProject, "first-child");
  const secondChild = path.join(parentProject, "second-child");
  const operationStarted = deferred<void>();
  const releaseOperation = deferred<void>();
  const watchedRoots = new Set<string>();
  let registeredRoots = [parentProject];

  class RestartedPauseCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new RestartedPauseCoordinator(
    { autoWatch: true, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      listProjects: () => registeredRoots.map((projectRootPath) => ({ projectRootPath })),
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    (root) => {
      watchedRoots.add(root);
      return { close: () => { watchedRoots.delete(root); } };
    },
  );

  try {
    await Promise.all([mkdir(firstChild), mkdir(secondChild)]);
    await coordinator.startAutomaticUpdates();
    await coordinator.reconcileWatchedProjects("startup");

    const pausedDeletion = coordinator.withProjectIndexPaused(parentProject, async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
      throw new Error("delete failed");
    });
    await operationStarted.promise;

    coordinator.stopAutomaticUpdates();
    registeredRoots = [parentProject, firstChild, secondChild];
    await coordinator.startAutomaticUpdates();
    assert.deepEqual([...watchedRoots].sort(), [firstChild, secondChild].sort());

    releaseOperation.resolve();
    await assert.rejects(pausedDeletion, /delete failed/);

    assert.deepEqual([...watchedRoots].sort(), [firstChild, secondChild].sort());
    assert.equal(coordinator.isWatching(parentProject), false);
  } finally {
    releaseOperation.resolve();
    coordinator.stopAutomaticUpdates();
    await rm(parentProject, { force: true, recursive: true });
  }
});

test("failed paused operations preserve a concurrent user project stop", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-pause-user-stop-"));
  const operationStarted = deferred<void>();
  const releaseOperation = deferred<void>();

  class PausedUserStopCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new PausedUserStopCoordinator(
    { autoWatch: true, watchReconcileSeconds: 0 } as unknown as Settings,
    { listProjects: () => [{ projectRootPath }] } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    noOpWatchFactory,
  );

  try {
    await coordinator.startAutomaticUpdates();
    const paused = coordinator.withProjectIndexPaused(projectRootPath, async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
      throw new Error("delete failed");
    });
    await operationStarted.promise;

    coordinator.stopWatching(projectRootPath);
    releaseOperation.resolve();
    await assert.rejects(paused, /delete failed/);

    const internal = coordinator as unknown as {
      automaticProjectRoots: Set<string>;
      suppressedProjectRoots: Set<string>;
    };
    assert.equal(coordinator.isWatching(projectRootPath), false);
    assert.equal(internal.automaticProjectRoots.has(projectRootPath), false);
    assert.equal(internal.suppressedProjectRoots.has(projectRootPath), true);
  } finally {
    releaseOperation.resolve();
    coordinator.stopAutomaticUpdates();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("failed paused operations preserve a concurrent user stop of all watchers", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-pause-user-stop-all-"));
  const operationStarted = deferred<void>();
  const releaseOperation = deferred<void>();

  class PausedUserStopAllCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new PausedUserStopAllCoordinator(
    { autoWatch: true, watchReconcileSeconds: 0 } as unknown as Settings,
    { listProjects: () => [{ projectRootPath }] } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    noOpWatchFactory,
  );

  try {
    await coordinator.startAutomaticUpdates();
    const paused = coordinator.withProjectIndexPaused(projectRootPath, async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
      throw new Error("delete failed");
    });
    await operationStarted.promise;

    coordinator.stopWatching();
    releaseOperation.resolve();
    await assert.rejects(paused, /delete failed/);

    const internal = coordinator as unknown as {
      automaticProjectRoots: Set<string>;
      suppressedProjectRoots: Set<string>;
    };
    assert.equal(coordinator.isWatching(projectRootPath), false);
    assert.equal(internal.automaticProjectRoots.has(projectRootPath), false);
    assert.equal(internal.suppressedProjectRoots.has(projectRootPath), true);
  } finally {
    releaseOperation.resolve();
    coordinator.stopAutomaticUpdates();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("failed paused operations rejoin automatic ownership after automatic updates restart", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-pause-restart-"));
  const operationStarted = deferred<void>();
  const releaseOperation = deferred<void>();

  class PausedRestartCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new PausedRestartCoordinator(
    { autoWatch: true, watchReconcileSeconds: 0 } as unknown as Settings,
    { listProjects: () => [{ projectRootPath }] } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    noOpWatchFactory,
  );

  try {
    await coordinator.startAutomaticUpdates();
    const paused = coordinator.withProjectIndexPaused(projectRootPath, async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
      throw new Error("delete failed");
    });
    await operationStarted.promise;

    coordinator.stopAutomaticUpdates();
    await coordinator.startAutomaticUpdates();
    assert.equal(coordinator.isWatching(projectRootPath), false);
    releaseOperation.resolve();
    await assert.rejects(paused, /delete failed/);

    const internal = coordinator as unknown as {
      automaticProjectRoots: Set<string>;
      suppressedProjectRoots: Set<string>;
    };
    assert.equal(coordinator.isWatching(projectRootPath), true);
    assert.equal(internal.automaticProjectRoots.has(projectRootPath), true);
    assert.equal(internal.suppressedProjectRoots.has(projectRootPath), false);
  } finally {
    releaseOperation.resolve();
    coordinator.stopAutomaticUpdates();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("failed paused operations do not revive watchers after automatic updates stop", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-pause-stop-"));
  const operationStarted = deferred<void>();
  const releaseOperation = deferred<void>();

  class PausedStopCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

  const coordinator = new PausedStopCoordinator(
    { autoWatch: true, watchReconcileSeconds: 0 } as unknown as Settings,
    { listProjects: () => [{ projectRootPath }] } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    noOpWatchFactory,
  );

  try {
    await coordinator.startAutomaticUpdates();
    assert.equal(coordinator.isWatching(projectRootPath), true);

    const paused = coordinator.withProjectIndexPaused(projectRootPath, async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
      throw new Error("delete failed");
    });
    await operationStarted.promise;

    coordinator.stopAutomaticUpdates();
    releaseOperation.resolve();
    await assert.rejects(paused, /delete failed/);

    const automaticProjectRoots = (
      coordinator as unknown as { automaticProjectRoots: Set<string> }
    ).automaticProjectRoots;
    assert.equal(coordinator.isWatching(projectRootPath), false);
    assert.equal(automaticProjectRoots.has(projectRootPath), false);
  } finally {
    releaseOperation.resolve();
    coordinator.stopAutomaticUpdates();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("cannot start a watcher while project indexing is paused", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-pause-watch-"));
  const operationStarted = deferred<void>();
  const releaseOperation = deferred<void>();
  const coordinator = new IndexCoordinator(
    { autoWatch: false } as unknown as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
  );

  try {
    const paused = coordinator.withProjectIndexPaused(projectRootPath, async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
    });
    await operationStarted.promise;

    assert.throws(
      () => coordinator.startWatching(projectRootPath),
      (error: unknown) => error instanceof Error && error.message.includes("temporarily paused"),
    );

    releaseOperation.resolve();
    await paused;
  } finally {
    releaseOperation.resolve();
    coordinator.stopWatching();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("automatic startup cannot revive a project being deleted", async () => {
  const operationStarted = deferred<void>();
  const releaseOperation = deferred<void>();
  const environment = await createTestProjectEnvironment({
    "source.ts": "export const value = 1;",
  });
  environment.settings.autoWatch = true;
  environment.settings.watchReconcileSeconds = 0;

  try {
    await environment.indexCoordinator.indexProject(environment.projectRootPath, "incremental");
    const deletion = environment.indexCoordinator.withProjectIndexPaused(
      environment.projectRootPath,
      async () => {
        operationStarted.resolve();
        await releaseOperation.promise;
        environment.store.deleteProject(environment.projectRootPath);
      },
    );
    await operationStarted.promise;

    await environment.indexCoordinator.startAutomaticUpdates();
    releaseOperation.resolve();
    await deletion;
    await environment.indexCoordinator.reconcileWatchedProjects("periodic");

    assert.equal(environment.store.getProjectByRoot(environment.projectRootPath), undefined);
  } finally {
    releaseOperation.resolve();
    environment.indexCoordinator.stopAutomaticUpdates?.();
    await environment.cleanup();
  }
});

test("stopping automatic updates during startup prevents late watcher registration", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-stop-startup-"));
  const releaseInspection = deferred<{ isDirectory(): boolean } | null>();
  let inspectionStarted = false;
  let watchCount = 0;
  const coordinator = new IndexCoordinator(
    { autoWatch: true, watchReconcileSeconds: 0 } as unknown as Settings,
    { listProjects: () => [{ projectRootPath }] } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    () => {
      watchCount += 1;
      return { close() {} };
    },
    async () => {
      inspectionStarted = true;
      return releaseInspection.promise;
    },
  );

  try {
    const starting = coordinator.startAutomaticUpdates();
    await waitFor(() => inspectionStarted);

    coordinator.stopAutomaticUpdates();
    releaseInspection.resolve({ isDirectory: () => true });
    await starting;

    assert.equal(watchCount, 0);
    assert.equal(coordinator.isWatching(), false);
  } finally {
    releaseInspection.resolve(null);
    coordinator.stopAutomaticUpdates?.();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("automatic updates can retry after startup project listing fails", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-startup-retry-"));
  let listAttempts = 0;
  let watchCount = 0;
  const coordinator = new IndexCoordinator(
    { autoWatch: true, watchReconcileSeconds: 0 } as unknown as Settings,
    {
      listProjects: () => {
        listAttempts += 1;
        if (listAttempts === 1) throw new Error("database unavailable");
        return [{ projectRootPath }];
      },
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    () => {
      watchCount += 1;
      return { close() {} };
    },
  );

  try {
    await assert.rejects(coordinator.startAutomaticUpdates(), /database unavailable/);
    await coordinator.startAutomaticUpdates();

    assert.equal(listAttempts, 2);
    assert.equal(watchCount, 1);
  } finally {
    coordinator.stopAutomaticUpdates?.();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("periodic reconciliation ticks do not create a trailing busy loop", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-periodic-coalesce-"));
  const releaseFirstRun = deferred<void>();
  let indexRuns = 0;

  class SlowReconcileCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      indexRuns += 1;
      if (indexRuns === 1) {
        await releaseFirstRun.promise;
      }
      return cachedResult(root);
    }
  }

  const coordinator = new SlowReconcileCoordinator(
    { autoWatch: true, watchReconcileSeconds: 0 } as unknown as Settings,
    { listProjects: () => [{ projectRootPath }] } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    noOpWatchFactory,
  );

  try {
    await coordinator.startAutomaticUpdates();
    await waitFor(() => indexRuns === 1);

    const ticks = [
      coordinator.reconcileWatchedProjects("periodic"),
      coordinator.reconcileWatchedProjects("periodic"),
      coordinator.reconcileWatchedProjects("periodic"),
    ];
    releaseFirstRun.resolve();
    await Promise.all(ticks);

    assert.equal(indexRuns, 1);
  } finally {
    releaseFirstRun.resolve();
    coordinator.stopAutomaticUpdates?.();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("duplicate same-project index requests report deduped in-flight pressure", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-index-dedupe-"));
  const settings = {
    batchSize: 1,
    enableVectorSearch: false,
    excludePatterns: [],
    indexFreshness: "always",
    indexFreshnessSeconds: 0,
    maxFileSizeKb: 1024,
    maxLinesPerChunk: 100,
    textExtensions: [".ts"],
    vectorIndexingMode: "lazy",
  } as unknown as Settings;
  const coordinator = new IndexCoordinator(
    settings,
    {
      getLastIndexedCommit: () => null,
    } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
  );

  try {
    const first = coordinator.indexProject(projectRootPath, "incremental");
    const second = coordinator.indexProject(projectRootPath, "incremental");
    const info = coordinator.getInFlightIndexInfo();

    assert.equal(info.length, 1);
    assert.equal(info[0].projectRootPath, projectRootPath);
    assert.equal(info[0].status, "running");
    assert.equal(info[0].dedupedRequests, 1);

    await Promise.allSettled([first, second]);
  } finally {
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("in-flight diagnostics track the active phase without a progress callback", async () => {
  const embeddingStarted = deferred<void>();
  const releaseEmbedding = deferred<void>();
  const baseProvider = new InMemoryEmbeddingProvider();
  const provider: EmbeddingProvider = {
    ...baseProvider,
    clearQueryCache: () => baseProvider.clearQueryCache(),
    embed: (text) => baseProvider.embed(text),
    embedBatch: async (texts) => {
      embeddingStarted.resolve();
      await releaseEmbedding.promise;
      return baseProvider.embedBatch(texts);
    },
    embedQuery: (query, useCache) => baseProvider.embedQuery(query, useCache),
    getDimension: () => baseProvider.getDimension(),
    getModelName: () => baseProvider.getModelName(),
    getQueryCacheStats: () => baseProvider.getQueryCacheStats(),
  };
  const environment = await createTestProjectEnvironment(
    { "src/index.ts": "export const value = 1;\n" },
    provider,
  );
  environment.settings.vectorIndexingMode = "eager";
  let indexing: Promise<IndexProjectResult> | undefined;

  try {
    indexing = environment.indexCoordinator.indexProject(
      environment.projectRootPath,
      "full",
      undefined,
      "automatic",
    );
    await embeddingStarted.promise;

    const [info] = environment.indexCoordinator.getInFlightIndexInfo();
    assert.equal(info.phase, "vector");
    assert.equal(info.current, 0);
    assert.equal(info.total, 1);
    assert.equal(info.origin, "automatic");
    assert.equal(typeof info.phaseElapsedMs, "number");
    assert.equal(typeof info.queueMs, "number");
    assert.ok(Number.isFinite(Date.parse(info.lastProgressAt)));
  } finally {
    releaseEmbedding.resolve();
    await Promise.allSettled(indexing ? [indexing] : []);
    await environment.cleanup();
  }
});

test("in-flight diagnostics report requests waiting for the global index slot", async () => {
  const embeddingStarted = deferred<void>();
  const releaseEmbedding = deferred<void>();
  const baseProvider = new InMemoryEmbeddingProvider();
  let embeddingCalls = 0;
  const provider: EmbeddingProvider = {
    ...baseProvider,
    clearQueryCache: () => baseProvider.clearQueryCache(),
    embed: (text) => baseProvider.embed(text),
    embedBatch: async (texts) => {
      embeddingCalls += 1;
      if (embeddingCalls === 1) {
        embeddingStarted.resolve();
        await releaseEmbedding.promise;
      }
      return baseProvider.embedBatch(texts);
    },
    embedQuery: (query, useCache) => baseProvider.embedQuery(query, useCache),
    getDimension: () => baseProvider.getDimension(),
    getModelName: () => baseProvider.getModelName(),
    getQueryCacheStats: () => baseProvider.getQueryCacheStats(),
  };
  const environment = await createTestProjectEnvironment(
    { "src/first.ts": "export const first = 1;\n" },
    provider,
  );
  environment.settings.indexConcurrency = 1;
  environment.settings.vectorIndexingMode = "eager";
  const secondProjectRootPath = path.join(environment.tempDir, "second-project");
  await mkdir(path.join(secondProjectRootPath, "src"), { recursive: true });
  await writeFile(path.join(secondProjectRootPath, "src/second.ts"), "export const second = 2;\n");
  let firstIndex: Promise<IndexProjectResult> | undefined;
  let secondIndex: Promise<IndexProjectResult> | undefined;

  try {
    firstIndex = environment.indexCoordinator.indexProject(environment.projectRootPath, "full");
    await embeddingStarted.promise;
    secondIndex = environment.indexCoordinator.indexProject(secondProjectRootPath, "full");
    await new Promise<void>((resolve) => setImmediate(resolve));

    const queued = environment.indexCoordinator
      .getInFlightIndexInfo()
      .find((info) => info.projectRootPath === secondProjectRootPath);
    assert.ok(queued);
    assert.equal(queued.phase, "queued");
    assert.equal(queued.origin, "explicit");
    assert.ok(queued.queueMs >= 0);
    assert.ok(queued.phaseElapsedMs >= 0);
  } finally {
    releaseEmbedding.resolve();
    await Promise.allSettled([firstIndex, secondIndex].filter(Boolean) as Array<Promise<IndexProjectResult>>);
    await environment.cleanup();
  }
});

test("same-project progress requests do not hide the active index diagnostics", async () => {
  const embeddingStarted = deferred<void>();
  const releaseEmbedding = deferred<void>();
  const baseProvider = new InMemoryEmbeddingProvider();
  let embeddingCalls = 0;
  const provider: EmbeddingProvider = {
    ...baseProvider,
    clearQueryCache: () => baseProvider.clearQueryCache(),
    embed: (text) => baseProvider.embed(text),
    embedBatch: async (texts) => {
      embeddingCalls += 1;
      if (embeddingCalls === 1) {
        embeddingStarted.resolve();
        await releaseEmbedding.promise;
      }
      return baseProvider.embedBatch(texts);
    },
    embedQuery: (query, useCache) => baseProvider.embedQuery(query, useCache),
    getDimension: () => baseProvider.getDimension(),
    getModelName: () => baseProvider.getModelName(),
    getQueryCacheStats: () => baseProvider.getQueryCacheStats(),
  };
  const environment = await createTestProjectEnvironment(
    { "src/index.ts": "export const value = 1;\n" },
    provider,
  );
  environment.settings.vectorIndexingMode = "eager";
  let activeIndex: Promise<IndexProjectResult> | undefined;
  let queuedIndex: Promise<IndexProjectResult> | undefined;

  try {
    activeIndex = environment.indexCoordinator.indexProject(
      environment.projectRootPath,
      "full",
      undefined,
      "automatic",
    );
    await embeddingStarted.promise;
    queuedIndex = environment.indexCoordinator.indexProject(
      environment.projectRootPath,
      "full",
      () => {},
      "explicit",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const info = environment.indexCoordinator.getInFlightIndexInfo();
    assert.equal(info.length, 2);
    const active = info.find((entry) => entry.phase === "vector" && entry.origin === "automatic");
    assert.ok(active);
    assert.equal(active.queuedRequests, 1);
    assert.ok(info.some((entry) => entry.phase === "queued" && entry.origin === "explicit"));
  } finally {
    releaseEmbedding.resolve();
    await Promise.allSettled([activeIndex, queuedIndex].filter(Boolean) as Array<Promise<IndexProjectResult>>);
    await environment.cleanup();
  }
});

test("a timed-out reuse cannot remove a newer same-project tracker", async () => {
  const embeddingStarted = deferred<void>();
  const releaseEmbedding = deferred<void>();
  const reuseStarted = deferred<void>();
  const releaseReuse = deferred<void>();
  const baseProvider = new InMemoryEmbeddingProvider();
  let embeddingCalls = 0;
  const provider: EmbeddingProvider = {
    ...baseProvider,
    clearQueryCache: () => baseProvider.clearQueryCache(),
    embed: (text) => baseProvider.embed(text),
    embedBatch: async (texts) => {
      embeddingCalls += 1;
      if (embeddingCalls === 1) {
        embeddingStarted.resolve();
        await releaseEmbedding.promise;
      }
      return baseProvider.embedBatch(texts);
    },
    embedQuery: (query, useCache) => baseProvider.embedQuery(query, useCache),
    getDimension: () => baseProvider.getDimension(),
    getModelName: () => baseProvider.getModelName(),
    getQueryCacheStats: () => baseProvider.getQueryCacheStats(),
  };
  const environment = await createTestProjectEnvironment(
    { "src/index.ts": "export const value = 1;\n" },
    provider,
  );
  environment.settings.vectorIndexingMode = "eager";
  const coordinatorInternals = environment.indexCoordinator as unknown as {
    withTimeout: <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>;
  };
  coordinatorInternals.withTimeout = async <T>(): Promise<T> => {
    reuseStarted.resolve();
    await releaseReuse.promise;
    throw new Error("forced reuse timeout");
  };
  let activeIndex: Promise<IndexProjectResult> | undefined;
  let reusedIndex: Promise<IndexProjectResult> | undefined;
  let queuedIndex: Promise<IndexProjectResult> | undefined;

  try {
    activeIndex = environment.indexCoordinator.indexProject(environment.projectRootPath, "full");
    await embeddingStarted.promise;
    reusedIndex = environment.indexCoordinator.indexProject(environment.projectRootPath, "full");
    await reuseStarted.promise;
    queuedIndex = environment.indexCoordinator.indexProject(
      environment.projectRootPath,
      "full",
      () => {},
      "automatic",
    );
    releaseReuse.resolve();
    await waitFor(() => environment.indexCoordinator.getInFlightIndexInfo().length === 3);

    const info = environment.indexCoordinator.getInFlightIndexInfo();
    assert.ok(info.some((entry) => entry.phase === "vector" && entry.origin === "explicit"));
    assert.ok(info.some((entry) => entry.phase === "queued" && entry.origin === "automatic"));
  } finally {
    releaseReuse.resolve();
    releaseEmbedding.resolve();
    await Promise.allSettled([activeIndex, reusedIndex, queuedIndex].filter(Boolean) as Array<Promise<IndexProjectResult>>);
    await environment.cleanup();
  }
});

test("a reuse timeout keeps the underlying running tracker visible", async () => {
  const embeddingStarted = deferred<void>();
  const releaseEmbedding = deferred<void>();
  const baseProvider = new InMemoryEmbeddingProvider();
  let embeddingCalls = 0;
  const provider: EmbeddingProvider = {
    ...baseProvider,
    clearQueryCache: () => baseProvider.clearQueryCache(),
    embed: (text) => baseProvider.embed(text),
    embedBatch: async (texts) => {
      embeddingCalls += 1;
      if (embeddingCalls === 1) {
        embeddingStarted.resolve();
        await releaseEmbedding.promise;
      }
      return baseProvider.embedBatch(texts);
    },
    embedQuery: (query, useCache) => baseProvider.embedQuery(query, useCache),
    getDimension: () => baseProvider.getDimension(),
    getModelName: () => baseProvider.getModelName(),
    getQueryCacheStats: () => baseProvider.getQueryCacheStats(),
  };
  const environment = await createTestProjectEnvironment(
    { "src/index.ts": "export const value = 1;\n" },
    provider,
  );
  environment.settings.vectorIndexingMode = "eager";
  const coordinatorInternals = environment.indexCoordinator as unknown as {
    withTimeout: <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>;
  };
  coordinatorInternals.withTimeout = async <T>(): Promise<T> => {
    throw new Error("forced reuse timeout");
  };
  let activeIndex: Promise<IndexProjectResult> | undefined;
  let restartedIndex: Promise<IndexProjectResult> | undefined;

  try {
    activeIndex = environment.indexCoordinator.indexProject(environment.projectRootPath, "full");
    await embeddingStarted.promise;
    restartedIndex = environment.indexCoordinator.indexProject(environment.projectRootPath, "full");
    await waitFor(() => environment.indexCoordinator.getInFlightIndexInfo().some((entry) => entry.phase === "queued"));

    assert.ok(
      environment.indexCoordinator
        .getInFlightIndexInfo()
        .some((entry) => entry.phase === "vector" && entry.origin === "explicit"),
    );
  } finally {
    releaseEmbedding.resolve();
    await Promise.allSettled([activeIndex, restartedIndex].filter(Boolean) as Array<Promise<IndexProjectResult>>);
    await environment.cleanup();
  }
});

test("completed indexing persists detailed phase timings", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  const originalWriteBatch = environment.store.writeFileIndexBatch.bind(environment.store);
  environment.store.writeFileIndexBatch = (...args) => {
    blockFor(20);
    return originalWriteBatch(...args);
  };

  try {
    const result = await environment.indexCoordinator.indexProject(environment.projectRootPath, "full");
    const persisted = environment.store.getLatestIndexEvent(result.projectId);

    for (const timing of [
      "parseMs",
      "writeMs",
      "symbolGraphMs",
      "semanticMs",
      "finalizeMs",
      "maxWriteBatchMs",
    ] as const) {
      assert.equal(typeof result.timings[timing], "number", `${timing} is missing from the result`);
    }
    assert.ok((result.timings.maxWriteBatchMs ?? 0) >= 15);
    assert.ok((result.timings.writeMs ?? 0) >= (result.timings.maxWriteBatchMs ?? 0));
    assert.deepEqual(persisted?.timings, result.timings);
  } finally {
    await environment.cleanup();
  }
});

test("SQLite project writes do not block the main event loop behind a database write lock", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
  );
  let lockWorker: Worker | undefined;
  let timerDelayMs = Number.POSITIVE_INFINITY;
  let timerPromise: Promise<void> | undefined;

  try {
    lockWorker = await holdDatabaseWriteLock(environment.settings.databasePath, 350);
    await coordinator.indexProject(environment.projectRootPath, "full", (event) => {
      if (!timerPromise && event.phase === "prepare" && event.status === "start" && event.total !== undefined) {
        const timerStartedAt = Date.now();
        timerPromise = new Promise<void>((resolve) => setTimeout(() => {
          timerDelayMs = Date.now() - timerStartedAt;
          resolve();
        }, 10));
      }
    });
    await timerPromise;

    assert.ok(timerDelayMs < 200, `main event loop timer was delayed ${timerDelayMs}ms`);
  } finally {
    await coordinator.close();
    await lockWorker?.terminate();
    await environment.cleanup();
  }
});

test("automatic indexing isolates lease control from bounded bulk write transactions", async () => {
  const environment = await createTestProjectEnvironment({
    "src/first.ts": "export const first = 1;\n",
    "src/second.ts": "export const second = 2;\n",
  });
  const bulkWorker = createSynchronousIndexStorageWorker(environment.store);
  const leaseWorker = createSynchronousIndexStorageWorker(environment.store);
  const originalBulkAcquire = bulkWorker.tryAcquireIndexMaintenanceLease.bind(bulkWorker);
  const originalLeaseAcquire = leaseWorker.tryAcquireIndexMaintenanceLease.bind(leaseWorker);
  const originalWriteBatch = bulkWorker.writeFileIndexBatch.bind(bulkWorker);
  const batchSizes: number[] = [];
  let bulkLeaseAcquires = 0;
  let controlLeaseAcquires = 0;
  bulkWorker.tryAcquireIndexMaintenanceLease = async (...args) => {
    bulkLeaseAcquires += 1;
    return originalBulkAcquire(...args);
  };
  leaseWorker.tryAcquireIndexMaintenanceLease = async (...args) => {
    controlLeaseAcquires += 1;
    return originalLeaseAcquire(...args);
  };
  bulkWorker.writeFileIndexBatch = async (projectId, files, indexedAt) => {
    batchSizes.push(files.length);
    await originalWriteBatch(projectId, files, indexedAt);
  };
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    bulkWorker,
    {},
    leaseWorker,
  );

  try {
    await coordinator.indexProject(environment.projectRootPath, "full", undefined, "automatic");

    assert.equal(bulkLeaseAcquires, 0);
    assert.equal(controlLeaseAcquires, 1);
    assert.deepEqual(batchSizes, [1, 1]);
  } finally {
    await coordinator.close();
    await environment.cleanup();
  }
});

test("automatic writes proactively refresh a near-expiry maintenance lease", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  const bulkWorker = createSynchronousIndexStorageWorker(environment.store);
  const leaseWorker = createSynchronousIndexStorageWorker(environment.store);
  let renewals = 0;
  leaseWorker.renewIndexMaintenanceLease = async () => {
    renewals += 1;
    return true;
  };
  leaseWorker.releaseIndexMaintenanceLease = async () => true;
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    bulkWorker,
    {},
    leaseWorker,
  );
  const internals = coordinator as unknown as {
    automaticMaintenanceLeaseExpiresAtMs: number;
    automaticMaintenanceLeaseReady: Promise<boolean>;
    automaticMaintenanceLeaseState: string;
  };
  internals.automaticMaintenanceLeaseExpiresAtMs = Date.now() + 15_000;
  internals.automaticMaintenanceLeaseReady = Promise.resolve(true);
  internals.automaticMaintenanceLeaseState = "held";

  try {
    await coordinator.indexProject(environment.projectRootPath, "full", undefined, "automatic");

    assert.equal(renewals, 1);
  } finally {
    await coordinator.close();
    await environment.cleanup();
  }
});

test("an expired same-owner maintenance lease is safely reacquired without a foreign-owner error", async () => {
  const environment = await createTestProjectEnvironment({});
  const bulkWorker = createSynchronousIndexStorageWorker(environment.store);
  const leaseWorker = createSynchronousIndexStorageWorker(environment.store);
  const originalAcquire = leaseWorker.tryAcquireIndexMaintenanceLease.bind(leaseWorker);
  let acquireCalls = 0;
  leaseWorker.tryAcquireIndexMaintenanceLease = async (...args) => {
    acquireCalls += 1;
    return originalAcquire(...args);
  };
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    bulkWorker,
    {},
    leaseWorker,
  );
  const internals = coordinator as unknown as {
    automaticMaintenanceLeaseExpiresAtMs: number;
    withAutomaticMaintenanceLease: <T>(operation: () => Promise<T>) => Promise<T>;
  };

  try {
    const result = await internals.withAutomaticMaintenanceLease(async () => {
      internals.automaticMaintenanceLeaseExpiresAtMs = Date.now() - 1;
      return internals.withAutomaticMaintenanceLease(async () => {
        const status = coordinator.getAutomaticMaintenanceLeaseStatus();
        assert.equal(status.state, "held");
        assert.equal(status.lastLostReason, "same-owner-expired");
        return "reacquired";
      });
    });

    assert.equal(result, "reacquired");
    assert.equal(acquireCalls, 2);
  } finally {
    await coordinator.close();
    await environment.cleanup();
  }
});

test("a foreign maintenance lease reports its real owner and busy error", async () => {
  const environment = await createTestProjectEnvironment({});
  const foreignOwnerId = "foreign-web-owner";
  const nowMs = Date.now();
  environment.store.tryAcquireIndexMaintenanceLease(foreignOwnerId, nowMs + 60_000, nowMs);
  const bulkWorker = createSynchronousIndexStorageWorker(environment.store);
  const leaseWorker = createSynchronousIndexStorageWorker(environment.store);
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    bulkWorker,
    {},
    leaseWorker,
  );
  const internals = coordinator as unknown as {
    withAutomaticMaintenanceLease: <T>(operation: () => Promise<T>) => Promise<T>;
  };

  try {
    await assert.rejects(
      internals.withAutomaticMaintenanceLease(async () => "unexpected"),
      (error: unknown) => (
        (error as { code?: string }).code === "INDEX_MAINTENANCE_BUSY"
        && (error as Error).message === "Another process owns automatic index maintenance"
      ),
    );
    const status = coordinator.getAutomaticMaintenanceLeaseStatus();
    assert.equal(status.state, "foreign-owner");
    assert.equal(status.observedOwnerId, foreignOwnerId);
    assert.notEqual(status.expiresAt, null);
  } finally {
    await coordinator.close();
    await environment.cleanup();
  }
});

test("automatic indexing fences new write batches after maintenance lease loss", async () => {
  const environment = await createTestProjectEnvironment({
    "src/first.ts": "export const first = 1;\n",
    "src/second.ts": "export const second = 2;\n",
  });
  const bulkWorker = createSynchronousIndexStorageWorker(environment.store);
  const leaseWorker = createSynchronousIndexStorageWorker(environment.store);
  const originalWriteBatch = bulkWorker.writeFileIndexBatch.bind(bulkWorker);
  let writeBatches = 0;
  let coordinator: IndexCoordinator;
  bulkWorker.writeFileIndexBatch = async (...args) => {
    writeBatches += 1;
    await originalWriteBatch(...args);
    if (writeBatches === 1) {
      (coordinator as unknown as { automaticMaintenanceLeaseExpiresAtMs: number })
        .automaticMaintenanceLeaseExpiresAtMs = 0;
    }
  };
  coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    bulkWorker,
    {},
    leaseWorker,
  );

  try {
    await assert.rejects(
      coordinator.indexProject(environment.projectRootPath, "full", undefined, "automatic"),
      (error: unknown) => (error as { code?: string }).code === "INDEX_MAINTENANCE_LEASE_LOST",
    );
    assert.equal(writeBatches, 1);
  } finally {
    await coordinator.close();
    await environment.cleanup();
  }
});

test("maintenance lease reacquisition survives a real SQLite write lock without blocking timers", async () => {
  const environment = await createTestProjectEnvironment({});
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
  );
  const internals = coordinator as unknown as {
    automaticMaintenanceLeaseExpiresAtMs: number;
    withAutomaticMaintenanceLease: <T>(operation: () => Promise<T>) => Promise<T>;
  };
  let lockWorker: Worker | undefined;

  try {
    await internals.withAutomaticMaintenanceLease(async () => {
      lockWorker = await holdDatabaseWriteLock(environment.settings.databasePath, 350);
      internals.automaticMaintenanceLeaseExpiresAtMs = Date.now() - 1;
      const timerStartedAt = Date.now();
      const timer = new Promise<number>((resolve) => setTimeout(() => resolve(Date.now() - timerStartedAt), 20));
      const reacquired = internals.withAutomaticMaintenanceLease(async () => "reacquired");

      const timerDelayMs = await timer;
      assert.ok(timerDelayMs < 200, `main event loop timer was delayed ${timerDelayMs}ms`);
      assert.equal(await reacquired, "reacquired");
      assert.equal(coordinator.getAutomaticMaintenanceLeaseStatus().state, "held");
    });
  } finally {
    await coordinator.close();
    await lockWorker?.terminate();
    await environment.cleanup();
  }
});

test("maintenance lease renewal failures expose their real error state", async () => {
  const environment = await createTestProjectEnvironment({});
  const bulkWorker = createSynchronousIndexStorageWorker(environment.store);
  const leaseWorker = createSynchronousIndexStorageWorker(environment.store);
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    bulkWorker,
    {},
    leaseWorker,
  );
  const internals = coordinator as unknown as {
    renewAutomaticMaintenanceLease: () => Promise<void>;
    withAutomaticMaintenanceLease: <T>(operation: () => Promise<T>) => Promise<T>;
  };

  try {
    await internals.withAutomaticMaintenanceLease(async () => {
      leaseWorker.renewIndexMaintenanceLease = async () => {
        throw new Error("SQLITE_BUSY: lease renewal lock timeout");
      };
      await internals.renewAutomaticMaintenanceLease();

      const status = coordinator.getAutomaticMaintenanceLeaseStatus();
      assert.equal(status.state, "renewal-failed");
      assert.equal(status.lastLostReason, "renewal-failed");
      assert.match(status.lastError ?? "", /SQLITE_BUSY/);
      assert.notEqual(status.expiresAt, null);
    });
  } finally {
    await coordinator.close();
    await environment.cleanup();
  }
});

test("a false lease renewal distinguishes same-owner expiry from an owner change", async () => {
  const environment = await createTestProjectEnvironment({});
  const bulkWorker = createSynchronousIndexStorageWorker(environment.store);
  const leaseWorker = createSynchronousIndexStorageWorker(environment.store);
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    bulkWorker,
    {},
    leaseWorker,
  );
  const internals = coordinator as unknown as {
    automaticMaintenanceLeaseOwnerId: string;
    renewAutomaticMaintenanceLease: () => Promise<void>;
    withAutomaticMaintenanceLease: <T>(operation: () => Promise<T>) => Promise<T>;
  };

  try {
    await internals.withAutomaticMaintenanceLease(async () => {
      const nowMs = Date.now();
      environment.store.tryAcquireIndexMaintenanceLease(
        internals.automaticMaintenanceLeaseOwnerId,
        nowMs - 1,
        nowMs,
      );
      await internals.renewAutomaticMaintenanceLease();

      const status = coordinator.getAutomaticMaintenanceLeaseStatus();
      assert.equal(status.state, "expired");
      assert.equal(status.lastLostReason, "same-owner-expired");
      assert.equal(status.observedOwnerId, null);
    });
  } finally {
    await coordinator.close();
    await environment.cleanup();
  }
});

test("existing file snapshots do not materialize on the main event loop", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  const originalListProjectFiles = environment.store.listProjectFiles.bind(environment.store);
  let mainThreadReads = 0;
  let timerDelayMs = Number.POSITIVE_INFINITY;
  let timerPromise: Promise<void> | undefined;
  environment.store.listProjectFiles = (...args) => {
    mainThreadReads += 1;
    blockFor(350);
    return originalListProjectFiles(...args);
  };
  const indexStorageWorker = {
    acquireLease() {},
    async close() {},
    async deleteFiles(projectId: string, relativePaths: string[]) {
      environment.store.deleteFiles(projectId, relativePaths);
    },
    async ensureSemanticIndex(projectId: string) {
      environment.store.ensureSemanticIndex(projectId);
    },
    async finalizeProjectIndex(projectId: string, finalization: Parameters<typeof environment.store.finalizeProjectIndex>[1]) {
      return environment.store.finalizeProjectIndex(projectId, finalization);
    },
    async prepareProjectIndex(projectId: string, project: Parameters<typeof environment.store.upsertProject>[1], timestamp: string) {
      environment.store.upsertProject(projectId, project, "indexing", timestamp);
      const existingFiles = originalListProjectFiles(projectId);
      const timerStartedAt = Date.now();
      timerPromise = new Promise<void>((resolve) => setTimeout(() => {
        timerDelayMs = Date.now() - timerStartedAt;
        resolve();
      }, 10));
      return { existingFiles };
    },
    releaseLease() {},
    async resolveSymbolGraph(projectId: string, changedFileIds: string[]) {
      environment.store.resolveSymbolGraph(projectId, new Set(changedFileIds));
    },
    async writeChunkVectors(entries: Parameters<typeof environment.store.writeChunkVectors>[0], projectId: string) {
      environment.store.writeChunkVectors(entries, projectId);
    },
    async writeFileIndexBatch(
      projectId: string,
      files: Parameters<typeof environment.store.writeFileIndexBatch>[1],
      indexedAt: string,
    ) {
      environment.store.writeFileIndexBatch(projectId, files, indexedAt);
    },
  } as unknown as IndexStorageWorker;
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    indexStorageWorker,
  );

  try {
    await coordinator.indexProject(environment.projectRootPath, "full");
    await timerPromise;

    assert.ok(timerDelayMs < 200, `main event loop timer was delayed ${timerDelayMs}ms`);
    assert.equal(mainThreadReads, 0);
  } finally {
    await coordinator.close();
    await environment.cleanup();
  }
});

test("coordinator awaits the injected index worker and preserves progress and timings", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  environment.settings.vectorIndexingMode = "eager";
  const calls: string[] = [];
  const events: string[] = [];
  let activeLeases = 0;
  let closed = false;
  const delay = () => new Promise((resolve) => setTimeout(resolve, 20));
  const indexStorageWorker: IndexStorageWorker = {
    acquireLease() {
      activeLeases += 1;
      calls.push("acquireLease");
    },
    async close() {
      closed = true;
      calls.push("close");
    },
    async deleteFiles(projectId, relativePaths) {
      calls.push("deleteFiles");
      await delay();
      environment.store.deleteFiles(projectId, relativePaths);
    },
    async ensureSemanticIndex(projectId) {
      calls.push("ensureSemanticIndex");
      await delay();
      environment.store.ensureSemanticIndex(projectId);
    },
    async finalizeProjectIndex(projectId, finalization) {
      calls.push("finalizeProjectIndex");
      await delay();
      return environment.store.finalizeProjectIndex(projectId, finalization);
    },
    async prepareProjectIndex(projectId, project, timestamp) {
      calls.push("prepareProjectIndex");
      await delay();
      environment.store.upsertProject(projectId, project, "indexing", timestamp);
      return { existingFiles: environment.store.listProjectFiles(projectId) };
    },
    async releaseIndexMaintenanceLease(ownerId) {
      return environment.store.releaseIndexMaintenanceLease(ownerId);
    },
    releaseLease() {
      activeLeases -= 1;
      calls.push("releaseLease");
    },
    async renewIndexMaintenanceLease(ownerId, expiresAtMs, nowMs) {
      return environment.store.renewIndexMaintenanceLease(ownerId, expiresAtMs, nowMs);
    },
    async resolveSymbolGraph(projectId, changedFileIds) {
      calls.push("resolveSymbolGraph");
      await delay();
      environment.store.resolveSymbolGraph(projectId, new Set(changedFileIds));
    },
    async tryAcquireIndexMaintenanceLease(ownerId, expiresAtMs, nowMs) {
      return environment.store.tryAcquireIndexMaintenanceLease(ownerId, expiresAtMs, nowMs);
    },
    async writeChunkVectors(entries, projectId) {
      calls.push("writeChunkVectors");
      await delay();
      environment.store.writeChunkVectors(entries, projectId);
    },
    async writeFileIndexBatch(projectId, files, indexedAt) {
      calls.push("writeFileIndexBatch");
      await delay();
      environment.store.writeFileIndexBatch(projectId, files, indexedAt);
    },
  };
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    indexStorageWorker,
  );

  try {
    const result = await coordinator.indexProject(
      environment.projectRootPath,
      "full",
      (event) => events.push(`${event.phase}:${event.status}`),
    );

    assert.deepEqual(calls.slice(0, -1), [
      "acquireLease",
      "prepareProjectIndex",
      "deleteFiles",
      "writeFileIndexBatch",
      "writeChunkVectors",
      "resolveSymbolGraph",
      "ensureSemanticIndex",
      "finalizeProjectIndex",
    ]);
    assert.equal(calls.at(-1), "releaseLease");
    assert.equal(activeLeases, 0);
    assert.ok((result.timings.writeMs ?? 0) >= 30);
    assert.ok((result.timings.symbolGraphMs ?? 0) >= 15);
    assert.ok((result.timings.semanticMs ?? 0) >= 15);
    assert.ok(events.includes("index:done"));
    assert.ok(events.includes("symbolGraph:done"));
    assert.ok(events.includes("semantic:done"));
  } finally {
    await coordinator.close();
    assert.equal(closed, true);
    await environment.cleanup();
  }
});

test("semantic startup warmup releases its worker lease after failure and still closes", async () => {
  let activeLeases = 0;
  let closed = false;
  const indexStorageWorker = {
    acquireLease() {
      activeLeases += 1;
    },
    async close() {
      closed = true;
    },
    async ensureSemanticIndex() {
      throw new Error("semantic warmup failed");
    },
    releaseLease() {
      activeLeases -= 1;
    },
  } as unknown as IndexStorageWorker;
  const coordinator = new IndexCoordinator(
    { indexConcurrency: 1 } as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    indexStorageWorker,
  );

  await assert.rejects(coordinator.ensureSemanticIndex("project"), /semantic warmup failed/);
  assert.equal(activeLeases, 0);
  await coordinator.close();
  assert.equal(closed, true);
});

test("closed coordinator rejects automatic update restart without leaking watchers or timers", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-closed-auto-watch-"));
  let watcherStarts = 0;
  let watcherCloses = 0;
  const coordinator = new IndexCoordinator(
    { autoWatch: true, watchReconcileSeconds: 60 } as unknown as Settings,
    { listProjects: () => [{ projectRootPath }] } as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    () => {
      watcherStarts += 1;
      return {
        close() {
          watcherCloses += 1;
        },
      };
    },
    async () => ({ isDirectory: () => true }),
  );

  try {
    const firstClose = coordinator.close();
    await firstClose;
    let startError: unknown;
    try {
      await coordinator.startAutomaticUpdates();
    } catch (error) {
      startError = error;
    }

    const secondClose = coordinator.close();
    await secondClose;

    assert.equal(secondClose, firstClose);
    assert.equal(watcherStarts, 0);
    assert.equal(watcherCloses, 0);
    assert.equal(coordinator.isWatching(), false);
    assert.equal(
      (coordinator as unknown as { reconciliationTimer?: NodeJS.Timeout }).reconciliationTimer,
      undefined,
    );
    assert.equal((startError as { code?: string } | undefined)?.code, "INDEX_COORDINATOR_CLOSED");
  } finally {
    coordinator.stopAutomaticUpdates();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("closed coordinator rejects manual watcher startup without leaking on repeated close", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-closed-manual-watch-"));
  let watcherStarts = 0;
  let watcherCloses = 0;
  const coordinator = new IndexCoordinator(
    { autoWatch: false } as unknown as Settings,
    {} as never,
    { debug() {}, info() {}, warn() {} } as never,
    {} as EmbeddingProvider,
    () => {
      watcherStarts += 1;
      return {
        close() {
          watcherCloses += 1;
        },
      };
    },
  );

  try {
    const firstClose = coordinator.close();
    await firstClose;
    let startError: unknown;
    try {
      coordinator.startWatching(projectRootPath);
    } catch (error) {
      startError = error;
    }

    const secondClose = coordinator.close();
    await secondClose;

    assert.equal(secondClose, firstClose);
    assert.equal(watcherStarts, 0);
    assert.equal(watcherCloses, 0);
    assert.equal(coordinator.isWatching(), false);
    assert.equal((startError as { code?: string } | undefined)?.code, "INDEX_COORDINATOR_CLOSED");
  } finally {
    coordinator.stopWatching();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("close drains an active index before closing its storage worker", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  const calls: string[] = [];
  let workerClosed = false;
  const indexStorageWorker: IndexStorageWorker = {
    acquireLease() {
      calls.push("acquireLease");
    },
    async close() {
      workerClosed = true;
      calls.push("close");
    },
    async deleteFiles(projectId, relativePaths) {
      environment.store.deleteFiles(projectId, relativePaths);
    },
    async ensureSemanticIndex(projectId) {
      calls.push("ensureSemanticIndex");
      environment.store.ensureSemanticIndex(projectId);
    },
    async finalizeProjectIndex(projectId, finalization) {
      calls.push("finalizeProjectIndex");
      return environment.store.finalizeProjectIndex(projectId, finalization);
    },
    async prepareProjectIndex(projectId, project, timestamp) {
      environment.store.upsertProject(projectId, project, "indexing", timestamp);
      return { existingFiles: environment.store.listProjectFiles(projectId) };
    },
    async releaseIndexMaintenanceLease(ownerId) {
      return environment.store.releaseIndexMaintenanceLease(ownerId);
    },
    releaseLease() {
      calls.push("releaseLease");
    },
    async renewIndexMaintenanceLease(ownerId, expiresAtMs, nowMs) {
      return environment.store.renewIndexMaintenanceLease(ownerId, expiresAtMs, nowMs);
    },
    async resolveSymbolGraph(projectId, changedFileIds) {
      calls.push("resolveSymbolGraph");
      environment.store.resolveSymbolGraph(projectId, new Set(changedFileIds));
    },
    async tryAcquireIndexMaintenanceLease(ownerId, expiresAtMs, nowMs) {
      return environment.store.tryAcquireIndexMaintenanceLease(ownerId, expiresAtMs, nowMs);
    },
    async writeChunkVectors(entries, projectId) {
      environment.store.writeChunkVectors(entries, projectId);
    },
    async writeFileIndexBatch(projectId, files, indexedAt) {
      calls.push("writeFileIndexBatch");
      writeStarted.resolve();
      await releaseWrite.promise;
      environment.store.writeFileIndexBatch(projectId, files, indexedAt);
    },
  };
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    indexStorageWorker,
  );
  let indexing: Promise<IndexProjectResult> | undefined;
  let closing: Promise<void> | undefined;

  try {
    indexing = coordinator.indexProject(environment.projectRootPath, "full");
    await writeStarted.promise;
    let closeSettled = false;
    closing = coordinator.close().then(() => {
      closeSettled = true;
    });
    const rejectedNewIndex = assert.rejects(
      coordinator.indexProject(environment.projectRootPath, "full"),
      /closing|closed/i,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closeSettled, false);
    assert.equal(workerClosed, false);

    releaseWrite.resolve();
    const result = await indexing;
    await Promise.all([closing, rejectedNewIndex]);
    assert.equal(environment.store.getProjectByRoot(environment.projectRootPath)?.status, "ready");
    assert.ok(calls.includes("resolveSymbolGraph"));
    assert.ok(calls.includes("ensureSemanticIndex"));
    assert.deepEqual(calls.slice(-2), ["releaseLease", "close"]);
    assert.equal(result.changedFiles, 1);
  } finally {
    releaseWrite.resolve();
    await Promise.allSettled([indexing, closing].filter(Boolean) as Promise<unknown>[]);
    await coordinator.close();
    await environment.cleanup();
  }
});

test("close force closes after a bounded drain grace and leaves recovery state non-ready", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  const writeStarted = deferred<void>();
  let rejectWrite!: (error: Error) => void;
  const blockedWrite = new Promise<void>((_resolve, reject) => {
    rejectWrite = reject;
  });
  const warnings: Array<Record<string, unknown> | undefined> = [];
  let workerClosed = false;
  const indexStorageWorker: IndexStorageWorker = {
    acquireLease() {},
    async close() {
      workerClosed = true;
      rejectWrite(new Error("forced worker close"));
    },
    async deleteFiles(projectId, relativePaths) {
      environment.store.deleteFiles(projectId, relativePaths);
    },
    async ensureSemanticIndex(projectId) {
      environment.store.ensureSemanticIndex(projectId);
    },
    async finalizeProjectIndex(projectId, finalization) {
      return environment.store.finalizeProjectIndex(projectId, finalization);
    },
    async prepareProjectIndex(projectId, project, timestamp) {
      environment.store.upsertProject(projectId, project, "indexing", timestamp);
      return { existingFiles: environment.store.listProjectFiles(projectId) };
    },
    async releaseIndexMaintenanceLease(ownerId) {
      return environment.store.releaseIndexMaintenanceLease(ownerId);
    },
    releaseLease() {},
    async renewIndexMaintenanceLease(ownerId, expiresAtMs, nowMs) {
      return environment.store.renewIndexMaintenanceLease(ownerId, expiresAtMs, nowMs);
    },
    async resolveSymbolGraph(projectId, changedFileIds) {
      environment.store.resolveSymbolGraph(projectId, new Set(changedFileIds));
    },
    async tryAcquireIndexMaintenanceLease(ownerId, expiresAtMs, nowMs) {
      return environment.store.tryAcquireIndexMaintenanceLease(ownerId, expiresAtMs, nowMs);
    },
    async writeChunkVectors(entries, projectId) {
      environment.store.writeChunkVectors(entries, projectId);
    },
    async writeFileIndexBatch() {
      writeStarted.resolve();
      await blockedWrite;
    },
  };
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn(_message: string, meta?: Record<string, unknown>) { warnings.push(meta); } } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    undefined,
    undefined,
    indexStorageWorker,
  );
  (coordinator as unknown as { closeDrainTimeoutMs: number }).closeDrainTimeoutMs = 25;
  const indexing = coordinator.indexProject(environment.projectRootPath, "full");
  const observedIndex = indexing.then(
    () => null,
    (error: Error) => error,
  );
  let closing: Promise<void> | undefined;

  try {
    await writeStarted.promise;
    closing = coordinator.close();
    const closeOutcome = await Promise.race([
      closing.then(() => "closed" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 150)),
    ]);

    assert.equal(closeOutcome, "closed");
    assert.equal(workerClosed, true);
    assert.match((await observedIndex)?.message ?? "", /forced worker close/);
    assert.equal(environment.store.getProjectByRoot(environment.projectRootPath)?.status, "indexing");
    assert.ok(warnings.some((meta) => meta?.reason === "drain-timeout"));
  } finally {
    rejectWrite(new Error("test cleanup"));
    await Promise.allSettled([indexing, closing].filter(Boolean) as Promise<unknown>[]);
    await coordinator.close();
    await environment.cleanup();
  }
});

test("vector SQLite writes are attributed to vector and write timings", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  environment.settings.vectorIndexingMode = "eager";
  const originalWriteChunkVectors = environment.store.writeChunkVectors.bind(environment.store);
  environment.store.writeChunkVectors = (...args) => {
    blockFor(35);
    return originalWriteChunkVectors(...args);
  };

  try {
    const result = await environment.indexCoordinator.indexProject(environment.projectRootPath, "full");

    assert.ok(result.timings.vectorMs >= 30);
    assert.ok((result.timings.writeMs ?? 0) >= 30);
    assert.ok((result.timings.maxWriteBatchMs ?? 0) >= 30);
    assert.deepEqual(environment.store.getLatestIndexEvent(result.projectId)?.timings, result.timings);
  } finally {
    await environment.cleanup();
  }
});

test("index finalization invalidates the main vector cache without SQL reconciliation", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  environment.settings.vectorIndexingMode = "eager";

  try {
    const first = await environment.indexCoordinator.indexProject(environment.projectRootPath, "full");
    const modelName = environment.embeddingProvider.getModelName();
    const firstVersion = environment.store.getProjectByRoot(environment.projectRootPath)?.index_version;
    assert.ok(firstVersion);
    const warmed = environment.store.getProjectVectors(first.projectId, modelName, firstVersion);
    const cached = environment.store.getProjectVectors(first.projectId, modelName, firstVersion);
    assert.equal(cached.cacheHit, true);
    const firstEmbedding = Array.from(warmed.vectors[0]?.embedding ?? []);

    environment.store.reconcileVectorCacheAfterIndex = () => {
      throw new Error("main-thread SQL vector reconciliation was called");
    };
    await writeFile(
      path.join(environment.projectRootPath, "src/index.ts"),
      "export const value = 2;\n",
      "utf8",
    );
    await environment.indexCoordinator.indexProject(environment.projectRootPath, "incremental");

    const secondVersion = environment.store.getProjectByRoot(environment.projectRootPath)?.index_version;
    assert.ok(secondVersion);
    const reloaded = environment.store.getProjectVectors(first.projectId, modelName, secondVersion);
    assert.equal(reloaded.cacheHit, false);
    assert.notDeepEqual(Array.from(reloaded.vectors[0]?.embedding ?? []), firstEmbedding);
  } finally {
    await environment.cleanup();
  }
});

test("post-detection preparation latency is attributed before parsing", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  const originalListProjectFiles = environment.store.listProjectFiles.bind(environment.store);
  environment.store.listProjectFiles = (...args) => {
    blockFor(35);
    return originalListProjectFiles(...args);
  };

  try {
    const result = await environment.indexCoordinator.indexProject(environment.projectRootPath, "full");

    assert.ok((result.timings.prepareMs ?? 0) >= 30);
    assert.ok(result.timings.indexMs >= (result.timings.prepareMs ?? 0));
    assert.ok(result.timings.totalMs >= (result.timings.prepareMs ?? 0));
    assert.deepEqual(environment.store.getLatestIndexEvent(result.projectId)?.timings, result.timings);
  } finally {
    await environment.cleanup();
  }
});

test("symbol graph latency is attributed before total indexing time completes", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export function answer() { return 42; }\n",
  });
  const originalResolveSymbolGraph = environment.store.resolveSymbolGraph.bind(environment.store);
  environment.store.resolveSymbolGraph = (...args) => {
    blockFor(30);
    return originalResolveSymbolGraph(...args);
  };

  try {
    const result = await environment.indexCoordinator.indexProject(environment.projectRootPath, "full");

    assert.ok((result.timings.symbolGraphMs ?? 0) >= 25);
    assert.ok(result.timings.indexMs >= (result.timings.symbolGraphMs ?? 0));
    assert.ok(result.timings.totalMs >= (result.timings.symbolGraphMs ?? 0));
  } finally {
    await environment.cleanup();
  }
});

test("semantic latency is attributed before total indexing time completes", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export function answer() { return 42; }\n",
  });
  const originalEnsureSemanticIndex = environment.store.ensureSemanticIndex.bind(environment.store);
  environment.store.ensureSemanticIndex = (...args) => {
    blockFor(30);
    return originalEnsureSemanticIndex(...args);
  };

  try {
    const result = await environment.indexCoordinator.indexProject(environment.projectRootPath, "full");

    assert.ok((result.timings.semanticMs ?? 0) >= 25);
    assert.ok(result.timings.indexMs >= (result.timings.semanticMs ?? 0));
    assert.ok(result.timings.totalMs >= (result.timings.semanticMs ?? 0));
  } finally {
    await environment.cleanup();
  }
});

test("automatic ownership refresh latency is included in finalization timings", async () => {
  const environment = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  environment.settings.autoWatch = true;
  environment.settings.watchReconcileSeconds = 0;
  let delayInspection = false;
  const coordinator = new IndexCoordinator(
    environment.settings,
    environment.store,
    { debug() {}, info() {}, warn() {} } as never,
    environment.embeddingProvider,
    noOpWatchFactory,
    async () => {
      if (delayInspection) {
        blockFor(30);
      }
      return { isDirectory: () => true };
    },
  );

  try {
    await coordinator.startAutomaticUpdates();
    delayInspection = true;
    const result = await coordinator.indexProject(environment.projectRootPath, "full");

    assert.ok((result.timings.finalizeMs ?? 0) >= 25);
    assert.ok(result.timings.indexMs >= (result.timings.finalizeMs ?? 0));
    assert.ok(result.timings.totalMs >= (result.timings.finalizeMs ?? 0));
    assert.deepEqual(environment.store.getLatestIndexEvent(result.projectId)?.timings, result.timings);
  } finally {
    coordinator.stopAutomaticUpdates();
    await environment.cleanup();
  }
});

test("mapInBatches yields to timers before starting a later batch", async () => {
  let timerFired = false;

  await mapInBatches([1, 2], 1, async (item) => {
    if (item === 1) {
      setTimeout(() => {
        timerFired = true;
      }, 0);
    } else {
      assert.equal(timerFired, true);
    }
    return item;
  });
});

test("mapInBatches preserves input for invalid batch sizes", async () => {
  for (const batchSize of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -5]) {
    const result = await mapInBatches([1, 2, 3], batchSize, async (item) => item * 2);
    assert.deepEqual(result, [2, 4, 6], `batchSize=${String(batchSize)}`);
  }
});

test("mapInBatches still yields for invalid batch sizes", async () => {
  for (const batchSize of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -5]) {
    let timerFired = false;
    await mapInBatches([1, 2], batchSize, async (item) => {
      if (item === 1) {
        setTimeout(() => {
          timerFired = true;
        }, 0);
      }
      return item;
    });
    assert.equal(timerFired, true, `batchSize=${String(batchSize)}`);
  }
});

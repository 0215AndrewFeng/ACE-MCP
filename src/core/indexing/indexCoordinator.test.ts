import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { IndexProjectResult, Settings } from "../common/types.js";
import { InMemoryEmbeddingProvider } from "../search/embedding.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { createTestProjectEnvironment } from "../../test/helpers.js";
import { IndexCoordinator } from "./indexCoordinator.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

test("recovers a failed watcher after a catch-up index", async () => {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-watch-recover-"));
  let errorListener: ((error: Error) => void) | undefined;
  let watchCount = 0;

  class RecoveringIndexCoordinator extends IndexCoordinator {
    public override async indexProject(root: string): Promise<IndexProjectResult> {
      return cachedResult(root);
    }
  }

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
          if (event === "error" && watchCount === 1) errorListener = listener;
        },
      };
    },
  );

  try {
    coordinator.startWatching(projectRootPath);
    errorListener?.(new Error("watch handle failed"));

    assert.equal(coordinator.isWatching(projectRootPath), false);
    await waitFor(() => watchCount === 2);
    assert.equal(coordinator.isWatching(projectRootPath), true);
  } finally {
    coordinator.stopWatching();
    await rm(projectRootPath, { force: true, recursive: true });
  }
});

test("recovered watcher is clean after its catch-up scan", async () => {
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
  );

  try {
    coordinator.startWatching(environment.projectRootPath);
    errorListener?.(new Error("watch handle failed"));
    await waitFor(() => watchCount === 2);

    const status = coordinator.getWatchStatuses()[0];
    assert.equal(status.watching, true);
    assert.equal(status.dirty, false);
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

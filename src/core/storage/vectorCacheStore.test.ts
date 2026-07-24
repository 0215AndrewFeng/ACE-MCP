import test from "node:test";
import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";

import { HnswIndex } from "../search/hnswIndex.js";
import { createTestProjectEnvironment } from "../../test/helpers.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function seedVectorCache() {
  const env = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  const indexResult = await env.indexCoordinator.indexProject(env.projectRootPath, "full");
  const chunks = env.store.listChunksMissingVectors(indexResult.projectId, "test-model");
  env.store.writeChunkVectors(chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    embedding: [1, 0],
    modelName: "test-model",
  })), indexResult.projectId);
  const project = env.store.getProjectByRoot(env.projectRootPath);
  assert.ok(project);
  return { env, indexResult, project };
}

test("VectorCacheStore caches project vectors and removes only deleted file vectors", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/a.ts": "export const alpha = 1;\n",
    "src/b.ts": "export const beta = 2;\n",
  });

  try {
    const indexResult = await env.indexCoordinator.indexProject(env.projectRootPath, "full");
    const chunks = env.store.listChunksMissingVectors(indexResult.projectId, "test-model");
    assert.equal(chunks.length, 2);

    env.store.writeChunkVectors(chunks.map((chunk, index) => ({
      chunkId: chunk.chunkId,
      embedding: index === 0 ? [1, 0] : [0, 1],
      modelName: "test-model",
    })), indexResult.projectId);

    const project = env.store.getProjectByRoot(env.projectRootPath);
    assert.ok(project);
    const firstRead = env.store.getProjectVectors(indexResult.projectId, "test-model", project.index_version);
    assert.equal(firstRead.cacheHit, false);
    assert.equal(firstRead.vectors.length, 2);

    env.store.deleteFiles(indexResult.projectId, ["src/a.ts"]);
    const secondRead = env.store.getProjectVectors(indexResult.projectId, "test-model", project.index_version);
    assert.equal(secondRead.cacheHit, true);
    assert.deepEqual(secondRead.vectors.map((vector) => vector.filePath), ["src/b.ts"]);
  } finally {
    await env.cleanup();
  }
});

test("clearing a project cache prevents a deferred HNSW load from starting an obsolete build", async () => {
  const { env, indexResult, project } = await seedVectorCache();
  const load = deferred<HnswIndex | null>();
  let buildCalls = 0;
  const vectorStore = (env.store as unknown as {
    vectorStore: {
      buildHnswIndexAsync: () => void;
      loadHnswFromDisk: () => Promise<HnswIndex | null>;
    };
  }).vectorStore;
  vectorStore.loadHnswFromDisk = () => load.promise;
  vectorStore.buildHnswIndexAsync = () => {
    buildCalls += 1;
  };

  try {
    env.store.getProjectVectors(indexResult.projectId, "test-model", project.index_version);
    env.store.clearProjectVectorCache(indexResult.projectId);
    load.resolve(null);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(buildCalls, 0);
  } finally {
    await env.cleanup();
  }
});

test("clearing a project cache prevents a deferred HNSW build from writing obsolete state", async () => {
  const { env, indexResult, project } = await seedVectorCache();
  const buildStarted = deferred<void>();
  const finishBuild = deferred<void>();
  const originalAddBatchAsync = HnswIndex.prototype.addBatchAsync;
  let saveCalls = 0;
  const vectorStore = (env.store as unknown as {
    vectorStore: {
      loadHnswFromDisk: () => Promise<HnswIndex | null>;
      saveHnswToDisk: () => void;
      vectorCache: Map<string, unknown>;
    };
  }).vectorStore;
  vectorStore.loadHnswFromDisk = async () => null;
  vectorStore.saveHnswToDisk = () => {
    saveCalls += 1;
  };
  HnswIndex.prototype.addBatchAsync = async () => {
    buildStarted.resolve();
    await finishBuild.promise;
  };

  try {
    env.store.getProjectVectors(indexResult.projectId, "test-model", project.index_version);
    await buildStarted.promise;
    env.store.clearProjectVectorCache(indexResult.projectId);
    finishBuild.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(saveCalls, 0);
    assert.equal(vectorStore.vectorCache.has(indexResult.projectId), false);
  } finally {
    HnswIndex.prototype.addBatchAsync = originalAddBatchAsync;
    await env.cleanup();
  }
});

test("HNSW disk cache identity includes the project index version", async () => {
  const { env, indexResult } = await seedVectorCache();
  const vectorStore = (env.store as unknown as {
    vectorStore: {
      getHnswCachePath: (
        projectId: string,
        modelName: string,
        indexVersion: number,
        vectorFingerprint: string,
      ) => string;
    };
  }).vectorStore;

  try {
    const firstVersionPath = vectorStore.getHnswCachePath(indexResult.projectId, "test-model", 1, "content");
    const secondVersionPath = vectorStore.getHnswCachePath(indexResult.projectId, "test-model", 2, "content");

    assert.notEqual(firstVersionPath, secondVersionPath);
  } finally {
    await env.cleanup();
  }
});

test("HNSW disk cache identity includes the indexed vector content", async () => {
  const { env, indexResult, project } = await seedVectorCache();
  const vectorStore = (env.store as unknown as {
    vectorStore: {
      getHnswCachePath: (
        projectId: string,
        modelName: string,
        indexVersion: number,
        vectorFingerprint: string,
      ) => string;
    };
  }).vectorStore;

  try {
    const oldContentPath = vectorStore.getHnswCachePath(
      indexResult.projectId,
      "test-model",
      project.index_version,
      "old-content",
    );
    const newContentPath = vectorStore.getHnswCachePath(
      indexResult.projectId,
      "test-model",
      project.index_version,
      "new-content",
    );

    assert.notEqual(oldContentPath, newContentPath);
  } finally {
    await env.cleanup();
  }
});

test("updating vector content changes HNSW identity without an index version bump", async () => {
  const { env, indexResult, project } = await seedVectorCache();
  const vectorStore = (env.store as unknown as {
    vectorStore: {
      vectorCache: Map<string, { indexVersion: number; vectorFingerprint: string }>;
    };
  }).vectorStore;

  try {
    const initial = env.store.getProjectVectors(
      indexResult.projectId,
      "test-model",
      project.index_version,
    );
    const chunkId = initial.vectors[0]?.chunkId;
    assert.ok(chunkId);
    const before = vectorStore.vectorCache.get(indexResult.projectId);
    assert.ok(before);
    const beforeFingerprint = before.vectorFingerprint;

    env.store.writeChunkVectors([{
      chunkId,
      embedding: [0, 1],
      modelName: "test-model",
    }], indexResult.projectId);
    const after = vectorStore.vectorCache.get(indexResult.projectId);
    assert.ok(after);

    assert.equal(after.indexVersion, before.indexVersion);
    assert.notEqual(after.vectorFingerprint, beforeFingerprint);
  } finally {
    await env.cleanup();
  }
});

test("clearing a project cache schedules disk cleanup without waiting for directory I/O", async () => {
  const { env, indexResult, project } = await seedVectorCache();
  const directoryEntries = deferred<string[]>();
  const originalReaddir = fsPromises.readdir;
  let readdirCalls = 0;
  (fsPromises as unknown as { readdir: () => Promise<string[]> }).readdir = async () => {
    readdirCalls += 1;
    return directoryEntries.promise;
  };

  try {
    const startedAt = Date.now();
    env.store.clearProjectVectorCache(indexResult.projectId, project.index_version + 1);

    assert.equal(readdirCalls, 1);
    assert.ok(Date.now() - startedAt < 50);
    directoryEntries.resolve([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    (fsPromises as unknown as { readdir: typeof originalReaddir }).readdir = originalReaddir;
    await env.cleanup();
  }
});

test("an obsolete HNSW save cannot delete a newer generation file after rename", async () => {
  const { env, indexResult, project } = await seedVectorCache();
  const firstRenameStarted = deferred<void>();
  const releaseFirstRename = deferred<void>();
  const secondRenameFinished = deferred<void>();
  const originalRename = fsPromises.rename;
  let renameCalls = 0;
  const vectorStore = (env.store as unknown as {
    vectorStore: {
      getHnswCachePath: (
        projectId: string,
        modelName: string,
        indexVersion: number,
        vectorFingerprint: string,
      ) => string;
      projectGenerations: Map<string, number>;
      saveHnswToDisk: (projectId: string, entry: unknown, hnswIndex: HnswIndex) => void;
      vectorCache: Map<string, unknown>;
    };
  }).vectorStore;
  const cacheEntry = (generation: number) => ({
    generation,
    hnswBuilding: false,
    hnswIndex: null,
    indexVersion: project.index_version,
    modelName: "test-model",
    vectorFingerprint: "same-content",
    vectors: [],
  });
  const hnswIndex = {
    serialize: () => Buffer.from("current-cache", "utf8"),
    size: () => 1,
  } as HnswIndex;
  (fsPromises as unknown as { rename: typeof originalRename }).rename = async (source, destination) => {
    await originalRename(source, destination);
    renameCalls += 1;
    if (renameCalls === 1) {
      firstRenameStarted.resolve();
      await releaseFirstRename.promise;
      return;
    }
    secondRenameFinished.resolve();
  };

  try {
    const oldEntry = cacheEntry(0);
    vectorStore.projectGenerations.set(indexResult.projectId, 0);
    vectorStore.vectorCache.set(indexResult.projectId, oldEntry);
    vectorStore.saveHnswToDisk(indexResult.projectId, oldEntry, hnswIndex);
    await firstRenameStarted.promise;

    const newEntry = cacheEntry(1);
    vectorStore.projectGenerations.set(indexResult.projectId, 1);
    vectorStore.vectorCache.set(indexResult.projectId, newEntry);
    vectorStore.saveHnswToDisk(indexResult.projectId, newEntry, hnswIndex);
    await secondRenameFinished.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    releaseFirstRename.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const cachePath = vectorStore.getHnswCachePath(
      indexResult.projectId,
      "test-model",
      project.index_version,
      "same-content",
    );
    assert.equal(await fsPromises.readFile(cachePath, "utf8"), "current-cache");
  } finally {
    releaseFirstRename.resolve();
    (fsPromises as unknown as { rename: typeof originalRename }).rename = originalRename;
    await env.cleanup();
  }
});

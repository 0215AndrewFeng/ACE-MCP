import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { createTestProjectEnvironment } from "../../test/helpers.js";

test("removeVectorCacheByPaths is a no-op when project not cached", async () => {
  const environment = await createTestProjectEnvironment({
    "a.ts": "export function alpha() {\n  return 1;\n}\n",
    "b.ts": "export function beta() {\n  return 2;\n}\n",
  });
  try {
    const { store } = environment;
    // deleteFiles internally calls removeVectorCacheByPaths; for an uncached
    // random projectId it must be a safe no-op (not throw).
    assert.doesNotThrow(() => store.deleteFiles("nonexistent-project", ["a.ts"]));
  } finally {
    await environment.cleanup();
  }
});

test("reconcileVectorCacheAfterIndex evicts stale vectors and keeps untouched ones", async () => {
  const environment = await createTestProjectEnvironment({
    "a.ts": "export function alpha() {\n  return 1;\n}\n",
    "b.ts": "export function beta() {\n  return 2;\n}\n",
  });

  try {
    const { store, indexCoordinator, embeddingProvider, projectRootPath } = environment;
    await indexCoordinator.indexProject(projectRootPath, "full");

    const project = store.getProjectByRoot(projectRootPath);
    assert.ok(project, "project should exist after indexing");
    const modelName = embeddingProvider.getModelName();

    // Warm: write vectors for every chunk (lazy mode does not write at index time).
    const missing = store.listChunksMissingVectors(project.project_id, modelName);
    assert.ok(missing.length >= 2, "both files should produce chunks needing vectors");
    const embeddings = await embeddingProvider.embedBatch(missing.map((chunk) => chunk.content));
    store.writeChunkVectors(
      missing.map((chunk, index) => ({ chunkId: chunk.chunkId, embedding: embeddings[index], modelName })),
      project.project_id,
    );

    // Populate the in-memory vector cache for this index_version.
    const initial = store.getProjectVectors(project.project_id, modelName, project.index_version);
    assert.ok(initial.vectors.some((v) => v.filePath === "a.ts"), "a.ts cached");
    assert.ok(initial.vectors.some((v) => v.filePath === "b.ts"), "b.ts cached");

    // Edit a.ts (new content → new chunk ids → old chunk_vectors cascade-deleted),
    // reindex incrementally; reconcileVectorCacheAfterIndex runs as part of indexing.
    await writeFile(path.join(projectRootPath, "a.ts"), "export function alphaRenamed() {\n  return 42;\n}\n", "utf8");
    await indexCoordinator.indexProject(projectRootPath, "incremental");

    const reindexed = store.getProjectByRoot(projectRootPath);
    assert.ok(reindexed);
    assert.ok(reindexed.index_version > project.index_version, "index_version bumped");

    const afterReconcile = store.getProjectVectors(project.project_id, modelName, reindexed.index_version);
    assert.equal(afterReconcile.cacheHit, true, "cache should hit at new version (no full reload)");
    // a.ts's new chunks are unwarmed (lazy) so its stale cached vectors must be gone.
    assert.equal(
      afterReconcile.vectors.some((v) => v.filePath === "a.ts"),
      false,
      "stale a.ts vectors should be evicted",
    );
    assert.ok(
      afterReconcile.vectors.some((v) => v.filePath === "b.ts"),
      "untouched b.ts vectors should remain",
    );
  } finally {
    await environment.cleanup();
  }
});

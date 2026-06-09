import assert from "node:assert/strict";
import { test } from "node:test";

import { createTestProjectEnvironment } from "../../test/helpers.js";

test("getVectorCoverage / hasVectorIndex reflect unwarmed vs warmed state", async () => {
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

    // Lazy mode: nothing warmed yet.
    const before = store.getVectorCoverage(project.project_id, modelName);
    assert.ok(before.totalChunkCount >= 2, "should have chunks");
    assert.equal(before.indexedChunkCount, 0, "no vectors warmed yet");
    assert.equal(store.hasVectorIndex(project.project_id, modelName), false);

    // Warm all chunks.
    const missing = store.listChunksMissingVectors(project.project_id, modelName);
    const embeddings = await embeddingProvider.embedBatch(missing.map((c) => c.content));
    store.writeChunkVectors(
      missing.map((c, i) => ({ chunkId: c.chunkId, embedding: embeddings[i], modelName })),
      project.project_id,
    );

    const after = store.getVectorCoverage(project.project_id, modelName);
    assert.equal(after.indexedChunkCount, after.totalChunkCount, "all chunks warmed");
    assert.equal(after.missingChunkCount, 0);
    assert.equal(store.hasVectorIndex(project.project_id, modelName), true);
  } finally {
    await environment.cleanup();
  }
});

test("deleteFiles removes a file's chunks without throwing", async () => {
  const environment = await createTestProjectEnvironment({
    "a.ts": "export function alpha() {\n  return 1;\n}\n",
    "b.ts": "export function beta() {\n  return 2;\n}\n",
  });

  try {
    const { store, indexCoordinator, projectRootPath } = environment;
    await indexCoordinator.indexProject(projectRootPath, "full");

    const project = store.getProjectByRoot(projectRootPath);
    assert.ok(project);

    const before = store.listProjectFiles(project.project_id).map((f) => f.relativePath);
    assert.ok(before.includes("a.ts"));
    assert.ok(before.includes("b.ts"));

    assert.doesNotThrow(() => store.deleteFiles(project.project_id, ["a.ts"]));

    const after = store.listProjectFiles(project.project_id).map((f) => f.relativePath);
    assert.equal(after.includes("a.ts"), false, "deleted file should be gone");
    assert.ok(after.includes("b.ts"), "untouched file should remain");
  } finally {
    await environment.cleanup();
  }
});

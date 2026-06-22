import test from "node:test";
import assert from "node:assert/strict";

import { createTestProjectEnvironment } from "../../test/helpers.js";

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

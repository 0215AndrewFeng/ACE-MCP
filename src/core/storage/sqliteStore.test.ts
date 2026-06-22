import test from "node:test";
import assert from "node:assert/strict";

import { createTestProjectEnvironment } from "../../test/helpers.js";

test("SQLiteStore records indexed files, chunks, symbols, and latest index metadata", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/refund.ts": "export class RefundService {\n  refundOrder() { return true; }\n}\n",
  });

  try {
    const indexResult = await env.indexCoordinator.indexProject(env.projectRootPath, "full");
    const stats = env.store.getProjectStats(env.projectRootPath);

    assert.equal(indexResult.indexedFiles, 1);
    assert.equal(stats?.fileCount, 1);
    assert.equal(stats?.chunkCount, 1);
    assert.equal(stats?.symbolCount, 2);
    assert.equal(stats?.latestIndexEvent?.indexedFiles, 1);
  } finally {
    await env.cleanup();
  }
});

test("SQLiteStore.deleteFiles cascades file-owned rows and leaves project stats consistent", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/refund.ts": "export class RefundService {\n  refundOrder() { return true; }\n}\n",
  });

  try {
    const indexResult = await env.indexCoordinator.indexProject(env.projectRootPath, "full");
    env.store.deleteFiles(indexResult.projectId, ["src/refund.ts"]);
    const stats = env.store.getProjectStats(env.projectRootPath);

    assert.equal(stats?.fileCount, 0);
    assert.equal(stats?.chunkCount, 0);
    assert.equal(stats?.symbolCount, 0);
    assert.deepEqual(env.store.listProjectFiles(indexResult.projectId), []);
  } finally {
    await env.cleanup();
  }
});

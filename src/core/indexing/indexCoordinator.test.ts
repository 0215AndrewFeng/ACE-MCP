import test from "node:test";
import assert from "node:assert/strict";

import type { IndexProjectResult, Settings } from "../common/types.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { IndexCoordinator } from "./indexCoordinator.js";

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
  } as Settings;
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
  } as Settings;
  const coordinator = new IndexCoordinator(settings, {} as never, { debug() {}, info() {}, warn() {} } as never, {} as EmbeddingProvider);
  const result = cachedResult(process.cwd());

  coordinator.restoreFreshnessState(process.cwd(), result);

  assert.equal(await coordinator.ensureFreshIndex(process.cwd(), 1), result);
});

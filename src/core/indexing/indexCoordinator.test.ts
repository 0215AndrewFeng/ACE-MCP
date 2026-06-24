import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

import test from "node:test";
import assert from "node:assert/strict";

import type { Settings } from "../core/common/types.js";
import { createTestProjectEnvironment } from "../test/helpers.js";
import { startWebApp } from "./app.js";

function blockFor(ms: number): void {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    // Deliberately simulate a synchronous SQLite read blocked behind a writer.
  }
}

test("startWebApp serves health and validation responses", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/index.ts": "export const value = 1;\n",
  });
  const app = await startWebApp(0, {
    embeddingProvider: env.embeddingProvider,
    indexCoordinator: env.indexCoordinator,
    llmClient: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    runtime: {
      nodeVersion: process.version,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "test",
      webPort: 0,
    },
    searchService: env.searchService,
    settings: env.settings,
    store: env.store,
    summaryGenerator: {} as never,
  });

  try {
    const health = await fetch(`http://127.0.0.1:${app.port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");

    const invalid = await fetch(`http://127.0.0.1:${app.port}/api/search-context`, {
      body: JSON.stringify({ projectRootPath: env.projectRootPath }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, "VALIDATION_ERROR");
  } finally {
    await app.close();
    await env.cleanup();
  }
});

test("health does not wait for per-project SQLite stats", async () => {
  const app = await startWebApp(0, {
    embeddingProvider: {} as never,
    indexCoordinator: {
      getInFlightIndexInfo: () => [{ ageMs: 12_000, projectRootPath: "/repo", queued: 1 }],
      isWatching: () => true,
    } as never,
    llmClient: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    runtime: {
      nodeVersion: process.version,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "test",
      webPort: 0,
    },
    searchService: {} as never,
    settings: {
      enableVectorSearch: true,
      vectorIndexingMode: "lazy",
    } as Settings,
    store: {
      getProjectStats: () => {
        blockFor(250);
        return null;
      },
      listProjects: () => [
        {
          languages: [],
          lastIndexAt: "2026-06-24T00:00:00.000Z",
          lastScanAt: "2026-06-24T00:00:00.000Z",
          projectRootPath: "/repo",
          status: "ready",
        },
      ],
    } as never,
    summaryGenerator: {} as never,
  });

  try {
    const startedAt = Date.now();
    const health = await fetch(`http://127.0.0.1:${app.port}/health`);
    const elapsedMs = Date.now() - startedAt;
    const body = await health.json();

    assert.equal(health.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.projects.total, 1);
    assert.equal(body.projects.ready, 1);
    assert.ok(elapsedMs < 100, `health took ${elapsedMs}ms`);
  } finally {
    await app.close();
  }
});

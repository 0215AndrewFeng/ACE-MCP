import assert from "node:assert/strict";
import test from "node:test";

import { Logger } from "../core/common/logger.js";
import { createStructuredToolResult } from "../server/toolPayloads.js";
import { createTestProjectEnvironment } from "../test/helpers.js";
import { APP_VERSION } from "../version.js";
import { startWebApp } from "./app.js";

test("web app exposes runtime diagnostics and health metadata", async () => {
  const environment = await createTestProjectEnvironment({
    "package.json": JSON.stringify({ name: "fixture" }),
    "src/refund/service.ts": "export function refundHandler() {\n  return 'refund';\n}\n",
  });

  try {
    const runtime = {
      nodeVersion: process.version,
      pid: process.pid,
      startedAt: new Date(Date.now() - 500).toISOString(),
      version: APP_VERSION,
      webPort: undefined,
    };
    const handle = await startWebApp(0, {
      indexCoordinator: environment.indexCoordinator,
      logger: new Logger(environment.settings.logFilePath, "error"),
      runtime,
      searchService: environment.searchService,
      settings: environment.settings,
      store: environment.store,
    });

    try {
      const healthResponse = await fetch(`http://127.0.0.1:${handle.port}/health`);
      const healthPayload = (await healthResponse.json()) as Record<string, unknown>;
      assert.equal(healthResponse.status, 200);
      assert.equal(healthPayload.status, "ok");
      assert.equal(healthPayload.version, runtime.version);
      assert.equal(healthPayload.pid, runtime.pid);
      assert.equal(typeof healthPayload.uptimeMs, "number");

      const runtimeResponse = await fetch(`http://127.0.0.1:${handle.port}/api/runtime`);
      const runtimePayload = (await runtimeResponse.json()) as Record<string, unknown>;
      assert.equal(runtimeResponse.status, 200);
      assert.equal(runtimePayload.version, runtime.version);
      assert.equal(runtimePayload.nodeVersion, runtime.nodeVersion);
      assert.equal(runtimePayload.pid, runtime.pid);
      assert.equal(typeof runtimePayload.uptimeMs, "number");
    } finally {
      await handle.close();
    }
  } finally {
    await environment.cleanup();
  }
});

test("web search and stats responses separate project totals from incremental sync deltas", async () => {
  const environment = await createTestProjectEnvironment({
    "package.json": JSON.stringify({ name: "fixture" }),
    "src/refund/service.ts": "export function refundHandler() {\n  return 'refund';\n}\n",
  });

  try {
    const runtime = {
      nodeVersion: process.version,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: APP_VERSION,
      webPort: undefined,
    };
    const handle = await startWebApp(0, {
      indexCoordinator: environment.indexCoordinator,
      logger: new Logger(environment.settings.logFilePath, "error"),
      runtime,
      searchService: environment.searchService,
      settings: environment.settings,
      store: environment.store,
    });

    try {
      const firstSearchResponse = await fetch(`http://127.0.0.1:${handle.port}/api/search-context`, {
        body: JSON.stringify({
          mode: "auto",
          projectRootPath: environment.projectRootPath,
          query: "refundHandler",
          topK: 5,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(firstSearchResponse.status, 200);

      const searchResponse = await fetch(`http://127.0.0.1:${handle.port}/api/search-context`, {
        body: JSON.stringify({
          mode: "auto",
          projectRootPath: environment.projectRootPath,
          query: "refundHandler",
          topK: 5,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const searchPayload = (await searchResponse.json()) as {
        notes: string[];
        stats: {
          indexSync: {
            indexedFileCount: number;
          };
          project: {
            indexedFileCount: number;
          };
        };
      };
      assert.equal(searchResponse.status, 200);
      assert.equal(searchPayload.stats.project.indexedFileCount, 1);
      assert.equal(searchPayload.stats.indexSync.indexedFileCount, 0);
      assert.equal(searchPayload.notes.some((note) => note.includes("persisted project total")), true);

      const statsResponse = await fetch(
        `http://127.0.0.1:${handle.port}/api/project-stats?projectRootPath=${encodeURIComponent(environment.projectRootPath)}`,
      );
      const statsPayload = (await statsResponse.json()) as {
        data: {
          indexed: boolean;
        };
        stats: {
          latestIndexing?: {
            indexedFileCount: number;
          };
          project: {
            indexedFileCount: number;
          };
        };
      };
      assert.equal(statsResponse.status, 200);
      assert.equal(statsPayload.data.indexed, true);
      assert.equal(statsPayload.stats.project.indexedFileCount, 1);
      assert.equal(statsPayload.stats.latestIndexing?.indexedFileCount, 0);
    } finally {
      await handle.close();
    }
  } finally {
    await environment.cleanup();
  }
});

test("structured tool results expose the same payload as text and structured content", () => {
  const payload = {
    data: { indexed: false },
    meta: { generatedAt: "2025-01-01T00:00:00.000Z", ok: true as const, tool: "project_stats" as const },
  };
  const result = createStructuredToolResult(payload);

  assert.deepEqual(result.structuredContent, payload);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, JSON.stringify(payload, null, 2));
});

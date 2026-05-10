import assert from "node:assert/strict";
import test from "node:test";

import { Logger } from "../core/common/logger.js";
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

test("web search and stats responses return valid data", async () => {
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
      // First search - should index the project
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

      const searchPayload = (await firstSearchResponse.json()) as {
        data: {
          diagnostics: {
            candidateCount: number;
          };
          results: unknown[];
        };
        stats: {
          project: {
            indexedFileCount: number;
          } | null;
          search: {
            searchMs: number;
          };
        };
      };
      assert.equal(Array.isArray(searchPayload.data.results), true);
      assert.equal((searchPayload.stats.project?.indexedFileCount ?? 0) >= 1, true);
      assert.equal(typeof searchPayload.stats.search.searchMs === "number", true);
      assert.equal(searchPayload.data.diagnostics.candidateCount >= searchPayload.data.results.length, true);

      // Stats API
      const statsResponse = await fetch(
        `http://127.0.0.1:${handle.port}/api/project-stats?projectRootPath=${encodeURIComponent(environment.projectRootPath)}`,
      );
      const statsPayload = (await statsResponse.json()) as {
        data: {
          status: string;
        };
      };
      assert.equal(statsResponse.status, 200);
      assert.equal(statsPayload.data.status, "ready");
    } finally {
      await handle.close();
    }
  } finally {
    await environment.cleanup();
  }
});

test("watch API endpoints return correct state", async () => {
  const environment = await createTestProjectEnvironment({
    "package.json": JSON.stringify({ name: "fixture" }),
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
      // start watch
      const startResponse = await fetch(`http://127.0.0.1:${handle.port}/api/watch/start`, {
        body: JSON.stringify({ projectRootPath: environment.projectRootPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(startResponse.status, 200);
      const startPayload = (await startResponse.json()) as { projectRootPath: string; watching: boolean };
      assert.equal(startPayload.watching, true);
      assert.equal(typeof startPayload.projectRootPath, "string");

      // stop watch
      const stopResponse = await fetch(`http://127.0.0.1:${handle.port}/api/watch/stop`, {
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(stopResponse.status, 200);
      const stopPayload = (await stopResponse.json()) as { watching: boolean };
      assert.equal(stopPayload.watching, false);
    } finally {
      await handle.close();
    }
  } finally {
    await environment.cleanup();
  }
});

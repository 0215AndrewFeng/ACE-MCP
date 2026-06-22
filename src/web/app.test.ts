import test from "node:test";
import assert from "node:assert/strict";

import { createTestProjectEnvironment } from "../test/helpers.js";
import { startWebApp } from "./app.js";

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

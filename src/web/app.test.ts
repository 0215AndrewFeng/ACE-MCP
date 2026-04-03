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

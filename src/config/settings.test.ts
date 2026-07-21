import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadSettings } from "./settings.js";

test("loads automatic index update defaults and environment overrides", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-settings-"));
  const environmentKeys = [
    "HOME",
    "ACE_MCP_INDEX_CONCURRENCY",
    "ACE_MCP_WATCH_DEBOUNCE_MS",
    "ACE_MCP_WATCH_MAX_WAIT_MS",
    "ACE_MCP_WATCH_RECONCILE_SECONDS",
  ] as const;
  const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));

  try {
    process.env.HOME = tempHome;
    process.env.ACE_MCP_INDEX_CONCURRENCY = "2";
    process.env.ACE_MCP_WATCH_DEBOUNCE_MS = "125";
    process.env.ACE_MCP_WATCH_MAX_WAIT_MS = "900";
    process.env.ACE_MCP_WATCH_RECONCILE_SECONDS = "45";

    const settings = await loadSettings();
    const generatedToml = await readFile(settings.settingsFilePath, "utf8");

    assert.equal(settings.indexConcurrency, 2);
    assert.equal(settings.watchDebounceMs, 125);
    assert.equal(settings.watchMaxWaitMs, 900);
    assert.equal(settings.watchReconcileSeconds, 45);
    assert.match(generatedToml, /^indexConcurrency = 1$/m);
    assert.match(generatedToml, /^watchDebounceMs = 2_?000$/m);
    assert.match(generatedToml, /^watchMaxWaitMs = 10_?000$/m);
    assert.match(generatedToml, /^watchReconcileSeconds = 600$/m);
  } finally {
    for (const key of environmentKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempHome, { force: true, recursive: true });
  }
});

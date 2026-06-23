import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { formatDoctorReport, runDoctorChecks } from "./doctor.js";

test("runDoctorChecks reports core install health with actionable statuses", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-doctor-"));

  try {
    const result = await runDoctorChecks({
      cwd: tempDir,
      env: {},
      settings: {
        dataDir: path.join(tempDir, "data"),
        databasePath: path.join(tempDir, "data/index.db"),
        embeddingApiKey: "",
        embeddingApiUrl: "",
        embeddingProvider: "memory",
        llmApiKey: "",
        llmApiUrl: "",
        logDir: path.join(tempDir, "log"),
        settingsFilePath: path.join(tempDir, "settings.toml"),
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.summary.error, 0);
    assert.ok(result.summary.ok >= 5);
    assert.ok(result.checks.some((check) => check.id === "node-version" && check.status === "ok"));
    assert.ok(result.checks.some((check) => check.id === "better-sqlite3" && check.status === "ok"));
    assert.ok(result.checks.some((check) => check.id === "sqlite-fts5" && check.status === "ok"));
    assert.ok(result.checks.some((check) => check.id === "data-dir-writable" && check.status === "ok"));
    assert.ok(result.checks.some((check) => check.id === "llm-config" && check.status === "warn"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("formatDoctorReport renders check names, statuses, and next steps", () => {
  const report = formatDoctorReport({
    checks: [
      {
        id: "node-version",
        message: "Node.js v22.0.0 satisfies >=18.18.0",
        name: "Node.js",
        status: "ok",
      },
      {
        fix: "Set ACE_MCP_LLM_API_URL and ACE_MCP_LLM_API_KEY before using ask_codebase.",
        id: "llm-config",
        message: "LLM config is not set; search still works.",
        name: "LLM config",
        status: "warn",
      },
    ],
    ok: true,
    summary: { error: 0, ok: 1, warn: 1 },
  });

  assert.match(report, /ace-mcp doctor/);
  assert.match(report, /\[OK\] Node\.js/);
  assert.match(report, /\[WARN\] LLM config/);
  assert.match(report, /Next steps/);
  assert.match(report, /ACE_MCP_LLM_API_URL/);
});

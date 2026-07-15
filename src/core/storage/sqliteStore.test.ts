import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { createTestProjectEnvironment } from "../../test/helpers.js";
import { Logger } from "../common/logger.js";
import { SQLiteStore } from "./sqliteStore.js";

test("SQLiteStore constructor applies connection pragmas used by search worker connections", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-sqlite-pragmas-"));
  const databasePath = path.join(tempDir, "index.db");

  try {
    const logger = new Logger(path.join(tempDir, "ace-mcp.log"), "error");
    const store = new SQLiteStore(databasePath, logger);
    const db = (store as unknown as { db: Database.Database }).db;
    const busyTimeout = db.pragma("busy_timeout", { simple: true }) as number;
    assert.equal(busyTimeout, 30000);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

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

test("SQLiteStore.deleteProject removes registration and cascades indexed rows", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/a.ts": "export const alpha = 1;\n",
    "src/b.ts": "export const beta = 2;\n",
  });

  try {
    const indexResult = await env.indexCoordinator.indexProject(env.projectRootPath, "full");
    const result = env.store.deleteProject(env.projectRootPath);

    assert.equal(result.deleted, true);
    assert.equal(result.fileCount, 2);
    assert.equal(result.projectId, indexResult.projectId);
    assert.equal(env.store.getProjectByRoot(env.projectRootPath), undefined);
    assert.equal(env.store.getProjectStats(env.projectRootPath), null);
    assert.equal(env.store.listProjects().some((project) => project.projectRootPath === env.projectRootPath), false);
    assert.deepEqual(env.store.listProjectFiles(indexResult.projectId), []);
  } finally {
    await env.cleanup();
  }
});

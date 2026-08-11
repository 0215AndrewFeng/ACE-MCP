import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("SQLiteStore prepares project state with its existing file snapshot", async () => {
  const env = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });

  try {
    const indexed = await env.indexCoordinator.indexProject(env.projectRootPath, "full");
    const prepared = (env.store as SQLiteStore & {
      prepareProjectIndex: typeof env.store.prepareProjectIndex;
    }).prepareProjectIndex(indexed.projectId, indexed.project, new Date().toISOString());

    assert.deepEqual(prepared.existingFiles.map((file) => file.relativePath), ["src/index.ts"]);
    assert.equal(env.store.getProjectByRoot(env.projectRootPath)?.status, "indexing");
  } finally {
    await env.cleanup();
  }
});

test("SQLiteStore rolls back project preparation when the file snapshot fails", async () => {
  const env = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });

  try {
    const indexed = await env.indexCoordinator.indexProject(env.projectRootPath, "full");
    env.store.listProjectFiles = () => {
      throw new Error("snapshot failed");
    };

    assert.throws(
      () => (env.store as SQLiteStore & {
        prepareProjectIndex: typeof env.store.prepareProjectIndex;
      }).prepareProjectIndex(indexed.projectId, indexed.project, new Date().toISOString()),
      /snapshot failed/,
    );
    assert.equal(env.store.getProjectByRoot(env.projectRootPath)?.status, "ready");
  } finally {
    await env.cleanup();
  }
});

test("SQLiteStore atomically persists failed project state with its index event", async () => {
  const env = await createTestProjectEnvironment({});
  const projectId = "atomic-failure-project";
  const timestamp = "2026-07-23T02:00:00.000Z";
  const project = {
    languages: ["javascript" as const],
    markers: ["package.json"],
    projectType: "single-language" as const,
    rootPath: path.join(env.tempDir, "atomic-project"),
  };
  const now = Date.now();
  const payload = {
    bumpIndexVersion: true,
    event: {
      changedFiles: 1,
      chunkCount: 0,
      createdAt: timestamp,
      deletedFiles: 0,
      failedFiles: [{ filePath: "src/broken.ts", message: "parse failed" }],
      indexedFiles: 0,
      metadata: {
        vectorIndex: { enabled: false, hydratedChunkCount: 0, mode: "lazy" as const },
      },
      scannedFiles: 1,
    },
    status: "error" as const,
    timestamp,
    timing: {
      baseTimings: { collectMs: 1, detectMs: 1, indexMs: 2, totalMs: 3, vectorMs: 0, writeMs: 0 },
      finalizeStartedAtMs: now,
      finalizeWriteStartedAtMs: now,
      indexStartedAtMs: now - 2,
      totalStartedAtMs: now - 3,
    },
  };

  try {
    env.store.upsertProject(projectId, project, "indexing", timestamp);
    const result = env.store.finalizeProjectIndex(projectId, payload);

    assert.equal(env.store.getProjectByRoot(project.rootPath)?.status, "error");
    assert.equal(env.store.getLatestIndexEvent(projectId)?.failedFileCount, 1);
    assert.deepEqual(env.store.getLatestIndexEvent(projectId)?.timings, result.timings);

    env.store.upsertProject(projectId, project, "indexing", timestamp);
    assert.throws(() => env.store.finalizeProjectIndex(projectId, payload));
    assert.equal(env.store.getProjectByRoot(project.rootPath)?.status, "indexing");
    assert.equal(env.store.getLatestIndexEvent(projectId)?.failedFileCount, 1);
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

test("SQLiteStore coordinates an expiring index maintenance lease across connections", async () => {
  const env = await createTestProjectEnvironment({
    "src/index.ts": "export const value = 1;\n",
  });
  const secondStore = new SQLiteStore(env.settings.databasePath, {
    debug() {},
    info() {},
    warn() {},
  } as never);
  secondStore.initialize();
  const nowMs = Date.now();

  try {
    assert.equal(env.store.tryAcquireIndexMaintenanceLease("web-a", nowMs + 60_000, nowMs), true);
    assert.deepEqual(secondStore.getActiveIndexMaintenanceLease(nowMs + 1), {
      expiresAtMs: nowMs + 60_000,
      ownerId: "web-a",
    });
    assert.equal(secondStore.tryAcquireIndexMaintenanceLease("web-b", nowMs + 90_000, nowMs + 1), false);

    assert.equal(secondStore.tryAcquireIndexMaintenanceLease("web-b", nowMs + 120_000, nowMs + 60_001), true);
    assert.equal(env.store.releaseIndexMaintenanceLease("web-a"), false);
    assert.equal(env.store.renewIndexMaintenanceLease("web-a", nowMs + 180_000), false);
    assert.equal(secondStore.releaseIndexMaintenanceLease("web-b"), true);
    assert.equal(env.store.getActiveIndexMaintenanceLease(nowMs + 60_002), null);
  } finally {
    await env.cleanup();
  }
});

test("SQLiteStore project routing excludes roots before applying one total result limit", async () => {
  const env = await createTestProjectEnvironment({
    "src/SharedThing.ts": "export class SharedThing { routeKeyword(): void {} }\n",
  });
  const secondProject = path.join(env.tempDir, "second-project");

  try {
    await mkdir(path.join(secondProject, "src"), { recursive: true });
    await writeFile(
      path.join(secondProject, "src/SharedThing.ts"),
      "export class SharedThing { routeKeyword(): void {} }\n",
      "utf8",
    );
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");
    await env.indexCoordinator.indexProject(secondProject, "full");

    const allMatches = env.store.searchProjectRoutes(
      "sharedthing* OR routekeyword*",
      ["SharedThing"],
      4,
    );
    const matches = env.store.searchProjectRoutes(
      "sharedthing* OR routekeyword*",
      ["SharedThing"],
      3,
      [env.projectRootPath],
    );

    assert.equal(allMatches.filter((match) => match.source === "symbol").every((match) => match.rank === 1), true);
    assert.ok(matches.length > 0);
    assert.ok(matches.length <= 3);
    assert.equal(matches.every((match) => match.projectRootPath === secondProject), true);
  } finally {
    await env.cleanup();
  }
});

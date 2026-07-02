import test from "node:test";
import assert from "node:assert/strict";

import type { Settings } from "../core/common/types.js";
import { createTestProjectEnvironment } from "../test/helpers.js";
import { LongTaskTracker } from "../core/tasks/longTaskTracker.js";
import { startWebApp } from "./app.js";

function blockFor(ms: number): void {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    // Deliberately simulate a synchronous SQLite read blocked behind a writer.
  }
}

async function assertTaskStatus(port: number, taskId: string, expectedStatus: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(taskId)}`);
    const body = await response.json();
    lastStatus = body.task?.status ?? "";
    if (lastStatus === expectedStatus) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`task ${taskId} status was ${lastStatus}, expected ${expectedStatus}`);
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
      getInFlightIndexInfo: () => [
        {
          dedupedRequests: 3,
          elapsedMs: 12_000,
          projectRootPath: "/repo",
          queuedRequests: 1,
          status: "running",
        },
      ],
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
    assert.equal(body.indexing[0].dedupedRequests, 3);
    assert.equal(body.indexing[0].queuedRequests, 1);
    assert.equal(body.indexing[0].status, "running");
    assert.ok(elapsedMs < 100, `health took ${elapsedMs}ms`);
  } finally {
    await app.close();
  }
});

test("health exposes active summary long tasks", async () => {
  const tracker = new LongTaskTracker();
  tracker.start("summary", "/repo");
  const app = await startWebApp(0, {
    embeddingProvider: {} as never,
    indexCoordinator: {
      getInFlightIndexInfo: () => [],
      isWatching: () => false,
    } as never,
    llmClient: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    longTaskTracker: tracker,
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
      listProjects: () => [],
    } as never,
    summaryGenerator: {} as never,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].type, "summary");
    assert.equal(body.tasks[0].projectRootPath, "/repo");
    assert.equal(body.tasks[0].status, "running");
    assert.equal(typeof body.tasks[0].elapsedMs, "number");
  } finally {
    await app.close();
  }
});

test("project profile validates project root path", async () => {
  const app = await startWebApp(0, {
    embeddingProvider: { getModelName: () => "test-vector-model" } as never,
    indexCoordinator: {
      getInFlightIndexInfo: () => [],
      isWatching: () => false,
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
      listProjects: () => [],
    } as never,
    summaryGenerator: { loadSummary: async () => null } as never,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/project-profile`);
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, "VALIDATION_ERROR");
    assert.equal(body.error, "projectRootPath is required");
  } finally {
    await app.close();
  }
});

test("project profile reports full-index recommendation for unknown projects", async () => {
  const app = await startWebApp(0, {
    embeddingProvider: { getModelName: () => "test-vector-model" } as never,
    indexCoordinator: {
      getInFlightIndexInfo: () => [],
      isWatching: () => false,
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
      getProjectByRoot: () => undefined,
      getProjectStats: () => null,
      listProjects: () => [],
    } as never,
    summaryGenerator: { loadSummary: async () => null } as never,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/project-profile?projectRootPath=${encodeURIComponent("/repo")}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.indexed, false);
    assert.equal(body.data.counts.fileCount, 0);
    assert.equal(body.data.summary.found, false);
    assert.equal(body.data.vector.enabled, true);
    assert.equal(body.data.vector.modelName, "test-vector-model");
    assert.equal(body.data.diagnostics.status, "not_indexed");
    assert.deepEqual(
      body.data.diagnostics.suggestions.map((suggestion: { code: string }) => suggestion.code),
      ["RUN_FULL_INDEX"],
    );
    assert.deepEqual(body.notes, ["Project has not been indexed yet."]);
  } finally {
    await app.close();
  }
});

test("project profile returns indexed search readiness diagnostics", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/order.ts": "export class OrderService {\n  refund(orderId: string) { return orderId; }\n}\n",
  });
  await env.indexCoordinator.indexProject(env.projectRootPath, "full");
  const summaryGeneratedAt = "2026-07-02T10:00:00.000Z";
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
    summaryGenerator: {
      loadSummary: async () => ({
        architecture: "Indexed test project",
        generatedAt: summaryGeneratedAt,
        modules: [
          {
            description: "Order module",
            fileCount: 1,
            keySymbols: ["OrderService"],
            path: "src",
          },
        ],
        projectRootPath: env.projectRootPath,
        relationships: [],
        tokensUsed: { completion: 3, prompt: 5 },
        version: 1,
      }),
    } as never,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/project-profile?projectRootPath=${encodeURIComponent(env.projectRootPath)}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.indexed, true);
    assert.equal(body.data.projectRootPath, env.projectRootPath);
    assert.equal(typeof body.data.projectId, "string");
    assert.ok(body.data.counts.fileCount >= 1);
    assert.ok(body.data.counts.chunkCount >= 1);
    assert.ok(body.data.counts.symbolCount >= 1);
    assert.ok(body.data.languages.some((item: { fileCount: number; language: string }) => item.fileCount >= 1 && item.language.length > 0));
    assert.equal(body.data.summary.found, true);
    assert.equal(body.data.summary.generatedAt, summaryGeneratedAt);
    assert.equal(body.data.summary.moduleCount, 1);
    assert.equal(body.data.vector.enabled, true);
    assert.equal(body.data.vector.mode, "lazy");
    assert.equal(body.data.vector.modelName, env.embeddingProvider.getModelName());
    assert.equal(typeof body.data.vector.hasIndex, "boolean");
    assert.ok(body.data.vector.coverage.totalChunkCount >= body.data.vector.coverage.indexedChunkCount);
    assert.equal(body.data.diagnostics.suggestions.some((suggestion: { code: string }) => suggestion.code === "GENERATE_SUMMARY"), false);
    assert.match(body.data.diagnostics.status, /healthy|needs_attention/);
    assert.equal(body.stats.project.fileCount, body.data.counts.fileCount);
    assert.equal(body.stats.vector.modelName, env.embeddingProvider.getModelName());
  } finally {
    await app.close();
    await env.cleanup();
  }
});

test("task list filters by type status and project root", async () => {
  const tracker = new LongTaskTracker();
  const summaryTaskId = tracker.start("summary", "/repo-a");
  tracker.finish(summaryTaskId, { moduleCount: 2 });
  const indexTaskId = tracker.start("index", "/repo-b");
  const failedTask = tracker.run("index", "/repo-a", async () => {
    throw new Error("index failed");
  });
  const app = await startWebApp(0, {
    embeddingProvider: {} as never,
    indexCoordinator: {
      getInFlightIndexInfo: () => [],
      isWatching: () => false,
    } as never,
    llmClient: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    longTaskTracker: tracker,
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
      listProjects: () => [],
    } as never,
    summaryGenerator: {} as never,
  });

  try {
    await assertTaskStatus(app.port, failedTask.taskId, "failed");
    const byType = await fetch(`http://127.0.0.1:${app.port}/api/tasks?type=summary`);
    const byTypeBody = await byType.json();
    assert.equal(byTypeBody.tasks.length, 1);
    assert.equal(byTypeBody.tasks[0].taskId, summaryTaskId);
    assert.equal(byTypeBody.filters.type, "summary");

    const byProject = await fetch(`http://127.0.0.1:${app.port}/api/tasks?projectRootPath=${encodeURIComponent("/repo-b")}`);
    const byProjectBody = await byProject.json();
    assert.equal(byProjectBody.tasks.length, 1);
    assert.equal(byProjectBody.tasks[0].taskId, indexTaskId);

    const byStatus = await fetch(`http://127.0.0.1:${app.port}/api/tasks?status=succeeded`);
    const byStatusBody = await byStatus.json();
    assert.deepEqual(byStatusBody.tasks.map((task: { taskId: string }) => task.taskId), [summaryTaskId]);

    const failed = await fetch(`http://127.0.0.1:${app.port}/api/tasks?status=failed&type=index`);
    const failedBody = await failed.json();
    assert.deepEqual(failedBody.tasks.map((task: { taskId: string }) => task.taskId), [failedTask.taskId]);

    const detail = await fetch(`http://127.0.0.1:${app.port}/api/tasks/${encodeURIComponent(summaryTaskId)}`);
    const detailBody = await detail.json();
    assert.equal(detailBody.task.result.moduleCount, 2);
  } finally {
    await app.close();
  }
});

test("summary generation starts a background task and exposes the result", async () => {
  let releaseSummary: ((value: unknown) => void) | undefined;
  const tracker = new LongTaskTracker();
  const app = await startWebApp(0, {
    embeddingProvider: {} as never,
    indexCoordinator: {
      ensureFreshIndex: async (projectRootPath: string) => ({
        projectId: "project-1",
        projectRootPath,
      }),
      getInFlightIndexInfo: () => [],
      isWatching: () => false,
    } as never,
    llmClient: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    longTaskTracker: tracker,
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
      listProjects: () => [],
    } as never,
    summaryGenerator: {
      generateProjectSummary: async () => {
        await new Promise((resolve) => {
          releaseSummary = resolve;
        });
        return {
          durationMs: 42,
          filesWritten: ["project-summary.json"],
          moduleCount: 2,
          outputDir: "/repo/.ace-mcp/summaries",
          tokensUsed: { completion: 3, prompt: 5, total: 8 },
        };
      },
    } as never,
  });

  try {
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${app.port}/api/summary/generate`, {
      body: JSON.stringify({ projectRootPath: "/repo" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await response.json();
    const elapsedMs = Date.now() - startedAt;

    assert.equal(response.status, 202);
    assert.equal(body.data.status, "running");
    assert.match(body.data.taskId, /^summary-/);
    assert.ok(elapsedMs < 100, `summary request took ${elapsedMs}ms`);

    releaseSummary?.(undefined);
    await assertTaskStatus(app.port, body.data.taskId, "succeeded");

    const taskResponse = await fetch(`http://127.0.0.1:${app.port}/api/tasks/${encodeURIComponent(body.data.taskId)}`);
    const taskBody = await taskResponse.json();

    assert.equal(taskResponse.status, 200);
    assert.equal(taskBody.task.status, "succeeded");
    assert.equal(taskBody.task.result.moduleCount, 2);
    assert.equal(taskBody.task.result.tokensUsed.total, 8);
  } finally {
    releaseSummary?.(undefined);
    await app.close();
  }
});

test("summary background task retains failure state", async () => {
  const tracker = new LongTaskTracker();
  const app = await startWebApp(0, {
    embeddingProvider: {} as never,
    indexCoordinator: {
      ensureFreshIndex: async (projectRootPath: string) => ({
        projectId: "project-1",
        projectRootPath,
      }),
      getInFlightIndexInfo: () => [],
      isWatching: () => false,
    } as never,
    llmClient: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    longTaskTracker: tracker,
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
      listProjects: () => [],
    } as never,
    summaryGenerator: {
      generateProjectSummary: async () => {
        throw new Error("summary failed");
      },
    } as never,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/summary/generate`, {
      body: JSON.stringify({ projectRootPath: "/repo" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    await assertTaskStatus(app.port, body.data.taskId, "failed");

    const taskResponse = await fetch(`http://127.0.0.1:${app.port}/api/tasks/${encodeURIComponent(body.data.taskId)}`);
    const taskBody = await taskResponse.json();

    assert.equal(taskBody.task.status, "failed");
    assert.equal(taskBody.task.error.message, "summary failed");
  } finally {
    await app.close();
  }
});

test("summary generation rejects missing project root without starting a task", async () => {
  const tracker = new LongTaskTracker();
  const app = await startWebApp(0, {
    embeddingProvider: {} as never,
    indexCoordinator: {
      ensureFreshIndex: async () => {
        throw new Error("should not index without projectRootPath");
      },
      getInFlightIndexInfo: () => [],
      isWatching: () => false,
    } as never,
    llmClient: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    longTaskTracker: tracker,
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
      listProjects: () => [],
    } as never,
    summaryGenerator: {} as never,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/summary/generate`, {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, "INVALID_PROJECT_ROOT");
    assert.deepEqual(tracker.list(), []);
  } finally {
    await app.close();
  }
});

test("index project starts a background task and exposes the result", async () => {
  let releaseIndex: ((value: unknown) => void) | undefined;
  const tracker = new LongTaskTracker();
  const app = await startWebApp(0, {
    embeddingProvider: {} as never,
    indexCoordinator: {
      getInFlightIndexInfo: () => [],
      indexProject: async (projectRootPath: string, mode: string) => {
        await new Promise((resolve) => {
          releaseIndex = resolve;
        });
        return {
          changedFiles: 3,
          chunkCount: 5,
          deletedFiles: 0,
          failedFileCount: 0,
          failedFiles: [],
          indexedFiles: 2,
          project: { languages: ["typescript"], markers: [], projectType: "node", rootPath: projectRootPath },
          projectId: "project-1",
          projectRootPath,
          scannedFiles: 2,
          timings: { collectMs: 1, detectMs: 1, indexMs: 1, totalMs: 3, vectorMs: 0 },
          vectorIndex: { enabled: true, hydratedChunkCount: 0, mode },
        };
      },
      isWatching: () => false,
    } as never,
    llmClient: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    longTaskTracker: tracker,
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
      listProjects: () => [],
    } as never,
    summaryGenerator: {} as never,
  });

  try {
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${app.port}/api/index-project`, {
      body: JSON.stringify({ mode: "full", projectRootPath: "/repo" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await response.json();
    const elapsedMs = Date.now() - startedAt;

    assert.equal(response.status, 202);
    assert.equal(body.data.status, "running");
    assert.match(body.data.taskId, /^index-/);
    assert.ok(elapsedMs < 100, `index request took ${elapsedMs}ms`);

    releaseIndex?.(undefined);
    await assertTaskStatus(app.port, body.data.taskId, "succeeded");

    const taskResponse = await fetch(`http://127.0.0.1:${app.port}/api/tasks/${encodeURIComponent(body.data.taskId)}`);
    const taskBody = await taskResponse.json();

    assert.equal(taskResponse.status, 200);
    assert.equal(taskBody.task.status, "succeeded");
    assert.equal(taskBody.task.result.indexedFiles, 2);
    assert.equal(taskBody.task.result.chunkCount, 5);
    assert.equal(taskBody.task.result.mode, "full");
  } finally {
    releaseIndex?.(undefined);
    await app.close();
  }
});

test("duplicate active index submissions reuse the same task", async () => {
  let releaseIndex: ((value: unknown) => void) | undefined;
  let indexCalls = 0;
  const tracker = new LongTaskTracker();
  const app = await startWebApp(0, {
    embeddingProvider: {} as never,
    indexCoordinator: {
      getInFlightIndexInfo: () => [],
      indexProject: async (projectRootPath: string, mode: string) => {
        indexCalls += 1;
        await new Promise((resolve) => {
          releaseIndex = resolve;
        });
        return {
          changedFiles: 1,
          chunkCount: 1,
          deletedFiles: 0,
          failedFileCount: 0,
          failedFiles: [],
          indexedFiles: 1,
          project: { languages: [], markers: [], projectType: "unknown", rootPath: projectRootPath },
          projectId: "project-1",
          projectRootPath,
          scannedFiles: 1,
          timings: { collectMs: 0, detectMs: 0, indexMs: 0, totalMs: 0, vectorMs: 0 },
          vectorIndex: { enabled: true, hydratedChunkCount: 0, mode },
        };
      },
      isWatching: () => false,
    } as never,
    llmClient: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    longTaskTracker: tracker,
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
      listProjects: () => [],
    } as never,
    summaryGenerator: {} as never,
  });

  try {
    const first = await fetch(`http://127.0.0.1:${app.port}/api/index-project`, {
      body: JSON.stringify({ mode: "full", projectRootPath: "/repo" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const firstBody = await first.json();
    const second = await fetch(`http://127.0.0.1:${app.port}/api/index-project`, {
      body: JSON.stringify({ mode: "full", projectRootPath: "/repo" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const secondBody = await second.json();

    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(secondBody.data.taskId, firstBody.data.taskId);
    assert.equal(secondBody.data.reused, true);
    assert.equal(indexCalls, 1);
  } finally {
    releaseIndex?.(undefined);
    await app.close();
  }
});

test("task cancel marks active task canceled and completed tasks reject cancel", async () => {
  let releaseIndex: ((value: unknown) => void) | undefined;
  const tracker = new LongTaskTracker();
  const app = await startWebApp(0, {
    embeddingProvider: {} as never,
    indexCoordinator: {
      getInFlightIndexInfo: () => [],
      indexProject: async (projectRootPath: string, mode: string) => {
        await new Promise((resolve) => {
          releaseIndex = resolve;
        });
        return {
          changedFiles: 1,
          chunkCount: 1,
          deletedFiles: 0,
          failedFileCount: 0,
          failedFiles: [],
          indexedFiles: 1,
          project: { languages: [], markers: [], projectType: "unknown", rootPath: projectRootPath },
          projectId: "project-1",
          projectRootPath,
          scannedFiles: 1,
          timings: { collectMs: 0, detectMs: 0, indexMs: 0, totalMs: 0, vectorMs: 0 },
          vectorIndex: { enabled: true, hydratedChunkCount: 0, mode },
        };
      },
      isWatching: () => false,
    } as never,
    llmClient: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    longTaskTracker: tracker,
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
      listProjects: () => [],
    } as never,
    summaryGenerator: {} as never,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/index-project`, {
      body: JSON.stringify({ mode: "full", projectRootPath: "/repo" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await response.json();
    const cancel = await fetch(`http://127.0.0.1:${app.port}/api/tasks/${encodeURIComponent(body.data.taskId)}/cancel`, {
      method: "POST",
    });
    const cancelBody = await cancel.json();

    assert.equal(cancel.status, 200);
    assert.equal(cancelBody.task.status, "canceled");

    releaseIndex?.(undefined);
    await assertTaskStatus(app.port, body.data.taskId, "canceled");

    const secondCancel = await fetch(`http://127.0.0.1:${app.port}/api/tasks/${encodeURIComponent(body.data.taskId)}/cancel`, {
      method: "POST",
    });
    const secondCancelBody = await secondCancel.json();
    assert.equal(secondCancel.status, 409);
    assert.equal(secondCancelBody.code, "TASK_NOT_CANCELABLE");
  } finally {
    releaseIndex?.(undefined);
    await app.close();
  }
});

test("index background task retains failure state", async () => {
  const tracker = new LongTaskTracker();
  const app = await startWebApp(0, {
    embeddingProvider: {} as never,
    indexCoordinator: {
      getInFlightIndexInfo: () => [],
      indexProject: async () => {
        throw new Error("index failed");
      },
      isWatching: () => false,
    } as never,
    llmClient: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    longTaskTracker: tracker,
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
      listProjects: () => [],
    } as never,
    summaryGenerator: {} as never,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/index-project`, {
      body: JSON.stringify({ mode: "incremental", projectRootPath: "/repo" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    await assertTaskStatus(app.port, body.data.taskId, "failed");

    const taskResponse = await fetch(`http://127.0.0.1:${app.port}/api/tasks/${encodeURIComponent(body.data.taskId)}`);
    const taskBody = await taskResponse.json();

    assert.equal(taskBody.task.status, "failed");
    assert.equal(taskBody.task.error.message, "index failed");
  } finally {
    await app.close();
  }
});

test("full index rejects registered parent directory unless confirmed", async () => {
  const tracker = new LongTaskTracker();
  const app = await startWebApp(0, {
    embeddingProvider: {} as never,
    indexCoordinator: {
      getInFlightIndexInfo: () => [],
      indexProject: async (projectRootPath: string, mode: string) => ({
        changedFiles: 0,
        chunkCount: 0,
        deletedFiles: 0,
        failedFileCount: 0,
        failedFiles: [],
        indexedFiles: 0,
        project: { languages: [], markers: [], projectType: "unknown", rootPath: projectRootPath },
        projectId: "project",
        projectRootPath,
        scannedFiles: 0,
        timings: { collectMs: 0, detectMs: 0, indexMs: 0, totalMs: 0, vectorMs: 0 },
        vectorIndex: { enabled: true, hydratedChunkCount: 0, mode },
      }),
      isWatching: () => false,
    } as never,
    llmClient: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    longTaskTracker: tracker,
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
      listProjects: () => [
        {
          languages: [],
          lastIndexAt: null,
          lastScanAt: null,
          projectRootPath: "/work/code/service-a",
          status: "ready",
        },
        {
          languages: [],
          lastIndexAt: null,
          lastScanAt: null,
          projectRootPath: "/work/code/service-b",
          status: "ready",
        },
      ],
    } as never,
    summaryGenerator: {} as never,
  });

  try {
    const blocked = await fetch(`http://127.0.0.1:${app.port}/api/index-project`, {
      body: JSON.stringify({ mode: "full", projectRootPath: "/work/code" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const blockedBody = await blocked.json();

    assert.equal(blocked.status, 409);
    assert.equal(blockedBody.code, "PARENT_DIRECTORY_REQUIRES_CONFIRMATION");
    assert.deepEqual(blockedBody.childProjects, ["/work/code/service-a", "/work/code/service-b"]);
    assert.deepEqual(tracker.list(), []);

    const confirmed = await fetch(`http://127.0.0.1:${app.port}/api/index-project`, {
      body: JSON.stringify({ confirmParentDirectory: true, mode: "full", projectRootPath: "/work/code" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    assert.equal(confirmed.status, 202);
    const confirmedBody = await confirmed.json();
    assert.match(confirmedBody.data.taskId, /^index-/);
  } finally {
    await app.close();
  }
});

test("QA response includes effective request parameters", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/refund.ts": "export function refundOrder() { return 'ok'; }\n",
  });
  const app = await startWebApp(0, {
    embeddingProvider: env.embeddingProvider,
    indexCoordinator: env.indexCoordinator,
    llmClient: {
      complete: async () => ({
        content: "Refund flow answer",
        usage: { promptTokens: 11, completionTokens: 3 },
      }),
      getModelName: () => "test-model",
      isConfigured: () => true,
    } as never,
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
    summaryGenerator: { loadSummary: async () => null } as never,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/qa/ask`, {
      body: JSON.stringify({
        contextMode: "full-file",
        maxContextTokens: 999999,
        maxSources: 999,
        maxTokens: 1234,
        projectRootPath: env.projectRootPath,
        question: "refund",
        retries: 999,
        timeoutSeconds: 999,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.answer, "Refund flow answer");
    assert.deepEqual(body.request, {
      callChainDepth: 1,
      contextMode: "full-file",
      includeSummary: true,
      maxContextTokens: 200000,
      maxSources: 100,
      maxTokens: 1234,
      retries: 5,
      timeoutSeconds: 600,
    });
  } finally {
    await app.close();
    await env.cleanup();
  }
});

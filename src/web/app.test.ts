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

test("full index rejects registered parent directory unless confirmed", async () => {
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

    const confirmed = await fetch(`http://127.0.0.1:${app.port}/api/index-project`, {
      body: JSON.stringify({ confirmParentDirectory: true, mode: "full", projectRootPath: "/work/code" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    assert.equal(confirmed.status, 200);
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

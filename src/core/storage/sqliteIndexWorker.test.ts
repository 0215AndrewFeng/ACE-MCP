import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Logger } from "../common/logger.js";
import { SQLiteIndexWorkerClient } from "./sqliteIndexWorkerClient.js";
import type { SQLiteIndexWorkerRequest } from "./sqliteIndexWorkerProtocol.js";
import { SQLiteSearchWorkerClient } from "./sqliteSearchWorkerClient.js";
import type { SQLiteSearchWorkerRequest } from "./sqliteSearchWorkerProtocol.js";
import { SQLiteStore } from "./sqliteStore.js";

async function createFixture() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-index-worker-"));
  const databasePath = path.join(tempDir, "index.db");
  const logFilePath = path.join(tempDir, "worker.log");
  await mkdir(path.dirname(databasePath), { recursive: true });
  const logger = new Logger(logFilePath, "error");
  const store = new SQLiteStore(databasePath, logger);
  store.initialize();
  return {
    cleanup: () => rm(tempDir, { force: true, recursive: true }),
    data: { databasePath, logFilePath, logLevel: "error" as const },
    logger,
    store,
    tempDir,
  };
}

const fixtureExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const fixtureWorkerUrl = new URL(`../../test/fixtures/sqliteIndexWorkerFixture${fixtureExtension}`, import.meta.url);

type SendCallback = (error: Error | null) => void;

function createFakeChildProcess(
  onSend: (message: SQLiteIndexWorkerRequest, callback: SendCallback | undefined) => void,
): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    channel: { unref() {} },
    connected: true,
    exitCode: null as number | null,
    signalCode: null,
    unref() {
      return child;
    },
    kill() {
      queueMicrotask(() => {
        child.connected = false;
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return true;
    },
    send(message: SQLiteIndexWorkerRequest, ...args: unknown[]) {
      const callback = args.find((arg): arg is SendCallback => typeof arg === "function");
      onSend(message, callback);
      return true;
    },
  });
  return child as unknown as ChildProcess;
}

function createFakeSearchChildProcess(
  onSend: (message: SQLiteSearchWorkerRequest, callback: SendCallback | undefined) => void,
): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    channel: { unref() {} },
    connected: true,
    exitCode: null as number | null,
    signalCode: null,
    unref() {
      return child;
    },
    kill() {
      queueMicrotask(() => {
        child.connected = false;
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return true;
    },
    send(message: SQLiteSearchWorkerRequest, ...args: unknown[]) {
      const callback = args.find((arg): arg is SendCallback => typeof arg === "function");
      onSend(message, callback);
      return true;
    },
  });
  return child as unknown as ChildProcess;
}

function emitFakeChildExit(worker: ChildProcess): void {
  const state = worker as unknown as {
    connected: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  if (state.exitCode !== null || state.signalCode !== null) {
    return;
  }
  state.connected = false;
  state.exitCode = 0;
  worker.emit("exit", 0, null);
}

test("source index worker writes every index storage operation and closes cleanly", async () => {
  const fixture = await createFixture();
  const client = new SQLiteIndexWorkerClient(fixture.data, fixture.logger);
  const searchClient = new SQLiteSearchWorkerClient(fixture.data, fixture.logger);
  const projectId = "worker-project";
  fixture.store.upsertProject(projectId, {
    languages: ["javascript"],
    markers: ["package.json"],
    projectType: "single-language",
    rootPath: path.join(fixture.tempDir, "project"),
  }, "indexing", new Date().toISOString());

  client.acquireLease();
  try {
    await client.writeFileIndexBatch(projectId, [
      {
        chunks: [{ chunkId: "keep-chunk", content: "export const answer = 42", endLine: 1, fileId: "keep-file", startLine: 1, symbolNames: ["answer"] }],
        imports: [],
        indexedFile: { encoding: "utf8", fileId: "keep-file", language: "javascript", lineCount: 1, mtimeMs: 1, relativePath: "src/keep.ts", sha256: "keep", size: 24 },
        symbols: [{ fileId: "keep-file", fullName: "answer", kind: "field", line: 1, name: "answer", signature: "answer", symbolId: "answer-symbol" }],
        usages: [],
      },
      {
        chunks: [{ chunkId: "drop-chunk", content: "export const stale = true", endLine: 1, fileId: "drop-file", startLine: 1, symbolNames: ["stale"] }],
        imports: [],
        indexedFile: { encoding: "utf8", fileId: "drop-file", language: "javascript", lineCount: 1, mtimeMs: 1, relativePath: "src/drop.ts", sha256: "drop", size: 25 },
        symbols: [],
        usages: [],
      },
    ], "2026-07-23T00:00:00.000Z");
    await client.writeChunkVectors([
      { chunkId: "keep-chunk", embedding: [1, 0, 0], modelName: "test-model" },
    ], projectId);
    await client.resolveSymbolGraph(projectId, ["keep-file", "drop-file"]);
    await client.ensureSemanticIndex(projectId);
    await client.deleteFiles(projectId, ["src/drop.ts"]);

    const results = await searchClient.getFilePreviewResults(projectId, ["src/keep.ts", "src/drop.ts"]);
    assert.deepEqual(results.map((result) => result.filePath), ["src/keep.ts"]);
    const candidates = await searchClient.searchCandidates(projectId, {
      lexical: { ftsQuery: "answer", limit: 10 },
      path: { limit: 10, tokens: ["keep"] },
      semanticFts: { limit: 10, semanticTerms: ["answer"] },
      symbol: { limit: 10, tokens: ["answer"] },
      unicodeSubstring: { limit: 10, tokens: ["answer"] },
    });
    assert.deepEqual(candidates.lexical.results, fixture.store.searchByText(projectId, "answer", 10));
    assert.deepEqual(candidates.path.results, fixture.store.searchByPath(projectId, ["keep"], 10));
    assert.deepEqual(candidates.semanticFts.results, fixture.store.searchBySemantic(projectId, ["answer"], 10));
    assert.deepEqual(candidates.symbol.results, fixture.store.searchBySymbols(projectId, ["answer"], 10));
    assert.deepEqual(
      candidates.unicodeSubstring.results,
      fixture.store.searchByTextSubstrings(projectId, ["answer"], 10),
    );
    const isolatedFailure = await searchClient.searchCandidates(projectId, {
      lexical: { ftsQuery: "\"", limit: 10 },
      path: { limit: 10, tokens: ["keep"] },
    });
    assert.match(isolatedFailure.lexical.error ?? "", /fts5|syntax|unterminated/i);
    assert.deepEqual(isolatedFailure.path.results, fixture.store.searchByPath(projectId, ["keep"], 10));
    assert.deepEqual(fixture.store.getChunkVector("keep-chunk")?.embedding, new Float32Array([1, 0, 0]));
  } finally {
    client.releaseLease();
    await Promise.all([client.close(), searchClient.close()]);
    await fixture.cleanup();
  }

  await assert.rejects(client.ensureSemanticIndex(projectId), /closed/);
});

test("source index worker prepares and atomically finalizes project metadata", async () => {
  const fixture = await createFixture();
  const client = new SQLiteIndexWorkerClient(fixture.data, fixture.logger);
  const projectId = "finalized-worker-project";
  const timestamp = "2026-07-23T01:00:00.000Z";
  const project = {
    languages: ["javascript" as const],
    markers: ["package.json"],
    projectType: "single-language" as const,
    rootPath: path.join(fixture.tempDir, "finalized-project"),
  };
  const now = Date.now();

  try {
    const prepared = await client.prepareProjectIndex(projectId, project, timestamp);
    assert.deepEqual(prepared.existingFiles, []);
    assert.equal(fixture.store.getProjectByRoot(project.rootPath)?.status, "indexing");

    const finalized = await client.finalizeProjectIndex(projectId, {
      bumpIndexVersion: true,
      event: {
        changedFiles: 1,
        chunkCount: 1,
        createdAt: timestamp,
        deletedFiles: 0,
        failedFiles: [],
        indexedFiles: 1,
        metadata: {
          gitOptimization: { commit: "abcdef12", enabled: true },
          vectorIndex: { enabled: false, hydratedChunkCount: 0, mode: "lazy" },
        },
        scannedFiles: 1,
      },
      lastIndexedCommit: "abcdef123456",
      status: "ready",
      timestamp,
      timing: {
        baseTimings: { collectMs: 1, detectMs: 1, indexMs: 4, totalMs: 6, vectorMs: 0, writeMs: 2 },
        finalizeStartedAtMs: now - 3,
        finalizeWriteStartedAtMs: now,
        indexStartedAtMs: now - 5,
        totalStartedAtMs: now - 7,
      },
    });

    assert.equal(fixture.store.getProjectByRoot(project.rootPath)?.status, "ready");
    assert.equal(fixture.store.getLatestIndexEvent(projectId)?.failedFileCount, 0);
    assert.deepEqual(fixture.store.getLatestIndexEvent(projectId)?.timings, finalized.timings);
    assert.ok((finalized.timings.writeMs ?? 0) >= 2);
    assert.ok((finalized.timings.finalizeMs ?? 0) >= 3);
    assert.ok(finalized.indexVersion >= 2);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("source index worker owns the cross-process index maintenance lease writes", async () => {
  const fixture = await createFixture();
  const client = new SQLiteIndexWorkerClient(fixture.data, fixture.logger);
  const nowMs = Date.now();

  try {
    assert.equal(await client.tryAcquireIndexMaintenanceLease("web-owner", nowMs + 60_000, nowMs), true);
    assert.deepEqual(fixture.store.getActiveIndexMaintenanceLease(nowMs + 1), {
      expiresAtMs: nowMs + 60_000,
      ownerId: "web-owner",
    });
    assert.equal(await client.renewIndexMaintenanceLease("web-owner", nowMs + 90_000, nowMs + 1), true);
    assert.equal(fixture.store.getActiveIndexMaintenanceLease(nowMs + 2)?.expiresAtMs, nowMs + 90_000);
    assert.equal(await client.releaseIndexMaintenanceLease("web-owner"), true);
    assert.equal(fixture.store.getActiveIndexMaintenanceLease(nowMs + 2), null);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("a blocking index worker leaves timers and the search worker independent", async () => {
  const fixture = await createFixture();
  const indexClient = new SQLiteIndexWorkerClient(fixture.data, fixture.logger, { workerUrl: fixtureWorkerUrl });
  const searchClient = new SQLiteSearchWorkerClient(fixture.data, fixture.logger);
  let indexSettled = false;
  let timerFired = false;

  try {
    const indexing = indexClient.deleteFiles("block", []).then(() => {
      indexSettled = true;
    });
    const timer = new Promise<void>((resolve) => setTimeout(() => {
      timerFired = true;
      resolve();
    }, 20));
    const searchResults = await searchClient.getFilePreviewResults("missing-project", []);

    assert.deepEqual(searchResults, []);
    assert.equal(indexSettled, false);
    await timer;
    assert.equal(timerFired, true);
    await indexing;
  } finally {
    await Promise.all([indexClient.close(), searchClient.close()]);
    await fixture.cleanup();
  }
});

test("active leases prevent idle worker replacement during an index run", async () => {
  const fixture = await createFixture();
  const client = new SQLiteIndexWorkerClient(fixture.data, fixture.logger, {
    idleMs: 30,
    workerUrl: fixtureWorkerUrl,
  });

  try {
    client.acquireLease();
    await client.deleteFiles("lease", []);
    await new Promise((resolve) => setTimeout(resolve, 90));
    await client.deleteFiles("lease", []);
    assert.equal((await readFile(`${fixture.data.databasePath}.pids`, "utf8")).trim().split("\n").length, 1);

    client.releaseLease();
    await new Promise((resolve) => setTimeout(resolve, 90));
    await client.deleteFiles("lease", []);
    assert.equal((await readFile(`${fixture.data.databasePath}.pids`, "utf8")).trim().split("\n").length, 2);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("worker response errors preserve their remote stack", async () => {
  const fixture = await createFixture();
  const client = new SQLiteIndexWorkerClient(fixture.data, fixture.logger, { workerUrl: fixtureWorkerUrl });

  try {
    await assert.rejects(client.ensureSemanticIndex("project"), (error: Error) => {
      assert.equal(error.message, "fixture index failure");
      assert.match(error.stack ?? "", /sqlite-index-worker-fixture:1:1/);
      return true;
    });
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("unexpected worker exit rejects its pending request", async () => {
  const fixture = await createFixture();
  const client = new SQLiteIndexWorkerClient(fixture.data, fixture.logger, { workerUrl: fixtureWorkerUrl });

  try {
    await assert.rejects(client.resolveSymbolGraph("project", []), /exited with code 23/);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("close rejects pending requests and terminates the worker", async () => {
  const fixture = await createFixture();
  const client = new SQLiteIndexWorkerClient(fixture.data, fixture.logger, { workerUrl: fixtureWorkerUrl });

  try {
    client.acquireLease();
    const pending = client.writeFileIndexBatch("project", [], new Date().toISOString());
    const rejected = assert.rejects(pending, /closed/);
    await client.close();
    await rejected;
    assert.doesNotThrow(() => client.releaseLease());
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("a retired worker exit cannot reject a replacement worker request", async () => {
  const fixture = await createFixture();
  let firstWorker: ChildProcess | undefined;
  let secondWorker: ChildProcess | undefined;
  let secondRequest: SQLiteIndexWorkerRequest | undefined;
  let factoryCalls = 0;
  const client = new SQLiteIndexWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        firstWorker = createFakeChildProcess((_message, callback) => {
          callback?.(null);
          queueMicrotask(() => {
            firstWorker?.emit("error", new Error("worker A failed"));
            setTimeout(() => {
              firstWorker?.emit("exit", 1, null);
            }, 20);
          });
        });
        return firstWorker;
      }
      secondWorker = createFakeChildProcess((message, callback) => {
        secondRequest = message;
        callback?.(null);
      });
      return secondWorker;
    },
  });

  try {
    await assert.rejects(client.deleteFiles("first", ["a.ts"]), /worker A failed/);
    let secondOutcome: "pending" | "resolved" | Error = "pending";
    const second = client.deleteFiles("second", ["b.ts"]);
    void second.then(
      () => { secondOutcome = "resolved"; },
      (error: Error) => { secondOutcome = error; },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondOutcome, "pending");
    assert.ok(secondRequest);
    secondWorker?.emit("message", { id: secondRequest.id, ok: true, result: null });
    await second;
    assert.equal(secondOutcome, "resolved");
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("close waits for and terminates both current and errored index children", async () => {
  const fixture = await createFixture();
  let firstWorker: ChildProcess | undefined;
  let secondWorker: ChildProcess | undefined;
  let firstKillCount = 0;
  let secondKillCount = 0;
  let factoryCalls = 0;
  let closing: Promise<void> | undefined;
  const client = new SQLiteIndexWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      factoryCalls += 1;
      const worker = createFakeChildProcess((_message, callback) => callback?.(null));
      if (factoryCalls === 1) {
        firstWorker = worker;
        worker.kill = () => {
          firstKillCount += 1;
          return true;
        };
      } else {
        secondWorker = worker;
        worker.kill = () => {
          secondKillCount += 1;
          return true;
        };
      }
      return worker;
    },
  });

  try {
    const first = client.deleteFiles("first", ["a.ts"]);
    assert.ok(firstWorker);
    firstWorker.emit("error", new Error("index worker A failed"));
    await assert.rejects(first, /index worker A failed/);

    const second = client.deleteFiles("second", ["b.ts"]);
    const secondRejected = assert.rejects(second, /closed/);
    let closeOutcome: "pending" | "resolved" = "pending";
    closing = client.close();
    void closing.then(() => { closeOutcome = "resolved"; });
    await secondRejected;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(firstKillCount, 1);
    assert.equal(secondKillCount, 1);
    assert.equal(closeOutcome, "pending");

    assert.ok(secondWorker);
    emitFakeChildExit(secondWorker);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeOutcome, "pending");

    emitFakeChildExit(firstWorker);
    await closing;
    assert.equal(closeOutcome, "resolved");
  } finally {
    if (firstWorker) emitFakeChildExit(firstWorker);
    if (secondWorker) emitFakeChildExit(secondWorker);
    await closing;
    await client.close();
    await fixture.cleanup();
  }
});

test("concurrent close waits for one idle index child termination", async () => {
  const fixture = await createFixture();
  let worker: ChildProcess | undefined;
  let killCount = 0;
  let closing: Promise<void> | undefined;
  let repeatedClose: Promise<void> | undefined;
  const client = new SQLiteIndexWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      worker = createFakeChildProcess((message, callback) => {
        callback?.(null);
        queueMicrotask(() => worker?.emit("message", { id: message.id, ok: true, result: null }));
      });
      worker.kill = () => {
        killCount += 1;
        return true;
      };
      return worker;
    },
    idleMs: 1,
  });

  try {
    await client.deleteFiles("project", ["idle.ts"]);
    for (let attempt = 0; attempt < 100 && killCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(killCount, 1);

    let closeOutcome: "pending" | "resolved" = "pending";
    closing = client.close();
    void closing.then(() => { closeOutcome = "resolved"; });
    repeatedClose = client.close();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(closeOutcome, "pending");
    assert.strictEqual(repeatedClose, closing);
    assert.equal(killCount, 1);

    assert.ok(worker);
    emitFakeChildExit(worker);
    await Promise.all([closing, repeatedClose]);
    assert.equal(closeOutcome, "resolved");
    assert.equal(killCount, 1);
  } finally {
    if (worker) emitFakeChildExit(worker);
    await Promise.all([closing, repeatedClose].filter((promise): promise is Promise<void> => Boolean(promise)));
    await client.close();
    await fixture.cleanup();
  }
});

test("asynchronous child send failures reject only the matching request", async () => {
  const fixture = await createFixture();
  let worker: ChildProcess;
  const client = new SQLiteIndexWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      worker = createFakeChildProcess((_message, callback) => {
        setImmediate(() => {
          if (callback) {
            callback(new Error("async send failed"));
          } else {
            (worker as unknown as { exitCode: number | null }).exitCode = 91;
            worker.emit("exit", 91, null);
          }
        });
      });
      return worker;
    },
  });

  try {
    await assert.rejects(client.deleteFiles("project", ["a.ts"]), /async send failed/);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("a retired search worker exit cannot reject a replacement worker request", async () => {
  const fixture = await createFixture();
  let firstWorker: ChildProcess | undefined;
  let secondWorker: ChildProcess | undefined;
  let secondRequest: SQLiteSearchWorkerRequest | undefined;
  let factoryCalls = 0;
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        firstWorker = createFakeSearchChildProcess((_message, callback) => {
          callback?.(null);
        });
        return firstWorker;
      }
      secondWorker = createFakeSearchChildProcess((message, callback) => {
        secondRequest = message;
        callback?.(null);
      });
      return secondWorker;
    },
  });

  try {
    const first = client.searchByPath("first", ["alpha"], 10);
    firstWorker?.emit("error", new Error("search worker A failed"));
    await assert.rejects(first, /search worker A failed/);

    let secondOutcome: "pending" | "resolved" | Error = "pending";
    const second = client.searchByPath("second", ["beta"], 10);
    void second.then(
      () => { secondOutcome = "resolved"; },
      (error: Error) => { secondOutcome = error; },
    );

    firstWorker?.emit("exit", 1, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondOutcome, "pending");
    assert.ok(secondRequest);
    secondWorker?.emit("message", { id: secondRequest.id, ok: true, result: [] });
    await second;
    assert.equal(secondOutcome, "resolved");
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("asynchronous search child send failures reject only the matching request", async () => {
  const fixture = await createFixture();
  let worker: ChildProcess | undefined;
  const requests: SQLiteSearchWorkerRequest[] = [];
  const callbacks: SendCallback[] = [];
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      worker = createFakeSearchChildProcess((message, callback) => {
        requests.push(message);
        if (callback) {
          callbacks.push(callback);
        }
      });
      return worker;
    },
    poolSize: 1,
  });

  try {
    const first = client.searchByPath("project", ["alpha"], 10);
    const second = client.searchByPath("project", ["beta"], 10);
    callbacks[0](new Error("async search send failed"));
    await assert.rejects(first, /async search send failed/);

    let secondOutcome: "pending" | "resolved" | Error = "pending";
    void second.then(
      () => { secondOutcome = "resolved"; },
      (error: Error) => { secondOutcome = error; },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondOutcome, "pending");
    worker?.emit("message", { id: requests[1].id, ok: true, result: [] });
    await second;
    assert.equal(secondOutcome, "resolved");
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("an unexpected search child exit rejects its pending request", async () => {
  const fixture = await createFixture();
  let worker: ChildProcess | undefined;
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      worker = createFakeSearchChildProcess((_message, callback) => callback?.(null));
      return worker;
    },
  });

  try {
    const pending = client.searchByPath("project", ["alpha"], 10);
    worker?.emit("exit", 23, null);
    await assert.rejects(pending, /exited with code 23/);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("search worker creation failure clears the request deadline timer", async () => {
  const fixture = await createFixture();
  const originalClearTimeout = globalThis.clearTimeout;
  let clearTimeoutCalls = 0;
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    clearTimeoutCalls += 1;
    originalClearTimeout(timer);
  }) as typeof clearTimeout;
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      throw new Error("search worker factory failed");
    },
    queueDeadlineMs: 1_000,
  });

  try {
    await assert.rejects(client.searchByPath("project", ["alpha"], 10), /factory failed/);
    assert.equal(clearTimeoutCalls, 1, "the rejected request left its deadline timer armed");
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
    await client.close();
    await fixture.cleanup();
  }
});

test("search worker diagnostics distinguish the active request from queued requests", async () => {
  const fixture = await createFixture();
  let worker: ChildProcess | undefined;
  const requests: SQLiteSearchWorkerRequest[] = [];
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      worker = createFakeSearchChildProcess((message, callback) => {
        requests.push(message);
        callback?.(null);
      });
      return worker;
    },
    poolSize: 1,
  });

  try {
    assert.deepEqual(client.getDiagnostics(), {
      activeRequests: 0,
      liveWorkers: 0,
      pendingRequests: 0,
      queueMs: {
        currentMax: 0,
        last: 0,
        max: 0,
        samples: 0,
        total: 0,
      },
    });

    const first = client.searchByPath("project", ["alpha"], 10);
    const second = client.searchByPath("project", ["beta"], 10);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const queued = client.getDiagnostics();
    assert.equal(queued.activeRequests, 1);
    assert.equal(queued.pendingRequests, 1);
    assert.equal(queued.liveWorkers, 1);
    assert.ok(queued.queueMs.currentMax > 0, JSON.stringify(queued));

    worker?.emit("message", { id: requests[0].id, ok: true, result: [] });
    await first;
    const promoted = client.getDiagnostics();
    assert.equal(promoted.activeRequests, 1);
    assert.equal(promoted.pendingRequests, 0);
    assert.equal(promoted.queueMs.samples, 1);
    assert.ok(promoted.queueMs.last > 0, JSON.stringify(promoted));
    assert.equal(promoted.queueMs.max, promoted.queueMs.last);
    assert.equal(promoted.queueMs.total, promoted.queueMs.last);

    worker?.emit("message", { id: requests[1].id, ok: true, result: [] });
    await second;
    assert.equal(client.getDiagnostics().activeRequests, 0);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

for (const poolSize of [1, 2, 4]) {
  test(`search worker pool bounds active workers at ${poolSize}`, async () => {
    const fixture = await createFixture();
    const workers: ChildProcess[] = [];
    const requests: Array<{ request: SQLiteSearchWorkerRequest; worker: ChildProcess }> = [];
    const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
      createChildProcess: () => {
        let worker: ChildProcess;
        worker = createFakeSearchChildProcess((request, callback) => {
          requests.push({ request, worker });
          callback?.(null);
        });
        workers.push(worker);
        return worker;
      },
      poolSize,
      queueMaxPending: 16,
      queueDeadlineMs: 1_000,
    });

    try {
      const operations = Array.from(
        { length: poolSize + 2 },
        (_, index) => client.searchByPath("project", [`term-${index}`], 10),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(workers.length, poolSize);
      assert.equal(requests.length, poolSize);
      assert.equal(client.getDiagnostics().activeRequests, poolSize);
      assert.equal(client.getDiagnostics().pendingRequests, 2);

      for (let index = 0; index < operations.length; index++) {
        const dispatched = requests[index];
        assert.ok(dispatched, `request ${index} was not dispatched`);
        dispatched.worker.emit("message", { id: dispatched.request.id, ok: true, result: [] });
        await operations[index];
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(client.getDiagnostics().activeRequests, 0);
      assert.equal(client.getDiagnostics().pendingRequests, 0);
    } finally {
      await client.close();
      await fixture.cleanup();
    }
  });
}

test("search worker pool rejects requests beyond its pending cap", async () => {
  const fixture = await createFixture();
  let worker: ChildProcess | undefined;
  const requests: SQLiteSearchWorkerRequest[] = [];
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      worker = createFakeSearchChildProcess((request, callback) => {
        requests.push(request);
        callback?.(null);
      });
      return worker;
    },
    poolSize: 1,
    queueMaxPending: 1,
    queueDeadlineMs: 1_000,
  });

  try {
    const active = client.searchByPath("project", ["active"], 10);
    const queued = client.searchByPath("project", ["queued"], 10);
    await assert.rejects(
      client.searchByPath("project", ["overload"], 10),
      (error: Error) => error.name === "SQLiteSearchWorkerOverloadError" && /queue is full/.test(error.message),
    );
    assert.equal(requests.length, 1);

    worker?.emit("message", { id: requests[0].id, ok: true, result: [] });
    await active;
    await new Promise<void>((resolve) => setImmediate(resolve));
    worker?.emit("message", { id: requests[1].id, ok: true, result: [] });
    await queued;
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("expired search requests leave the queue without creating stale debt", async () => {
  const fixture = await createFixture();
  let worker: ChildProcess | undefined;
  const requests: SQLiteSearchWorkerRequest[] = [];
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      worker = createFakeSearchChildProcess((request, callback) => {
        requests.push(request);
        callback?.(null);
      });
      return worker;
    },
    poolSize: 1,
    queueMaxPending: 4,
    queueDeadlineMs: 1_000,
  });

  try {
    const active = client.searchCandidates(
      "project",
      { path: { limit: 10, tokens: ["active"] } },
      undefined,
      1_000,
    );
    await assert.rejects(
      client.searchCandidates(
        "project",
        { path: { limit: 10, tokens: ["expires"] } },
        undefined,
        10,
      ),
      (error: Error) => error.name === "SQLiteSearchWorkerQueueTimeoutError" && /request deadline/.test(error.message),
    );
    assert.equal(client.getDiagnostics().pendingRequests, 0);

    worker?.emit("message", {
      id: requests[0].id,
      ok: true,
      result: {
        identifierBoost: { durationMs: 0, results: [] },
        lexical: { durationMs: 0, results: [] },
        path: { durationMs: 0, results: [] },
        semanticFts: { durationMs: 0, results: [] },
        symbol: { durationMs: 0, results: [] },
        unicodeSubstring: { durationMs: 0, results: [] },
      },
    });
    await active;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests.length, 1, "expired work was sent after its caller had timed out");
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("an active search deadline retires its worker before a replacement continues the queue", async () => {
  const fixture = await createFixture();
  const workers: ChildProcess[] = [];
  const requests: Array<{ request: SQLiteSearchWorkerRequest; worker: ChildProcess }> = [];
  let firstKillCount = 0;
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      let worker: ChildProcess;
      worker = createFakeSearchChildProcess((request, callback) => {
        requests.push({ request, worker });
        callback?.(null);
      });
      if (workers.length === 0) {
        worker.kill = () => {
          firstKillCount += 1;
          return true;
        };
      }
      workers.push(worker);
      return worker;
    },
    poolSize: 1,
    queueMaxPending: 4,
    queueDeadlineMs: 1_000,
  });

  try {
    const expired = client.searchCandidates("project", { path: { limit: 10, tokens: ["slow"] } }, undefined, 10);
    const replacement = client.searchCandidates("project", { path: { limit: 10, tokens: ["next"] } }, undefined, 1_000);

    await assert.rejects(
      expired,
      (error: Error) => error.name === "SQLiteSearchWorkerQueueTimeoutError" && /deadline/.test(error.message),
    );
    assert.equal(firstKillCount, 1);
    assert.equal(workers.length, 1, "replacement started before the timed-out worker terminated");

    const firstRequest = requests[0];
    firstRequest.worker.emit("message", { id: firstRequest.request.id, ok: true, result: {} });
    firstRequest.worker.emit("error", new Error("late error from retired worker"));
    emitFakeChildExit(firstRequest.worker);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(workers.length, 2);
    assert.equal(requests.length, 2);
    const replacementRequest = requests[1];
    firstRequest.worker.emit("exit", 17, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(client.getDiagnostics().activeRequests, 1);
    replacementRequest.worker.emit("message", {
      id: replacementRequest.request.id,
      ok: true,
      result: {
        identifierBoost: { durationMs: 0, results: [] },
        lexical: { durationMs: 0, results: [] },
        path: { durationMs: 0, results: [] },
        semanticFts: { durationMs: 0, results: [] },
        symbol: { durationMs: 0, results: [] },
        unicodeSubstring: { durationMs: 0, results: [] },
      },
    });
    await replacement;
  } finally {
    for (const worker of workers) emitFakeChildExit(worker);
    await client.close();
    await fixture.cleanup();
  }
});

test("a failed search worker is stopped before pool capacity is reused", async () => {
  const fixture = await createFixture();
  const workers: ChildProcess[] = [];
  const requests: Array<{ request: SQLiteSearchWorkerRequest; worker: ChildProcess }> = [];
  let firstKillCount = 0;
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      let worker: ChildProcess;
      worker = createFakeSearchChildProcess((request, callback) => {
        requests.push({ request, worker });
        callback?.(null);
      });
      if (workers.length === 0) {
        worker.kill = () => {
          firstKillCount += 1;
          return true;
        };
      }
      workers.push(worker);
      return worker;
    },
    poolSize: 1,
    queueMaxPending: 4,
  });

  try {
    const failed = client.searchByPath("project", ["failed"], 10);
    const queued = client.searchByPath("project", ["queued"], 10);
    workers[0].emit("error", new Error("worker failed without exiting"));
    await assert.rejects(failed, /worker failed without exiting/);

    assert.equal(firstKillCount, 1);
    assert.equal(workers.length, 1);
    assert.equal(client.getDiagnostics().liveWorkers, 1);
    assert.equal(client.getDiagnostics().pendingRequests, 1);

    emitFakeChildExit(workers[0]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(workers.length, 2);
    assert.equal(client.getDiagnostics().liveWorkers, 1);
    const queuedRequest = requests[1];
    queuedRequest.worker.emit("message", { id: queuedRequest.request.id, ok: true, result: [] });
    await queued;
  } finally {
    for (const worker of workers) emitFakeChildExit(worker);
    await client.close();
    await fixture.cleanup();
  }
});

test("a search child that does not exit after termination no longer occupies pool capacity", async () => {
  const fixture = await createFixture();
  const workers: ChildProcess[] = [];
  const requests: Array<{ request: SQLiteSearchWorkerRequest; worker: ChildProcess }> = [];
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      let worker: ChildProcess;
      worker = createFakeSearchChildProcess((request, callback) => {
        requests.push({ request, worker });
        callback?.(null);
      });
      if (workers.length === 0) {
        worker.kill = () => true;
      }
      workers.push(worker);
      return worker;
    },
    poolSize: 1,
    queueDeadlineMs: 3_000,
    queueMaxPending: 4,
  });

  const failed = client.searchByPath("project", ["failed"], 10);
  const queued = client.searchByPath("project", ["queued"], 10);
  void queued.catch(() => {});
  try {
    workers[0].emit("error", new Error("worker failed without exiting"));
    await assert.rejects(failed, /worker failed without exiting/);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(workers.length, 2, "the terminated child permanently occupied the only pool slot");
    assert.equal(client.getDiagnostics().liveWorkers, 1);

    const queuedRequest = requests[1];
    queuedRequest.worker.emit("message", { id: queuedRequest.request.id, ok: true, result: [] });
    await queued;
  } finally {
    for (const worker of workers) emitFakeChildExit(worker);
    await client.close();
    await fixture.cleanup();
  }
});

test("identical search payloads with different deadlines do not share one in-flight promise", async () => {
  const fixture = await createFixture();
  const workers: ChildProcess[] = [];
  const requests: Array<{ request: SQLiteSearchWorkerRequest; worker: ChildProcess }> = [];
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      let worker: ChildProcess;
      worker = createFakeSearchChildProcess((request, callback) => {
        requests.push({ request, worker });
        callback?.(null);
      });
      workers.push(worker);
      return worker;
    },
    poolSize: 2,
  });

  try {
    const strategies = { path: { limit: 10, tokens: ["same"] } };
    const short = client.searchCandidates("project", strategies, undefined, 10);
    const long = client.searchCandidates("project", strategies, undefined, 1_000);
    assert.equal(workers.length, 2);
    assert.equal(requests.length, 2);

    requests[1].worker.emit("message", {
      id: requests[1].request.id,
      ok: true,
      result: {
        identifierBoost: { durationMs: 0, results: [] },
        lexical: { durationMs: 0, results: [] },
        path: { durationMs: 0, results: [] },
        semanticFts: { durationMs: 0, results: [] },
        symbol: { durationMs: 0, results: [] },
        unicodeSubstring: { durationMs: 0, results: [] },
      },
    });
    await long;
    await assert.rejects(short, /deadline/);
  } finally {
    for (const worker of workers) emitFakeChildExit(worker);
    await client.close();
    await fixture.cleanup();
  }
});

test("identical cold search worker requests reuse one in-flight operation", async () => {
  const fixture = await createFixture();
  let worker: ChildProcess | undefined;
  const requests: SQLiteSearchWorkerRequest[] = [];
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      worker = createFakeSearchChildProcess((request, callback) => {
        requests.push(request);
        callback?.(null);
      });
      return worker;
    },
    poolSize: 2,
  });

  try {
    const first = client.searchByPath("project", ["same"], 10);
    const second = client.searchByPath("project", ["same"], 10);
    assert.equal(requests.length, 1);

    worker?.emit("message", { id: requests[0].id, ok: true, result: [] });
    assert.deepEqual(await Promise.all([first, second]), [[], []]);
    assert.equal(requests.length, 1);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("search reader dispatch does not repair the semantic index", async () => {
  const workerSourcePath = new URL(`./sqliteSearchWorker${fixtureExtension}`, import.meta.url);
  const workerSource = await readFile(workerSourcePath, "utf8");
  const semanticDispatch = workerSource.match(
    /case "searchBySemantic":[\s\S]*?(?=\n\s*case |\n\s*}\n\s*} catch)/,
  )?.[0] ?? "";

  assert.ok(semanticDispatch, "semantic search dispatch was not found");
  assert.doesNotMatch(semanticDispatch, /ensureSemanticIndex/);
});

test("closing a search worker rejects its pending request", async () => {
  const fixture = await createFixture();
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => createFakeSearchChildProcess((_message, callback) => callback?.(null)),
  });

  try {
    const pending = client.searchByPath("project", ["alpha"], 10);
    const rejected = assert.rejects(pending, /closed/);
    await client.close();
    await rejected;
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("an idle search child is replaced before the next request", async () => {
  const fixture = await createFixture();
  let factoryCalls = 0;
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      factoryCalls += 1;
      let worker: ChildProcess;
      worker = createFakeSearchChildProcess((message, callback) => {
        callback?.(null);
        queueMicrotask(() => worker.emit("message", { id: message.id, ok: true, result: [] }));
      });
      return worker;
    },
  });

  try {
    await client.searchByPath("project", ["alpha"], 10);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await client.searchByPath("project", ["beta"], 10);
    assert.equal(factoryCalls, 2);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("all search methods reject after close without creating a worker", async () => {
  const fixture = await createFixture();
  let factoryCalls = 0;
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      factoryCalls += 1;
      let worker: ChildProcess;
      worker = createFakeSearchChildProcess((message, callback) => {
        callback?.(null);
        queueMicrotask(() => worker.emit("message", { id: message.id, ok: true, result: [] }));
      });
      return worker;
    },
  });

  try {
    await client.close();
    const operations = [
      () => client.getFilePreviewResults("project", ["src/index.ts"]),
      () => client.listProjectFiles("project"),
      () => client.searchProjectRoutes("alpha", ["Alpha"], 10),
      () => client.searchByPath("project", ["alpha"], 10),
      () => client.searchBySemantic("project", ["alpha"], 10),
      () => client.searchBySymbols("project", ["Alpha"], 10),
      () => client.searchByText("project", "alpha", 10),
      () => client.searchByTextSubstrings("project", ["alpha"], 10),
    ];
    for (const operation of operations) {
      await assert.rejects(operation(), /closed/);
    }
    assert.equal(factoryCalls, 0);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("search requests reject while close is waiting without creating a replacement", async () => {
  const fixture = await createFixture();
  let factoryCalls = 0;
  let firstWorker: ChildProcess | undefined;
  let closing: Promise<void> | undefined;
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        firstWorker = createFakeSearchChildProcess((_message, callback) => callback?.(null));
        firstWorker.kill = () => true;
        return firstWorker;
      }
      let worker: ChildProcess;
      worker = createFakeSearchChildProcess((message, callback) => {
        callback?.(null);
        queueMicrotask(() => worker.emit("message", { id: message.id, ok: true, result: [] }));
      });
      return worker;
    },
  });

  try {
    const activeRequest = client.searchByPath("active", ["alpha"], 10);
    const activeRejected = assert.rejects(activeRequest, /closed/);
    closing = client.close();
    await activeRejected;

    await assert.rejects(client.searchByPath("replacement", ["beta"], 10), /closed/);
    assert.equal(factoryCalls, 1);
  } finally {
    firstWorker?.emit("exit", 0, null);
    await closing;
    await client.close();
    await fixture.cleanup();
  }
});

test("close terminates both current and errored search children", async () => {
  const fixture = await createFixture();
  let firstWorker: ChildProcess | undefined;
  let secondWorker: ChildProcess | undefined;
  let firstKillCount = 0;
  let secondKillCount = 0;
  let factoryCalls = 0;
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      factoryCalls += 1;
      const worker = createFakeSearchChildProcess((_message, callback) => callback?.(null));
      const originalKill = worker.kill.bind(worker);
      if (factoryCalls === 1) {
        firstWorker = worker;
        worker.kill = () => {
          firstKillCount += 1;
          return originalKill();
        };
      } else {
        secondWorker = worker;
        worker.kill = () => {
          secondKillCount += 1;
          return originalKill();
        };
      }
      return worker;
    },
  });

  try {
    const first = client.searchByPath("first", ["alpha"], 10);
    firstWorker?.emit("error", new Error("search worker A failed"));
    await assert.rejects(first, /search worker A failed/);

    const second = client.searchByPath("second", ["beta"], 10);
    const secondRejected = assert.rejects(second, /closed/);
    await client.close();
    await secondRejected;

    assert.ok(firstWorker);
    assert.ok(secondWorker);
    assert.equal(firstKillCount, 1);
    assert.equal(secondKillCount, 1);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("close terminates every live search pool worker", async () => {
  const fixture = await createFixture();
  const workers: ChildProcess[] = [];
  const requests: Array<{ request: SQLiteSearchWorkerRequest; worker: ChildProcess }> = [];
  const kills: number[] = [];
  const client = new SQLiteSearchWorkerClient(fixture.data, fixture.logger, {
    createChildProcess: () => {
      let worker: ChildProcess;
      worker = createFakeSearchChildProcess((request, callback) => {
        requests.push({ request, worker });
        callback?.(null);
      });
      const workerIndex = workers.length;
      const originalKill = worker.kill.bind(worker);
      worker.kill = () => {
        kills[workerIndex] = (kills[workerIndex] ?? 0) + 1;
        return originalKill();
      };
      workers.push(worker);
      return worker;
    },
    poolSize: 4,
  });

  try {
    const operations = Array.from({ length: 4 }, (_, index) =>
      client.searchByPath("project", [`term-${index}`], 10),
    );
    assert.equal(workers.length, 4);
    const rejections = operations.map((operation) => assert.rejects(operation, /closed/));
    await client.close();
    await Promise.all(rejections);
    assert.deepEqual(kills, [1, 1, 1, 1]);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

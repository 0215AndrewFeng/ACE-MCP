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

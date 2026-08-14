import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const benchmarkScript = path.join(rootDir, "scripts", "benchmark-search.mjs");
const projectRootPath = path.join(rootDir, "benchmark-fixture");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runBenchmark(args, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [benchmarkScript, ...args], {
      cwd: rootDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`benchmark child timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout });
    });
  });
}

async function startBenchmarkServer(options = {}) {
  const state = {
    activeSearchRequests: 0,
    healthRequests: 0,
    indexRequests: 0,
    indexStarted: false,
    maxActiveSearchRequests: 0,
    resolveOutsideActive: 0,
    resolveRequests: 0,
    searchOutsideActive: 0,
    searchQueries: [],
    searchRequests: 0,
    searchTopKs: [],
  };
  const activeResolveLimit = options.activeResolveLimit ?? Number.POSITIVE_INFINITY;
  const isActive = () => state.indexStarted
    && options.neverActive !== true
    && state.resolveRequests < activeResolveLimit;

  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");

    if (request.method === "GET" && request.url === "/health") {
      const requestNumber = state.healthRequests;
      state.healthRequests += 1;
      const healthDelayMs = typeof options.healthDelayMs === "function"
        ? options.healthDelayMs(requestNumber)
        : options.healthDelayMs ?? 0;
      await delay(healthDelayMs);
      const indexingEntry = {
        projectRootPath,
        status: "running",
      };
      if (options.omitIndexPhase !== true) {
        indexingEntry.phase = options.indexPhase ?? "parse";
      }
      response.end(JSON.stringify({
        indexing: isActive()
          ? [indexingEntry]
          : [],
        maintenanceLease: options.maintenanceLease ?? {
          lastError: null,
          lastLostReason: null,
          state: "held",
        },
        pid: process.pid,
        searchWorker: {
          activeRequests: state.activeSearchRequests,
          liveWorkers: Math.min(2, state.activeSearchRequests),
          pendingRequests: Math.max(0, state.activeSearchRequests - 2),
          queueMs: {
            currentMax: 0,
            last: state.searchRequests > 2 ? 4 : 0,
            max: state.searchRequests > 2 ? 7 : 0,
            samples: Math.max(0, state.searchRequests - 2),
            total: Math.max(0, state.searchRequests - 2) * 4,
          },
        },
        status: "ok",
        version: "test",
        watchHealth: options.watchHealth ?? {
          active: 1,
          circuitOpen: false,
          expected: 1,
          exhausted: 0,
          retrying: 0,
          status: "healthy",
        },
      }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/index-project") {
      state.indexRequests += 1;
      if (options.rejectIndex === true) {
        response.statusCode = 409;
        response.end(JSON.stringify({
          code: "PARENT_DIRECTORY_REQUIRES_CONFIRMATION",
          error: "parent directory requires confirmation",
        }));
        return;
      }
      state.indexStarted = true;
      response.statusCode = 202;
      response.end(JSON.stringify({
        data: {
          projectRootPath,
          status: "running",
          taskId: "index-test",
          taskUrl: "/api/tasks/index-test",
        },
      }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/projects/resolve") {
      if (!isActive()) {
        state.resolveOutsideActive += 1;
      }
      const requestNumber = state.resolveRequests;
      state.resolveRequests += 1;
      const resolveDelayMs = typeof options.resolveDelayMs === "function"
        ? options.resolveDelayMs(requestNumber)
        : options.resolveDelayMs ?? 1;
      await delay(resolveDelayMs);
      response.end(JSON.stringify({ data: { candidates: [], decision: "abstain" } }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/search-context") {
      if (state.indexStarted && !isActive()) {
        state.searchOutsideActive += 1;
      }
      const requestNumber = state.searchRequests;
      state.searchRequests += 1;
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      state.searchQueries.push(payload.query);
      state.searchTopKs.push(payload.topK);
      state.activeSearchRequests += 1;
      state.maxActiveSearchRequests = Math.max(
        state.maxActiveSearchRequests,
        state.activeSearchRequests,
      );
      const searchDelayMs = typeof options.searchDelayMs === "function"
        ? options.searchDelayMs(requestNumber)
        : options.searchDelayMs ?? 1;
      await delay(searchDelayMs);
      state.activeSearchRequests -= 1;
      const defaultResults = [{
        endLine: 2,
        filePath: "src/refund.ts",
        startLine: 1,
      }];
      const results = typeof options.searchResults === "function"
        ? options.searchResults(requestNumber)
        : options.searchResults ?? defaultResults;
      response.end(JSON.stringify({ data: { results } }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    state,
  };
}

test("search benchmark reports the real non-zero minimum latency", async () => {
  const server = await startBenchmarkServer({ healthDelayMs: 12, searchDelayMs: 12 });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--iterations", "2",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.healthSummary.minMs > 0, JSON.stringify(summary.healthSummary));
    assert.ok(summary.searchSummary.minMs > 0, JSON.stringify(summary.searchSummary));
  } finally {
    await server.close();
  }
});

test("search benchmark runs real search concurrency separately from health probes", async () => {
  const server = await startBenchmarkServer({ healthDelayMs: 2, searchDelayMs: 25 });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--iterations", "2",
      "--concurrency", "3",
      "--search-concurrency", "4",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.concurrency, 3);
    assert.equal(summary.searchConcurrency, 4);
    assert.equal(server.state.searchRequests, 8);
    assert.equal(server.state.healthRequests, 8);
    assert.ok(server.state.maxActiveSearchRequests >= 4, JSON.stringify(server.state));
    assert.equal(summary.searchSummary.count, 8);
    assert.ok(summary.searchSummary.p50Ms > 0, JSON.stringify(summary.searchSummary));
    assert.ok(summary.searchSummary.p95Ms >= summary.searchSummary.p50Ms);
    assert.ok(summary.searchSummary.p99Ms >= summary.searchSummary.p95Ms);
    assert.ok(summary.throughput.searchesPerSecond > 0, JSON.stringify(summary.throughput));
    assert.deepEqual(summary.searchFailures, { errors: 0, timeouts: 0 });
    assert.equal(summary.results.nonEmptyCount, 8);
    assert.equal(summary.results.stable, true);
    assert.equal(summary.results.distinctSignatures, 1);
    assert.ok(summary.searchQueueMs.samples > 0, JSON.stringify(summary.searchQueueMs));
    assert.ok(summary.searchQueueMs.maxMs > 0, JSON.stringify(summary.searchQueueMs));
  } finally {
    await server.close();
  }
});

test("release benchmark gates idle and during-index searches at 8, 16, and 32 concurrency", async () => {
  const server = await startBenchmarkServer({
    activeResolveLimit: 100,
    healthDelayMs: 1,
    resolveDelayMs: 1,
    searchDelayMs: 2,
  });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--release-gate",
      "--iterations", "2",
      "--search-p95-threshold-ms", "1000",
      "--search-p99-threshold-ms", "1000",
      "--timeout-ms", "1000",
      "--json",
    ], 20_000);

    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mode, "release-gate");
    assert.deepEqual(summary.concurrencyLevels, [8, 16, 32]);
    assert.deepEqual(summary.idle.levels.map((level) => level.searchConcurrency), [8, 16, 32]);
    assert.deepEqual(summary.duringIndex.levels.map((level) => level.searchConcurrency), [8, 16, 32]);
    assert.ok(summary.idle.levels.every((level) => level.results.stable));
    assert.ok(summary.duringIndex.levels.every((level) => level.results.stable));
    assert.ok(summary.idle.levels.every((level) => level.searchQueueMs.samples > 0));
    assert.ok(summary.duringIndex.levels.every((level) => level.searchQueueMs.samples > 0));
    assert.equal(server.state.indexRequests, 3);
    assert.ok(server.state.maxActiveSearchRequests >= 32, JSON.stringify(server.state));
    assert.equal(new Set(server.state.searchQueries).size, 6);
    assert.equal(new Set(server.state.searchTopKs).size, 32);
  } finally {
    await server.close();
  }
});

test("benchmark fails closed when watcher health degrades", async () => {
  const server = await startBenchmarkServer({
    watchHealth: {
      active: 0,
      circuitOpen: true,
      expected: 1,
      exhausted: 0,
      retrying: 1,
      status: "degraded",
    },
  });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--release-gate",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /watcher health degraded/i);
    assert.equal(server.state.searchRequests, 0);
  } finally {
    await server.close();
  }
});

test("benchmark fails closed when the maintenance lease is lost", async () => {
  const server = await startBenchmarkServer({
    maintenanceLease: {
      lastError: "heartbeat renewal failed",
      lastLostReason: "renewal-failed",
      state: "lost",
    },
  });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--release-gate",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /maintenance lease lost/i);
    assert.equal(server.state.searchRequests, 0);
  } finally {
    await server.close();
  }
});

test("search benchmark reports unstable and empty result sets without hiding samples", async () => {
  const server = await startBenchmarkServer({
    searchResults: (requestNumber) => requestNumber === 0
      ? []
      : [{ endLine: 2, filePath: `src/${requestNumber}.ts`, startLine: 1 }],
  });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--iterations", "1",
      "--search-concurrency", "3",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.searchSummary.count, 3);
    assert.equal(summary.results.nonEmptyCount, 2);
    assert.equal(summary.results.emptyCount, 1);
    assert.equal(summary.results.stable, false);
    assert.equal(summary.results.distinctSignatures, 3);
  } finally {
    await server.close();
  }
});

test("during-index benchmark collects at least twenty health and resolve samples while the target index is active", async () => {
  const server = await startBenchmarkServer({ activeResolveLimit: 30, healthDelayMs: 1, resolveDelayMs: 2 });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--query", "FlowSwitcher",
      "--during-index",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mode, "during-index");
    assert.equal(summary.observedActive, true);
    assert.ok(summary.healthSummary.count >= 20, JSON.stringify(summary.healthSummary));
    assert.ok(summary.resolveSummary.count >= 20, JSON.stringify(summary.resolveSummary));
    assert.equal(server.state.indexRequests, 1);
    assert.equal(server.state.resolveOutsideActive, 0);
  } finally {
    await server.close();
  }
});

test("during-index benchmark optionally collects concurrent non-empty search samples only while indexing is active", async () => {
  const server = await startBenchmarkServer({
    activeResolveLimit: 30,
    healthDelayMs: 1,
    resolveDelayMs: 2,
    searchDelayMs: 3,
  });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--query", "FlowSwitcher",
      "--during-index",
      "--during-index-search",
      "--search-concurrency", "2",
      "--search-p95-threshold-ms", "100",
      "--search-p99-threshold-ms", "100",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mode, "during-index");
    assert.equal(summary.searchConcurrency, 2);
    assert.ok(summary.searchSummary.count >= 20, JSON.stringify(summary.searchSummary));
    assert.ok(summary.searchSummary.p99Ms >= summary.searchSummary.p95Ms);
    assert.equal(summary.searchFailures.errors, 0);
    assert.equal(summary.searchFailures.timeouts, 0);
    assert.equal(summary.results.nonEmptyCount, summary.searchSummary.count);
    assert.equal(summary.results.stable, true);
    assert.equal(server.state.searchOutsideActive, 0);
  } finally {
    await server.close();
  }
});

test("during-index search benchmark fails when search p99 exceeds its threshold", async () => {
  const server = await startBenchmarkServer({
    activeResolveLimit: 30,
    healthDelayMs: 1,
    resolveDelayMs: 1,
    searchDelayMs: 25,
  });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--during-index",
      "--during-index-search",
      "--search-p95-threshold-ms", "100",
      "--search-p99-threshold-ms", "5",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /search p99 .* exceeds .*5ms/i);
    assert.match(result.stderr, /benchmark diagnostics/i);
    assert.ok(server.state.searchRequests >= 20);
  } finally {
    await server.close();
  }
});

test("during-index search benchmark fails closed on search timeouts", async () => {
  const server = await startBenchmarkServer({
    activeResolveLimit: 30,
    healthDelayMs: (requestNumber) => requestNumber === 0 ? 80 : 1,
    resolveDelayMs: 1,
    searchDelayMs: 80,
  });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--during-index",
      "--during-index-search",
      "--active-window-timeout-ms", "5000",
      "--timeout-ms", "30",
      "--json",
    ], 3000);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /timeout count .* exceeds allowed 0/i);
    assert.match(result.stderr, /search valid sample count 0 is below required 20/i);
    assert.match(result.stderr, /benchmark diagnostics/i);
    assert.ok(server.state.searchRequests >= 20);
  } finally {
    await server.close();
  }
});

test("during-index benchmark fails when it never observes active indexing", async () => {
  const server = await startBenchmarkServer({ neverActive: true });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--during-index",
      "--active-wait-timeout-ms", "100",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /did not observe active indexing/i);
    assert.match(result.stderr, /benchmark diagnostics/i);
    assert.equal(server.state.resolveRequests, 0);
  } finally {
    await server.close();
  }
});

test("during-index benchmark does not treat a target entry without phase as active indexing", async () => {
  const server = await startBenchmarkServer({ omitIndexPhase: true });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--during-index",
      "--active-wait-timeout-ms", "100",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /did not observe active indexing/i);
    assert.equal(server.state.resolveRequests, 0);
  } finally {
    await server.close();
  }
});

test("during-index benchmark does not treat an unknown target phase as active indexing", async () => {
  const server = await startBenchmarkServer({ indexPhase: "legacy-working" });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--during-index",
      "--active-wait-timeout-ms", "100",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /did not observe active indexing/i);
    assert.equal(server.state.resolveRequests, 0);
  } finally {
    await server.close();
  }
});

test("during-index benchmark fails with diagnostics when resolve p95 exceeds its threshold", async () => {
  const server = await startBenchmarkServer({ healthDelayMs: 1, resolveDelayMs: 25 });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--during-index",
      "--resolve-p95-threshold-ms", "5",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /resolve p95 .* exceeds .*5ms/i);
    assert.match(result.stderr, /benchmark diagnostics/i);
    assert.ok(server.state.resolveRequests >= 20);
  } finally {
    await server.close();
  }
});

test("during-index benchmark fails when request timeouts exceed the zero-timeout threshold", async () => {
  const server = await startBenchmarkServer({
    healthDelayMs: 1,
    resolveDelayMs: (requestNumber) => requestNumber === 0 ? 80 : 1,
  });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--during-index",
      "--timeout-ms", "30",
      "--json",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /timeout count 1 exceeds allowed 0/i);
    assert.match(result.stderr, /benchmark diagnostics/i);
    assert.ok(server.state.resolveRequests >= 21);
  } finally {
    await server.close();
  }
});

test("during-index benchmark excludes pre-window observation timeouts from active samples", async () => {
  const server = await startBenchmarkServer({
    healthDelayMs: (requestNumber) => requestNumber === 1 ? 80 : 1,
    resolveDelayMs: 1,
  });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--during-index",
      "--active-wait-timeout-ms", "1000",
      "--timeout-ms", "30",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.timeouts.total, 0);
    assert.ok(summary.healthSummary.count >= 20);
    assert.ok(summary.resolveSummary.count >= 20);
  } finally {
    await server.close();
  }
});

test("during-index benchmark preserves index submission status and service error diagnostics", async () => {
  const server = await startBenchmarkServer({ rejectIndex: true });
  try {
    const result = await runBenchmark([
      "--base-url", server.baseUrl,
      "--project", projectRootPath,
      "--during-index",
      "--timeout-ms", "1000",
      "--json",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /409/);
    assert.match(result.stderr, /PARENT_DIRECTORY_REQUIRES_CONFIRMATION/);
    assert.match(result.stderr, /benchmark diagnostics/i);
  } finally {
    await server.close();
  }
});

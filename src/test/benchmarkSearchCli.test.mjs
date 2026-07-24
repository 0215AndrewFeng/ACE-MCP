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
    healthRequests: 0,
    indexRequests: 0,
    indexStarted: false,
    resolveOutsideActive: 0,
    resolveRequests: 0,
    searchRequests: 0,
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
        pid: process.pid,
        status: "ok",
        version: "test",
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
      state.searchRequests += 1;
      await delay(options.searchDelayMs ?? 1);
      response.end(JSON.stringify({ data: { results: [] } }));
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

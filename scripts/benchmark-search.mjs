#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import process from "node:process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_QUERY = "RefundService";
const DEFAULT_ITERATIONS = 5;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ACTIVE_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_ACTIVE_WINDOW_TIMEOUT_MS = 60_000;
const DEFAULT_ACTIVE_SAMPLE_COUNT = 20;
const DEFAULT_HEALTH_P95_THRESHOLD_MS = 1_000;
const DEFAULT_RESOLVE_P95_THRESHOLD_MS = 2_000;
const DEFAULT_MAX_TIMEOUTS = 0;
const ACTIVE_POLL_INTERVAL_MS = 25;
const ACTIVE_INDEX_PHASES = new Set([
  "prepare",
  "collect",
  "detect",
  "parse",
  "index",
  "vector",
  "symbolGraph",
  "semantic",
  "finalize",
]);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    activeWaitTimeoutMs: DEFAULT_ACTIVE_WAIT_TIMEOUT_MS,
    activeWindowTimeoutMs: DEFAULT_ACTIVE_WINDOW_TIMEOUT_MS,
    baseUrl: process.env.ACE_MCP_BENCHMARK_BASE_URL || DEFAULT_BASE_URL,
    concurrency: DEFAULT_CONCURRENCY,
    duringIndex: false,
    healthP95ThresholdMs: DEFAULT_HEALTH_P95_THRESHOLD_MS,
    iterations: DEFAULT_ITERATIONS,
    json: false,
    maxTimeouts: DEFAULT_MAX_TIMEOUTS,
    projectRootPath: process.cwd(),
    query: DEFAULT_QUERY,
    resolveP95ThresholdMs: DEFAULT_RESOLVE_P95_THRESHOLD_MS,
    smoke: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      return value;
    };

    switch (arg) {
      case "--active-wait-timeout-ms":
        options.activeWaitTimeoutMs = parsePositiveInteger(next(), arg);
        break;
      case "--active-window-timeout-ms":
        options.activeWindowTimeoutMs = parsePositiveInteger(next(), arg);
        break;
      case "--base-url":
        options.baseUrl = next().replace(/\/$/, "");
        break;
      case "--concurrency":
        options.concurrency = parsePositiveInteger(next(), arg);
        break;
      case "--iterations":
        options.iterations = parsePositiveInteger(next(), arg);
        break;
      case "--during-index":
        options.duringIndex = true;
        break;
      case "--health-p95-threshold-ms":
        options.healthP95ThresholdMs = parsePositiveInteger(next(), arg);
        break;
      case "--json":
        options.json = true;
        break;
      case "--max-timeouts":
        options.maxTimeouts = parseNonNegativeInteger(next(), arg);
        break;
      case "--project":
        options.projectRootPath = next();
        break;
      case "--query":
        options.query = next();
        break;
      case "--resolve-p95-threshold-ms":
        options.resolveP95ThresholdMs = parsePositiveInteger(next(), arg);
        break;
      case "--smoke":
        options.smoke = true;
        options.iterations = 1;
        options.concurrency = 1;
        options.query = DEFAULT_QUERY;
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(next(), arg);
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parsePositiveInteger(raw, label) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInteger(raw, label) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: npm run benchmark:search -- [options]

Options:
  --base-url <url>       ace-mcp Web base URL (default: ${DEFAULT_BASE_URL})
  --project <path>       Indexed project root path (default: current directory)
  --query <text>         Search query (default: ${DEFAULT_QUERY})
  --iterations <n>       Search iterations (default: ${DEFAULT_ITERATIONS})
  --concurrency <n>      Parallel health probes during each search (default: ${DEFAULT_CONCURRENCY})
  --timeout-ms <n>       Per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --during-index         Start a full index and benchmark health/project resolution only while it is active
  --active-wait-timeout-ms <n>
                         Time allowed to observe active indexing (default: ${DEFAULT_ACTIVE_WAIT_TIMEOUT_MS})
  --active-window-timeout-ms <n>
                         Time allowed to collect ${DEFAULT_ACTIVE_SAMPLE_COUNT} valid samples per endpoint (default: ${DEFAULT_ACTIVE_WINDOW_TIMEOUT_MS})
  --health-p95-threshold-ms <n>
                         Fail above this active-index health p95 (default: ${DEFAULT_HEALTH_P95_THRESHOLD_MS})
  --resolve-p95-threshold-ms <n>
                         Fail above this active-index project resolve p95 (default: ${DEFAULT_RESOLVE_P95_THRESHOLD_MS})
  --max-timeouts <n>     Allowed probe timeouts before failure (default: ${DEFAULT_MAX_TIMEOUTS})
  --json                 Print machine-readable JSON
  --smoke                Create and index a tiny temp project, then run one benchmark iteration
  --help                 Show this help
`);
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}: ${text}`);
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${url} timed out after ${timeoutMs}ms`);
    }
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`${url} failed${detail}${cause}`);
  } finally {
    clearTimeout(timer);
  }
}

async function timed(label, operation) {
  const startedAt = performance.now();
  const result = await operation();
  return {
    durationMs: Math.round(performance.now() - startedAt),
    label,
    result,
  };
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

function summarize(values) {
  return {
    count: values.length,
    maxMs: Math.max(...values, 0),
    minMs: values.length === 0 ? 0 : Math.min(...values),
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
  };
}

function extractResultCount(searchResult) {
  const results = searchResult?.results ?? searchResult?.data?.results;
  return Array.isArray(results) ? results.length : 0;
}

async function runSearch(baseUrl, projectRootPath, query, timeoutMs) {
  return timed("search", () =>
    fetchJson(`${baseUrl}/api/search-context`, {
      body: JSON.stringify({
        includeContextLines: 0,
        mode: "hybrid",
        projectRootPath,
        query,
        resultMode: "metadata",
        topK: 10,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    }, timeoutMs),
  );
}

async function indexProject(baseUrl, projectRootPath, timeoutMs) {
  return fetchJson(`${baseUrl}/api/index-project`, {
    body: JSON.stringify({
      mode: "full",
      projectRootPath,
    }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  }, timeoutMs);
}

async function runHealthProbe(baseUrl, timeoutMs) {
  return timed("health", () => fetchJson(`${baseUrl}/health`, undefined, timeoutMs));
}

async function runResolveProbe(baseUrl, query, timeoutMs) {
  return timed("resolve", () =>
    fetchJson(`${baseUrl}/api/projects/resolve`, {
      body: JSON.stringify({ query, topK: 3 }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    }, timeoutMs),
  );
}

function normalizeComparablePath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function findActiveIndex(health, projectRootPath) {
  if (!Array.isArray(health?.indexing)) {
    return undefined;
  }
  const targetPath = normalizeComparablePath(projectRootPath);
  return health.indexing.find((entry) =>
    entry
      && typeof entry.projectRootPath === "string"
      && normalizeComparablePath(entry.projectRootPath) === targetPath
      && ACTIVE_INDEX_PHASES.has(entry.phase),
  );
}

async function captureProbe(operation) {
  const startedAt = performance.now();
  try {
    const probe = await operation();
    return { ...probe, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      durationMs: Math.round(performance.now() - startedAt),
      error: message,
      ok: false,
      timedOut: /timed out after \d+ms/i.test(message),
    };
  }
}

function compactHealth(health) {
  if (!health || typeof health !== "object") {
    return health;
  }
  return {
    indexing: Array.isArray(health.indexing) ? health.indexing : [],
    pid: health.pid,
    status: health.status,
    tasks: Array.isArray(health.tasks) ? health.tasks.slice(0, 10) : [],
    version: health.version,
  };
}

function formatBenchmarkDiagnostics(options, diagnostics) {
  return JSON.stringify({
    baseUrl: options.baseUrl,
    healthProbeFailures: diagnostics.healthProbeFailures.slice(-10),
    indexSubmission: diagnostics.indexSubmission,
    lastHealth: compactHealth(diagnostics.lastHealth),
    observationProbeFailures: diagnostics.observationProbeFailures.slice(-10),
    observedPhases: [...diagnostics.observedPhases],
    projectRootPath: options.projectRootPath,
    resolveProbeFailures: diagnostics.resolveProbeFailures.slice(-10),
    summary: diagnostics.summary,
  }, null, 2);
}

function benchmarkFailure(message, options, diagnostics) {
  return new Error(`${message}\nbenchmark diagnostics:\n${formatBenchmarkDiagnostics(options, diagnostics)}`);
}

function recordActiveHealth(probe, projectRootPath, healthMs, diagnostics) {
  diagnostics.lastHealth = probe.result;
  const activeIndex = findActiveIndex(probe.result, projectRootPath);
  if (!activeIndex) {
    return false;
  }
  healthMs.push(probe.durationMs);
  if (typeof activeIndex.phase === "string") {
    diagnostics.observedPhases.add(activeIndex.phase);
  }
  return true;
}

async function waitForActiveIndex(options, diagnostics) {
  const deadline = Date.now() + options.activeWaitTimeoutMs;
  while (Date.now() < deadline) {
    const probe = await captureProbe(() => runHealthProbe(options.baseUrl, options.timeoutMs));
    if (probe.ok) {
      diagnostics.lastHealth = probe.result;
      const activeIndex = findActiveIndex(probe.result, options.projectRootPath);
      if (activeIndex) {
        if (typeof activeIndex.phase === "string") {
          diagnostics.observedPhases.add(activeIndex.phase);
        }
        return;
      }
    } else {
      diagnostics.observationProbeFailures.push(probe);
    }
    await new Promise((resolve) => setTimeout(resolve, ACTIVE_POLL_INTERVAL_MS));
  }

  throw benchmarkFailure(
    `did not observe active indexing for ${options.projectRootPath} within ${options.activeWaitTimeoutMs}ms`,
    options,
    diagnostics,
  );
}

async function runDuringIndexBenchmark(options, serverHealth) {
  const diagnostics = {
    healthProbeFailures: [],
    indexSubmission: undefined,
    lastHealth: serverHealth,
    observationProbeFailures: [],
    observedPhases: new Set(),
    resolveProbeFailures: [],
    summary: undefined,
  };

  try {
    diagnostics.indexSubmission = await indexProject(options.baseUrl, options.projectRootPath, options.timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw benchmarkFailure(`could not start target index: ${message}`, options, diagnostics);
  }
  await waitForActiveIndex(options, diagnostics);

  const healthMs = [];
  const resolveMs = [];
  const sampleStartedAt = Date.now();
  const deadline = sampleStartedAt + options.activeWindowTimeoutMs;
  while (
    (healthMs.length < DEFAULT_ACTIVE_SAMPLE_COUNT || resolveMs.length < DEFAULT_ACTIVE_SAMPLE_COUNT)
    && Date.now() < deadline
  ) {
    const before = await captureProbe(() => runHealthProbe(options.baseUrl, options.timeoutMs));
    if (!before.ok) {
      diagnostics.healthProbeFailures.push(before);
      continue;
    }
    if (!recordActiveHealth(before, options.projectRootPath, healthMs, diagnostics)) {
      break;
    }

    const resolveProbe = await captureProbe(() => runResolveProbe(
      options.baseUrl,
      options.query,
      options.timeoutMs,
    ));
    const after = await captureProbe(() => runHealthProbe(options.baseUrl, options.timeoutMs));
    let activeAfter = false;
    if (after.ok) {
      activeAfter = recordActiveHealth(after, options.projectRootPath, healthMs, diagnostics);
    } else {
      diagnostics.healthProbeFailures.push(after);
    }

    if (!resolveProbe.ok) {
      diagnostics.resolveProbeFailures.push(resolveProbe);
    } else if (activeAfter) {
      resolveMs.push(resolveProbe.durationMs);
    }
    if (!activeAfter) {
      break;
    }
  }

  const healthTimeouts = diagnostics.healthProbeFailures.filter((failure) => failure.timedOut).length;
  const resolveTimeouts = diagnostics.resolveProbeFailures.filter((failure) => failure.timedOut).length;
  const timeoutCount = healthTimeouts + resolveTimeouts;
  const summary = {
    baseUrl: options.baseUrl,
    healthP95Ms: percentile(healthMs, 95),
    healthSummary: summarize(healthMs),
    mode: "during-index",
    observedActive: true,
    observedPhases: [...diagnostics.observedPhases],
    projectRootPath: options.projectRootPath,
    query: options.query,
    requiredSamples: DEFAULT_ACTIVE_SAMPLE_COUNT,
    resolveP95Ms: percentile(resolveMs, 95),
    resolveSummary: summarize(resolveMs),
    sampleWindowMs: Date.now() - sampleStartedAt,
    server: {
      pid: serverHealth.pid,
      version: serverHealth.version,
    },
    thresholds: {
      healthP95Ms: options.healthP95ThresholdMs,
      maxTimeouts: options.maxTimeouts,
      resolveP95Ms: options.resolveP95ThresholdMs,
    },
    timeouts: {
      health: healthTimeouts,
      resolve: resolveTimeouts,
      total: timeoutCount,
    },
  };
  diagnostics.summary = summary;

  const violations = [];
  if (summary.healthSummary.count < DEFAULT_ACTIVE_SAMPLE_COUNT) {
    violations.push(`health valid sample count ${summary.healthSummary.count} is below required ${DEFAULT_ACTIVE_SAMPLE_COUNT}`);
  }
  if (summary.resolveSummary.count < DEFAULT_ACTIVE_SAMPLE_COUNT) {
    violations.push(`resolve valid sample count ${summary.resolveSummary.count} is below required ${DEFAULT_ACTIVE_SAMPLE_COUNT}`);
  }
  if (summary.healthP95Ms > options.healthP95ThresholdMs) {
    violations.push(`health p95 ${summary.healthP95Ms}ms exceeds threshold ${options.healthP95ThresholdMs}ms`);
  }
  if (summary.resolveP95Ms > options.resolveP95ThresholdMs) {
    violations.push(`resolve p95 ${summary.resolveP95Ms}ms exceeds threshold ${options.resolveP95ThresholdMs}ms`);
  }
  if (timeoutCount > options.maxTimeouts) {
    violations.push(`timeout count ${timeoutCount} exceeds allowed ${options.maxTimeouts}`);
  }
  const nonTimeoutFailures = [
    ...diagnostics.healthProbeFailures,
    ...diagnostics.resolveProbeFailures,
  ].filter((failure) => !failure.timedOut);
  if (nonTimeoutFailures.length > 0) {
    violations.push(`${nonTimeoutFailures.length} non-timeout probe request(s) failed`);
  }
  if (violations.length > 0) {
    throw benchmarkFailure(
      `during-index responsiveness benchmark failed:\n- ${violations.join("\n- ")}`,
      options,
      diagnostics,
    );
  }

  return summary;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("Could not allocate a local TCP port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetchJson(`${baseUrl}/health`, undefined, Math.min(timeoutMs, 1000));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`ace-mcp benchmark smoke server did not become healthy: ${message}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function getLogs(homeDir, stdout, stderr) {
  const chunks = [];
  if (stdout.trim()) {
    chunks.push(`--- stdout ---\n${stdout.trim()}`);
  }
  if (stderr.trim()) {
    chunks.push(`--- stderr ---\n${stderr.trim()}`);
  }

  const logDir = path.join(homeDir, ".ace-mcp", "log");
  try {
    const entries = await readdir(logDir);
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".log")) {
        continue;
      }
      const logPath = path.join(logDir, entry);
      const content = await readFile(logPath, "utf8");
      if (content.trim()) {
        chunks.push(`--- ${entry} ---\n${content.trim().slice(-8000)}`);
      }
    }
  } catch {
    // Log directory may not exist if the process exits before settings load.
  }

  return chunks.join("\n");
}

async function startSmokeServer(timeoutMs) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-benchmark-server-"));
  const homeDir = process.env.ACE_MCP_BENCHMARK_SMOKE_HOME || path.join(tempRoot, "home");
  await mkdir(homeDir, { recursive: true });
  const port = await getFreePort();
  let stderr = "";
  let stdout = "";
  const child = spawn(process.execPath, [path.join(rootDir, "dist", "index.js"), "--web-port", String(port)], {
    cwd: rootDir,
    env: {
      ...process.env,
      ACE_MCP_AUTO_WATCH: "false",
      ACE_MCP_LOG_LEVEL: "error",
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  child.unref();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, timeoutMs);
  } catch (error) {
    await stopChild(child);
    const message = error instanceof Error ? error.message : String(error);
    const logs = await getLogs(homeDir, stdout, stderr);
    await rm(tempRoot, { force: true, recursive: true });
    throw new Error(`${message}\n${logs}`.trim());
  }
  return {
    baseUrl,
    getLogs: () => getLogs(homeDir, stdout, stderr),
    cleanup: async () => {
      await stopChild(child);
      await rm(tempRoot, { force: true, recursive: true });
    },
  };
}

async function runIteration(options, iteration) {
  let timerFired = false;
  const timerPromise = new Promise((resolve) => {
    setTimeout(() => {
      timerFired = true;
      resolve();
    }, 0);
  });

  const searchPromise = runSearch(options.baseUrl, options.projectRootPath, options.query, options.timeoutMs);
  const healthPromises = Array.from({ length: options.concurrency }, () => runHealthProbe(options.baseUrl, options.timeoutMs));
  const [search, ...healthResults] = await Promise.all([searchPromise, ...healthPromises]);
  const timerBeforeSearchResolved = timerFired;
  await timerPromise;

  return {
    healthMs: healthResults.map((result) => result.durationMs),
    iteration,
    resultCount: extractResultCount(search.result),
    searchMs: search.durationMs,
    timerBeforeSearchResolved,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let smokeDir;
  let smokeServer;
  try {
    if (options.smoke) {
      smokeServer = await startSmokeServer(options.timeoutMs);
      smokeDir = await createSmokeProject(options.duringIndex);
      options.baseUrl = smokeServer.baseUrl;
      options.projectRootPath = smokeDir;
    }

    const health = await fetchJson(`${options.baseUrl}/health`, undefined, options.timeoutMs);
    if (options.duringIndex) {
      const summary = await runDuringIndexBenchmark(options, health);
      if (options.json || options.smoke) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      console.log(`ace-mcp during-index responsiveness benchmark (${summary.server.version ?? "unknown"})`);
      console.log(`project: ${summary.projectRootPath}`);
      console.log(`query: ${summary.query}`);
      console.log(`observed phases: ${summary.observedPhases.join(", ") || "unknown"}`);
      console.log(`valid samples: health ${summary.healthSummary.count}, resolve ${summary.resolveSummary.count}`);
      console.log(`health p50/p95/max: ${summary.healthSummary.p50Ms}/${summary.healthSummary.p95Ms}/${summary.healthSummary.maxMs}ms (limit ${summary.thresholds.healthP95Ms}ms)`);
      console.log(`resolve p50/p95/max: ${summary.resolveSummary.p50Ms}/${summary.resolveSummary.p95Ms}/${summary.resolveSummary.maxMs}ms (limit ${summary.thresholds.resolveP95Ms}ms)`);
      console.log(`timeouts: ${summary.timeouts.total} (allowed ${summary.thresholds.maxTimeouts})`);
      return;
    }
    if (options.smoke) {
      await indexProject(options.baseUrl, options.projectRootPath, options.timeoutMs);
    }
    const iterations = [];

    for (let index = 0; index < options.iterations; index++) {
      iterations.push(await runIteration(options, index + 1));
    }
    if (options.smoke && iterations.some((iteration) => iteration.resultCount < 1)) {
      throw new Error("smoke benchmark did not return search results");
    }

    const searchMs = iterations.map((iteration) => iteration.searchMs);
    const healthMs = iterations.flatMap((iteration) => iteration.healthMs);
    const eventLoopDelay = {
      blockedIterations: iterations.filter((iteration) => !iteration.timerBeforeSearchResolved).length,
      responsiveIterations: iterations.filter((iteration) => iteration.timerBeforeSearchResolved).length,
      totalIterations: iterations.length,
    };
    const summary = {
      baseUrl: options.baseUrl,
      concurrency: options.concurrency,
      eventLoopDelay,
      healthP95Ms: percentile(healthMs, 95),
      healthSummary: summarize(healthMs),
      iterations,
      projectRootPath: options.projectRootPath,
      query: options.query,
      searchP95Ms: percentile(searchMs, 95),
      searchSummary: summarize(searchMs),
      server: {
        pid: health.pid,
        version: health.version,
      },
    };

    if (options.json || options.smoke) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log(`ace-mcp search benchmark (${summary.server.version ?? "unknown"})`);
    console.log(`project: ${summary.projectRootPath}`);
    console.log(`query: ${summary.query}`);
    console.log(`iterations: ${options.iterations}, health concurrency: ${options.concurrency}`);
    console.log(`search p50/p95/max: ${summary.searchSummary.p50Ms}/${summary.searchSummary.p95Ms}/${summary.searchSummary.maxMs}ms`);
    console.log(`health p50/p95/max: ${summary.healthSummary.p50Ms}/${summary.healthSummary.p95Ms}/${summary.healthSummary.maxMs}ms`);
    console.log(`event loop responsive iterations: ${eventLoopDelay.responsiveIterations}/${eventLoopDelay.totalIterations}`);
  } catch (error) {
    if (smokeServer) {
      const logs = await smokeServer.getLogs();
      if (logs) {
        console.error(logs);
      }
    }
    throw error;
  } finally {
    if (smokeDir) {
      await rm(smokeDir, { force: true, recursive: true });
    }
    if (smokeServer) {
      await smokeServer.cleanup();
    }
  }
}

async function createSmokeProject(duringIndex = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-benchmark-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), "{\"type\":\"module\"}\n", "utf8");
  await writeFile(
    path.join(root, "src", "refund.ts"),
    [
      "export class RefundService {",
      "  refundOrder() {",
      "    return 'refund';",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  if (duringIndex) {
    await Promise.all(Array.from({ length: 400 }, (_, index) =>
      writeFile(
        path.join(root, "src", `refund-${index}.ts`),
        [
          `export class RefundService${index} {`,
          ...Array.from({ length: 12 }, (_unused, methodIndex) => [
            `  refundOrder${methodIndex}(orderId: string) {`,
            `    return orderId.trim() + "-${index}-${methodIndex}";`,
            "  }",
          ]).flat(),
          "}",
          "",
        ].join("\n"),
        "utf8",
      ),
    ));
  }
  return root;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

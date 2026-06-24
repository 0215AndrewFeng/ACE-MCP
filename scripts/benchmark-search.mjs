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
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.ACE_MCP_BENCHMARK_BASE_URL || DEFAULT_BASE_URL,
    concurrency: DEFAULT_CONCURRENCY,
    iterations: DEFAULT_ITERATIONS,
    json: false,
    projectRootPath: process.cwd(),
    query: DEFAULT_QUERY,
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
      case "--base-url":
        options.baseUrl = next().replace(/\/$/, "");
        break;
      case "--concurrency":
        options.concurrency = parsePositiveInteger(next(), arg);
        break;
      case "--iterations":
        options.iterations = parsePositiveInteger(next(), arg);
        break;
      case "--json":
        options.json = true;
        break;
      case "--project":
        options.projectRootPath = next();
        break;
      case "--query":
        options.query = next();
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

function printHelp() {
  console.log(`Usage: npm run benchmark:search -- [options]

Options:
  --base-url <url>       ace-mcp Web base URL (default: ${DEFAULT_BASE_URL})
  --project <path>       Indexed project root path (default: current directory)
  --query <text>         Search query (default: ${DEFAULT_QUERY})
  --iterations <n>       Search iterations (default: ${DEFAULT_ITERATIONS})
  --concurrency <n>      Parallel health probes during each search (default: ${DEFAULT_CONCURRENCY})
  --timeout-ms <n>       Per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
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
    throw new Error(`${url} failed${cause}`);
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
    minMs: Math.min(...values, 0),
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
      smokeDir = await createSmokeProject();
      options.baseUrl = smokeServer.baseUrl;
      options.projectRootPath = smokeDir;
    }

    const health = await fetchJson(`${options.baseUrl}/health`, undefined, options.timeoutMs);
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

async function createSmokeProject() {
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
  return root;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

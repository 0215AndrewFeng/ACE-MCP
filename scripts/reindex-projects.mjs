#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 7_200_000;

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.ACE_MCP_BASE_URL || DEFAULT_BASE_URL,
    dryRun: false,
    includeParent: false,
    projects: [],
    summary: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case "--base-url":
        options.baseUrl = next().replace(/\/$/, "");
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--include-parent":
        options.includeParent = true;
        break;
      case "--project":
        options.projects.push(path.resolve(next()));
        break;
      case "--summary":
        options.summary = true;
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
  console.log(`Usage: node scripts/reindex-projects.mjs [options]

Sequentially full-index registered ace-mcp projects and optionally generate summaries.

Options:
  --base-url <url>       ace-mcp Web base URL (default: ${DEFAULT_BASE_URL})
  --project <path>       Process only this project path; may be repeated
  --summary              Generate summaries after successful full index
  --dry-run              Print the plan without sending index/summary requests
  --include-parent       Allow aggregate parent directories that contain registered projects
  --timeout-ms <n>       Per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --help                 Show this help
`);
}

function isInside(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  return candidate !== parent && candidate.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

function classifyProjects(projects, options) {
  const wanted = options.projects.length > 0 ? new Set(options.projects.map((p) => path.resolve(p))) : null;
  const uniquePaths = [...new Set(projects.map((project) => path.resolve(project.projectRootPath)))];
  return uniquePaths
    .filter((projectRootPath) => !wanted || wanted.has(projectRootPath))
    .map((projectRootPath) => {
      const childProjects = uniquePaths.filter((candidate) => isInside(projectRootPath, candidate));
      const exists = existsSync(projectRootPath);
      const isParent = childProjects.length > 0;
      const skipped = !exists
        ? "missing"
        : childProjects.length > 1 && !options.includeParent
          ? "parent"
          : undefined;
      return { childProjects, exists, isParent, projectRootPath, skipped };
    });
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "error" in body ? body.error : text;
      throw new Error(`${url} returned ${response.status}: ${message}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function loadProjects(baseUrl, timeoutMs) {
  const body = await fetchJson(`${baseUrl}/api/projects`, {}, timeoutMs);
  if (!Array.isArray(body.projects)) {
    throw new Error("/api/projects did not return a projects array");
  }
  return body.projects;
}

async function indexProject(baseUrl, projectRootPath, timeoutMs, confirmParentDirectory) {
  const body = await fetchJson(`${baseUrl}/api/index-project`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmParentDirectory, mode: "full", projectRootPath }),
  }, timeoutMs);
  const taskId = body.data?.taskId;
  if (!taskId) {
    return body;
  }

  return pollTask(baseUrl, taskId, timeoutMs);
}

async function generateSummary(baseUrl, projectRootPath, timeoutMs) {
  const body = await fetchJson(`${baseUrl}/api/summary/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectRootPath }),
  }, timeoutMs);
  const taskId = body.data?.taskId;
  if (!taskId) {
    return body;
  }

  return pollTask(baseUrl, taskId, timeoutMs);
}

async function pollTask(baseUrl, taskId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const body = await fetchJson(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, {}, timeoutMs);
    const task = body.task;
    if (task?.status === "succeeded") {
      return { ...body, data: task.result, task };
    }
    if (task?.status === "failed") {
      throw new Error(`task ${taskId} failed: ${task.error?.message ?? "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`task ${taskId} did not finish within ${timeoutMs}ms`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projects = await loadProjects(options.baseUrl, options.timeoutMs);
  const plan = classifyProjects(projects, options);
  const report = [];

  console.log(`ace-mcp maintenance reindex plan (${plan.length} project paths)`);
  for (const item of plan) {
    const marker = item.skipped ? `skip:${item.skipped}` : "process";
    const extra = item.isParent ? ` childProjects=${item.childProjects.length}` : "";
    console.log(`${marker}\t${item.projectRootPath}${extra}`);
  }

  if (options.dryRun) {
    console.log("dry-run complete; no requests sent");
    return;
  }

  for (const item of plan) {
    if (item.skipped) {
      report.push({ projectRootPath: item.projectRootPath, skipped: item.skipped });
      continue;
    }

    const startedAt = Date.now();
    try {
      console.log(`index:start\t${item.projectRootPath}`);
      const indexResult = await indexProject(options.baseUrl, item.projectRootPath, options.timeoutMs, item.isParent);
      const indexStats = indexResult.data ?? indexResult.stats?.indexSync ?? {};
      console.log(`index:ok\t${item.projectRootPath}\tindexed=${indexStats.indexedFiles ?? "?"}\tchunks=${indexStats.chunkCount ?? "?"}\tfailed=${indexStats.failedFileCount ?? "?"}`);

      let summaryResult;
      if (options.summary) {
        console.log(`summary:start\t${item.projectRootPath}`);
        summaryResult = await generateSummary(options.baseUrl, item.projectRootPath, options.timeoutMs);
        console.log(`summary:ok\t${item.projectRootPath}\tmodules=${summaryResult.data?.moduleCount ?? "?"}`);
      }

      report.push({
        durationMs: Date.now() - startedAt,
        indexedFiles: indexStats.indexedFiles,
        chunkCount: indexStats.chunkCount,
        failedFileCount: indexStats.failedFileCount,
        projectRootPath: item.projectRootPath,
        summaryModules: summaryResult?.data?.moduleCount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`error\t${item.projectRootPath}\t${message}`);
      report.push({ error: message, projectRootPath: item.projectRootPath });
    }
  }

  const ok = report.filter((item) => !item.skipped && !item.error).length;
  const skipped = report.filter((item) => item.skipped).length;
  const failed = report.filter((item) => item.error).length;
  console.log(JSON.stringify({ failed, ok, report, skipped }, null, 2));
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

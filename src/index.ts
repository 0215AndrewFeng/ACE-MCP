#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { disableAutostart, enableAutostart, getAutostartStatus } from "./autostart/index.js";
import { formatHelpText, parseCliArgs, shouldStartAutomaticUpdates } from "./config/cli.js";
import { formatDoctorReport, runDoctorChecks } from "./config/doctor.js";
import { loadSettings } from "./config/settings.js";
import { Logger } from "./core/common/logger.js";
import { IndexCoordinator } from "./core/indexing/indexCoordinator.js";
import type { IndexProjectResult } from "./core/common/types.js";
import { createEmbeddingProvider } from "./core/search/embedding.js";
import { loadEvalConfig, runEval } from "./core/search/evalRunner.js";
import { LlmClient } from "./core/llm/llmClient.js";
import { SummaryGenerator } from "./core/summary/summaryGenerator.js";
import { LongTaskTracker } from "./core/tasks/longTaskTracker.js";
import { SearchService } from "./core/search/searchService.js";
import { ProjectRouter } from "./core/search/projectRouter.js";
import { SQLiteStore } from "./core/storage/sqliteStore.js";
import { createMcpServer } from "./server/mcpServer.js";
import { startWebApp } from "./web/app.js";
import { APP_VERSION } from "./version.js";

async function handleAutostart(action: "enable" | "disable" | "status", webPort?: number): Promise<void> {
  if (action === "status") {
    const status = await getAutostartStatus();
    process.stdout.write(`Autostart Status:\n`);
    process.stdout.write(`  Platform: ${status.platform}\n`);
    process.stdout.write(`  Enabled:  ${status.enabled ? "yes" : "no"}\n`);
    process.stdout.write(`  Running:  ${status.running ? "yes" : "no"}\n`);
    if (status.webPort) {
      process.stdout.write(`  Web Port: ${status.webPort}\n`);
    }
    return;
  }

  if (action === "enable") {
    await enableAutostart({ enabled: true, webPort });
    process.stdout.write(`✓ Autostart enabled${webPort ? ` (web port: ${webPort})` : ""}\n`);
    process.stdout.write(`  Service will start automatically on system boot.\n`);
    return;
  }

  if (action === "disable") {
    await disableAutostart();
    process.stdout.write(`✓ Autostart disabled\n`);
    return;
  }
}

/**
 * Warm up previously-indexed projects to eliminate first-query latency.
 * Introduced in v4.6.4; v4.10.3 runs it before MCP/Web readiness so synchronous
 * vector hydration is never user-visible.
 */
async function warmupKnownProjects(
  store: SQLiteStore,
  indexCoordinator: IndexCoordinator,
  embeddingProvider: ReturnType<typeof createEmbeddingProvider>,
  logger: Logger,
  vectorCacheMaxProjects: number,
): Promise<void> {
  const startTime = Date.now();
  const projects = store.listProjectsWithIds();

  if (projects.length === 0) {
    logger.info("warmup: no previously-indexed projects found");
    return;
  }

  logger.info("warmup: starting", { projectCount: projects.length });

  // Restore freshness state for ALL known projects (cheap — just Map entries)
  let freshnessRestoredCount = 0;
  for (const project of projects) {
    try {
      const projectStats = store.getProjectStats(project.projectRootPath);
      const event = projectStats?.latestIndexEvent;
      if (!projectStats || projectStats.status !== "ready" || !event || event.failedFileCount > 0) {
        logger.debug("warmup: skipping project freshness restore", {
          projectRootPath: project.projectRootPath,
          reason: !projectStats
            ? "not-found"
            : projectStats.status !== "ready"
              ? projectStats.status
              : !event
                ? "missing-index-event"
                : "failed-index-event",
        });
        continue;
      }

      // Restore from the real successful event so cached metadata remains faithful.
      const indexResult: IndexProjectResult = {
        ...event,
        project: {
          rootPath: project.projectRootPath,
          projectType: "single-language",
          languages: projectStats.languages,
          markers: [],
        },
        projectId: project.projectId,
        projectRootPath: project.projectRootPath,
      };

      indexCoordinator.restoreFreshnessState(project.projectRootPath, indexResult);
      freshnessRestoredCount += 1;

      logger.debug("warmup: freshness state restored", {
        projectRootPath: project.projectRootPath,
        lastIndexAt: project.lastIndexAt,
      });
    } catch (error) {
      logger.warn("warmup: failed to restore freshness for project", {
        error: error instanceof Error ? error.message : String(error),
        projectRootPath: project.projectRootPath,
      });
    }
  }

  // Pre-load vector cache only for the most recent projects (respect vectorCacheMaxProjects)
  const maxProjects = vectorCacheMaxProjects;
  const projectsToWarm = projects.slice(0, maxProjects);
  const modelName = embeddingProvider.getModelName();

  for (const project of projectsToWarm) {
    try {
      // Pre-load vector cache and trigger async HNSW build
      if (store.hasVectorIndex(project.projectId, modelName)) {
        store.getProjectVectors(project.projectId, modelName, project.indexVersion);
        logger.debug("warmup: vector cache pre-loaded", {
          projectRootPath: project.projectRootPath,
        });
      }

      // Semantic FTS writes use the coordinator-owned worker and its shutdown lease.
      await indexCoordinator.ensureSemanticIndex(project.projectId);
      logger.debug("warmup: semantic FTS ensured", {
        projectRootPath: project.projectRootPath,
      });
    } catch (error) {
      logger.warn("warmup: failed for project", {
        error: error instanceof Error ? error.message : String(error),
        projectRootPath: project.projectRootPath,
      });
    }
  }

  const elapsedMs = Date.now() - startTime;
  logger.info("warmup: complete", {
    elapsedMs,
    freshnessRestoredCount,
    vectorWarmedCount: projectsToWarm.length,
  });
}

async function main(): Promise<void> {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  if (cliOptions.help) {
    process.stdout.write(`${formatHelpText()}\n`);
    return;
  }

  if (cliOptions.version) {
    process.stdout.write(`${APP_VERSION}\n`);
    return;
  }

  // Handle autostart commands (exit after handling)
  if (cliOptions.autostart) {
    await handleAutostart(cliOptions.autostart, cliOptions.webPort);
    return;
  }

  const settings = await loadSettings();

  if (cliOptions.doctor) {
    const result = await runDoctorChecks({
      cwd: process.cwd(),
      env: process.env,
      settings,
      webPort: cliOptions.webPort,
    });
    process.stdout.write(`${formatDoctorReport(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const logger = new Logger(settings.logFilePath, settings.logLevel);
  const store = new SQLiteStore(settings.databasePath, logger);
  store.initialize();

  const embeddingProvider = createEmbeddingProvider(settings, logger);
  const indexCoordinator = new IndexCoordinator(settings, store, logger, embeddingProvider);
  const searchService = new SearchService(store, logger, settings, embeddingProvider);
  const projectRouter = new ProjectRouter(store, searchService);

  // --eval: run search-quality evaluation against a golden case file, then exit
  if (cliOptions.evalPath) {
    try {
      const evalConfig = await loadEvalConfig(cliOptions.evalPath);
      const result = await runEval(evalConfig, indexCoordinator, searchService);
      process.stdout.write(`${result.report}\n`);
      await Promise.all([indexCoordinator.close(), searchService.close()]);
      process.exit(result.passed ? 0 : 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Eval failed: ${message}\n`);
      await Promise.all([indexCoordinator.close(), searchService.close()]);
      process.exit(1);
    }
  }

  const llmClient = new LlmClient(settings.llmApiUrl, settings.llmApiKey, settings.llmModel, settings.llmMaxTokens, settings.llmTemperature);
  const summaryGenerator = new SummaryGenerator(store, llmClient, logger);
  const longTaskTracker = new LongTaskTracker();

  const server = createMcpServer({
    embeddingProvider,
    indexCoordinator,
    llmClient,
    logger,
    projectRouter,
    searchService,
    settings,
    store,
    summaryGenerator,
  });
  const runtime = {
    nodeVersion: process.version,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: APP_VERSION,
    webPort: cliOptions.webPort,
  };
  let webAppHandle: Awaited<ReturnType<typeof startWebApp>> | undefined;

  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    logger.info("shutdown requested", { signal });
    try {
      indexCoordinator.stopAutomaticUpdates();
      if (webAppHandle) {
        await webAppHandle.close();
      }
    } finally {
      try {
        await Promise.all([indexCoordinator.close(), searchService.close()]);
      } finally {
        process.exit(exitCode);
      }
    }
  };

  process.on("unhandledRejection", (error) => {
    logger.error("unhandled rejection", {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  });
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", {
      error: error.stack ?? error.message,
    });
    void shutdown("uncaughtException", 1);
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT", 0);
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });

  // --warm intentionally delays readiness: vector hydration is synchronous, while
  // semantic writes run through the coordinator-owned SQLite worker.
  if (cliOptions.warm) {
    await warmupKnownProjects(
      store,
      indexCoordinator,
      embeddingProvider,
      logger,
      settings.vectorCacheMaxProjects,
    );
  }

  if (cliOptions.webPort) {
    webAppHandle = await startWebApp(cliOptions.webPort, {
      embeddingProvider,
      indexCoordinator,
      llmClient,
      logger,
      longTaskTracker,
      projectRouter,
      runtime,
      searchService,
      settings,
      store,
      summaryGenerator,
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (shouldStartAutomaticUpdates(cliOptions)) {
    void indexCoordinator.startAutomaticUpdates().catch((error) => {
      logger.warn("automatic index updates failed to start", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  logger.info("ace-mcp server started", {
    databasePath: settings.databasePath,
    pid: process.pid,
    version: APP_VERSION,
    webPort: cliOptions.webPort,
  });

}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

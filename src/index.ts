import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { disableAutostart, enableAutostart, getAutostartStatus } from "./autostart/index.js";
import { formatHelpText, parseCliArgs } from "./config/cli.js";
import { loadSettings } from "./config/settings.js";
import { Logger } from "./core/common/logger.js";
import { IndexCoordinator } from "./core/indexing/indexCoordinator.js";
import { createEmbeddingProvider } from "./core/search/embedding.js";
import { LlmClient } from "./core/llm/llmClient.js";
import { SummaryGenerator } from "./core/summary/summaryGenerator.js";
import { SearchService } from "./core/search/searchService.js";
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
  const logger = new Logger(settings.logFilePath, settings.logLevel);
  const store = new SQLiteStore(settings.databasePath, logger);
  store.initialize();

  const embeddingProvider = createEmbeddingProvider(settings);
  const indexCoordinator = new IndexCoordinator(settings, store, logger, embeddingProvider);
  const searchService = new SearchService(store, logger, settings, embeddingProvider);
  const llmClient = new LlmClient(settings.llmApiUrl, settings.llmApiKey, settings.llmModel, settings.llmMaxTokens, settings.llmTemperature);
  const summaryGenerator = new SummaryGenerator(store, llmClient, logger);

  const server = createMcpServer({
    indexCoordinator,
    llmClient,
    logger,
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
      indexCoordinator.stopWatching();
      if (webAppHandle) {
        await webAppHandle.close();
      }
    } finally {
      process.exit(exitCode);
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

  if (cliOptions.webPort) {
    webAppHandle = await startWebApp(cliOptions.webPort, {
      indexCoordinator,
      llmClient,
      logger,
      runtime,
      searchService,
      settings,
      store,
      summaryGenerator,
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
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

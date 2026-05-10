import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { formatHelpText, parseCliArgs } from "./config/cli.js";
import { loadSettings } from "./config/settings.js";
import { Logger } from "./core/common/logger.js";
import { IndexCoordinator } from "./core/indexing/indexCoordinator.js";
import { createEmbeddingProvider } from "./core/search/embedding.js";
import { SearchService } from "./core/search/searchService.js";
import { SQLiteStore } from "./core/storage/sqliteStore.js";
import { createMcpServer } from "./server/mcpServer.js";
import { startWebApp } from "./web/app.js";
import { APP_VERSION } from "./version.js";

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

  const settings = await loadSettings();
  const logger = new Logger(settings.logFilePath, settings.logLevel);
  const store = new SQLiteStore(settings.databasePath, logger);
  store.initialize();

  const embeddingProvider = createEmbeddingProvider(settings);
  const indexCoordinator = new IndexCoordinator(settings, store, logger, embeddingProvider);
  const searchService = new SearchService(store, logger, settings, embeddingProvider);

  const server = createMcpServer({
    indexCoordinator,
    logger,
    searchService,
    settings,
    store,
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
      logger,
      runtime,
      searchService,
      settings,
      store,
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

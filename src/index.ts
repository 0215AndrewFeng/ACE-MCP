import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { formatHelpText, parseCliArgs } from "./config/cli.js";
import { loadSettings } from "./config/settings.js";
import { Logger } from "./core/common/logger.js";
import { IndexCoordinator } from "./core/indexing/indexCoordinator.js";
import { SearchService } from "./core/search/searchService.js";
import { SQLiteStore } from "./core/storage/sqliteStore.js";
import { createMcpServer } from "./server/mcpServer.js";
import { startWebApp } from "./web/app.js";

async function main(): Promise<void> {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  if (cliOptions.help) {
    process.stdout.write(`${formatHelpText()}\n`);
    return;
  }

  const settings = await loadSettings();
  const logger = new Logger(settings.logFilePath, settings.logLevel);
  const store = new SQLiteStore(settings.databasePath, logger);
  store.initialize();

  const indexCoordinator = new IndexCoordinator(settings, store, logger);
  const searchService = new SearchService(store, logger);

  const server = createMcpServer({
    indexCoordinator,
    logger,
    searchService,
    settings,
    store,
  });

  if (cliOptions.webPort) {
    await startWebApp(cliOptions.webPort, {
      indexCoordinator,
      logger,
      searchService,
      settings,
      store,
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("ace-mcp server started", { databasePath: settings.databasePath, webPort: cliOptions.webPort });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

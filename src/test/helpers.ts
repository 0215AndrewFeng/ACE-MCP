import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Settings } from "../core/common/types.js";
import { IndexCoordinator } from "../core/indexing/indexCoordinator.js";
import { Logger } from "../core/common/logger.js";
import { SearchService } from "../core/search/searchService.js";
import { SQLiteStore } from "../core/storage/sqliteStore.js";

export interface TestProjectEnvironment {
  cleanup: () => Promise<void>;
  indexCoordinator: IndexCoordinator;
  projectRootPath: string;
  searchService: SearchService;
  settings: Settings;
  store: SQLiteStore;
  tempDir: string;
}

async function writeProjectFiles(projectRootPath: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(projectRootPath, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
}

export async function createTestProjectEnvironment(files: Record<string, string>): Promise<TestProjectEnvironment> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-test-"));
  const projectRootPath = path.join(tempDir, "project");
  const dataDir = path.join(tempDir, "data");
  const logDir = path.join(tempDir, "log");
  await mkdir(projectRootPath, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeProjectFiles(projectRootPath, files);

  const settings: Settings = {
    batchSize: 32,
    dataDir,
    databasePath: path.join(dataDir, "index.db"),
    defaultTopK: 8,
    enableVectorSearch: true,
    excludePatterns: [".git", "node_modules", "dist"],
    logDir,
    logFilePath: path.join(logDir, "ace-mcp.log"),
    logLevel: "error",
    maxFileSizeKb: 1024,
    maxLinesPerChunk: 80,
    settingsFilePath: path.join(tempDir, "settings.toml"),
    textExtensions: [".java", ".js", ".jsx", ".ts", ".tsx", ".cs", ".py"],
    vectorIndexingMode: "lazy",
  };
  const logger = new Logger(settings.logFilePath, "error");
  const store = new SQLiteStore(settings.databasePath, logger);
  store.initialize();

  return {
    cleanup: async () => {
      await rm(tempDir, { force: true, recursive: true });
    },
    indexCoordinator: new IndexCoordinator(settings, store, logger),
    projectRootPath,
    searchService: new SearchService(store, logger, settings),
    settings,
    store,
    tempDir,
  };
}

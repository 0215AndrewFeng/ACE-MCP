import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Settings } from "../core/common/types.js";
import type { EmbeddingProvider } from "../core/search/embedding.js";
import { createEmbeddingProvider } from "../core/search/embedding.js";
import {
  createSynchronousIndexStorageWorker,
  IndexCoordinator,
} from "../core/indexing/indexCoordinator.js";
import type { WatchFactory } from "../core/indexing/indexCoordinator.js";
import { Logger } from "../core/common/logger.js";
import { SearchService } from "../core/search/searchService.js";
import { SQLiteStore } from "../core/storage/sqliteStore.js";

export interface TestProjectEnvironment {
  cleanup: () => Promise<void>;
  embeddingProvider: EmbeddingProvider;
  indexCoordinator: IndexCoordinator;
  projectRootPath: string;
  searchService: SearchService;
  settings: Settings;
  store: SQLiteStore;
  tempDir: string;
}

const testWatchFactory: WatchFactory = () => ({ close() {} });

async function writeProjectFiles(projectRootPath: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(projectRootPath, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
}

export async function createTestProjectEnvironment(files: Record<string, string>, embeddingProvider?: EmbeddingProvider): Promise<TestProjectEnvironment> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-test-"));
  const projectRootPath = path.join(tempDir, "project");
  const dataDir = path.join(tempDir, "data");
  const logDir = path.join(tempDir, "log");
  await mkdir(projectRootPath, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeProjectFiles(projectRootPath, files);

  const settings: Settings = {
    autoWatch: false,
    batchSize: 32,
    dataDir,
    databasePath: path.join(dataDir, "index.db"),
    defaultTopK: 8,
    embeddingApiKey: "",
    embeddingApiUrl: "",
    embeddingModel: "text-embedding-3-small",
    embeddingProvider: "memory",
    enableVectorSearch: true,
    excludePatterns: [".git", "node_modules", "dist"],
    logDir,
    logFilePath: path.join(logDir, "ace-mcp.log"),
    logLevel: "error",
    maxFileSizeKb: 1024,
    maxLinesPerChunk: 80,
    settingsFilePath: path.join(tempDir, "settings.toml"),
    textExtensions: [".java", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".cs", ".py", ".md"],
    vectorIndexingMode: "lazy",
    indexFreshness: "always",
    indexFreshnessSeconds: 30,
    indexConcurrency: 1,
    watchDebounceMs: 2000,
    watchMaxWaitMs: 10_000,
    watchReconcileSeconds: 600,
    searchCacheTtlMs: 60_000,
    searchCacheMaxSize: 100,
    vectorCacheMaxProjects: 10,
    searchFanoutLimit: 50,
    searchWorkerPoolSize: 2,
    searchWorkerQueueMaxPending: 64,
    searchWorkerQueueDeadlineMs: 5000,
    llmApiUrl: "",
    llmApiKey: "",
    llmModel: "gpt-4o-mini",
    llmMaxTokens: 8192,
    llmTemperature: 0.3,
    enableLlmReranker: false,
    llmRerankerMaxCandidates: 10,
    // v4.3.6: Ask Codebase limits
    qaMaxSourcesDefault: 10,
    qaMaxSourcesMax: 100,
    qaMaxContextTokens: 24000,
    qaMaxContextTokensMax: 200000,
    // v4.3.6: Search limits
    searchPerFileLimit: 2,
    searchFanoutMultiplier: 3,
  };
  const logger = new Logger(settings.logFilePath, "error");
  const store = new SQLiteStore(settings.databasePath, logger);
  store.initialize();
  const provider = embeddingProvider ?? createEmbeddingProvider(settings);
  const searchService = new SearchService(store, logger, settings, provider);
  const indexCoordinator = new IndexCoordinator(
    settings,
    store,
    logger,
    provider,
    testWatchFactory,
    undefined,
    undefined,
    createSynchronousIndexStorageWorker(store),
  );

  return {
    cleanup: async () => {
      await indexCoordinator.close();
      await searchService.close();
      for (const project of store.listProjectsWithIds()) {
        store.clearProjectVectorCache(project.projectId);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
    },
    embeddingProvider: provider,
    indexCoordinator,
    projectRootPath,
    searchService,
    settings,
    store,
    tempDir,
  };
}
